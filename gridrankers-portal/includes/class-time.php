<?php
/**
 * Time tracker maths (SPEC.md 6.15): work hours, the schedule, entry length and overlaps.
 * Pure functions, unit-tested.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Work hours, working days and time-entry checks.
 *
 * Dates are `Y-m-d`; times of day are `HH:MM` (site time zone); entry times are
 * `Y-m-d H:i:s` in UTC, as stored. Members, days off and leave rows are the ones
 * GRP_People takes.
 */
class GRP_Time {

	/**
	 * Team work hours when none are set.
	 */
	const DEFAULT_WORK_HOURS = array(
		'start' => '09:00',
		'end'   => '17:00',
	);

	/**
	 * Longest entry: the hourly job stops a timer still running after this.
	 */
	const MAX_ENTRY_SECONDS = 12 * HOUR_IN_SECONDS;

	/**
	 * Team Members edit their own entries started this many days ago at most.
	 */
	const OWNER_EDIT_DAYS = 7;

	/**
	 * Entries may end this far in the future (clock differences).
	 */
	const FUTURE_GRACE_SECONDS = 120;

	/**
	 * Days the schedule covers by default.
	 */
	const SCHEDULE_DAYS = 14;

	/**
	 * Clean work hours `{start, end}`, or null when the value holds none (start must be before end).
	 *
	 * @param mixed $value Work hours (array or JSON).
	 * @return array|null
	 */
	public static function work_hours( $value ) {
		if ( is_string( $value ) ) {
			$value = json_decode( $value, true );
		}
		if ( ! is_array( $value ) ) {
			return null;
		}
		$start = self::time_of_day( $value['start'] ?? null );
		$end   = self::time_of_day( $value['end'] ?? null );
		if ( null === $start || null === $end || $start >= $end ) {
			return null;
		}

		return array(
			'start' => $start,
			'end'   => $end,
		);
	}

	/**
	 * A person's work hours: their own, else the team's, else 09:00–17:00.
	 *
	 * @param array|null $member     Member row.
	 * @param mixed      $team_hours Team work hours setting.
	 * @return array `{start, end}`.
	 */
	public static function hours_for( $member, $team_hours ) {
		return self::work_hours( $member['work_hours'] ?? null )
			?? self::work_hours( $team_hours )
			?? self::DEFAULT_WORK_HOURS;
	}

	/**
	 * Whether a date is a working day for a person, and why not.
	 *
	 * Order: a team event or seasonal day off (its name), the weekly day off (the weekday's name),
	 * approved leave ("Leave", never its type or reason). Pending leave is a working day.
	 *
	 * @param string  $date        `Y-m-d`.
	 * @param array   $member      Member row.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off (`kind`, `name`, `from_date`, `to_date`).
	 * @param array[] $leaves      Leave rows (any person, any status).
	 * @param mixed   $team_hours  Team work hours setting.
	 * @return array `{date, working, reason: null|event|seasonal|weekly|leave, label, start, end}`.
	 */
	public static function schedule_day( $date, array $member, $team_weekly, array $days_off, array $leaves, $team_hours ) {
		$hours  = self::hours_for( $member, $team_hours );
		$reason = null;
		$label  = '';

		foreach ( $days_off as $off ) {
			if ( $date >= $off['from_date'] && $date <= $off['to_date'] ) {
				$reason = 'seasonal' === ( $off['kind'] ?? '' ) ? 'seasonal' : 'event';
				$label  = (string) ( $off['name'] ?? '' );
				break;
			}
		}
		if ( null === $reason && 'weekly' === GRP_People::day_off_kind( $date, $member, $team_weekly, array() ) ) {
			$reason = 'weekly';
			$label  = gmdate( 'l', strtotime( $date . ' UTC' ) );
		}
		if ( null === $reason && self::on_leave( $date, $member, $leaves ) ) {
			$reason = 'leave';
			$label  = 'Leave';
		}

		return array(
			'date'    => $date,
			'working' => null === $reason,
			'reason'  => $reason,
			'label'   => $label,
			'start'   => $hours['start'],
			'end'     => $hours['end'],
		);
	}

	/**
	 * A person's schedule for `$days` dates from `$from`.
	 *
	 * @param string  $from        First date.
	 * @param int     $days        Number of dates (1–62).
	 * @param array   $member      Member row.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_hours  Team work hours setting.
	 * @return array[] One schedule_day() per date.
	 */
	public static function schedule( $from, $days, array $member, $team_weekly, array $days_off, array $leaves, $team_hours ) {
		$days = max( 1, min( 62, (int) $days ) );
		$out  = array();
		for ( $i = 0; $i < $days; $i++ ) {
			$out[] = self::schedule_day( GRP_People::add_days( $from, $i ), $member, $team_weekly, $days_off, $leaves, $team_hours );
		}

		return $out;
	}

