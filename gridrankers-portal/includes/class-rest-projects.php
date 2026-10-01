<?php
/**
 * REST: /projects.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Projects: list, add, rename, delete, move between Active/Paused/Inactive, set/change cycle.
 */
class GRP_REST_Projects extends GRP_REST_Controller {

	const STATES = array( 'active', 'paused', 'inactive' );

	const CYCLE_MODES = array( 'merge', 'due', 'waived' );

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/projects', WP_REST_Server::READABLE, 'index' );
		self::route( '/projects', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/projects/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
		self::route( '/projects/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/projects/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/projects/(?P<id>[\w-]+)/state', 'PATCH', 'set_state' );
		self::route( '/projects/(?P<id>[\w-]+)/cycle', WP_REST_Server::CREATABLE, 'set_cycle' );
	}

	/**
	 * GET /projects.
	 *
	 * @return WP_REST_Response
	 */
	public static function index() {
		return rest_ensure_response( GRP_Store::find( 'grp_projects', array(), array( 'order_by' => 'name' ) ) );
	}

	/**
	 * GET /projects/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );

		return $project ? rest_ensure_response( $project ) : self::not_found();
	}

	/**
	 * POST /projects `{name, cycle_day?}`. Choosing a cycle day locks it.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::ADD_PROJECT ) ) {
			return self::forbidden();
		}

		$name = self::text( $request['name'], 191 );
		if ( '' === $name ) {
			return self::invalid( __( 'Enter a project name.', 'gridrankers-portal' ) );
		}
		if ( self::name_taken( $name ) ) {
			return self::conflict( __( 'A project with that name already exists.', 'gridrankers-portal' ), 'grp_name_taken' );
		}

		$row = array(
			'name'  => $name,
			'state' => 'active',
		);
		if ( isset( $request['cycle_day'] ) && '' !== $request['cycle_day'] ) {
			$day                  = self::int( $request['cycle_day'], 1, 28, 1 );
			$row['cycle_day']     = $day;
			$row['cycle_set']     = 1;
			$row['cycle_log']     = array( self::log_entry( null, $day, 'initial' ) );
			$row['cycle_changes'] = array();
		}

		$project = GRP_Store::transaction(
			static function () use ( $row ) {
				$project = GRP_Store::insert( 'grp_projects', $row );
				GRP_Activity::audit( 'project', 'client', $project, self::actor(), 'project added' );
				// New projects start with the standard monthly tasks for this cycle.
				GRP_Standard_Tasks::ensure( $project, GRP_Cycles::today() );
				return GRP_Store::get( 'grp_projects', $project['id'] );
			}
		);

		return new WP_REST_Response( $project, 201 );
	}

	/**
	 * PATCH /projects/{id} `{name}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::EDIT_PROJECT ) ) {
			return self::forbidden();
		}

		$name = self::text( $request['name'], 191 );
		if ( '' === $name ) {
			return self::invalid( __( 'Enter a project name.', 'gridrankers-portal' ) );
		}
		if ( $name === $project['name'] ) {
			return rest_ensure_response( $project );
		}
		if ( self::name_taken( $name, $project['id'] ) ) {
			return self::conflict( __( 'A project with that name already exists.', 'gridrankers-portal' ), 'grp_name_taken' );
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $project, $name ) {
					$updated = GRP_Store::update( 'grp_projects', $project['id'], array( 'name' => $name ) );
					GRP_Activity::audit(
						'edit',
						'client',
						$updated,
						self::actor(),
						'',
						array(
							array(
								'field' => 'name',
								'label' => 'name',
								'from'  => $project['name'],
								'to'    => $name,
							),
						)
					);
					return $updated;
				}
			)
		);
	}

	/**
	 * DELETE /projects/{id}. Super Admin only. The project and its tasks go to the trash.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_PROJECT ) ) {
			return self::forbidden( __( 'Only the Super Admin can delete projects.', 'gridrankers-portal' ) );
		}

		GRP_Store::transaction(
			static function () use ( $project ) {
				foreach ( array( 'grp_meeting_tasks', 'grp_monthly_tasks' ) as $table ) {
					foreach ( GRP_Store::find( $table, array( 'project_id' => $project['id'] ) ) as $task ) {
						self::trash( $table, $task );
					}
				}
				self::trash( 'grp_projects', $project );
				GRP_Activity::audit( 'delete', 'client', $project, self::actor(), 'project deleted' );
			}
		);

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $project['id'],
			)
		);
	}

	/**
	 * PATCH /projects/{id}/state `{state}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_state( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::SET_PROJECT_STATE ) ) {
			return self::forbidden( __( 'Only a Super Admin or Team Leader can move projects.', 'gridrankers-portal' ) );
		}

		$state = (string) $request['state'];
		if ( ! in_array( $state, self::STATES, true ) ) {
			return self::invalid( __( 'Invalid project state.', 'gridrankers-portal' ) );
		}
		if ( $state === $project['state'] ) {
			return rest_ensure_response( $project );
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $project, $state ) {
					$updated = GRP_Store::update( 'grp_projects', $project['id'], array( 'state' => $state ) );
					GRP_Activity::audit( 'project', 'client', $updated, self::actor(), "moved to $state projects" );
					return $updated;
				}
			)
		);
	}

	/**
	 * POST /projects/{id}/cycle `{day, mode?, from?, reason?}`.
	 *
	 * The first choice locks the cycle day (anyone). Changing a locked cycle is Super Admin
	 * only, needs a reason and a mode (merge / due / waived) and is stored in
	 * `cycle_changes` and `cycle_log` (SPEC.md section 6.1).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_cycle( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}

		$day    = is_numeric( $request['day'] ) && (int) $request['day'] >= 1 && (int) $request['day'] <= 28 ? (int) $request['day'] : 0;
		$reason = self::textarea( $request['reason'] ?? '', 500 );
		$locked = (bool) $project['cycle_set'];

		if ( ! self::can(
			GRP_Permissions::CHANGE_PROJECT_CYCLE,
			array(
				'cycle_set' => $locked,
				'reason'    => $reason,
			)
		) ) {
			return $locked && self::can( GRP_Permissions::DELETE_PROJECT )
				? self::invalid( __( 'Add a reason for changing the cycle.', 'gridrankers-portal' ), 'grp_reason_required' )
				: self::forbidden( __( 'The cycle is locked. Only the Super Admin can change it.', 'gridrankers-portal' ) );
		}
		if ( ! $day ) {
			return self::invalid( __( 'Pick a start day between 1 and 28.', 'gridrankers-portal' ) );
		}

		if ( ! $locked ) {
			$changes = array(
				'cycle_day'     => $day,
				'cycle_set'     => 1,
				'cycle_changes' => array(),
				'cycle_log'     => array( self::log_entry( null, $day, 'initial' ) ),
			);
			$detail  = "cycle set to day $day";
		} else {
			$prev = (int) $project['cycle_day'];
			if ( $day === $prev ) {
				return self::invalid( __( 'The cycle already starts on that day.', 'gridrankers-portal' ) );
			}
			$mode = (string) $request['mode'];
			if ( ! in_array( $mode, self::CYCLE_MODES, true ) ) {
				return self::invalid( __( 'Choose how to handle the gap: merge, due or waived.', 'gridrankers-portal' ) );
			}
			$from = self::date( $request['from'] ?? '', 'start date' );
			if ( is_wp_error( $from ) ) {
				return $from;
			}
			$from = $from ? $from : GRP_Cycles::today();

			$entry   = array(
				'from'    => $from,
				'day'     => $day,
				'prevDay' => $prev,
				'mode'    => $mode,
				'reason'  => $reason,
				'by'      => self::actor()['id'],
				'at'      => gmdate( 'c' ),
			);
			$log     = self::log_entry( $prev, $day, 'admin' ) + array(
				'reason' => $reason,
				'mode'   => $mode,
				'start'  => $from,
			);
			$changes = array(
				'cycle_day'     => $day,
				'cycle_changes' => array_merge( (array) $project['cycle_changes'], array( $entry ) ),
				'cycle_log'     => array_merge( (array) $project['cycle_log'], array( $log ) ),
			);
			$detail  = "day $prev → $day from $from ($mode): $reason";
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $project, $changes, $detail ) {
					$updated = GRP_Store::update( 'grp_projects', $project['id'], $changes );
					GRP_Activity::audit( 'cycle', 'client', $updated, self::actor(), $detail );
					return $updated;
				}
			)
		);
	}

	/**
	 * A cycle_log entry.
	 *
	 * @param int|null $from Previous day.
	 * @param int      $to   New day.
	 * @param string   $by   `initial` or `admin`.
	 * @return array
	 */
	private static function log_entry( $from, $to, $by ) {
		return array(
			'from'      => $from,
			'to'        => $to,
			'at'        => gmdate( 'c' ),
			'by'        => $by,
			'by_member' => self::actor()['id'] ?? null,
		);
	}

	/**
	 * Whether another project already uses a name (case-insensitive).
	 *
	 * @param string      $name       Name.
	 * @param string|null $except_id  Project to ignore.
	 * @return bool
	 */
	private static function name_taken( $name, $except_id = null ) {
		foreach ( GRP_Store::find( 'grp_projects', array( 'name' => $name ) ) as $project ) {
			if ( $project['id'] !== $except_id ) {
				return true;
			}
		}

		return false;
	}
}
