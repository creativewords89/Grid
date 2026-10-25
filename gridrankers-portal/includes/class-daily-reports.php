<?php
/**
 * Daily reports: what each person did today, written by hand (SPEC.md 6.18).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pure rules of daily reports: who writes them, which day is a working day for someone, and which
 * report is missing. Every function takes "today" so it can be tested.
 */
class GRP_Daily_Reports {

	/** Option holding the day reports started (schema 17); nobody owes a report from before it. */
	const SINCE_OPTION = 'grp_reports_since';

	/** A report is due by this time of the day (site time). */
	const DUE = '19:00';

	/** The reminder band shows from this time on (site time). */
	const REMIND_FROM = '17:00';

	/** How many days back a missing report is looked for, and may still be sent late. */
	const BACK_DAYS = 14;

	/** Most entries in one report. */
	const MAX_ENTRIES = 30;

	/** Most links on one entry. */
	const MAX_LINKS = 10;

	/** Most minutes on one entry, and in one day. */
	const MAX_MINUTES = 1440;

	/** Entry projects that are not a project. */
	const OTHER_PROJECTS = array( 'office', 'other' );

	/**
	 * Schema 17: reports start today.
	 */
	public static function start() {
		if ( ! get_option( self::SINCE_OPTION ) ) {
			update_option( self::SINCE_OPTION, GRP_Cycles::today(), false );
		}
	}

	/**
	 * The day reports started.
	 *
	 * @return string `Y-m-d`.
	 */
	public static function since() {
		$since = (string) get_option( self::SINCE_OPTION, '' );

		return preg_match( '/^\d{4}-\d{2}-\d{2}$/', $since ) ? $since : GRP_Cycles::today();
	}

	/**
	 * Id of a person's report for a day.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 * @return string
	 */
	public static function row_id( $member_id, $day ) {
		return 'dr_' . md5( $member_id . '|' . $day );
	}

	/**
	 * Whether a person writes daily reports: active Team Leaders and Team Members (not the Super Admin).
	 *
	 * @param array|null $member Member row.
	 * @return bool
	 */
	public static function writes( $member ) {
		return in_array( GRP_Permissions::effective_role( $member ), array( GRP_Permissions::ROLE_LEAD, GRP_Permissions::ROLE_MEMBER ), true );
	}

	/**
	 * Why a person owes no report on a day: `leave` (approved leave), `day_off` (weekly day off or a
	 * whole-team day off), or null on a working day.
	 *
	 * @param string  $day         `Y-m-d`.
	 * @param array   $member      Member row.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return string|null
	 */
	public static function out_reason( $day, array $member, array $leaves, $team_weekly, array $days_off ) {
		foreach ( $leaves as $leave ) {
			if ( 'approved' === ( $leave['status'] ?? '' ) && (string) $leave['member_id'] === (string) $member['id'] && $day >= $leave['from_date'] && $day <= $leave['to_date'] ) {
				return 'leave';
			}
		}

		return GRP_People::day_off_kind( $day, $member, $team_weekly, $days_off ) ? 'day_off' : null;
	}

	/**
	 * The first day a person owes a report: the later of the day reports started and the day they joined.
	 *
	 * @param array  $member Member row.
	 * @param string $since  Day reports started.
	 * @return string `Y-m-d`.
	 */
	public static function first_day( array $member, $since ) {
		$joined = substr( (string) ( $member['created_at'] ?? '' ), 0, 10 );

		return preg_match( '/^\d{4}-\d{2}-\d{2}$/', $joined ) && $joined > $since ? $joined : $since;
	}

	/**
	 * The person's last working day before today (looking back at most BACK_DAYS), or null.
	 *
	 * @param array   $member      Member row.
	 * @param string  $today       `Y-m-d`.
	 * @param string  $since       Day reports started.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return string|null
	 */
	public static function last_workday( array $member, $today, $since, array $leaves, $team_weekly, array $days_off ) {
		$first = self::first_day( $member, $since );
		for ( $i = 1; $i <= self::BACK_DAYS; $i++ ) {
			$day = GRP_People::add_days( $today, -$i );
			if ( $day < $first ) {
				return null;
			}
			if ( null === self::out_reason( $day, $member, $leaves, $team_weekly, $days_off ) ) {
				return $day;
			}
		}

		return null;
	}

