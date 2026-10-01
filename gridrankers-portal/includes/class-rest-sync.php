<?php
/**
 * REST: /sync.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Live updates: rows changed since a cursor, plus deletions (SPEC.md section 2).
 *
 * The client polls every 10 s with the `cursor` from its previous response. Rows are
 * returned when `updated_at >= since`, so a row can arrive twice (clients upsert by id)
 * but is never missed. When `more` is true the client asks again with the same `since`
 * and `page + 1`, then continues with the first response's cursor.
 */
class GRP_REST_Sync extends GRP_REST_Controller {

	const PER_PAGE = 1000;

	/**
	 * Synced tables and their response keys.
	 */
	const TABLES = array(
		'grp_projects'      => 'projects',
		'grp_meeting_tasks' => 'meeting_tasks',
		'grp_monthly_tasks' => 'monthly_tasks',
		'grp_cycle_records' => 'records',
		'grp_members'       => 'members',
		'grp_activity'      => 'activity',
		'grp_trash'         => 'trash',
		'grp_dismissals'    => 'dismissals',
		'grp_settings'      => 'settings',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/sync', WP_REST_Server::READABLE, 'sync' );
	}

	/**
	 * GET /sync `?since=&page=`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function sync( WP_REST_Request $request ) {
		$cursor = GRP_Ids::now();
		$since  = trim( (string) ( $request['since'] ?? '' ) );
		if ( '' !== $since && ! preg_match( '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $since ) ) {
			return self::invalid( __( 'Invalid sync cursor.', 'gridrankers-portal' ) );
		}
		$page    = max( 0, (int) $request['page'] );
		$actor   = self::actor();
		$manager = self::is_manager();

		$changes = array();
		$more    = false;
		foreach ( self::TABLES as $table => $key ) {
			$where = '' !== $since ? array( 'updated_at >=' => $since ) : array();

			if ( 'grp_trash' === $table && ! $manager ) {
				$changes[ $key ] = array();
				continue;
			}
			if ( ( 'grp_activity' === $table && ! $manager ) || 'grp_dismissals' === $table ) {
				$where['member_id'] = $actor['id'];
			}

			$rows = GRP_Store::find(
				$table,
				$where,
				array(
					'order_by' => 'updated_at',
					'limit'    => self::PER_PAGE,
					'offset'   => self::PER_PAGE * $page,
				)
			);
			if ( count( $rows ) === self::PER_PAGE ) {
				$more = true;
			}
			if ( 'grp_members' === $table ) {
				$rows = array_map( array( 'GRP_REST_Members', 'visible' ), $rows );
			}
			$changes[ $key ] = $rows;
		}

		$deletions = array();
		if ( '' !== $since && 0 === $page ) {
			foreach ( GRP_Store::find( 'grp_deletions', array( 'updated_at >=' => $since ), array( 'order_by' => 'updated_at' ) ) as $row ) {
				if ( isset( self::TABLES[ $row['table_name'] ] ) ) {
					$deletions[] = array(
						'table' => self::TABLES[ $row['table_name'] ],
						'id'    => $row['doc_id'],
					);
				}
			}
		}

		$response = rest_ensure_response(
			array(
				'cursor'    => $cursor,
				'since'     => $since,
				'page'      => $page,
				'more'      => $more,
				'changes'   => $changes,
				'deletions' => $deletions,
			)
		);
		$response->header( 'Cache-Control', 'no-store' );

		return $response;
	}
}
