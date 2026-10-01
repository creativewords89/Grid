<?php
/**
 * REST: /meeting-tasks.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Meeting tasks: CRUD, status changes and per-person progress (SPEC.md 6.3, 6.5, 6.6).
 */
class GRP_REST_Meeting_Tasks extends GRP_REST_Controller {

	const TABLE = 'grp_meeting_tasks';

	const PRIORITIES = array( 'urgent', 'high', 'normal', 'low' );

	const STATUSES = array( 'todo', 'doing', 'done' );

	const STATUS_TEXT = array(
		'todo'  => 'To fix',
		'doing' => 'In progress',
		'done'  => 'Fixed',
	);

	const DEADLINE_TYPES = array( 'none', 'weekly', 'biweekly', 'date', 'dates', 'monthly' );

	/**
	 * Field labels for the audit log (reference FIELD_LABEL).
	 */
	const FIELD_LABELS = array(
		'project_id'   => 'project',
		'title'        => 'title',
		'notes'        => 'notes',
		'url'          => 'link',
		'priority'     => 'priority',
		'status'       => 'status',
		'meeting_date' => 'meeting date',
		'target'       => 'quantity',
		'assignees'    => 'responsible',
		'deadline'     => 'deadline',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/meeting-tasks', WP_REST_Server::READABLE, 'index' );
		self::route( '/meeting-tasks', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/status', WP_REST_Server::CREATABLE, 'set_status' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/progress', WP_REST_Server::CREATABLE, 'progress' );
	}

