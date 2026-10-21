<?php
/**
 * Leave, holidays, days off and Who's out today (SPEC.md 6.10). Pure functions, unit-tested.
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
	 * Employment types (SPEC.md 6.10, design HOL-1).
	 */
	const EMPLOYMENT = array( 'intern', 'full_time', 'part_time', 'contractual' );

	/**
	 * Employment types with leave days; interns and contractual employees have none.
	 */
	const WITH_LEAVE = array( 'full_time', 'part_time' );

	/**
	 * Leave days a full-time or part-time employee gets per calendar year (Jan 1 – Dec 31), by leave type:
	 * `day` is casual leave.
	 */
	const ALLOWANCE = array(
		'day'  => 10,
		'sick' => 14,
	);

	/**
	 * Festival holidays (event and seasonal days off) the Super Admin may set per calendar year.
	 */
	const FESTIVAL_PER_YEAR = 13;

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
	 * Whether a person has leave days: full-time and part-time employees.
	 *
	 * @param array|null $member Member row.
	 * @return bool
	 */
	public static function has_leave( $member ) {
		return in_array( (string) ( $member['employment'] ?? 'full_time' ), self::WITH_LEAVE, true );
	}

	/**
	 * Leave days of a type a person gets per calendar year: 10 casual, 14 sick for full-time and
	 * part-time employees, none for interns and contractual employees.
	 *
	 * @param array|null $member Member row.
	 * @param string     $type   `day` (casual) or `sick`.
	 * @return int
	 */
	public static function allowance( $member, $type ) {
		return self::has_leave( $member ) ? self::ALLOWANCE[ 'sick' === $type ? 'sick' : 'day' ] : 0;
	}

	/**
	 * A person's approved leave days of each type in a calendar year, in date order (`day` and
	 * `sick` => list of `Y-m-d`). Days off are not counted.
	 *
	 * @param array   $member      Member row.
	 * @param int     $year        Year.
	 * @param array[] $leaves      Leave rows (any person, any status).
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return array{day: string[], sick: string[]}
	 */
	public static function leave_dates( array $member, $year, array $leaves, $team_weekly, array $days_off ) {
		$first = sprintf( '%04d-01-01', $year );
		$last  = sprintf( '%04d-12-31', $year );
		$out   = array(
			'day'  => array(),
			'sick' => array(),
		);
		foreach ( self::approved( $leaves, $member['id'] ) as $leave ) {
			$type = 'sick' === ( $leave['type'] ?? 'day' ) ? 'sick' : 'day';
			foreach ( self::dates( max( $leave['from_date'], $first ), min( $leave['to_date'], $last ) ) as $date ) {
				if ( null === self::day_off_kind( $date, $member, $team_weekly, $days_off ) ) {
					$out[ $type ][] = $date;
				}
			}
		}
		sort( $out['day'] );
		sort( $out['sick'] );

		return $out;
	}

	/**
	 * A person's leave in a calendar year, per type: allowance, days taken, days left and days over.
	 *
	 * @param array   $member      Member row.
	 * @param int     $year        Year.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return array{day: array, sick: array} Each `{allowance, taken, left, over}`.
	 */
	public static function balance( array $member, $year, array $leaves, $team_weekly, array $days_off ) {
		$out = array();
		foreach ( self::leave_dates( $member, $year, $leaves, $team_weekly, $days_off ) as $type => $dates ) {
			$allowance    = self::allowance( $member, $type );
			$taken        = count( $dates );
			$out[ $type ] = array(
				'allowance' => $allowance,
				'taken'     => $taken,
				'left'      => max( 0, $allowance - $taken ),
				'over'      => max( 0, $taken - $allowance ),
			);
		}

		return $out;
	}

	/**
	 * A month's leave settlement (SPEC.md 6.10): leave days taken that month; the days among them
	 * past the year's allowance of their type (counted in date order) are deducted; in December
	 * the days left of both allowances are paid out.
	 *
	 * @param array   $member      Member row.
	 * @param string  $month       `YYYY-MM`.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return array `{taken, result: paid|even|deducted, paid, deducted}`.
	 */
	public static function settlement( array $member, $month, array $leaves, $team_weekly, array $days_off ) {
		$year     = (int) substr( $month, 0, 4 );
		$taken    = 0;
		$deducted = 0;
		$paid     = 0;
		foreach ( self::leave_dates( $member, $year, $leaves, $team_weekly, $days_off ) as $type => $dates ) {
			$allowance = self::allowance( $member, $type );
			foreach ( $dates as $i => $date ) {
				if ( substr( $date, 0, 7 ) === $month ) {
					++$taken;
					$deducted += $i >= $allowance ? 1 : 0;
				}
			}
			if ( '12' === substr( $month, 5, 2 ) ) {
				$paid += max( 0, $allowance - count( $dates ) );
			}
		}

		return array(
			'taken'    => $taken,
			'result'   => $deducted ? 'deducted' : ( $paid ? 'paid' : 'even' ),
			'paid'     => $paid,
			'deducted' => $deducted,
		);
	}

	/**
	 * Festival holiday days set for a calendar year: the dates of event and seasonal days off in
	 * it that are not the team's weekly day off.
	 *
	 * @param int     $year        Year.
	 * @param array[] $days_off    Whole-team days off.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @return int
	 */
	public static function festival_days( $year, array $days_off, $team_weekly ) {
		$first  = sprintf( '%04d-01-01', $year );
		$last   = sprintf( '%04d-12-31', $year );
		$weekly = self::weekly_off( null, $team_weekly );
		$dates  = array();
		foreach ( $days_off as $off ) {
			foreach ( self::dates( max( $off['from_date'], $first ), min( $off['to_date'], $last ) ) as $date ) {
				if ( ! in_array( self::weekday( $date ), $weekly, true ) ) {
					$dates[ $date ] = true;
				}
			}
		}

		return count( $dates );
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
	 * Year-end report per person: their employment, approved casual (`day`) and sick leave, their
	 * total, the days left of each allowance (paid out with December's salary), the days over
	 * (deducted) and the days off they had.
	 *
	 * @param int     $year        Year.
	 * @param array[] $members     Members.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return array[] `{member_id, employment, day, sick, total, day_left, sick_left, over, days_off}`.
	 */
	public static function year_report( $year, array $members, array $leaves, $team_weekly, array $days_off ) {
		$first = sprintf( '%04d-01-01', $year );
		$last  = sprintf( '%04d-12-31', $year );
		$rows  = array();
		foreach ( $members as $member ) {
			$balance = self::balance( $member, $year, $leaves, $team_weekly, $days_off );
			$row     = array(
				'member_id'  => $member['id'],
				'employment' => (string) ( $member['employment'] ?? 'full_time' ),
				'day'        => $balance['day']['taken'],
				'sick'       => $balance['sick']['taken'],
				'total'      => $balance['day']['taken'] + $balance['sick']['taken'],
				'day_left'   => $balance['day']['left'],
				'sick_left'  => $balance['sick']['left'],
				'over'       => $balance['day']['over'] + $balance['sick']['over'],
				'days_off'   => 0,
			);
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
