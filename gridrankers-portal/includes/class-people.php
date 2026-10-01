<?php
/**
 * Leave, days off and Who's out today (SPEC.md 6.10). Pure functions, unit-tested.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Day-off and leave maths.
 *
 * Dates are `Y-m-d` strings; weekdays are 0 (Sunday) – 6 (Saturday). `$days_off` are
 * `grp_days_off` rows (`from_date`, `to_date`, `kind`); `$leaves` are `grp_leave` rows;
 * members need `id` and `weekly_off` (null = the team's weekly day off).
 */
class GRP_People {

	/**
	 * Team weekly day off when none is set: Friday.
	 */
	const DEFAULT_WEEKLY_OFF = array( 5 );

	/**
	 * Leave days everyone (but the Super Admin) gets per calendar month.
	 */
	const LEAVE_PER_MONTH = 1;

	/**
	 * Leave may start this many days in the past (e.g. sick leave told afterwards).
	 */
	const PAST_DAYS = 30;

	/**
	 * Clean list of weekdays (0–6), or null when the value holds none.
	 *
	 * @param mixed $value Weekdays (array or JSON).
	 * @return int[]|null
	 */
	public static function weekdays( $value ) {
		if ( is_string( $value ) ) {
			$value = json_decode( $value, true );
		}
		if ( ! is_array( $value ) ) {
			return null;
		}
		$days = array();
		foreach ( $value as $day ) {
			if ( is_numeric( $day ) && (int) $day >= 0 && (int) $day <= 6 ) {
				$days[ (int) $day ] = (int) $day;
			}
		}
		sort( $days );

		return array_values( $days );
	}

	/**
	 * A person's weekly day off: their own, else the team's.
	 *
	 * @param array|null $member      Member row.
	 * @param mixed      $team_weekly Team weekly day off.
	 * @return int[]
	 */
	public static function weekly_off( $member, $team_weekly ) {
		$own = self::weekdays( $member['weekly_off'] ?? null );
		if ( null !== $own ) {
			return $own;
		}
		$team = self::weekdays( $team_weekly );

		return null === $team ? self::DEFAULT_WEEKLY_OFF : $team;
	}

	/**
	 * Why a date is a person's day off: `weekly`, `event`, `seasonal`, or null when it is a working day.
	 *
	 * @param string     $date        `Y-m-d`.
	 * @param array|null $member      Member row.
	 * @param mixed      $team_weekly Team weekly day off.
	 * @param array[]    $days_off    Whole-team days off.
	 * @return string|null
	 */
	public static function day_off_kind( $date, $member, $team_weekly, array $days_off ) {
		foreach ( $days_off as $off ) {
			if ( $date >= $off['from_date'] && $date <= $off['to_date'] ) {
				return 'seasonal' === ( $off['kind'] ?? '' ) ? 'seasonal' : 'event';
			}
		}

		return in_array( self::weekday( $date ), self::weekly_off( $member, $team_weekly ), true ) ? 'weekly' : null;
	}

	/**
	 * Leave days in a range, per calendar month (`YYYY-MM` => days). Days off are not counted.
	 *
	 * @param string     $from        First date.
	 * @param string     $to          Last date.
	 * @param array|null $member      Member row.
	 * @param mixed      $team_weekly Team weekly day off.
	 * @param array[]    $days_off    Whole-team days off.
	 * @return array<string, int>
	 */
	public static function leave_days( $from, $to, $member, $team_weekly, array $days_off ) {
		$months = array();
		foreach ( self::dates( $from, $to ) as $date ) {
			if ( null === self::day_off_kind( $date, $member, $team_weekly, $days_off ) ) {
				$month            = substr( $date, 0, 7 );
				$months[ $month ] = ( $months[ $month ] ?? 0 ) + 1;
			}
		}

		return $months;
	}

	/**
	 * Approved leave days a person took in a calendar month.
	 *
	 * @param array   $member      Member row.
	 * @param string  $month       `YYYY-MM`.
	 * @param array[] $leaves      Leave rows (any person, any status).
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return int
	 */
	public static function taken_in_month( array $member, $month, array $leaves, $team_weekly, array $days_off ) {
		$taken = 0;
		foreach ( self::approved( $leaves, $member['id'] ) as $leave ) {
			if ( substr( $leave['from_date'], 0, 7 ) <= $month && substr( $leave['to_date'], 0, 7 ) >= $month ) {
				$taken += self::leave_days( $leave['from_date'], $leave['to_date'], $member, $team_weekly, $days_off )[ $month ] ?? 0;
			}
		}

		return $taken;
	}

	/**
	 * Leave days left in a month (never below 0).
	 *
	 * @param int $taken Days taken that month.
	 * @return int
	 */
	public static function days_left( $taken ) {
		return max( 0, self::LEAVE_PER_MONTH - (int) $taken );
	}

	/**
	 * Month-end settlement: 0 taken → 1 day paid; 1 → even; more → taken − 1 deducted.
	 *
	 * @param int $taken Days taken that month.
	 * @return array `{taken, result: paid|even|deducted, paid, deducted}`.
	 */
	public static function settlement( $taken ) {
		$taken    = max( 0, (int) $taken );
		$paid     = self::days_left( $taken );
		$deducted = max( 0, $taken - self::LEAVE_PER_MONTH );

		return array(
			'taken'    => $taken,
			'result'   => $paid ? 'paid' : ( $deducted ? 'deducted' : 'even' ),
			'paid'     => $paid,
			'deducted' => $deducted,
		);
	}