	/**
	 * GET /meeting-tasks `?project=`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function index( WP_REST_Request $request ) {
		$where = $request['project'] ? array( 'project_id' => (string) $request['project'] ) : array();

		return rest_ensure_response( GRP_Store::find( self::TABLE, $where, array( 'order_by' => 'created_at' ) ) );
	}

	/**
	 * GET /meeting-tasks/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );

		return $task ? rest_ensure_response( $task ) : self::not_found();
	}

	/**
	 * POST /meeting-tasks. Anyone signed in can add a task.
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

		$status = $request['status'] ? (string) $request['status'] : 'todo';
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			return self::invalid( __( 'Invalid status.', 'gridrankers-portal' ) );
		}
		if ( 'todo' !== $status && ! self::can(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => array(
					'status'    => 'todo',
					'assignees' => $fields['assignees'],
				),
				'to'   => $status,
			)
		) ) {
			return self::forbidden( __( 'Only the people responsible can start or complete this task.', 'gridrankers-portal' ) );
		}
		$completion = 'done' === $status ? self::completion( $request, ! self::is_manager() ) : null;
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		$task = GRP_Store::transaction(
			static function () use ( $fields, $status, $completion ) {
				$task = GRP_Store::insert(
					self::TABLE,
					$fields + array(
						'status'     => 'todo',
						'progress'   => array(),
						'created_by' => self::actor()['id'],
					)
				);
				if ( 'todo' !== $status ) {
					$task = GRP_Store::update( self::TABLE, $task['id'], self::status_changes( $task, $status, $completion ) );
				}
				GRP_Activity::audit( 'add', 'items', $task, self::actor(), ( 'urgent' === $task['priority'] ? 'urgent · ' : '' ) . self::STATUS_TEXT[ $task['status'] ] );
				return $task;
			}
		);

		return new WP_REST_Response( $task, 201 );
	}

	/**
	 * PATCH /meeting-tasks/{id}. Super Admin / Team Leader only.
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

		$status = $request['status'] ? (string) $request['status'] : $task['status'];
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			return self::invalid( __( 'Invalid status.', 'gridrankers-portal' ) );
		}
		if ( 'done' === $task['status'] && 'done' !== $status ) {
			return self::conflict( __( "It's completed — use Revise or Reject in Details to reopen it.", 'gridrankers-portal' ), 'grp_status_locked' );
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $fields, $status ) {
					$updated = GRP_Store::update( self::TABLE, $task['id'], $fields );
					if ( $status !== $task['status'] ) {
						$updated = GRP_Store::update( self::TABLE, $task['id'], self::status_changes( $updated, $status, null ) );
					}
					$changes = self::diff( $task, $updated, self::FIELD_LABELS );
					if ( $changes ) {
						GRP_Activity::audit( 'edit', 'items', $updated, self::actor(), '', $changes );
					}
					return $updated;
				}
			)
		);
	}

	/**
	 * DELETE /meeting-tasks/{id}: soft delete into the trash.
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
				GRP_Activity::audit( 'delete', 'items', $task, self::actor() );
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
	 * POST /meeting-tasks/{id}/status `{status, note?, link?}`.
	 *
	 * Members need a completion note to mark a task Fixed. Done tasks only change
	 * through review; In progress → To fix is for managers (GRP_Permissions).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_status( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}

		$to = (string) $request['status'];
		if ( ! in_array( $to, self::STATUSES, true ) ) {
			return self::invalid( __( 'Invalid status.', 'gridrankers-portal' ) );
		}
		if ( $to === $task['status'] ) {
			return rest_ensure_response( $task );
		}
		if ( ! self::can(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => $task,
				'to'   => $to,
			)
		) ) {
			return self::forbidden( self::status_denied_message( $task ) );
		}

		$completion = 'done' === $to ? self::completion( $request, ! self::is_manager() ) : null;
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $to, $completion ) {
					$updated = GRP_Store::update( self::TABLE, $task['id'], self::status_changes( $task, $to, $completion ) );
					GRP_Activity::audit( 'done' === $to ? 'done' : 'status', 'items', $updated, self::actor(), self::STATUS_TEXT[ $task['status'] ] . ' → ' . self::STATUS_TEXT[ $to ] );
					return $updated;
				}
			)
		);
	}

	/**
	 * POST /meeting-tasks/{id}/progress `{memberId, delta, note?, link?}`.
	 *
	 * Ticks one unit of a person's share (or of an unassigned task when memberId is empty).
	 * Status follows the total: first tick → In progress, total = target → Fixed (review).
	 * Each unit is credited to the share's owner (port of the reference `ishare` handler).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function progress( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}

		$delta = (int) $request['delta'];
		if ( 1 !== abs( $delta ) ) {
			return self::invalid( __( 'Progress changes one unit at a time.', 'gridrankers-portal' ) );
		}

		$member_id = (string) ( $request['memberId'] ?? '' );
		$assignees = (array) $task['assignees'];
		$share     = (int) ( $task['target'] ?? 1 );
		if ( '' !== $member_id ) {
			$assignee = wp_list_filter( $assignees, array( 'id' => $member_id ) );
			if ( ! $assignee ) {
				return self::invalid( __( "That person isn't responsible for this task.", 'gridrankers-portal' ) );
			}
			$share = max( 1, (int) reset( $assignee )['n'] );
		} elseif ( $assignees ) {
			return self::invalid( __( 'Pick whose share to tick.', 'gridrankers-portal' ) );
		}

		$key      = '' === $member_id ? '_' : $member_id;
		$progress = (array) $task['progress'];
		$was      = (int) ( $progress[ $key ] ?? 0 );
		$now      = max( 0, min( $share, $was + $delta ) );
		$target   = max( 1, (int) $task['target'] );

		$progress[ $key ] = $now;
		$total            = (int) array_sum( $progress );

		if ( ! self::can(
			GRP_Permissions::TICK_PROGRESS,
			array(
				'task'        => $task,
				'member_id'   => '' === $member_id ? self::actor()['id'] : $member_id,
				'delta'       => $delta,
				'total_after' => $total,
			)
		) ) {
			return self::forbidden( 'done' === $task['status'] ? self::status_denied_message( $task ) : __( 'You can only tick off your own share of tasks assigned to you.', 'gridrankers-portal' ) );
		}
		if ( $now === $was ) {
			return rest_ensure_response( $task );
		}

		$status     = $total >= $target ? 'done' : ( $total > 0 ? 'doing' : 'todo' );
		$completion = 'done' === $status ? self::completion( $request, false ) : null;
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $key, $member_id, $progress, $total, $target, $status, $was, $now, $delta, $completion ) {
					$changes = array( 'progress' => $progress );
					if ( $status !== $task['status'] ) {
						$changes += self::status_changes( $task, $status, $completion, false );
					}
					$updated = GRP_Store::update( self::TABLE, $task['id'], $changes );

					$ref = 'itemq:' . $task['id'] . ':' . $key;
					if ( $delta > 0 ) {
						GRP_Activity::credit( '' === $member_id ? self::actor()['id'] : $member_id, $task['project_id'], $task['title'], "$total/$target", 1, 'board', $ref );
					} else {
						GRP_Activity::uncredit( $ref, 1 );
					}
					GRP_Activity::audit( 'progress', 'items', $updated, self::actor(), self::name_of( $member_id ) . ": $was → $now · $total/$target" );

					return $updated;
				}
			)
		);
	}

	/**
	 * Column changes for a status move: done_at, review, completion and (for tasks
	 * without a quantity) the activity credit (reference `withReview` + `itemDoneLog`).
	 *
	 * @param array      $task       Task before the move.
	 * @param string     $to         New status.
	 * @param array|null $completion Completion note.
	 * @param bool       $credit     Credit/uncredit single-unit tasks.
	 * @return array
	 */
	private static function status_changes( array $task, $to, $completion, $credit = true ) {
		$was_done = 'done' === $task['status'];
		$changes  = array( 'status' => $to );

		if ( 'done' === $to && ! $was_done ) {
			$changes['done_at'] = GRP_Ids::now();
			$changes['review']  = self::new_review();
			if ( $completion ) {
				$changes['completion'] = $completion;
			}
			if ( $credit && (int) $task['target'] <= 1 ) {
				GRP_Activity::credit( self::actor()['id'], $task['project_id'], $task['title'], 'Fixed', 1, 'board', 'item:' . $task['id'] );
			}
		} elseif ( 'done' !== $to ) {
			$changes['done_at'] = null;
			$review             = $task['review'] ?? null;
			if ( is_array( $review ) && in_array( $review['state'] ?? '', array( 'pending', 'accepted' ), true ) ) {
				$changes['review'] = null;
			}
		}

		return $changes;
	}

