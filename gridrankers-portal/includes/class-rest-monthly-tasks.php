<?php
/**
 * REST: /monthly-tasks.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Recurring (monthly / weekly) tasks: CRUD with deadlines and breakdowns (SPEC.md 6.4, 6.5).
 * Progress lives in cycle records (GRP_REST_Records).
 */
class GRP_REST_Monthly_Tasks extends GRP_REST_Controller {

	const TABLE = 'grp_monthly_tasks';

	const DUE_MODES = array( 'none', 'weekly', 'biweekly', 'date', 'dates', 'monthly' );

	const FIELD_LABELS = array(
		'project_id'   => 'project',
		'title'        => 'title',
		'notes'        => 'notes',
		'freq'         => 'how often',
		'due_mode'     => 'deadline',
		'due_day'      => 'due day',
		'due_from_day' => 'from day',
		'target'       => 'quantity',
		'parts'        => 'breakdown',
		'assignees'    => 'responsible',
		'steps'        => 'steps',
		'files'        => 'files',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/monthly-tasks', WP_REST_Server::READABLE, 'index' );
		self::route( '/monthly-tasks', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/monthly-tasks/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
		self::route( '/monthly-tasks/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/monthly-tasks/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * GET /monthly-tasks `?project=`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function index( WP_REST_Request $request ) {
		$where = $request['project'] ? array( 'project_id' => (string) $request['project'] ) : array();

		return rest_ensure_response( GRP_Store::find( self::TABLE, $where, array( 'order_by' => 'created_at' ) ) );
	}

	/**
	 * GET /monthly-tasks/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );

		return $task ? rest_ensure_response( $task ) : self::not_found();
	}

	/**
	 * POST /monthly-tasks.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::ADD_TASK ) ) {
			return self::forbidden();
		}

		$fields = self::fields( $request, null );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}

		$task = GRP_Store::transaction(
			static function () use ( $fields ) {
				$task = GRP_Store::insert( self::TABLE, $fields + array( 'created_by' => self::actor()['id'] ) );
				GRP_Activity::audit( 'add', 'monthly', $task, self::actor(), self::freq_text( $task ) );
				return $task;
			}
		);

		return new WP_REST_Response( $task, 201 );
	}

	/**
	 * PATCH /monthly-tasks/{id}. Super Admin / Team Leader only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::EDIT_TASK ) ) {
			return self::forbidden( __( "Tasks can only be changed by a Super Admin or Team Leader once they're added.", 'gridrankers-portal' ) );
		}

		$fields = self::fields( $request, $task );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $fields ) {
					$updated = GRP_Store::update( self::TABLE, $task['id'], $fields );
					$changes = self::diff( $task, $updated, self::FIELD_LABELS );
					if ( $changes ) {
						GRP_Activity::audit( 'edit', 'monthly', $updated, self::actor(), '', $changes );
					}
					return $updated;
				}
			)
		);
	}

	/**
	 * DELETE /monthly-tasks/{id}: soft delete into the trash.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_TASK ) ) {
			return self::forbidden( __( 'Only a Super Admin or Team Leader can delete tasks.', 'gridrankers-portal' ) );
		}

		$trash = GRP_Store::transaction(
			static function () use ( $task ) {
				$trash = self::trash( self::TABLE, $task );
				GRP_Activity::audit( 'delete', 'monthly', $task, self::actor() );
				return $trash;
			}
		);

		return rest_ensure_response(
			array(
				'deleted'  => true,
				'id'       => $task['id'],
				'trash_id' => $trash['id'],
				'trash'    => $trash,
			)
		);
	}

	/**
	 * Validated fields. On update, a field is changed only when present; quantity,
	 * breakdown and responsible people are always recomputed together.
	 *
	 * @param WP_REST_Request $request Request.
	 * @param array|null      $task    Existing task on update.
	 * @return array|WP_Error
	 */
	private static function fields( WP_REST_Request $request, $task ) {
		$creating = null === $task;
		$has      = static function ( $key ) use ( $request, $creating ) {
			return $creating || null !== $request->get_param( $key );
		};
		$out      = array();

		if ( $has( 'project_id' ) ) {
			$project = GRP_Store::get( 'grp_projects', (string) $request['project_id'] );
			if ( ! $project ) {
				return self::invalid( __( 'Pick a project.', 'gridrankers-portal' ) );
			}
			$out['project_id'] = $project['id'];
		}
		if ( $has( 'title' ) ) {
			$out['title'] = self::text( $request['title'], 200 );
			if ( '' === $out['title'] ) {
				return self::invalid( __( 'Name the task.', 'gridrankers-portal' ) );
			}
		}
		if ( $has( 'notes' ) ) {
			$out['notes'] = self::textarea( $request['notes'] );
		}
		// Files added with the task (SPEC.md 6.17): the brief, screenshots, the client's documents.
		if ( null !== $request->get_param( 'files' ) ) {
			$files = self::attached_files( $request['files'] );
			if ( is_wp_error( $files ) ) {
				return $files;
			}
			$out['files'] = $files;
		}

		if ( $has( 'due_mode' ) ) {
			$due = self::due( $request );
			if ( is_wp_error( $due ) ) {
				return $due;
			}
			$out += $due;
		}

		// Steps in order (SPEC.md 6.16) instead of a breakdown: their people share the whole task.
		if ( $has( 'steps' ) ) {
			$steps = GRP_Steps::clean( $request['steps'], 'day' );
			if ( is_wp_error( $steps ) ) {
				return $steps;
			}
			$out['steps'] = $steps;
		}
		$steps = array_key_exists( 'steps', $out ) ? $out['steps'] : ( $task['steps'] ?? null );
		if ( $steps ) {
			if ( ! empty( $request['parts'] ) ) {
				return self::invalid( __( 'Use steps or a breakdown, not both.', 'gridrankers-portal' ) );
			}
			$target = self::int( $has( 'target' ) ? $request['target'] : ( $task['target'] ?? 1 ), 1, 99, 1 );
			// The last step's day is the task's deadline in each cycle (SPEC.md 6.16).
			if ( GRP_Steps::last_due( $steps ) && ! GRP_Cycles::is_weekly( $out + (array) $task ) && ! GRP_Cycles::is_biweekly( $out + (array) $task ) ) {
				$out['due_mode']     = 'date';
				$out['due_day']      = (int) GRP_Steps::last_due( $steps );
				$out['due_from_day'] = null;
			}
			return $out + array(
				'target'    => $target,
				'parts'     => null,
				'team'      => 1,
				'assignees' => GRP_Steps::assignees( $steps, $target ),
			);
		}

		if ( $has( 'target' ) || $has( 'parts' ) || $has( 'assignees' ) || $has( 'team' ) ) {
			$work = self::work(
				$has( 'target' ) ? $request['target'] : ( $task['target'] ?? 1 ),
				$has( 'parts' ) ? $request['parts'] : ( $task['parts'] ?? array() ),
				$has( 'assignees' ) ? $request['assignees'] : ( $task['assignees'] ?? array() ),
				null !== $request->get_param( 'team' ) ? (bool) $request['team'] : (bool) ( $task['team'] ?? true )
			);
			if ( is_wp_error( $work ) ) {
				return $work;
			}
			// Every monthly task has someone responsible (SPEC.md 6.11): none is added, or
			// emptied, without people. The system's standard tasks are added another way.
			if ( ! $work['assignees'] ) {
				return self::invalid( __( 'A monthly task needs at least one person responsible.', 'gridrankers-portal' ), 'grp_people_required' );
			}
			$out += $work;
		}

		return $out;
	}

	/**
	 * "4× per cycle", "every two weeks", "weekly"... for the audit log.
	 *
	 * @param array $task Task.
	 * @return string
	 */
	private static function freq_text( array $task ) {
		$per  = array(
			'weekly'   => 'per week',
			'biweekly' => 'per 2 weeks',
			'monthly'  => 'per cycle',
		);
		$how  = array(
			'weekly'   => 'weekly',
			'biweekly' => 'every two weeks',
			'monthly'  => 'monthly',
		);
		$freq = $task['freq'] ?? 'monthly';

		return (int) $task['target'] > 1 ? $task['target'] . '× ' . ( $per[ $freq ] ?? 'per cycle' ) : ( $how[ $freq ] ?? $freq );
	}

	/**
	 * Deadline mode and days (SPEC.md 6.4). Weekly / bi-weekly mode makes the task repeat
	 * every week / every two weeks of the cycle.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	private static function due( WP_REST_Request $request ) {
		$mode = $request['due_mode'] ? (string) $request['due_mode'] : 'monthly';
		if ( ! in_array( $mode, self::DUE_MODES, true ) ) {
			return self::invalid( __( 'Invalid deadline.', 'gridrankers-portal' ) );
		}

		$out = array(
			'due_mode'     => $mode,
			'freq'         => in_array( $mode, array( 'weekly', 'biweekly' ), true ) ? $mode : 'monthly',
			'due_day'      => null,
			'due_from_day' => null,
		);

		if ( 'date' === $mode ) {
			$day = self::int( $request['due_day'], 1, 31, 0 );
			if ( ! $day ) {
				return self::invalid( __( 'Pick the day of the cycle it is due.', 'gridrankers-portal' ) );
			}
			$out['due_day'] = $day;
		}
		if ( 'dates' === $mode ) {
			$from = self::int( $request['due_from_day'], 1, 31, 0 );
			$to   = self::int( $request['due_day'], 1, 31, 0 );
			if ( ! $from || ! $to ) {
				return self::invalid( __( 'Pick the first and last day of the cycle it is due.', 'gridrankers-portal' ) );
			}
			$out['due_from_day'] = min( $from, $to );
			$out['due_day']      = max( $from, $to );
		}

		return $out;
	}

	/**
	 * The people on a task's breakdown rows, summed per person (`[{id, n}]`). Rows keep their people
	 * in `people`, or a legacy single `who` (old exports). Empty when no row has anyone.
	 *
	 * @param mixed $parts Breakdown rows.
	 * @return array
	 */
	public static function breakdown_people( $parts ) {
		$by = array();
		foreach ( is_array( $parts ) ? $parts : array() as $part ) {
			$part   = (array) $part;
			$people = ! empty( $part['people'] ) && is_array( $part['people'] ) ? $part['people'] : ( ! empty( $part['who'] ) ? array( array( 'id' => $part['who'] ) ) : array() );
			foreach ( $people as $person ) {
				$person = (array) $person;
				$id     = (string) ( $person['id'] ?? '' );
				if ( '' !== $id ) {
					$by[ $id ] = ( $by[ $id ] ?? 0 ) + max( 1, (int) ( $person['n'] ?? $part['n'] ?? 1 ) );
				}
			}
		}
		$list = array();
		foreach ( $by as $id => $n ) {
			$list[] = array(
				'id' => $id,
				'n'  => $n,
			);
		}

		return $list;
	}

	/**
	 * Quantity, breakdown and responsible people (SPEC.md 6.5).
	 *
	 * Without a breakdown: quantity as given, responsible people share the whole task
	 * (team). With a breakdown, quantity = sum of rows; when any row has people the
	 * responsible list is derived from the rows (team = 0, n aggregated).
	 *
	 * @param mixed $target    Quantity.
	 * @param mixed $parts     Breakdown rows.
	 * @param mixed $assignees Responsible people.
	 * @param bool  $team      Whole-task team.
	 * @return array|WP_Error
	 */
	private static function work( $target, $parts, $assignees, $team ) {
		$rows = array();
		foreach ( is_array( $parts ) ? $parts : array() as $part ) {
			$part = (array) $part;
			$name = self::text( $part['name'] ?? '', 100 );
			if ( '' === $name ) {
				continue;
			}
			$n      = self::int( $part['n'] ?? 1, 1, 999, 1 );
			$people = self::assignees( $part['people'] ?? array(), $n );
			if ( is_wp_error( $people ) ) {
				return $people;
			}
			$id     = preg_replace( '/[^\w-]/', '', (string) ( $part['id'] ?? '' ) );
			$rows[] = array(
				'id'     => '' !== $id ? $id : 'p' . strtolower( substr( GRP_Ids::ulid(), -10 ) ),
				'name'   => $name,
				'n'      => $n,
				'people' => $people,
			);
		}

		if ( ! $rows ) {
			$target = self::int( $target, 1, 99, 1 );
			$list   = self::assignees( $assignees, $target, $team );
			if ( is_wp_error( $list ) ) {
				return $list;
			}
			return array(
				'target'    => $target,
				'parts'     => null,
				'assignees' => $list,
				'team'      => $team ? 1 : 0,
			);
		}

		$target = min( 999, array_sum( wp_list_pluck( $rows, 'n' ) ) );
		$by     = array();
		foreach ( $rows as $row ) {
			foreach ( $row['people'] as $person ) {
				$by[ $person['id'] ] = ( $by[ $person['id'] ] ?? 0 ) + $person['n'];
			}
		}

		if ( ! $by ) {
			$list = self::assignees( $assignees, $target, true );
			if ( is_wp_error( $list ) ) {
				return $list;
			}
			return array(
				'target'    => $target,
				'parts'     => $rows,
				'assignees' => $list,
				'team'      => 1,
			);
		}

		$list = array();
		foreach ( $by as $id => $n ) {
			$list[] = array(
				'id' => $id,
				'n'  => $n,
			);
		}

		return array(
			'target'    => $target,
			'parts'     => $rows,
			'assignees' => $list,
			'team'      => 0,
		);
	}
}
