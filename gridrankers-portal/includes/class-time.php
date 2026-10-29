<?php
/**
 * Time tracker maths (SPEC.md 6.21): the working day, the schedule, entry checks, overlaps, and the
 * tracked and handwritten time of a daily report. Pure functions, unit-tested.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Working days, time-entry checks and report entries made from tracked time.
 *
 * Dates are `Y-m-d`; times of day are `HH:MM` (site time zone); entry times are `Y-m-d H:i:s`
 * in UTC, as stored. Members, days off and leave rows are the ones GRP_People takes; report
 * entries are the `grp_daily_reports.entries` items (6.18) with `source` hand (default) or tracked.
 */
class GRP_Time {

	/**
	 * Option: the day the tracker started (no handwritten-hours notices for reports before it).
	 */
	const SINCE_OPTION = 'grp_time_since';

	/**
	 * Setting key of the team's start of the working day: `{start: "09:00"}`.
	 */
	const START_KEY = 'work_start';

	/**
	 * Team start of the working day when none is set.
	 */
	const DEFAULT_START = '09:00';

	/**
	 * Length of the working day until the person sets their working hours (6.19): 8 hours.
	 */
	const DEFAULT_DAY_MINUTES = 480;

	/**
	 * Longest entry: the hourly job stops a timer still running after this.
	 */
	const MAX_ENTRY_SECONDS = 12 * HOUR_IN_SECONDS;

	/**
	 * Entries may start or end this far in the future (clock differences).
	 */
	const FUTURE_GRACE_SECONDS = 120;

	/**
	 * Title of the tracked entry for time on no task.
	 */
	const NO_TASK_TITLE = 'Tracked time';

	/**
	 * Schema 24: the tracker starts today.
	 */
	public static function start() {
		if ( ! get_option( self::SINCE_OPTION ) ) {
			update_option( self::SINCE_OPTION, GRP_Cycles::today(), false );
		}
	}

	/**
	 * The day the tracker started.
	 *
	 * @return string `Y-m-d`.
	 */
	public static function since() {
		$since = (string) get_option( self::SINCE_OPTION, '' );

		return GRP_People::is_date( $since ) ? $since : GRP_Cycles::today();
	}

	/**
	 * `HH:MM` from a time of day such as `9:00` or `17:30`, or null.
	 *
	 * @param mixed $value Value.
	 * @return string|null
	 */
	public static function start_time( $value ) {
		if ( ! is_string( $value ) || ! preg_match( '/^([01]?\d|2[0-3]):([0-5]\d)$/', trim( $value ), $m ) ) {
			return null;
		}

		return sprintf( '%02d:%02d', (int) $m[1], (int) $m[2] );
	}

	/**
	 * A person's working day: the start is their own, else the team's, else 09:00; the length is their
	 * working hours from Pay (6.19), else 8 hours; the end is start + length (at most 23:59).
	 *
	 * @param array|null $member     Member row (`work_start`).
	 * @param mixed      $team_start Team start setting.
	 * @param array|null $pay        Pay row (`day_minutes`).
	 * @return array `{start, end, minutes}`.
	 */
	public static function work_day( $member, $team_start, $pay ) {
		$start   = self::start_time( $member['work_start'] ?? null ) ?? self::start_time( $team_start ) ?? self::DEFAULT_START;
		$minutes = (int) ( $pay['day_minutes'] ?? 0 );
		if ( $minutes < 1 ) {
			$minutes = self::DEFAULT_DAY_MINUTES;
		}
		$from = (int) substr( $start, 0, 2 ) * 60 + (int) substr( $start, 3, 2 );
		$to   = min( $from + $minutes, 23 * 60 + 59 );

		return array(
			'start'   => $start,
			'end'     => sprintf( '%02d:%02d', intdiv( $to, 60 ), $to % 60 ),
			'minutes' => $minutes,
		);
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
	 * @param array   $work_day    work_day().
	 * @return array `{date, working, reason: null|event|seasonal|weekly|leave, label, start, end}`.
	 */
	public static function schedule_day( $date, array $member, $team_weekly, array $days_off, array $leaves, array $work_day ) {
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
			'start'   => $work_day['start'],
			'end'     => $work_day['end'],
		);
	}

