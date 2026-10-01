<?php
/**
 * REST: /trash.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Recently deleted (30 days): list, restore, delete forever. Super Admin / Team Leader.
 */
class GRP_REST_Trash extends GRP_REST_Controller {

	const TABLE = 'grp_trash';

	const KEEP_DAYS = 30;

	/**
	 * Tables a trash entry can be restored into, with their audit type.
	 */
	const RESTORABLE = array(
		'grp_meeting_tasks' => 'items',
		'grp_monthly_tasks' => 'monthly',
		'grp_projects'      => 'client',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/trash', WP_REST_Server::READABLE, 'index' );
		self::route( '/trash/(?P<id>[\w-]+)/restore', WP_REST_Server::CREATABLE, 'restore' );
		self::route( '/trash/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * Deletes entries older than 30 days.
	 */
	public static function purge() {
		foreach ( GRP_Store::find( self::TABLE, array( 'deleted_at <' => GRP_Ids::now( time() - self::KEEP_DAYS * DAY_IN_SECONDS ) ) ) as $row ) {
			GRP_Store::delete( self::TABLE, $row['id'] );
		}
	}

	/**
	 * GET /trash.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index() {
		if ( ! self::can( GRP_Permissions::MANAGE_TRASH ) ) {
			return self::forbidden();
		}

		self::purge();

		return rest_ensure_response(
			GRP_Store::find(
				self::TABLE,
				array(),
				array(
					'order_by' => 'deleted_at',
					'order'    => 'DESC',
				)
			)
		);
	}

	/**
	 * POST /trash/{id}/restore: puts the row back exactly as it was.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function restore( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_TRASH ) ) {
			return self::forbidden();
		}

		$entry = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $entry ) {
			return self::not_found();
		}
		$table = $entry['type'];
		$data  = (array) $entry['data'];
		if ( ! isset( self::RESTORABLE[ $table ] ) || empty( $data['id'] ) ) {
			return self::invalid( __( "This item can't be restored.", 'gridrankers-portal' ) );
		}
		if ( GRP_Store::get( $table, $data['id'] ) ) {
			return self::conflict( __( 'It has already been restored.', 'gridrankers-portal' ) );
		}
		if ( 'grp_projects' !== $table && ! GRP_Store::get( 'grp_projects', (string) ( $data['project_id'] ?? '' ) ) ) {
			return self::conflict( __( 'Its project was removed. Restore the project first.', 'gridrankers-portal' ), 'grp_project_missing' );
		}
		if ( 'grp_projects' === $table && GRP_Store::find( 'grp_projects', array( 'name' => (string) $data['name'] ) ) ) {
			return self::conflict( __( 'A project with that name already exists.', 'gridrankers-portal' ), 'grp_name_taken' );
		}

		$row = GRP_Store::transaction(
			static function () use ( $entry, $table, $data ) {
				unset( $data['updated_at'] );
				$row = GRP_Store::insert( $table, $data );
				GRP_Store::delete( self::TABLE, $entry['id'] );
				GRP_Activity::audit( 'restore', self::RESTORABLE[ $table ], $row, self::actor() );
				return $row;
			}
		);

		return rest_ensure_response( $row );
	}

	/**
	 * DELETE /trash/{id}: delete forever.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_TRASH ) ) {
			return self::forbidden();
		}

		$entry = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $entry ) {
			return self::not_found();
		}
		GRP_Store::delete( self::TABLE, $entry['id'] );

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $entry['id'],
			)
		);
	}
}
