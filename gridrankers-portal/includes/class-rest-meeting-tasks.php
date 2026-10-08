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

	/** `project_id` of a General task: one that isn't part of any project (SPEC.md 6.13). */
	const GENERAL = '';


	const TABLE = 'grp_meeting_tasks';

	const PRIORITIES = array( 'urgent', 'high', 'normal', 'low' );

	const STATUSES = array( 'todo', 'doing', 'done' );

	const STATUS_TEXT = array(
		'todo'  => 'Not started',
		'doing' => 'In progress',
		'done'  => 'Completed',
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
		'steps'        => 'steps',
		'files'        => 'files',
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
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/step', WP_REST_Server::CREATABLE, 'step' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/undo', WP_REST_Server::CREATABLE, 'request_undo' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/undo/decide', WP_REST_Server::CREATABLE, 'decide_undo' );
		self::route( '/meeting-tasks/(?P<id>[\w-]+)/submission', 'PATCH', 'edit_submission' );
	}

	/**
	 * PATCH /meeting-tasks/{id}/submission `{note, links, files, comment}`: edit the saved
	 * submission (SPEC.md 6.6, design SF-B).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function edit_submission( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		$completion = self::edited_submission( $task['completion'] ?? null, $request );
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $completion ) {
					$updated = GRP_Store::update( self::TABLE, $task['id'], array( 'completion' => $completion ) );
					GRP_Activity::audit( 'edit', 'items', $updated, self::actor(), 'Submission edited' );
					return $updated;
				}
			)
		);
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
		if ( self::GENERAL === $fields['project_id'] && ! self::can( GRP_Permissions::ADD_GENERAL_TASK ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can add a general task.', 'gridrankers-portal' ) );
		}

		$status = $request['status'] ? (string) $request['status'] : 'todo';
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			return self::invalid( __( 'Invalid status.', 'gridrankers-portal' ) );
		}
		if ( 'todo' !== $status && ! empty( $fields['steps'] ) ) {
			return self::invalid( __( 'A task with steps starts at the first step.', 'gridrankers-portal' ) );
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
		$completion = 'done' === $status ? self::completion( $request, true ) : null;
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
		$steps = array_key_exists( 'steps', $fields ) ? $fields['steps'] : ( $task['steps'] ?? null );
		if ( $steps && $status !== $task['status'] ) {
			return self::invalid( __( 'This task has steps — tick the steps instead.', 'gridrankers-portal' ) );
		}
		if ( array_key_exists( 'steps', $fields ) || isset( $fields['target'] ) ) {
			if ( 'done' === $task['status'] && ( $steps ? wp_json_encode( $steps ) : '' ) !== ( GRP_Steps::on( $task ) ? wp_json_encode( $task['steps'] ) : '' ) ) {
				return self::conflict( __( "It's completed — reopen it before changing its steps.", 'gridrankers-portal' ), 'grp_status_locked' );
			}
			$fields['step_done'] = $steps ? GRP_Steps::fit( $steps, $task['step_done'] ?? null, $fields['target'] ?? $task['target'] ) : null;
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
	 * Members need a completion note to mark a task Completed. Done tasks only change
	 * through review; In progress → Not started is for managers (GRP_Permissions).
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
		if ( GRP_Steps::on( $task ) ) {
			return self::invalid( __( 'This task has steps — tick the steps instead.', 'gridrankers-portal' ), 'grp_has_steps' );
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

		$completion = 'done' === $to ? self::completion( $request, true ) : null;
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
	 * Ticks one unit of a person's share (or, for a Team Leader, of an unassigned task when memberId is empty).
	 * Status follows the total: first tick → In progress, total = target → Completed (review).
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
		if ( GRP_Steps::on( $task ) ) {
			return self::invalid( __( 'This task has steps — tick the steps instead.', 'gridrankers-portal' ), 'grp_has_steps' );
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
			return self::forbidden( 'done' === $task['status'] ? self::status_denied_message( $task ) : ( self::not_assigned_message( $task ) ?? __( 'You can only tick off your own share of tasks assigned to you.', 'gridrankers-portal' ) ) );
		}
		if ( $now === $was ) {
			return rest_ensure_response( $task );
		}

		$status = $total >= $target ? 'done' : ( $total > 0 ? 'doing' : 'todo' );
		// The last unit completes the task: everyone fills in the submission (SPEC.md 6.6).
		$completion = 'done' === $status && 'done' !== $task['status'] ? self::completion( $request, true ) : null;
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
	 * POST /meeting-tasks/{id}/step `{step, delta, note?, links?, files?, comment?, reviewer?}` (SPEC.md 6.16).
	 *
	 * Moves one step by one unit. A step counts only what the step before has finished; the last
	 * step's count is the task's, so its last unit completes the task (with the submission form).
	 * Each unit is credited to the step's person.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function step( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		if ( ! GRP_Steps::on( $task ) ) {
			return self::invalid( __( 'This task has no steps.', 'gridrankers-portal' ) );
		}
		$change = GRP_Steps::change( $request );
		if ( is_wp_error( $change ) ) {
			return $change;
		}
		$steps = array_values( $task['steps'] );
		$i     = GRP_Steps::index( $steps, (string) $request['step'] );
		if ( $i < 0 ) {
			return self::invalid( __( 'That step no longer exists.', 'gridrankers-portal' ) );
		}
		$step   = $steps[ $i ];
		$target = max( 1, (int) $task['target'] );
		$delta  = GRP_Steps::direction( $change, $task['step_done'] ?? null, $step['id'], $target );
		if ( ! self::can(
			GRP_Permissions::TICK_STEP,
			array(
				'task'  => $task,
				'step'  => $step,
				'delta' => $delta,
			)
		) ) {
			if ( 'done' === $task['status'] ) {
				return self::forbidden( self::status_denied_message( $task ) );
			}
			return self::forbidden(
				$delta < 0
					? __( 'Only a Team Leader or Super Admin can move a step back.', 'gridrankers-portal' )
					/* translators: 1: step name, 2: person's name. */
					: sprintf( __( '“%1$s” is %2$s’s step.', 'gridrankers-portal' ), $step['name'], self::name_of( $step['member'] ) )
			);
		}

		$done = GRP_Steps::apply( $steps, $task['step_done'] ?? null, $step['id'], $change, $target, self::actor()['id'] );
		if ( is_wp_error( $done ) ) {
			return $done;
		}
		$count  = GRP_Steps::count( $steps, $done );
		$status = $count >= $target ? 'done' : ( GRP_Steps::begun( $steps, $done, $target ) ? 'doing' : 'todo' );
		// The last step completes the task: the submission form (SPEC.md 6.6).
		$completion = 'done' === $status ? self::completion( $request, true ) : null;
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $step, $done, $status, $completion, $target ) {
					$changes = array( 'step_done' => $done );
					if ( $status !== $task['status'] ) {
						$changes += self::status_changes( $task, $status, $completion, false );
					}
					$updated = GRP_Store::update( self::TABLE, $task['id'], $changes );
					$was     = GRP_Steps::n( $task['step_done'] ?? null, $step['id'] );
					$n       = GRP_Steps::n( $done, $step['id'] );
					$ref     = GRP_Steps::ref( 'stepi', $task['id'], $step['id'] );
					if ( $n > $was ) {
						GRP_Activity::credit( $step['member'], $task['project_id'], $task['title'], $step['name'] . " · $n/$target", $n - $was, 'board', $ref );
					} elseif ( $n < $was ) {
						GRP_Activity::uncredit( $ref, $was - $n );
					}
					$text = array(
						'todo'  => 'Not started',
						'doing' => 'In progress',
						'done'  => 'Completed',
					);
					GRP_Activity::audit( 'progress', 'items', $updated, self::actor(), $step['name'] . ' · ' . self::name_of( $step['member'] ) . ': ' . $text[ GRP_Steps::state( $task['step_done'] ?? null, $step['id'], $target ) ] . ' → ' . $text[ GRP_Steps::state( $done, $step['id'], $target ) ] . ( $target > 1 ? " · $n of $target" : '' ) );
					return $updated;
				}
			)
		);
	}

	/**
	 * POST /meeting-tasks/{id}/undo `{reason}`: a Team Member asks to put a task they moved to
	 * In progress by mistake back to Not started (SPEC.md 6.6).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function request_undo( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::REQUEST_UNDO, array( 'task' => $task ) ) ) {
			return self::forbidden( __( 'Only the person working on a task that is In progress can ask to undo it.', 'gridrankers-portal' ) );
		}
		if ( GRP_Undo::pending( $task ) ) {
			return self::conflict( __( 'An undo is already requested for this task.', 'gridrankers-portal' ), 'grp_undo_pending' );
		}
		$undo = GRP_Undo::request( $request['reason'] ?? '', self::actor() );
		if ( is_wp_error( $undo ) ) {
			return $undo;
		}
		$updated = GRP_Store::update( self::TABLE, $task['id'], array( 'undo_request' => $undo ) );
		GRP_Activity::audit( 'status', 'items', $updated, self::actor(), 'undo requested' );

		return rest_ensure_response( $updated );
	}

	/**
	 * POST /meeting-tasks/{id}/undo/decide `{action: undo|keep, note?}`. Team Leaders and the
	 * Super Admin; the person who asked gets a notice with the answer.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function decide_undo( WP_REST_Request $request ) {
		$task = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $task ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DECIDE_UNDO ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can answer a request to undo.', 'gridrankers-portal' ) );
		}
		$undo = GRP_Undo::pending( $task );
		if ( ! $undo ) {
			return self::conflict( __( 'There is no request to undo on this task.', 'gridrankers-portal' ), 'grp_undo_none' );
		}
		$action = (string) $request['action'];
		if ( ! in_array( $action, array( 'undo', 'keep' ), true ) ) {
			return self::invalid( __( 'Choose Undo or Keep.', 'gridrankers-portal' ) );
		}
		$approved = 'undo' === $action && 'doing' === $task['status'];
		$note     = $request['note'] ?? '';

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $undo, $approved, $note ) {
					$changes = $approved ? self::status_changes( $task, 'todo', null ) : array( 'undo_request' => null );
					$updated = GRP_Store::update( self::TABLE, $task['id'], $changes );
					GRP_Activity::audit( 'status', 'items', $updated, self::actor(), $approved ? 'undo approved: In progress → Not started' : 'undo not approved' );
					GRP_Undo::answer( $undo, $approved, $task['title'], $note, self::actor() );
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
		// Any status move answers a pending request to undo.
		$changes = array(
			'status'       => $to,
			'undo_request' => null,
		);

		if ( 'done' === $to && ! $was_done ) {
			$changes['done_at'] = GRP_Ids::now();
			$changes['review']  = self::new_review();
			if ( $completion ) {
				$changes['completion'] = $completion;
			}
			if ( $credit && (int) $task['target'] <= 1 ) {
				GRP_Activity::credit( self::actor()['id'], $task['project_id'], $task['title'], 'Completed', 1, 'board', 'item:' . $task['id'] );
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
		$unassigned = self::not_assigned_message( $task );
		if ( null !== $unassigned && 'done' !== $task['status'] ) {
			return $unassigned;
		}
		if ( 'done' === $task['status'] ) {
			return self::is_manager()
				? __( "It's completed. To reopen it, use Revise or Reject in Details.", 'gridrankers-portal' )
				: __( "It's completed. Only a Team Leader or Super Admin can send it back (Revise or Reject).", 'gridrankers-portal' );
		}
		if ( 'doing' === $task['status'] ) {
			return __( "It's in progress — only a Team Leader or Super Admin can move it back to the start.", 'gridrankers-portal' );
		}

		return __( 'You can’t update this task.', 'gridrankers-portal' );
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
			// An empty project is a General task: not part of any project (SPEC.md 6.13).
			$id = (string) ( $request['project_id'] ?? '' );
			if ( '' === $id ) {
				$out['project_id'] = self::GENERAL;
			} else {
				$project = GRP_Store::get( 'grp_projects', $id );
				if ( ! $project ) {
					return self::invalid( __( 'Pick a project, or General.', 'gridrankers-portal' ) );
				}
				$out['project_id'] = $project['id'];
			}
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
		// Files added with the task (SPEC.md 6.17): the brief, screenshots, the client's documents.
		if ( null !== $request->get_param( 'files' ) ) {
			$files = self::attached_files( $request['files'] );
			if ( is_wp_error( $files ) ) {
				return $files;
			}
			$out['files'] = $files;
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
		// Steps in order (SPEC.md 6.16): their people share the whole task.
		if ( $has( 'steps' ) ) {
			$steps = GRP_Steps::clean( $request['steps'], 'date' );
			if ( is_wp_error( $steps ) ) {
				return $steps;
			}
			$out['steps'] = $steps;
		}
		$steps = array_key_exists( 'steps', $out ) ? $out['steps'] : ( $task['steps'] ?? null );
		// The last step's date is the task's deadline (SPEC.md 6.16).
		if ( $steps && GRP_Steps::last_due( $steps ) ) {
			$out['deadline'] = array(
				'type' => 'date',
				'date' => GRP_Steps::last_due( $steps ),
			);
		}
		if ( $steps && ( array_key_exists( 'steps', $out ) || isset( $out['target'] ) || isset( $out['assignees'] ) ) ) {
			$out['team']      = 1;
			$out['assignees'] = GRP_Steps::assignees( $steps, $out['target'] ?? (int) ( $task['target'] ?? 1 ) );
		}
		if ( $has( 'deadline' ) && ! isset( $out['deadline'] ) ) {
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
