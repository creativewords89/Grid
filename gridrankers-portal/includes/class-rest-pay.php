<?php
/**
 * REST: /pay and /salary.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pay (SPEC.md 6.19): each Team Leader and Team Member sets their own working hours, salary and
 * payment details (design PAY-1, PAY-2) and sees their own month (PAY-3); the Super Admin sees the
 * pay sheet and marks payslips paid (PAY-4). Never sent by /sync: Team Leaders see nobody else's pay.
 */
class GRP_REST_Pay extends GRP_REST_Controller {

	const TABLE = 'grp_pay';

	const SLIPS = 'grp_payslips';

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/pay/me', WP_REST_Server::READABLE, 'me' );
		self::route( '/pay/me', 'PUT', 'save' );
		self::route( '/salary', WP_REST_Server::READABLE, 'salary' );
		self::route( '/salary/sheet', WP_REST_Server::READABLE, 'sheet' );
		self::route( '/salary/paid', WP_REST_Server::CREATABLE, 'paid' );
	}

	/**
	 * A no-store response.
	 *
	 * @param mixed $data Data.
	 * @return WP_REST_Response
	 */
	private static function respond( $data ) {
		$response = rest_ensure_response( $data );
		$response->header( 'Cache-Control', 'no-store' );

		return $response;
	}

	/**
	 * `?month=YYYY-MM`, default this month; never a month still to come.
	 *
	 * @param WP_REST_Request $request Request.
	 * @param string          $today   `Y-m-d`.
	 * @return string|WP_Error
	 */
	private static function month( WP_REST_Request $request, $today ) {
		$month = (string) $request['month'];
		if ( '' === $month ) {
			return substr( $today, 0, 7 );
		}
		if ( ! preg_match( '/^\d{4}-(0[1-9]|1[0-2])$/', $month ) ) {
			return self::invalid( __( 'Invalid month.', 'gridrankers-portal' ) );
		}

		return min( $month, substr( $today, 0, 7 ) );
	}

	/**
	 * GET /pay/me: the signed-in person's pay — whether they still have to set it up (design PAY-1),
	 * their hours, salary and payment details, and their payslips. Bills a month that just ended.
	 *
	 * @return WP_REST_Response
	 */
	public static function me() {
		$actor = self::actor();
		$today = GRP_Cycles::today();
		GRP_Pay::bill( $today );
		$earns = GRP_Pay::earns( $actor );
		$pay   = $earns ? GRP_Store::get( self::TABLE, (string) $actor['id'] ) : null;

		return self::respond(
			array(
				'today'   => $today,
				'earns'   => $earns,
				'needed'  => $earns && ! GRP_Pay::complete( $pay ),
				'pay'     => $pay,
				'choices' => GRP_Pay::DAY_CHOICES,
				'slips'   => $earns ? GRP_Store::find(
					self::SLIPS,
					array( 'member_id' => $actor['id'] ),
					array(
						'order_by' => 'month',
						'order'    => 'DESC',
					)
				) : array(),
			)
		);
	}

	/**
	 * PUT /pay/me `{day_minutes, salary, method, bank_name?, branch?, account_name, account_number, routing?}`:
	 * sets the actor's own working hours, salary and payment details. All are required.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save( WP_REST_Request $request ) {
		$actor = self::actor();
		if ( ! self::can( GRP_Permissions::SET_OWN_PAY, array( 'member_id' => $actor['id'] ) ) ) {
			return self::forbidden( __( 'The Super Admin has no salary in the portal.', 'gridrankers-portal' ) );
		}

		$minutes = is_numeric( $request['day_minutes'] ) ? (int) $request['day_minutes'] : 0;
		if ( $minutes < GRP_Pay::MIN_DAY || $minutes > GRP_Pay::MAX_DAY ) {
			return self::invalid( __( 'Pick how many hours you work a day (1 to 16).', 'gridrankers-portal' ), 'grp_pay_hours' );
		}
		$salary = str_replace( array( ',', ' ' ), '', (string) $request['salary'] );
		if ( ! preg_match( '/^\d+$/', $salary ) || (int) $salary < 1 || (int) $salary > GRP_Pay::MAX_SALARY ) {
			return self::invalid( __( 'Write your monthly salary in BDT.', 'gridrankers-portal' ), 'grp_pay_salary' );
		}
		$method = (string) $request['method'];
		if ( ! in_array( $method, GRP_Pay::METHODS, true ) ) {
			return self::invalid( __( 'Choose how you are paid: bank account, bKash or Nagad.', 'gridrankers-portal' ), 'grp_pay_method' );
		}
		$name = self::text( $request['account_name'] ?? '', 120 );
		if ( '' === $name ) {
			return self::invalid( __( 'Write the account name.', 'gridrankers-portal' ), 'grp_pay_account' );
		}
		$number = preg_replace( '/[\s-]+/', ' ', trim( (string) $request['account_number'] ) );
		$digits = preg_replace( '/\D/', '', $number );
		if ( 'bank' === $method ) {
			if ( ! preg_match( '/^[\d ]+$/', $number ) || strlen( $digits ) < 6 || strlen( $digits ) > 34 ) {
				return self::invalid( __( 'Write the bank account number (digits only).', 'gridrankers-portal' ), 'grp_pay_account' );
			}
		} elseif ( ! preg_match( '/^01\d{9}$/', $digits ) || ! preg_match( '/^[\d ]+$/', $number ) ) {
			return self::invalid( __( 'Write the 11-digit mobile number, e.g. 01712345678.', 'gridrankers-portal' ), 'grp_pay_account' );
		}
		$bank    = 'bank' === $method ? self::text( $request['bank_name'] ?? '', 120 ) : '';
		$branch  = 'bank' === $method ? self::text( $request['branch'] ?? '', 120 ) : '';
		$routing = 'bank' === $method ? preg_replace( '/\D/', '', (string) $request['routing'] ) : '';
		if ( 'bank' === $method && '' === $bank ) {
			return self::invalid( __( 'Write the bank name.', 'gridrankers-portal' ), 'grp_pay_account' );
		}
		if ( strlen( $routing ) > 20 ) {
			return self::invalid( __( 'The routing number is too long.', 'gridrankers-portal' ), 'grp_pay_account' );
		}

		$fields = array(
			'day_minutes'    => $minutes,
			'salary'         => (int) $salary,
			'method'         => $method,
			'bank_name'      => $bank,
			'branch'         => $branch,
			'account_name'   => $name,
			'account_number' => 'bank' === $method ? $number : $digits,
			'routing'        => $routing,
		);
		$id     = (string) $actor['id'];
		$row    = GRP_Store::get( self::TABLE, $id )
			? GRP_Store::update( self::TABLE, $id, $fields )
			: GRP_Store::insert(
				self::TABLE,
				array(
					'id'        => $id,
					'member_id' => $id,
				) + $fields
			);

		return self::respond( $row );
	}

	/**
	 * GET /salary?member=&month=YYYY-MM: a person's month (design PAY-3) — every day's hours and
	 * extra hours, days off and leave, and the salary it adds up to — with the payslip once billed.
	 * Their own; the Super Admin anyone's.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function salary( WP_REST_Request $request ) {
		$actor  = self::actor();
		$id     = '' !== (string) $request['member'] ? (string) $request['member'] : (string) $actor['id'];
		$person = GRP_Store::get( 'grp_members', $id );
		if ( ! $person ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::VIEW_SALARY, array( 'member_id' => $person['id'] ) ) ) {
			return self::forbidden( __( 'You can only see your own salary.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		$month = self::month( $request, $today );
		if ( is_wp_error( $month ) ) {
			return $month;
		}
		$pay = GRP_Store::get( self::TABLE, (string) $person['id'] );

		return self::respond(
			array(
				'member_id' => $person['id'],
				'month'     => $month,
				'today'     => $today,
				'billing'   => GRP_Pay::billing_date( $month ),
				'summary'   => GRP_Pay::complete( $pay ) ? GRP_Pay::month_of( $person, $pay, $month, $today ) : null,
				'slip'      => GRP_Store::get( self::SLIPS, GRP_Pay::slip_id( $person['id'], $month ) ),
			)
		);
	}

	/**
	 * GET /salary/sheet?month=YYYY-MM: the pay sheet (design PAY-4) — everyone with a salary, their
	 * hours, rates, extra hours, leave, total and payment details; a billed month shows its payslips.
	 * Super Admin only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function sheet( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PAY ) ) {
			return self::forbidden( __( 'Only the Super Admin sees the pay sheet.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		GRP_Pay::bill( $today );
		$month = self::month( $request, $today );
		if ( is_wp_error( $month ) ) {
			return $month;
		}

		$rows = array();
		foreach ( GRP_Store::find( 'grp_members', array( 'active' => 1 ), array( 'order_by' => 'name' ) ) as $member ) {
			if ( ! GRP_Pay::earns( $member ) ) {
				continue;
			}
			$pay  = GRP_Store::get( self::TABLE, (string) $member['id'] );
			$ok   = GRP_Pay::complete( $pay );
			$sum  = $ok ? GRP_Pay::month_of( $member, $pay, $month, $today ) : null;
			$slip = GRP_Store::get( self::SLIPS, GRP_Pay::slip_id( $member['id'], $month ) );
			if ( $sum ) {
				unset( $sum['days'] );
			}
			$rows[] = array(
				'member_id' => $member['id'],
				'pay'       => $ok ? $pay : null,
				'summary'   => $sum,
				'slip'      => $slip,
			);
		}

		return self::respond(
			array(
				'month'   => $month,
				'today'   => $today,
				'billing' => GRP_Pay::billing_date( $month ),
				'billed'  => GRP_Pay::billing_date( $month ) <= $today,
				'rows'    => $rows,
			)
		);
	}

	/**
	 * POST /salary/paid `{month, member_ids: [], paid?: true}`: marks billed payslips paid (or not
	 * paid). Super Admin only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function paid( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PAY ) ) {
			return self::forbidden( __( 'Only the Super Admin marks salaries paid.', 'gridrankers-portal' ) );
		}
		$month = (string) $request['month'];
		if ( ! preg_match( '/^\d{4}-(0[1-9]|1[0-2])$/', $month ) ) {
			return self::invalid( __( 'Invalid month.', 'gridrankers-portal' ) );
		}
		$ids = is_array( $request['member_ids'] ) ? array_map( 'strval', $request['member_ids'] ) : array();
		if ( ! $ids ) {
			return self::invalid( __( 'Choose who was paid.', 'gridrankers-portal' ) );
		}
		$paid  = ! isset( $request['paid'] ) || ! empty( $request['paid'] );
		$slips = array();
		foreach ( array_unique( $ids ) as $id ) {
			$slip = GRP_Store::get( self::SLIPS, GRP_Pay::slip_id( $id, $month ) );
			if ( ! $slip ) {
				return self::conflict( __( 'That month isn’t billed yet — salaries are paid after the 1st.', 'gridrankers-portal' ), 'grp_not_billed' );
			}
			$slips[] = $slip;
		}
		$out = array();
		foreach ( $slips as $slip ) {
			$out[] = GRP_Store::update(
				self::SLIPS,
				$slip['id'],
				$paid
					? array(
						'paid_at' => GRP_Ids::now(),
						'paid_by' => self::actor()['id'],
					)
					: array(
						'paid_at' => null,
						'paid_by' => null,
					)
			);
		}

		return self::respond( $out );
	}
}
