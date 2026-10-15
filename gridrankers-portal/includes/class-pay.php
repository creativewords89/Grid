<?php
/**
 * Pay: working hours, salary, payment details and the monthly salary (SPEC.md 6.19).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Salary maths, the setup lock and billing day.
 *
 * Everyone who writes daily reports (Team Leaders and Team Members) sets their own working hours,
 * monthly salary and payment details; nothing else works until they have. A day's pay is always
 * salary ÷ 30 and an hour's pay a day's pay ÷ their hours. Extra hours (time in a sent daily report
 * over their hours) are paid at that rate; leave follows the monthly settlement (6.10). On the 1st of
 * each month the month before is billed: a payslip per person and a notice to them and the Super Admin.
 */
class GRP_Pay {

	/** Option `YYYY-MM`, the month pay started (schema 18); earlier months are never billed. */
	const SINCE_OPTION = 'grp_pay_since';

	/** Option `YYYY-MM`, the last month whose billing notice went to the Super Admin. */
	const BILLED_OPTION = 'grp_pay_billed';

	/** A month's salary is this many days' pay. */
	const DAYS_IN_MONTH = 30;

	/** Working hours a day people pick from (minutes); any other value from 1 to 16 hours also works. */
	const DAY_CHOICES = array( 300, 360, 480 );

	/** Shortest and longest working day (minutes). */
	const MIN_DAY = 60;
	const MAX_DAY = 960;

	/** Highest monthly salary accepted (BDT). */
	const MAX_SALARY = 10000000;

	/** Ways to be paid. */
	const METHODS = array( 'bank', 'bkash', 'nagad' );

	/** REST routes (under the namespace) a person who hasn't set up their pay may still change. */
	const OPEN_ROUTES = array( '/auth/', '/pay/me' );