	/**
	 * Why a status/progress change was refused.
	 *
	 * @param array $task Task.
	 * @return string
	 */
	private static function status_denied_message( array $task ) {
		if ( 'done' === $task['status'] ) {
			return self::is_manager()
				? __( "It's completed. To reopen it, use Revise or Reject in Details.", 'gridrankers-portal' )
				: __( "It's completed. Only a Team Leader or Super Admin can send it back (Revise or Reject).", 'gridrankers-portal' );
		}
		if ( 'doing' === $task['status'] ) {
			return __( "It's in progress — only a Team Leader or Super Admin can move it back to the start.", 'gridrankers-portal' );
		}

		return __( 'This task is assigned to someone else — only they can update it.', 'gridrankers-portal' );
	}

	/**
	 * Validated editable fields from a request. On update only fields present are returned.
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
			$out['title'] = self::text( $request['title'], 500 );
			if ( '' === $out['title'] ) {
				return self::invalid( __( 'Say what needs to change.', 'gridrankers-portal' ) );
			}
		}
		if ( $has( 'notes' ) ) {
			$out['notes'] = self::textarea( $request['notes'] );
		}
		if ( $has( 'url' ) ) {
			$url = self::url( $request['url'], 'page URL' );
			if ( is_wp_error( $url ) ) {
				return $url;
			}
			$out['url'] = $url;
		}
		if ( $has( 'priority' ) ) {
			$priority = $request['priority'] ? (string) $request['priority'] : 'normal';
			if ( ! in_array( $priority, self::PRIORITIES, true ) ) {
				return self::invalid( __( 'Invalid priority.', 'gridrankers-portal' ) );
			}
			$out['priority'] = $priority;
		}
		if ( $has( 'meeting_date' ) ) {
			$date = self::date( $request['meeting_date'], 'meeting date' );
			if ( is_wp_error( $date ) ) {
				return $date;
			}
			$out['meeting_date'] = $date;
		}
		if ( $has( 'target' ) ) {
			$out['target'] = self::int( $request['target'], 1, 999, 1 );
		}
		if ( $has( 'team' ) ) {
			$out['team'] = $request['team'] ? 1 : 0;
		}
		if ( $has( 'assignees' ) || isset( $out['target'] ) || isset( $out['team'] ) ) {
			$raw       = $has( 'assignees' ) ? $request['assignees'] : ( $task['assignees'] ?? array() );
			$assignees = self::assignees( $raw, $out['target'] ?? (int) $task['target'], (bool) ( $out['team'] ?? $task['team'] ?? 0 ) );
			if ( is_wp_error( $assignees ) ) {
				return $assignees;
			}
			$out['assignees'] = $assignees;
		}
		if ( $has( 'deadline' ) ) {
			$deadline = self::deadline( $request['deadline'] );
			if ( is_wp_error( $deadline ) ) {
				return $deadline;
			}
			$out['deadline'] = $deadline;
		}

		return $out;
	}

	/**
	 * Validates a deadline (SPEC.md section 6.3).
	 *
	 * @param mixed $raw Raw deadline.
	 * @return array|WP_Error
	 */
	private static function deadline( $raw ) {
		$raw  = is_array( $raw ) ? $raw : array();
		$type = (string) ( $raw['type'] ?? 'none' );
		if ( ! in_array( $type, self::DEADLINE_TYPES, true ) ) {
			return self::invalid( __( 'Invalid deadline type.', 'gridrankers-portal' ) );
		}

		switch ( $type ) {
			case 'weekly':
				$weeks = array();
				foreach ( (array) ( $raw['weeks'] ?? array() ) as $week ) {
					$week = self::date( $week, 'week' );
					if ( is_wp_error( $week ) || ! $week || '1' !== gmdate( 'N', strtotime( $week . ' 00:00:00 UTC' ) ) ) {
						return self::invalid( __( 'Weekly deadlines are picked by their Monday.', 'gridrankers-portal' ) );
					}
					$weeks[ $week ] = true;
				}
				if ( ! $weeks ) {
					return self::invalid( __( 'Pick at least one week.', 'gridrankers-portal' ) );
				}
				$weeks = array_keys( $weeks );
				sort( $weeks );
				return array(
					'type'  => 'weekly',
					'weeks' => array_slice( $weeks, 0, 12 ),
				);

			case 'biweekly':
				// Two weeks from a Monday: due on the Sunday of the second week.
				$from = self::date( $raw['from'] ?? '', 'from date' );
				if ( is_wp_error( $from ) || ! $from || '1' !== gmdate( 'N', strtotime( $from . ' 00:00:00 UTC' ) ) ) {
					return self::invalid( __( 'Bi-weekly deadlines start on a Monday.', 'gridrankers-portal' ) );
				}
				return array(
					'type' => 'biweekly',
					'from' => $from,
					'to'   => gmdate( 'Y-m-d', strtotime( $from . ' 00:00:00 UTC +13 days' ) ),
				);

			case 'date':
				$date = self::date( $raw['date'] ?? '', 'due date' );
				if ( is_wp_error( $date ) || ! $date ) {
					return self::invalid( __( 'Pick the due date.', 'gridrankers-portal' ) );
				}
				return array(
					'type' => 'date',
					'date' => $date,
				);

			case 'dates':
				$from = self::date( $raw['from'] ?? '', 'from date' );
				$to   = self::date( $raw['to'] ?? '', 'to date' );
				if ( is_wp_error( $from ) || is_wp_error( $to ) || ! $from || ! $to ) {
					return self::invalid( __( 'Pick both dates.', 'gridrankers-portal' ) );
				}
				return array(
					'type' => 'dates',
					'from' => min( $from, $to ),
					'to'   => max( $from, $to ),
				);

			case 'monthly':
				// Last day of the calendar month it was set in (locked to that month).
				$month = (string) ( $raw['month'] ?? '' );
				if ( ! preg_match( '/^\d{4}-(0[1-9]|1[0-2])$/', $month ) ) {
					$month = substr( GRP_Cycles::today(), 0, 7 );
				}
				return array(
					'type'  => 'monthly',
					'month' => $month,
				);
		}

		return array( 'type' => 'none' );
	}
}
