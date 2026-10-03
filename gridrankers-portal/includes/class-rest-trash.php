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
				$row = self::put_back( $entry, $table, $data );
				// A restored project brings back the tasks that were deleted with it.
				if ( 'grp_projects' === $table ) {
					foreach ( self::tasks_deleted_with( $row['id'] ) as $task_entry ) {
						if ( ! GRP_Store::get( $task_entry['type'], (string) ( $task_entry['data']['id'] ?? '' ) ) ) {
							self::put_back( $task_entry, $task_entry['type'], (array) $task_entry['data'] );
						}
					}
				}
				return $row;
			}
		);

		return rest_ensure_response( $row );
	}

	/**
	 * Re-inserts a trashed row, removes its trash entry and logs the restore.
	 *
	 * @param array  $entry Trash entry.
	 * @param string $table Table.
	 * @param array  $data  Row.
	 * @return array Restored row.
	 */
	private static function put_back( array $entry, $table, array $data ) {
		unset( $data['updated_at'] );
		$row = GRP_Store::insert( $table, $data );
		GRP_Store::delete( self::TABLE, $entry['id'] );
		GRP_Activity::audit( 'restore', self::RESTORABLE[ $table ], $row, self::actor() );

		return $row;
	}

	/**
	 * Trash entries of the tasks deleted together with a project.
	 *
	 * @param string $project_id Project.
	 * @return array[]
	 */
	private static function tasks_deleted_with( $project_id ) {
		return array_filter(
			GRP_Store::find(
				self::TABLE,
				array(
					'project_id'   => $project_id,
					'with_project' => 1,
				)
			),
			static function ( $e ) {
				return 'grp_projects' !== $e['type'];
			}
		);
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
		GRP_Store::transaction(
			static function () use ( $entry ) {
				GRP_Store::delete( self::TABLE, $entry['id'] );
				// A project deleted forever takes every task of it still in the trash along.
				if ( 'grp_projects' === $entry['type'] && ! GRP_Store::get( 'grp_projects', $entry['doc_id'] ) ) {
					foreach ( GRP_Store::find( self::TABLE, array( 'project_id' => $entry['doc_id'] ) ) as $task_entry ) {
						GRP_Store::delete( self::TABLE, $task_entry['id'] );
					}
					// Its keyword checklist (SPEC.md 6.12) stays while the project is in the trash.
					foreach ( GRP_Store::find( 'grp_keywords', array( 'project_id' => $entry['doc_id'] ) ) as $keyword ) {
						GRP_Store::delete( 'grp_keywords', $keyword['id'] );
					}
				}
			}
		);

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $entry['id'],
			)
		);
	}
}