	/**
	 * Hooks the setup lock.
	 */
	public static function init() {
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'lock' ), 10, 3 );
	}

	/**
	 * Schema 18: pay starts this month.
	 */
	public static function start() {
		if ( ! get_option( self::SINCE_OPTION ) ) {
			update_option( self::SINCE_OPTION, substr( GRP_Cycles::today(), 0, 7 ), false );
		}
	}

	/**
	 * The month pay started.
	 *
	 * @return string `YYYY-MM`.
	 */
	public static function since() {
		$since = (string) get_option( self::SINCE_OPTION, '' );

		return preg_match( '/^\d{4}-\d{2}$/', $since ) ? $since : substr( GRP_Cycles::today(), 0, 7 );
	}

	/**
	 * Whether a person has a salary in the portal: active Team Leaders and Team Members.
	 *
	 * @param array|null $member Member row.
	 * @return bool
	 */
	public static function earns( $member ) {
		return $member && (int) ( $member['active'] ?? 1 ) && GRP_Daily_Reports::writes( $member );
	}

	/**
	 * Whether a pay row has everything: hours, salary and payment details.
	 *
	 * @param array|null $pay Pay row.
	 * @return bool
	 */
	public static function complete( $pay ) {
		if ( ! $pay || (int) ( $pay['day_minutes'] ?? 0 ) < self::MIN_DAY || (int) ( $pay['salary'] ?? 0 ) < 1 ) {
			return false;
		}
		if ( ! in_array( $pay['method'] ?? '', self::METHODS, true ) || '' === (string) ( $pay['account_name'] ?? '' ) || '' === (string) ( $pay['account_number'] ?? '' ) ) {
			return false;
		}

		return 'bank' !== $pay['method'] || '' !== (string) ( $pay['bank_name'] ?? '' );
	}

	/**
	 * Whether a person still has to set up their pay before using the portal (design PAY-1).
	 *
	 * @param array|null $member Member row.
	 * @return bool
	 */
	public static function needs_setup( $member ) {
		return self::earns( $member ) && ! self::complete( GRP_Store::get( 'grp_pay', (string) $member['id'] ) );
	}

	/**
	 * Filter rest_pre_dispatch: refuses every change but signing in/out and setting up pay while the
	 * signed-in person hasn't set up their pay.
	 *
	 * @param mixed           $result  Response so far.
	 * @param WP_REST_Server  $server  Server.
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function lock( $result, $server, $request ) {
		$base = '/' . GRP_REST_Auth::REST_NAMESPACE;
		$path = (string) $request->get_route();
		if ( null !== $result || 0 !== strpos( $path, $base . '/' ) || in_array( $request->get_method(), array( 'GET', 'HEAD', 'OPTIONS' ), true ) ) {
			return $result;
		}
		$path = substr( $path, strlen( $base ) );
		foreach ( self::OPEN_ROUTES as $open ) {
			if ( 0 === strpos( $path, $open ) ) {
				return $result;
			}
		}
		$actor = GRP_Auth::current_member();
		if ( $actor && self::needs_setup( (array) $actor ) ) {
			return new WP_Error( 'grp_pay_needed', __( 'Set up your working hours, salary and payment details first.', 'gridrankers-portal' ), array( 'status' => 403 ) );
		}

		return $result;
	}

	/**
	 * A day's pay: salary ÷ 30.
	 *
	 * @param int $salary Monthly salary.
	 * @return float
	 */
	public static function day_pay( $salary ) {
		return (int) $salary / self::DAYS_IN_MONTH;
	}

	/**
	 * An hour's pay: a day's pay ÷ the working hours.
	 *
	 * @param int $salary      Monthly salary.
	 * @param int $day_minutes Working day in minutes.
	 * @return float
	 */
	public static function hour_pay( $salary, $day_minutes ) {
		return $day_minutes > 0 ? self::day_pay( $salary ) * 60 / (int) $day_minutes : 0.0;
	}

	/**
	 * Pay for extra minutes, rounded to the taka.
	 *
	 * @param int $minutes     Extra minutes.
	 * @param int $salary      Monthly salary.
	 * @param int $day_minutes Working day in minutes.
	 * @return int
	 */
	public static function extra_pay( $minutes, $salary, $day_minutes ) {
		return $day_minutes > 0 ? (int) round( (int) $minutes * (int) $salary / ( self::DAYS_IN_MONTH * (int) $day_minutes ) ) : 0;
	}

	/**
	 * Pay for whole days, rounded to the taka.
	 *
	 * @param int $days   Days.
	 * @param int $salary Monthly salary.
	 * @return int
	 */
	public static function days_pay( $days, $salary ) {
		return (int) round( (int) $days * (int) $salary / self::DAYS_IN_MONTH );
	}

	/**
	 * A person's month (design PAY-3): every day's hours and extra hours, the leave settlement and
	 * the salary it adds up to. Only sent reports count. On a working day the time over their hours
	 * is extra; on a day off or a leave day all of it is.
	 *
	 * @param array   $member      Member row.
	 * @param array   $pay         Pay row (`salary`, `day_minutes`).
	 * @param string  $month       `YYYY-MM`.
	 * @param array[] $reports     Their daily reports (any days).
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @param string  $today       `Y-m-d`.
	 * @return array `{days: [{day, kind: work|leave|day_off|future, minutes, extra}], worked, extra, extra_pay, leave: settlement, leave_pay, deducted, total, salary, day_minutes, day_pay, hour_pay}`.
	 */
	public static function month( array $member, array $pay, $month, array $reports, array $leaves, $team_weekly, array $days_off, $today ) {
		$salary = (int) $pay['salary'];
		$length = (int) $pay['day_minutes'];
		$sent   = array();
		foreach ( $reports as $report ) {
			if ( ! empty( $report['sent_at'] ) && (string) $report['member_id'] === (string) $member['id'] ) {
				$sent[ (string) $report['day'] ] = GRP_Daily_Reports::minutes( $report );
			}
		}

		$days   = array();
		$worked = 0;
		$extra  = 0;
		$last   = gmdate( 't', strtotime( $month . '-01 UTC' ) );
		for ( $d = 1; $d <= (int) $last; $d++ ) {
			$day = $month . '-' . str_pad( (string) $d, 2, '0', STR_PAD_LEFT );
			$out = GRP_Daily_Reports::out_reason( $day, $member, $leaves, $team_weekly, $days_off );
			// Leave on a day off is not leave (6.10).
			if ( 'leave' === $out && GRP_People::day_off_kind( $day, $member, $team_weekly, $days_off ) ) {
				$out = 'day_off';
			}
			$minutes = $sent[ $day ] ?? 0;
			$over    = $out ? $minutes : max( 0, $minutes - $length );
			$kind    = $out ? $out : ( $day > $today ? 'future' : 'work' );
			$worked += $minutes;
			$extra  += $over;
			$days[]  = array(
				'day'     => $day,
				'kind'    => $kind,
				'minutes' => $minutes,
				'extra'   => $over,
			);
		}

		$leave     = GRP_People::settlement( GRP_People::taken_in_month( $member, $month, $leaves, $team_weekly, $days_off ) );
		$extra_pay = self::extra_pay( $extra, $salary, $length );
		$leave_pay = self::days_pay( $leave['paid'], $salary );
		$deducted  = self::days_pay( $leave['deducted'], $salary );

		return array(
			'days'        => $days,
			'worked'      => $worked,
			'extra'       => $extra,
			'extra_pay'   => $extra_pay,
			'leave'       => $leave,
			'leave_pay'   => $leave_pay,
			'deducted'    => $deducted,
			'total'       => $salary + $extra_pay + $leave_pay - $deducted,
			'salary'      => $salary,
			'day_minutes' => $length,
			'day_pay'     => round( self::day_pay( $salary ), 2 ),
			'hour_pay'    => round( self::hour_pay( $salary, $length ), 2 ),
		);
	}

	/**
	 * The month before a date's month.
	 *
	 * @param string $today `Y-m-d`.
	 * @return string `YYYY-MM`.
	 */
	public static function previous_month( $today ) {
		return gmdate( 'Y-m', strtotime( substr( $today, 0, 7 ) . '-01 UTC -1 month' ) );
	}

	/**
	 * The billing date of a month: the 1st of the next month.
	 *
	 * @param string $month `YYYY-MM`.
	 * @return string `Y-m-d`.
	 */
	public static function billing_date( $month ) {
		return gmdate( 'Y-m-d', strtotime( $month . '-01 UTC +1 month' ) );
	}

	/**
	 * Id of a person's payslip for a month.
	 *
	 * @param string $member_id Person.
	 * @param string $month     `YYYY-MM`.
	 * @return string
	 */
	public static function slip_id( $member_id, $month ) {
		return 'ps_' . md5( $member_id . '|' . $month );
	}

	/**
	 * A person's month with their pay, from their reports and leave in the database.
	 *
	 * @param array  $member Member row.
	 * @param array  $pay    Pay row.
	 * @param string $month  `YYYY-MM`.
	 * @param string $today  `Y-m-d`.
	 * @return array See month().
	 */
	public static function month_of( array $member, array $pay, $month, $today ) {
		$reports = GRP_Store::find(
			'grp_daily_reports',
			array(
				'member_id' => $member['id'],
				'day >='    => $month . '-01',
				'day <='    => $month . '-31',
			)
		);

		return self::month( $member, $pay, $month, $reports, GRP_Store::find( 'grp_leave', array( 'status' => 'approved' ) ), GRP_REST_People::team_weekly(), GRP_REST_People::days_off(), $today );
	}

	/**
	 * Billing day (design PAY-4): once the month is over, each person with pay gets a payslip for it
	 * and a notice with their total; the Super Admin gets one notice for everyone. Safe to repeat.
	 *
	 * @param string $today `Y-m-d`.
	 * @return int Payslips made.
	 */
	public static function bill( $today ) {
		$month = self::previous_month( $today );
		if ( $month < self::since() ) {
			return 0;
		}
		$admin = self::admin_id();
		$made  = 0;
		$end   = $month . '-31 23:59:59';
		foreach ( GRP_Store::find( 'grp_members', array( 'active' => 1 ), array( 'order_by' => 'name' ) ) as $member ) {
			$pay = GRP_Store::get( 'grp_pay', (string) $member['id'] );
			// Only people who were set up in that month (or before) are billed for it.
			if ( ! self::earns( $member ) || ! self::complete( $pay ) || (string) $pay['created_at'] > $end ) {
				continue;
			}
			$id = self::slip_id( $member['id'], $month );
			if ( GRP_Store::get( 'grp_payslips', $id ) ) {
				continue;
			}
			$sum = self::month_of( $member, $pay, $month, $today );
			GRP_Store::insert(
				'grp_payslips',
				array(
					'id'            => $id,
					'member_id'     => $member['id'],
					'month'         => $month,
					'salary'        => $sum['salary'],
					'day_minutes'   => $sum['day_minutes'],
					'worked'        => $sum['worked'],
					'extra'         => $sum['extra'],
					'extra_pay'     => $sum['extra_pay'],
					'leave_taken'   => $sum['leave']['taken'],
					'leave_pay'     => $sum['leave_pay'],
					'deducted_days' => $sum['leave']['deducted'],
					'deducted'      => $sum['deducted'],
					'total'         => $sum['total'],
					'account'       => self::account_line( $pay ),
					'paid_at'       => null,
					'paid_by'       => null,
				)
			);
			++$made;
			self::notify( array( (string) $member['id'] ), $admin, self::slip_title( $month ), self::slip_line( $sum ) );
		}

		if ( $made && get_option( self::BILLED_OPTION ) !== $month ) {
			update_option( self::BILLED_OPTION, $month, false );
			$admins = array_map(
				static function ( $m ) {
					return (string) $m['id'];
				},
				array_filter(
					GRP_Store::find( 'grp_members', array( 'active' => 1 ) ),
					static function ( $m ) {
						return GRP_Permissions::ROLE_ADMIN === GRP_Permissions::effective_role( $m );
					}
				)
			);
			if ( $admins ) {
				self::notify( array_values( $admins ), $admin, self::sheet_title( $month ), self::sheet_line( GRP_Store::find( 'grp_payslips', array( 'month' => $month ) ) ) );
			}
		}

		return $made;
	}

	/**
	 * "Your October pay".
	 *
	 * @param string $month `YYYY-MM`.
	 * @return string
	 */
	private static function slip_title( $month ) {
		/* translators: %s: month name. */
		return sprintf( __( 'Your %s pay', 'gridrankers-portal' ), self::month_name( $month ) );
	}

	/**
	 * "Billing day — October pay".
	 *
	 * @param string $month `YYYY-MM`.
	 * @return string
	 */
	private static function sheet_title( $month ) {
		/* translators: %s: month name. */
		return sprintf( __( 'Billing day — %s pay', 'gridrankers-portal' ), self::month_name( $month ) );
	}

	/**
	 * A payslip in one line: "Salary 30,000 · 6h 30m extra + 813 · 2 days off − 1,000 · total 29,813 BDT".
	 *
	 * @param array $sum See month().
	 * @return string
	 */
	public static function slip_line( array $sum ) {
		/* translators: %s: amount. */
		$parts = array( sprintf( __( 'Salary %s', 'gridrankers-portal' ), self::money( $sum['salary'] ) ) );
		if ( $sum['extra'] ) {
			/* translators: 1: hours, 2: amount. */
			$parts[] = sprintf( __( '%1$s extra + %2$s', 'gridrankers-portal' ), self::hours( $sum['extra'] ), self::money( $sum['extra_pay'] ) );
		}
		if ( $sum['leave_pay'] ) {
			/* translators: %s: amount. */
			$parts[] = sprintf( __( 'day off not used + %s', 'gridrankers-portal' ), self::money( $sum['leave_pay'] ) );
		}
		if ( $sum['deducted'] ) {
			/* translators: 1: days, 2: amount. */
			$parts[] = sprintf( __( '%1$d days off − %2$s', 'gridrankers-portal' ), $sum['leave']['taken'], self::money( $sum['deducted'] ) );
		}
		/* translators: %s: amount. */
		$parts[] = sprintf( __( 'total %s BDT', 'gridrankers-portal' ), self::money( $sum['total'] ) );

		return implode( ' · ', $parts );
	}

	/**
	 * The Super Admin's billing notice: "4 people worked extra (+ 3,802 BDT); 3 took more than their day off (− 3,200 BDT). Total to pay 133,602 BDT."
	 *
	 * @param array[] $slips Payslips of the month.
	 * @return string
	 */
	public static function sheet_line( array $slips ) {
		$extra    = array_filter( $slips, static fn( $s ) => (int) $s['extra_pay'] > 0 );
		$deducted = array_filter( $slips, static fn( $s ) => (int) $s['deducted'] > 0 );
		$total    = array_sum( array_map( static fn( $s ) => (int) $s['total'], $slips ) );
		/* translators: 1: people, 2: amount. */
		$line = sprintf( _n( '%1$d person worked extra (+ %2$s BDT)', '%1$d people worked extra (+ %2$s BDT)', count( $extra ), 'gridrankers-portal' ), count( $extra ), self::money( array_sum( array_map( static fn( $s ) => (int) $s['extra_pay'], $slips ) ) ) );
		/* translators: 1: people, 2: amount. */
		$line .= '; ' . sprintf( _n( '%1$d took more than their day off (− %2$s BDT)', '%1$d took more than their day off (− %2$s BDT)', count( $deducted ), 'gridrankers-portal' ), count( $deducted ), self::money( array_sum( array_map( static fn( $s ) => (int) $s['deducted'], $slips ) ) ) );
		/* translators: %s: amount. */
		return $line . '. ' . sprintf( __( 'Total to pay %s BDT.', 'gridrankers-portal' ), self::money( $total ) );
	}

	/**
	 * Where the money goes, without the full number: "Dutch-Bangla Bank •••• 5678", "bKash •••• 5678".
	 *
	 * @param array $pay Pay row.
	 * @return string
	 */
	public static function account_line( array $pay ) {
		$last  = substr( preg_replace( '/\D/', '', (string) $pay['account_number'] ), -4 );
		$where = 'bank' === $pay['method'] ? (string) $pay['bank_name'] : ( 'bkash' === $pay['method'] ? 'bKash' : 'Nagad' );

		return $where . ' •••• ' . $last;
	}

	/**
	 * 29813 → "29,813".
	 *
	 * @param int $amount Amount.
	 * @return string
	 */
	public static function money( $amount ) {
		return number_format( (int) $amount );
	}

	/**
	 * 390 → "6h 30m".
	 *
	 * @param int $minutes Minutes.
	 * @return string
	 */
	public static function hours( $minutes ) {
		$h = intdiv( (int) $minutes, 60 );
		$m = (int) $minutes % 60;

		return $m ? ( $h ? "{$h}h {$m}m" : "{$m}m" ) : "{$h}h";
	}

	/**
	 * "2026-10" → "October".
	 *
	 * @param string $month `YYYY-MM`.
	 * @return string
	 */
	private static function month_name( $month ) {
		return gmdate( 'F', strtotime( $month . '-01 UTC' ) );
	}

	/**
	 * The Super Admin who signs automatic notices: the first active one.
	 *
	 * @return string|null
	 */
	private static function admin_id() {
		foreach ( GRP_Store::find( 'grp_members', array( 'active' => 1 ), array( 'order_by' => 'created_at' ) ) as $member ) {
			if ( GRP_Permissions::ROLE_ADMIN === GRP_Permissions::effective_role( $member ) ) {
				return (string) $member['id'];
			}
		}

		return null;
	}

	/**
	 * A private notice (kind `notice`) to some people, shown for 7 days.
	 *
	 * @param string[]    $to    Recipients.
	 * @param string|null $from  Author.
	 * @param string      $title Title.
	 * @param string      $body  Body.
	 */
	private static function notify( array $to, $from, $title, $body ) {
		GRP_Store::insert(
			'grp_posts',
			array(
				'kind'       => 'notice',
				'title'      => $title,
				'body'       => $body,
				'to_members' => $to,
				'to_member'  => $to[0] ?? null,
				'show_until' => GRP_People::add_days( GRP_Cycles::today(), 7 ),
				'pinned'     => 0,
				'created_by' => $from,
			)
		);
	}
}