	/**
	 * Seconds between two UTC datetimes (never negative).
	 *
	 * @param string $started_at `Y-m-d H:i:s`.
	 * @param string $ended_at   `Y-m-d H:i:s`.
	 * @return int
	 */
	public static function seconds( $started_at, $ended_at ) {
		return max( 0, self::ts( $ended_at ) - self::ts( $started_at ) );
	}

	/**
	 * Why an entry's times are not acceptable, or null when they are.
	 *
	 * Running entries (no end) are checked against `$now` for the 12-hour limit only when stopped,
	 * so they pass here as long as they did not start in the future.
	 *
	 * @param string      $started_at `Y-m-d H:i:s` UTC.
	 * @param string|null $ended_at   `Y-m-d H:i:s` UTC, or null while running.
	 * @param string      $now        `Y-m-d H:i:s` UTC.
	 * @return string|null `grp_time_invalid`, `grp_time_order`, `grp_time_too_long`, `grp_time_future`.
	 */
	public static function invalid_times( $started_at, $ended_at, $now ) {
		if ( ! self::is_datetime( $started_at ) || ( null !== $ended_at && ! self::is_datetime( $ended_at ) ) ) {
			return 'grp_time_invalid';
		}
		$limit = self::ts( $now ) + self::FUTURE_GRACE_SECONDS;
		if ( self::ts( $started_at ) > $limit || ( null !== $ended_at && self::ts( $ended_at ) > $limit ) ) {
			return 'grp_time_future';
		}
		if ( null === $ended_at ) {
			return null;
		}
		if ( self::ts( $ended_at ) <= self::ts( $started_at ) ) {
			return 'grp_time_order';
		}
		if ( self::seconds( $started_at, $ended_at ) > self::MAX_ENTRY_SECONDS ) {
			return 'grp_time_too_long';
		}

		return null;
	}

	/**
	 * Ids of a person's entries that overlap `$entry`. Touching ends do not overlap; a running entry
	 * lasts until `$now`; deleted entries and the entry itself are ignored.
	 *
	 * @param array   $entry   `{id?, member_id, started_at, ended_at|null}`.
	 * @param array[] $entries Other entries (any person).
	 * @param string  $now     `Y-m-d H:i:s` UTC.
	 * @return string[]
	 */
	public static function overlapping( array $entry, array $entries, $now ) {
		$start = self::ts( $entry['started_at'] );
		$end   = self::ts( $entry['ended_at'] ?? $now );
		$ids   = array();
		foreach ( $entries as $other ) {
			if ( (string) $other['member_id'] !== (string) $entry['member_id'] || ! empty( $other['deleted_at'] ) ) {
				continue;
			}
			if ( isset( $entry['id'] ) && (string) $other['id'] === (string) $entry['id'] ) {
				continue;
			}
			if ( $start < self::ts( $other['ended_at'] ?? $now ) && $end > self::ts( $other['started_at'] ) ) {
				$ids[] = (string) $other['id'];
			}
		}

		return $ids;
	}

	/**
	 * Whether a Team Member may still edit their own entry: started in the last 7 days.
	 *
	 * @param string $started_at `Y-m-d H:i:s` UTC.
	 * @param string $now        `Y-m-d H:i:s` UTC.
	 * @return bool
	 */
	public static function owner_may_edit( $started_at, $now ) {
		return self::is_datetime( $started_at ) && self::ts( $started_at ) >= self::ts( $now ) - self::OWNER_EDIT_DAYS * DAY_IN_SECONDS;
	}

	/**
	 * Whether a value is a real `Y-m-d H:i:s` datetime.
	 *
	 * @param mixed $value Value.
	 * @return bool
	 */
	public static function is_datetime( $value ) {
		return is_string( $value )
			&& preg_match( '/^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/', $value, $m )
			&& GRP_People::is_date( $m[1] );
	}

	/**
	 * Whether a person has approved leave on a date.
	 *
	 * @param string  $date   `Y-m-d`.
	 * @param array   $member Member row.
	 * @param array[] $leaves Leave rows.
	 * @return bool
	 */
	private static function on_leave( $date, array $member, array $leaves ) {
		foreach ( $leaves as $leave ) {
			if ( 'approved' === $leave['status'] && (string) $leave['member_id'] === (string) $member['id'] && $date >= $leave['from_date'] && $date <= $leave['to_date'] ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * `HH:MM` from a time of day, or null.
	 *
	 * @param mixed $value Value such as `9:00` or `17:30`.
	 * @return string|null
	 */
	private static function time_of_day( $value ) {
		if ( ! is_string( $value ) || ! preg_match( '/^([01]?\d|2[0-3]):([0-5]\d)$/', trim( $value ), $m ) ) {
			return null;
		}

		return sprintf( '%02d:%02d', (int) $m[1], (int) $m[2] );
	}

	/**
	 * Unix time of a UTC datetime.
	 *
	 * @param string $datetime `Y-m-d H:i:s`.
	 * @return int
	 */
	private static function ts( $datetime ) {
		return (int) strtotime( $datetime . ' UTC' );
	}
}