	/**
	 * The day whose report the person still owes (SPEC.md 6.18, design DR-D): their last working day
	 * before today when that report was never sent; null when nothing is missing.
	 *
	 * @param array      $member      Member row.
	 * @param string     $today       `Y-m-d`.
	 * @param string     $since       Day reports started.
	 * @param array[]    $leaves      Leave rows.
	 * @param mixed      $team_weekly Team weekly day off.
	 * @param array[]    $days_off    Whole-team days off.
	 * @param array|null $report      Their report for that day, if any (looked up by the caller).
	 * @return string|null
	 */
	public static function missing( array $member, $today, $since, array $leaves, $team_weekly, array $days_off, $report = false ) {
		if ( ! self::writes( $member ) ) {
			return null;
		}
		$day = self::last_workday( $member, $today, $since, $leaves, $team_weekly, $days_off );
		if ( null === $day ) {
			return null;
		}
		if ( false === $report ) {
			$report = GRP_Store::get( 'grp_daily_reports', self::row_id( $member['id'], $day ) );
		}

		return $report && ! empty( $report['sent_at'] ) ? null : $day;
	}

	/**
	 * A person's state for a day on the Team tab (design DR-B): `sent`, `late`, `leave`, `day_off`,
	 * `not_sent` (a working day with no sent report), or `none` (before they owed reports, or a day still to come).
	 *
	 * @param array      $member      Member row.
	 * @param string     $day         `Y-m-d`.
	 * @param string     $today       `Y-m-d`.
	 * @param string     $since       Day reports started.
	 * @param array|null $report      Their report for the day.
	 * @param array[]    $leaves      Leave rows.
	 * @param mixed      $team_weekly Team weekly day off.
	 * @param array[]    $days_off    Whole-team days off.
	 * @return string
	 */
	public static function state( array $member, $day, $today, $since, $report, array $leaves, $team_weekly, array $days_off ) {
		if ( $report && ! empty( $report['sent_at'] ) ) {
			return (int) $report['late'] ? 'late' : 'sent';
		}
		$out = self::out_reason( $day, $member, $leaves, $team_weekly, $days_off );
		if ( $out ) {
			return $out;
		}

		return $day > $today || $day < self::first_day( $member, $since ) ? 'none' : 'not_sent';
	}

	/**
	 * How many working days in a row, ending on `$day`, a person sent no report (design TR-G1): days
	 * off and leave are skipped, a sent report or the first day they owed one ends the run.
	 *
	 * @param array   $member      Member row.
	 * @param string  $day         `Y-m-d`.
	 * @param string  $since       Day reports started.
	 * @param array   $sent        Days (`Y-m-d` => true) they sent a report.
	 * @param array[] $leaves      Leave rows.
	 * @param mixed   $team_weekly Team weekly day off.
	 * @param array[] $days_off    Whole-team days off.
	 * @return int
	 */
	public static function missed_in_a_row( array $member, $day, $since, array $sent, array $leaves, $team_weekly, array $days_off ) {
		$first  = self::first_day( $member, $since );
		$missed = 0;
		for ( $i = 0; $i <= self::BACK_DAYS; $i++ ) {
			$d = GRP_People::add_days( $day, -$i );
			if ( $d < $first || ! empty( $sent[ $d ] ) ) {
				break;
			}
			if ( null === self::out_reason( $d, $member, $leaves, $team_weekly, $days_off ) ) {
				++$missed;
			}
		}

		return $missed;
	}

	/**
	 * Total minutes of a report's entries.
	 *
	 * @param array|null $report Report row.
	 * @return int
	 */
	public static function minutes( $report ) {
		$total = 0;
		foreach ( (array) ( $report['entries'] ?? array() ) as $entry ) {
			$total += (int) ( ( (array) $entry )['minutes'] ?? 0 );
		}

		return $total;
	}

	/**
	 * Minutes as "8h", "7h 30m" or "45m".
	 *
	 * @param int $minutes Minutes.
	 * @return string
	 */
	public static function hours( $minutes ) {
		$h = intdiv( (int) $minutes, 60 );
		$m = (int) $minutes % 60;

		return $h ? ( $m ? "{$h}h {$m}m" : "{$h}h" ) : "{$m}m";
	}
}