	/**
	 * A person's schedule for `$days` dates (1–62) from `$from`.
	 *
	 * @param string  $from        First date.
	 * @param int     $days        Number of dates.
	 * @param array   $member      Member row.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @param array[] $leaves      Leave rows.
	 * @param array   $work_day    work_day().
	 * @return array[] One schedule_day() per date.
	 */
	public static function schedule( $from, $days, array $member, $team_weekly, array $days_off, array $leaves, array $work_day ) {
		$days = max( 1, min( 62, (int) $days ) );
		$out  = array();
		for ( $i = 0; $i < $days; $i++ ) {
			$out[] = self::schedule_day( GRP_People::add_days( $from, $i ), $member, $team_weekly, $days_off, $leaves, $work_day );
		}

		return $out;
	}

	/**
	 * The site-time-zone day a UTC datetime falls on.
	 *
	 * @param string            $datetime `Y-m-d H:i:s` UTC.
	 * @param DateTimeZone|null $tz       Time zone (default: the site's).
	 * @return string `Y-m-d`.
	 */
	public static function day_of( $datetime, $tz = null ) {
		$date = new DateTimeImmutable( $datetime, new DateTimeZone( 'UTC' ) );

		return $date->setTimezone( $tz ? $tz : wp_timezone() )->format( 'Y-m-d' );
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
	 * Why an entry's times are not acceptable, or null when they are. A running entry (no end) only
	 * has to start before now.
	 *
	 * @param string      $started_at `Y-m-d H:i:s` UTC.
	 * @param string|null $ended_at   `Y-m-d H:i:s` UTC, or null while running.
	 * @param string      $now        `Y-m-d H:i:s` UTC.
	 * @return string|null `grp_time_invalid`, `grp_time_future`, `grp_time_order` or `grp_time_too_long`.
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
	 * Whether a person may still change their own entry: like a sent report, the same day only.
	 *
	 * @param string $day   The entry's day.
	 * @param string $today Today (site time zone).
	 * @return bool
	 */
	public static function owner_may_edit( $day, $today ) {
		return GRP_People::is_date( $day ) && $day === $today;
	}

	/**
	 * A report's entries with its tracked entries rebuilt from the day's time entries: one per task
	 * (or per project for No task), its minutes the sum of its stopped entries. Handwritten entries
	 * are kept as they are; a tracked entry keeps its id, details, files and links; a tracked entry with
	 * no time left is removed. New tracked entries come after the existing ones.
	 *
	 * @param array[] $entries      The report's entries.
	 * @param array[] $time_entries The person's time entries of that day.
	 * @param array   $titles       Task titles by key (`item:id`, `record:id`).
	 * @return array[]
	 */
	public static function with_tracked( array $entries, array $time_entries, array $titles ) {
		$groups = array();
		foreach ( $time_entries as $time ) {
			if ( ! empty( $time['deleted_at'] ) || empty( $time['ended_at'] ) ) {
				continue;
			}
			$key = self::tracked_key( $time );
			if ( ! isset( $groups[ $key ] ) ) {
				$groups[ $key ] = array(
					'seconds' => 0,
					'ids'     => array(),
					'first'   => $time,
				);
			}
			$groups[ $key ]['seconds'] += self::seconds( $time['started_at'], $time['ended_at'] );
			$groups[ $key ]['ids'][]    = (string) $time['id'];
		}

		$out = array();
		foreach ( $entries as $entry ) {
			$entry = (array) $entry;
			if ( ! self::is_tracked( $entry ) ) {
				$out[] = $entry;
				continue;
			}
			$key = self::tracked_key( $entry );
			if ( isset( $groups[ $key ] ) ) {
				$out[] = self::tracked_entry( $entry, $groups[ $key ], $titles, $key );
				unset( $groups[ $key ] );
			}
		}
		foreach ( $groups as $key => $group ) {
			$out[] = self::tracked_entry( array( 'id' => 'tr_' . md5( $key ) ), $group, $titles, $key );
		}

		return $out;
	}

	/**
	 * Tracked and handwritten minutes of a report.
	 *
	 * @param array|null $report Report row (or `{entries}`).
	 * @return array `{tracked, hand, total}`.
	 */
	public static function split( $report ) {
		$split = array(
			'tracked' => 0,
			'hand'    => 0,
		);
		foreach ( (array) ( $report['entries'] ?? array() ) as $entry ) {
			$entry = (array) $entry;
			$split[ self::is_tracked( $entry ) ? 'tracked' : 'hand' ] += max( 0, (int) ( $entry['minutes'] ?? 0 ) );
		}
		$split['total'] = $split['tracked'] + $split['hand'];

		return $split;
	}

	/**
	 * Handwritten time added between two versions of a report: handwritten entries that are new or
	 * longer. Tracked entries never count. Pass no `$before` entries when the report is first sent.
	 *
	 * @param array[] $before Entries the Super Admin was last told about (or none).
	 * @param array[] $after  Entries now.
	 * @return array `{minutes, entries: [{id, title, minutes, added}]}`.
	 */
	public static function hand_added( array $before, array $after ) {
		$was = array();
		foreach ( $before as $entry ) {
			$entry = (array) $entry;
			if ( ! self::is_tracked( $entry ) ) {
				$was[ (string) ( $entry['id'] ?? '' ) ] = (int) ( $entry['minutes'] ?? 0 );
			}
		}

		$added = array(
			'minutes' => 0,
			'entries' => array(),
		);
		foreach ( $after as $entry ) {
			$entry = (array) $entry;
			if ( self::is_tracked( $entry ) ) {
				continue;
			}
			$minutes = (int) ( $entry['minutes'] ?? 0 );
			$more    = $minutes - ( $was[ (string) ( $entry['id'] ?? '' ) ] ?? 0 );
			if ( $more > 0 ) {
				$added['minutes']  += $more;
				$added['entries'][] = array(
					'id'      => (string) ( $entry['id'] ?? '' ),
					'title'   => (string) ( $entry['title'] ?? '' ),
					'minutes' => $minutes,
					'added'   => $more,
				);
			}
		}

		return $added;
	}

	/**
	 * Whether a report entry was made from tracked time.
	 *
	 * @param array $entry Report entry.
	 * @return bool
	 */
	public static function is_tracked( array $entry ) {
		return 'tracked' === ( $entry['source'] ?? '' );
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
	 * The tracked entry a time entry (or a tracked report entry) belongs to: its task, or for No task
	 * its project (`none:` = Office).
	 *
	 * @param array $row Time entry or tracked report entry.
	 * @return string
	 */
	private static function tracked_key( array $row ) {
		$kind = (string) ( $row['ref_kind'] ?? 'none' );
		if ( in_array( $kind, array( 'item', 'record' ), true ) && '' !== (string) ( $row['ref_id'] ?? '' ) ) {
			return $kind . ':' . $row['ref_id'];
		}
		$project = (string) ( $row['project_id'] ?? $row['project'] ?? '' );

		return 'none:' . ( 'office' === $project ? '' : $project );
	}

	/**
	 * A tracked report entry for a group of time entries.
	 *
	 * @param array  $entry  The existing entry (id, details, files, links kept).
	 * @param array  $group  `{seconds, ids, first}`.
	 * @param array  $titles Task titles by key.
	 * @param string $key    tracked_key().
	 * @return array
	 */
	private static function tracked_entry( array $entry, array $group, array $titles, $key ) {
		$first   = $group['first'];
		$kind    = (string) ( $first['ref_kind'] ?? 'none' );
		$none    = 0 === strpos( $key, 'none:' );
		$project = (string) ( $first['project_id'] ?? '' );

		return array(
			'id'       => (string) $entry['id'],
			'title'    => $none ? self::NO_TASK_TITLE : (string) ( $titles[ $key ] ?? ( $entry['title'] ?? self::NO_TASK_TITLE ) ),
			'details'  => (string) ( $entry['details'] ?? '' ),
			'project'  => '' === $project ? 'office' : $project,
			'minutes'  => (int) round( $group['seconds'] / 60 ),
			'files'    => array_values( (array) ( $entry['files'] ?? array() ) ),
			'links'    => array_values( (array) ( $entry['links'] ?? array() ) ),
			'source'   => 'tracked',
			'time_ids' => $group['ids'],
			'ref_kind' => $none ? 'none' : $kind,
			'ref_id'   => $none ? '' : (string) $first['ref_id'],
		);
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
			if ( 'approved' === ( $leave['status'] ?? '' ) && (string) $leave['member_id'] === (string) $member['id'] && $date >= $leave['from_date'] && $date <= $leave['to_date'] ) {
				return true;
			}
		}

		return false;
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