	/**
	 * Whether a range overlaps a person's pending or approved leave.
	 *
	 * @param string      $member_id Person.
	 * @param string      $from      First date.
	 * @param string      $to        Last date.
	 * @param array[]     $leaves    Leave rows.
	 * @param string|null $except_id Leave being edited.
	 * @return bool
	 */
	public static function overlaps( $member_id, $from, $to, array $leaves, $except_id = null ) {
		foreach ( $leaves as $leave ) {
			if ( (string) $leave['member_id'] !== (string) $member_id || ( null !== $except_id && $leave['id'] === $except_id ) ) {
				continue;
			}
			if ( in_array( $leave['status'], array( 'pending', 'approved' ), true ) && $from <= $leave['to_date'] && $to >= $leave['from_date'] ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Everyone but `$except_id` who is out on `$date`: a day off or approved leave.
	 *
	 * @param string      $date        `Y-m-d`.
	 * @param array[]     $members     Active members.
	 * @param array[]     $leaves      Leave rows.
	 * @param mixed       $team_weekly Team weekly day off.
	 * @param array[]     $days_off    Whole-team days off.
	 * @param string|null $except_id   The viewer.
	 * @return array[] `{member_id, why: day_off|leave, back}` (back = next date neither).
	 */
	public static function whos_out( $date, array $members, array $leaves, $team_weekly, array $days_off, $except_id = null ) {
		$out = array();
		foreach ( $members as $member ) {
			if ( (string) $member['id'] === (string) $except_id ) {
				continue;
			}
			$why = self::why_out( $date, $member, $leaves, $team_weekly, $days_off );
			if ( ! $why ) {
				continue;
			}
			$back = self::add_days( $date, 1 );
			for ( $i = 0; $i < 366; $i++ ) {
				if ( ! self::why_out( $back, $member, $leaves, $team_weekly, $days_off ) ) {
					break;
				}
				$back = self::add_days( $back, 1 );
			}
			$out[] = array(
				'member_id' => $member['id'],
				'why'       => $why,
				'back'      => $back,
			);
		}

		return $out;
	}

	/**
	 * Year-end counts per person: approved day leave, sick leave, their total, and the days off they had.
	 *
	 * @param int     $year        Year.
	 * @param array[] $members     Members.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return array[] `{member_id, day, sick, total, days_off}`.
	 */
	public static function year_report( $year, array $members, array $leaves, $team_weekly, array $days_off ) {
		$first = sprintf( '%04d-01-01', $year );
		$last  = sprintf( '%04d-12-31', $year );
		$rows  = array();
		foreach ( $members as $member ) {
			$row = array(
				'member_id' => $member['id'],
				'day'       => 0,
				'sick'      => 0,
				'total'     => 0,
				'days_off'  => 0,
			);
			foreach ( self::approved( $leaves, $member['id'] ) as $leave ) {
				$from = max( $leave['from_date'], $first );
				$to   = min( $leave['to_date'], $last );
				if ( $from <= $to ) {
					$type          = 'sick' === $leave['type'] ? 'sick' : 'day';
					$row[ $type ] += array_sum( self::leave_days( $from, $to, $member, $team_weekly, $days_off ) );
				}
			}
			$row['total'] = $row['day'] + $row['sick'];
			foreach ( self::dates( $first, $last ) as $date ) {
				if ( self::day_off_kind( $date, $member, $team_weekly, $days_off ) ) {
					++$row['days_off'];
				}
			}
			$rows[] = $row;
		}

		return $rows;
	}

	/**
	 * Whether a `Y-m-d` string is a real date.
	 *
	 * @param mixed $date Value.
	 * @return bool
	 */
	public static function is_date( $date ) {
		return is_string( $date ) && preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m ) && checkdate( (int) $m[2], (int) $m[3], (int) $m[1] );
	}

	/**
	 * Adds days to a date.
	 *
	 * @param string $date `Y-m-d`.
	 * @param int    $days Days (may be negative).
	 * @return string
	 */
	public static function add_days( $date, $days ) {
		return gmdate( 'Y-m-d', strtotime( $date . ' UTC' ) + (int) $days * DAY_IN_SECONDS );
	}

	/**
	 * Why a person is out on a date: `leave`, `day_off`, or null.
	 *
	 * @param string  $date        `Y-m-d`.
	 * @param array   $member      Member row.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return string|null
	 */
	private static function why_out( $date, array $member, array $leaves, $team_weekly, array $days_off ) {
		foreach ( self::approved( $leaves, $member['id'] ) as $leave ) {
			if ( $date >= $leave['from_date'] && $date <= $leave['to_date'] ) {
				return 'leave';
			}
		}

		return self::day_off_kind( $date, $member, $team_weekly, $days_off ) ? 'day_off' : null;
	}

	/**
	 * A person's approved leave.
	 *
	 * @param array[] $leaves    Leave rows.
	 * @param string  $member_id Person.
	 * @return array[]
	 */
	private static function approved( array $leaves, $member_id ) {
		return array_filter(
			$leaves,
			static function ( $leave ) use ( $member_id ) {
				return 'approved' === $leave['status'] && (string) $leave['member_id'] === (string) $member_id;
			}
		);
	}

	/**
	 * Every date from `$from` to `$to`, inclusive.
	 *
	 * @param string $from First date.
	 * @param string $to   Last date.
	 * @return string[]
	 */
	private static function dates( $from, $to ) {
		$dates = array();
		for ( $date = $from; $date <= $to; $date = self::add_days( $date, 1 ) ) {
			$dates[] = $date;
		}

		return $dates;
	}

	/**
	 * Weekday of a date, 0 (Sunday) – 6 (Saturday).
	 *
	 * @param string $date `Y-m-d`.
	 * @return int
	 */
	private static function weekday( $date ) {
		return (int) gmdate( 'w', strtotime( $date . ' UTC' ) );
	}
}
