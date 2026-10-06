<?php
/**
 * Scheduled housekeeping (grp_daily) (SPEC.md sections 2 and 6.8).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers grp_daily with WP-Cron (hourly; every task is safe to repeat). A real server
 * cron should also hit wp-cron.php so it runs without visitors (see README).
 */
class GRP_Cron {

	const HOOK = 'grp_daily';

	/**
	 * Hooks the job and makes sure it is scheduled.
	 */
	public static function init() {
		add_action( self::HOOK, array( __CLASS__, 'run' ) );
		add_action( 'init', array( __CLASS__, 'schedule' ) );
	}

	/**
	 * Schedules the job if it isn't yet.
	 */
	public static function schedule() {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time() + 60, 'hourly', self::HOOK );
		}
	}

	/**
	 * Removes the schedule (deactivation).
	 */
	public static function unschedule() {
		wp_clear_scheduled_hook( self::HOOK );
	}

	/**
	 * Runs every housekeeping task. Safe to call any number of times.
	 *
	 * @param string|null $today `Y-m-d` (default: today in the site timezone).
	 * @return array Summary.
	 */
	public static function run( $today = null ) {
		global $wpdb;

		$today   = $today ? $today : GRP_Cycles::today();
		$summary = array(
			'standard_tasks' => 0,
			'trash_purged'   => 0,
			'sessions'       => 0,
			'tombstones'     => 0,
			'billing'        => 0,
		);

		foreach ( GRP_Store::find( 'grp_projects' ) as $project ) {
			$summary['standard_tasks'] += GRP_Standard_Tasks::ensure( $project, $today );
		}

		$summary['billing'] = GRP_Billing::ensure( $today );

		$before = count( GRP_Store::find( 'grp_trash' ) );
		GRP_REST_Trash::purge();
		$summary['trash_purged'] = $before - count( GRP_Store::find( 'grp_trash' ) );

		$summary['sessions'] = (int) $wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'DELETE FROM %i WHERE expires_at <= %s', GRP_Install::table( 'grp_sessions' ), GRP_Ids::now() )
		);

		// Clients that haven't synced for 60 days do a full sync anyway.
		$summary['tombstones'] = (int) $wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'DELETE FROM %i WHERE deleted_at < %s', GRP_Install::table( 'grp_deletions' ), GRP_Ids::now( time() - 60 * DAY_IN_SECONDS ) )
		);

		return $summary;
	}
}
