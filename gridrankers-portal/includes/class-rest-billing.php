<?php
/**
 * REST: /billing.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The Super Admin's invoice tracker (SPEC.md 6.14). Every route is Super Admin only.
 */
class GRP_REST_Billing extends GRP_REST_Controller {

	/** Largest amount accepted. */
	const MAX_AMOUNT = 999999999;

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/billing', WP_REST_Server::READABLE, 'index' );
		self::route( '/billing/projects/(?P<id>[\w-]+)', 'PUT', 'save_fee' );
		self::route( '/billing/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/billing/(?P<id>[\w-]+)/payments', WP_REST_Server::CREATABLE, 'add_payment' );
		self::route( '/billing/(?P<id>[\w-]+)/payments/(?P<pid>[\w-]+)', WP_REST_Server::DELETABLE, 'remove_payment' );
	}

	/**
	 * 403 for everyone but the Super Admin.
	 *
	 * @return WP_Error|null
	 */
	private static function refuse() {
		return self::can( GRP_Permissions::MANAGE_BILLING ) ? null : self::forbidden( __( 'Only the Super Admin keeps the invoices.', 'gridrankers-portal' ) );
	}

	/**
	 * GET /billing: creates the rows of cycles that just ended, then returns rows and fees.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index() {
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		GRP_Billing::ensure( GRP_Cycles::today() );

		$response = rest_ensure_response(
			array(
				'billing'      => GRP_Store::find( 'grp_billing', array(), array( 'order_by' => 'cycle_end' ) ),
				'billing_fees' => GRP_Store::find( 'grp_billing_fees' ),
			)
		);
		$response->header( 'Cache-Control', 'no-store' );

		return $response;
	}

	/**
	 * PUT /billing/projects/{id} `{fee, currency, remind_days}`. A new fee fills in the
	 * amount of that project's cycles that have none and are not sent yet.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save_fee( WP_REST_Request $request ) {
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		$fee = self::amount( $request['fee'], true );
		if ( is_wp_error( $fee ) ) {
			return $fee;
		}
		$fields = array(
			'fee'         => $fee,
			'currency'    => self::currency( $request['currency'] ),
			'remind_days' => self::int( $request['remind_days'], 1, 90, GRP_Billing::REMIND_DAYS ),
		);

		$row = GRP_Store::get( 'grp_billing_fees', $project['id'] )
			? GRP_Store::update( 'grp_billing_fees', $project['id'], $fields )
			: GRP_Store::insert( 'grp_billing_fees', array( 'id' => $project['id'] ) + $fields );

		if ( null !== $fee ) {
			foreach ( GRP_Store::find( 'grp_billing', array( 'project_id' => $project['id'] ) ) as $bill ) {
				if ( null === $bill['amount'] && empty( $bill['sent_at'] ) && empty( $bill['skipped'] ) ) {
					GRP_Store::update(
						'grp_billing',
						$bill['id'],
						array(
							'amount'   => $fee,
							'currency' => $fields['currency'],
						)
					);
				}
			}
		}

		return rest_ensure_response( $row );
	}

	/**
	 * PATCH /billing/{id} `{sent?, sent_at?, ref?, amount?, currency?, skipped?, note?}`.
	 * `sent` true stamps today (or `sent_at`); false clears it.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$row = GRP_Store::get( 'grp_billing', $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}

		$params  = $request->get_params();
		$changes = array();

		if ( array_key_exists( 'sent', $params ) || array_key_exists( 'sent_at', $params ) ) {
			$sent = array_key_exists( 'sent', $params ) ? (bool) $params['sent'] : null !== $params['sent_at'];
			if ( $sent ) {
				$date = empty( $params['sent_at'] ) ? GRP_Cycles::today() : self::date( $params['sent_at'], 'invoice date' );
				if ( is_wp_error( $date ) ) {
					return $date;
				}
				$changes['sent_at'] = $date;
				$changes['sent_by'] = self::actor()['id'];
			} else {
				$changes['sent_at'] = null;
				$changes['sent_by'] = null;
			}
		}
		if ( array_key_exists( 'amount', $params ) ) {
			$amount = self::amount( $params['amount'], true );
			if ( is_wp_error( $amount ) ) {
				return $amount;
			}
			$changes['amount'] = $amount;
		}
		if ( array_key_exists( 'currency', $params ) ) {
			$changes['currency'] = self::currency( $params['currency'] );
		}
		if ( array_key_exists( 'ref', $params ) ) {
			$ref            = self::text( $params['ref'], 191 );
			$changes['ref'] = '' === $ref ? null : $ref;
		}
		if ( array_key_exists( 'skipped', $params ) ) {
			$changes['skipped'] = $params['skipped'] ? 1 : 0;
		}
		if ( array_key_exists( 'note', $params ) ) {
			$note            = self::textarea( $params['note'], 2000 );
			$changes['note'] = '' === $note ? null : $note;
		}
		if ( ! $changes ) {
			return self::invalid( __( 'Nothing to change.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response( GRP_Store::update( 'grp_billing', $row['id'], $changes ) );
	}

	/**
	 * POST /billing/{id}/payments `{amount, date?, method?, ref?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function add_payment( WP_REST_Request $request ) {
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$row = GRP_Store::get( 'grp_billing', $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$amount = self::amount( $request['amount'], false );
		if ( is_wp_error( $amount ) ) {
			return $amount;
		}
		$date = empty( $request['date'] ) ? GRP_Cycles::today() : self::date( $request['date'], 'payment date' );
		if ( is_wp_error( $date ) ) {
			return $date;
		}

		$payments   = (array) ( $row['payments'] ?? array() );
		$payments[] = array(
			'id'     => GRP_Ids::ulid(),
			'amount' => $amount,
			'date'   => $date,
			'method' => self::text( $request['method'], 40 ),
			'ref'    => self::text( $request['ref'], 191 ),
			'by'     => self::actor()['id'],
			'at'     => GRP_Ids::now(),
		);

		$response = rest_ensure_response( GRP_Store::update( 'grp_billing', $row['id'], array( 'payments' => $payments ) ) );
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * DELETE /billing/{id}/payments/{pid}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function remove_payment( WP_REST_Request $request ) {
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$row = GRP_Store::get( 'grp_billing', $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$payments = (array) ( $row['payments'] ?? array() );
		$kept     = array_values(
			array_filter(
				$payments,
				static function ( $p ) use ( $request ) {
					return (string) ( $p['id'] ?? '' ) !== (string) $request['pid'];
				}
			)
		);
		if ( count( $kept ) === count( $payments ) ) {
			return self::not_found();
		}

		return rest_ensure_response( GRP_Store::update( 'grp_billing', $row['id'], array( 'payments' => $kept ) ) );
	}

	/**
	 * A money amount: a number from 0 (or above 0 for payments) up to MAX_AMOUNT, 2 decimals.
	 *
	 * @param mixed $value      Raw value.
	 * @param bool  $allow_none Whether empty means "no amount" (null).
	 * @return float|null|WP_Error
	 */
	private static function amount( $value, $allow_none ) {
		if ( is_string( $value ) ) {
			$value = trim( str_replace( ',', '', $value ) );
		}
		if ( null === $value || '' === $value ) {
			return $allow_none ? null : self::invalid( __( 'Enter the amount received.', 'gridrankers-portal' ) );
		}
		if ( ! is_numeric( $value ) || (float) $value < 0 || (float) $value > self::MAX_AMOUNT || ( ! $allow_none && (float) $value <= 0 ) ) {
			return self::invalid( __( 'Enter an amount like 500 or 1250.50.', 'gridrankers-portal' ) );
		}

		return round( (float) $value, 2 );
	}

	/**
	 * A currency symbol or code, e.g. `$`, `৳`, `USD` (default `$`).
	 *
	 * @param mixed $value Raw value.
	 * @return string
	 */
	private static function currency( $value ) {
		$value = mb_substr( trim( sanitize_text_field( (string) $value ) ), 0, 8 );

		return '' === $value ? GRP_Billing::CURRENCY : $value;
	}
}
