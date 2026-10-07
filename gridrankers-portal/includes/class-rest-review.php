<?php
/**
 * REST: /review.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Accept / revise / reject completed work (SPEC.md 6.6, reference `doReview`).
 */
class GRP_REST_Review extends GRP_REST_Controller {

	const ACTIONS = array(
		'accept'   => 'accepted',
		'revision' => 'revision',
		'reject'   => 'rejected',
	);

	const STATE_TEXT = array(
		'pending'  => 'Awaiting review',
		'accepted' => 'Accepted',
		'revision' => 'Revision requested',
		'rejected' => 'Rejected',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/review', WP_REST_Server::CREATABLE, 'review' );
		self::route( '/review/request', WP_REST_Server::CREATABLE, 'request' );
	}

	/**
	 * POST /review `{kind: item|record, id, action: accept|revision|reject, note}`.
	 *
	 * Accept needs pending work. Revision / reject need a note and work that is pending
	 * or completed (reopening accepted work). Revise removes one unit (from the
	 * submitter); reject clears all units; their activity credit is removed.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function review( WP_REST_Request $request ) {
		$action = (string) $request['action'];
		if ( ! isset( self::ACTIONS[ $action ] ) ) {
			return self::invalid( __( 'Invalid review action.', 'gridrankers-portal' ) );
		}
		$note = self::textarea( $request['note'] ?? '', 1000 );
		if ( 'accept' !== $action && '' === $note ) {
			return self::invalid( __( 'Add a short note so they know what to do.', 'gridrankers-portal' ), 'grp_note_required' );
		}

		$kind = (string) $request['kind'];
		if ( 'item' === $kind ) {
			return self::review_item( (string) $request['id'], $action, $note );
		}
		if ( 'record' === $kind ) {
			return self::review_record( (string) $request['id'], $action, $note );
		}

		return self::invalid( __( 'Invalid review kind.', 'gridrankers-portal' ) );
	}

	/**
	 * Reviews a meeting task.
	 *
	 * @param string $id     Task id.
	 * @param string $action Action.
	 * @param string $note   Note.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function review_item( $id, $action, $note ) {
		$task = GRP_Store::get( 'grp_meeting_tasks', $id );
		if ( ! $task ) {
			return self::not_found();
		}
		$denied = self::denied( $task['review'] ?? null, $action );
		if ( $denied ) {
			return $denied;
		}

		$review = self::current_review( $task['review'] ?? null, 'done' === $task['status'], $action, $task['done_at'] ?? null, self::first_assignee( $task ) );
		if ( is_wp_error( $review ) ) {
			return $review;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $review, $action, $note ) {
					$changes = array( 'review' => self::decided( $review, $action, $note ) );
					$q       = (int) $task['target'] > 1;
					$sub     = (string) ( $review['submittedBy'] ?? '' );

					if ( GRP_Steps::on( $task ) && in_array( $action, array( 'revision', 'reject' ), true ) ) {
						// Steps (SPEC.md 6.16): Revise gives back the last step's last unit, Reject clears them all.
						self::steps_back( $task['steps'], $task['step_done'] ?? null, 'stepi', $task['id'], $action, $changes );
						$changes['status']  = 'revision' === $action ? 'doing' : 'todo';
						$changes['done_at'] = null;
					} elseif ( 'revision' === $action ) {
						$changes['status']  = 'doing';
						$changes['done_at'] = null;
						if ( $q ) {
							$progress = (array) $task['progress'];
							$k        = self::unit_owner( $progress, $sub );
							if ( null !== $k ) {
								$progress[ $k ] = (int) $progress[ $k ] - 1;
								GRP_Activity::uncredit( 'itemq:' . $task['id'] . ':' . $k, 1 );
							}
							$changes['progress'] = $progress;
						} else {
							self::clear_single_unit( $task, $changes );
						}
					} elseif ( 'reject' === $action ) {
						$changes['status']  = 'todo';
						$changes['done_at'] = null;
						if ( $q ) {
							foreach ( array_keys( (array) $task['progress'] ) as $k ) {
								GRP_Activity::uncredit( 'itemq:' . $task['id'] . ':' . $k );
							}
							$changes['progress'] = array();
						} else {
							self::clear_single_unit( $task, $changes );
						}
					}

					$updated = GRP_Store::update( 'grp_meeting_tasks', $task['id'], $changes );
					GRP_Activity::audit( 'review', 'items', $updated, self::actor(), self::STATE_TEXT[ self::ACTIONS[ $action ] ] . ( '' !== $note ? ': ' . $note : '' ) );
					return $updated;
				}
			)
		);
	}

	/**
	 * Reviews a recurring task's period record.
	 *
	 * @param string $id     Record id.
	 * @param string $action Action.
	 * @param string $note   Note.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function review_record( $id, $action, $note ) {
		$rec  = GRP_Store::get( 'grp_cycle_records', $id );
		$task = $rec ? GRP_Store::get( 'grp_monthly_tasks', $rec['task_id'] ) : null;
		if ( ! $rec || ! $task ) {
			return self::not_found();
		}
		$denied = self::denied( $rec['review'] ?? null, $action );
		if ( $denied ) {
			return $denied;
		}

		$n      = max( 1, (int) $task['target'] );
		$by     = (array) $rec['by_person'];
		$review = self::current_review( $rec['review'] ?? null, (int) $rec['count'] >= $n && 'skipped' !== $rec['status'], $action, $rec['done_at'] ?? null, (string) ( array_key_first( $by ) ?? self::first_assignee( $task ) ) );
		if ( is_wp_error( $review ) ) {
			return $review;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $rec, $task, $n, $by, $review, $action, $note ) {
					$changes = array( 'review' => self::decided( $review, $action, $note ) );

					if ( GRP_Steps::on( $task ) && in_array( $action, array( 'revision', 'reject' ), true ) ) {
						self::steps_back( $task['steps'], $rec['step_done'] ?? null, 'stepr', $rec['id'], $action, $changes );
						$changes += array(
							'count'   => GRP_Steps::count( $task['steps'], $changes['step_done'] ),
							'status'  => 'revision' === $action ? 'doing' : 'todo',
							'done_at' => null,
						);
					} elseif ( 'revision' === $action ) {
						$k = self::unit_owner( $by, (string) ( $review['submittedBy'] ?? '' ) );
						if ( null !== $k ) {
							$by[ $k ] = (int) $by[ $k ] - 1;
						}
						$changes += array(
							'by_person' => $by,
							'count'     => max( 0, ( (int) $rec['count'] ? (int) $rec['count'] : $n ) - 1 ),
							'status'    => 'doing',
							'done_at'   => null,
						);
						GRP_Activity::uncredit( 'rec:' . $rec['id'], 1 );
					} elseif ( 'reject' === $action ) {
						$changes += array(
							'by_person' => array(),
							'parts'     => empty( $task['parts'] ) ? null : array(),
							'count'     => 0,
							'status'    => 'todo',
							'done_at'   => null,
						);
						GRP_Activity::uncredit( 'rec:' . $rec['id'] );
					}

					$updated = GRP_Store::update( 'grp_cycle_records', $rec['id'], $changes );
					$where   = $rec['week'] ? 'Week ' . $rec['week'] : 'This cycle';
					GRP_Activity::audit( 'review', 'monthly', $task, self::actor(), "$where · " . self::STATE_TEXT[ self::ACTIONS[ $action ] ] . ( '' !== $note ? ': ' . $note : '' ) );
					return $updated;
				}
			)
		);
	}

	/**
	 * POST /review/request `{kind: item|record, id, reviewer, note?}`: a Super Admin or Team
	 * Leader asks someone to review work they finished themselves (SPEC.md 6.6). The work
	 * goes back to `pending` with that reviewer; only they (or the Super Admin) can decide.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function request( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::REQUEST_REVIEW ) ) {
			return self::forbidden( __( 'Only a Super Admin or Team Leader can ask for a review.', 'gridrankers-portal' ) );
		}
		$actor    = self::actor();
		$reviewer = GRP_Store::get( 'grp_members', (string) ( $request['reviewer'] ?? '' ) );
		if ( ! $reviewer || ! (int) $reviewer['active'] || $reviewer['id'] === $actor['id'] ) {
			return self::invalid( __( 'Pick who should review it.', 'gridrankers-portal' ) );
		}

		$kind  = (string) $request['kind'];
		$table = array(
			'item'   => 'grp_meeting_tasks',
			'record' => 'grp_cycle_records',
		)[ $kind ] ?? null;
		if ( ! $table ) {
			return self::invalid( __( 'Invalid review kind.', 'gridrankers-portal' ) );
		}
		$row = GRP_Store::get( $table, (string) $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$review = (array) ( $row['review'] ?? array() );
		$own    = 'accepted' === ( $review['state'] ?? '' ) && ! empty( $review['auto'] ) && (string) ( $review['submittedBy'] ?? '' ) === (string) $actor['id'];
		if ( ! $own ) {
			return self::conflict( __( 'You can only ask for a review of work you finished yourself.', 'gridrankers-portal' ), 'grp_not_own_work' );
		}

		$changes = array(
			'review' => array(
				'state'       => 'pending',
				'submittedBy' => $actor['id'],
				'submittedAt' => gmdate( 'c' ),
				'reviewer'    => $reviewer['id'],
				'note'        => self::textarea( $request['note'] ?? '', 1000 ),
			),
		);

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $table, $row, $changes, $reviewer, $actor ) {
					$updated = GRP_Store::update( $table, $row['id'], $changes );
					$task    = 'grp_cycle_records' === $table ? GRP_Store::get( 'grp_monthly_tasks', $row['task_id'] ) : $updated;
					GRP_Activity::audit( 'review', 'grp_cycle_records' === $table ? 'monthly' : 'items', (array) $task, $actor, 'Review asked of ' . $reviewer['name'] );
					return $updated;
				}
			)
		);
	}

	/**
	 * Why the actor may not decide this review, or null when they may. A review someone
	 * asked for belongs to that reviewer (and the Super Admin); others need REVIEW.
	 *
	 * @param mixed  $review Stored review.
	 * @param string $action Action.
	 * @return WP_Error|null
	 */
	private static function denied( $review, $action ) {
		$review = is_array( $review ) ? $review : array();
		if ( 'pending' === ( $review['state'] ?? '' ) && ! empty( $review['reviewer'] ) ) {
			$ok = self::can( GRP_Permissions::ANSWER_REVIEW_REQUEST, array( 'reviewer' => $review['reviewer'] ) )
				&& ( 'reject' !== $action || self::can( GRP_Permissions::REVIEW ) );
			return $ok ? null : self::forbidden( __( 'Someone else was asked to review this.', 'gridrankers-portal' ) );
		}

		return self::can( GRP_Permissions::REVIEW ) ? null : self::forbidden( __( 'Only a Super Admin or Team Leader can review work.', 'gridrankers-portal' ) );
	}

	/**
	 * Revise or Reject on a task with steps: the last step gives back one unit, or every step is
	 * cleared, with their activity credit.
	 *
	 * @param array  $steps   Steps.
	 * @param mixed  $done    `step_done`.
	 * @param string $prefix  Credit ref prefix (`stepi` / `stepr`).
	 * @param string $id      Task or record id.
	 * @param string $action  revision or reject.
	 * @param array  $changes Column changes (gets `step_done`).
	 */
	private static function steps_back( array $steps, $done, $prefix, $id, $action, array &$changes ) {
		if ( 'revision' === $action ) {
			$last = end( $steps );
			if ( GRP_Steps::n( $done, $last['id'] ) > 0 ) {
				GRP_Activity::uncredit( GRP_Steps::ref( $prefix, $id, $last['id'] ), 1 );
			}
			$changes['step_done'] = GRP_Steps::revise( $steps, $done );
			return;
		}
		foreach ( $steps as $step ) {
			GRP_Activity::uncredit( GRP_Steps::ref( $prefix, $id, $step['id'] ) );
		}
		$changes['step_done'] = array();
	}

	/**
	 * Removes the single unit of a quantity-1 task, however it was completed
	 * (status button credits `item:`, a progress tick credits `itemq:`).
	 *
	 * @param array $task    Task.
	 * @param array $changes Column changes (progress is reset).
	 */
	private static function clear_single_unit( array $task, array &$changes ) {
		GRP_Activity::uncredit( 'item:' . $task['id'] );
		foreach ( array_keys( (array) $task['progress'] ) as $k ) {
			GRP_Activity::uncredit( 'itemq:' . $task['id'] . ':' . $k );
		}
		$changes['progress'] = array();
	}

	/**
	 * The review being decided, or why it can't be.
	 *
	 * Work completed before reviews existed (or by a reviewer) counts as accepted.
	 *
	 * @param array|null $review    Stored review.
	 * @param bool       $done      Whether the work is completed.
	 * @param string     $action    Action.
	 * @param string     $done_at   Completion time.
	 * @param string     $submitter Fallback submitter.
	 * @return array|WP_Error
	 */
	private static function current_review( $review, $done, $action, $done_at, $submitter ) {
		if ( ! is_array( $review ) || empty( $review['state'] ) ) {
			if ( ! $done ) {
				return self::conflict( __( 'There is nothing to review.', 'gridrankers-portal' ), 'grp_nothing_to_review' );
			}
			$review = array(
				'state'       => 'accepted',
				'submittedBy' => $submitter,
				'submittedAt' => $done_at ? $done_at : gmdate( 'c' ),
			);
		}

		$pending = 'pending' === $review['state'];
		if ( 'accept' === $action ? ! $pending : ! ( $pending || $done ) ) {
			return self::conflict( __( 'This work has already been reviewed.', 'gridrankers-portal' ), 'grp_already_reviewed' );
		}

		return $review;
	}

	/**
	 * Review after a decision.
	 *
	 * @param array  $review Review.
	 * @param string $action Action.
	 * @param string $note   Note.
	 * @return array
	 */
	private static function decided( array $review, $action, $note ) {
		unset( $review['auto'] );

		return array_merge(
			$review,
			array(
				'state' => self::ACTIONS[ $action ],
				'by'    => self::actor()['id'],
				'at'    => gmdate( 'c' ),
				'note'  => $note,
			)
		);
	}

	/**
	 * Whose unit a revision removes: the submitter's, else the first person with units.
	 *
	 * @param array  $counts    Member id => units.
	 * @param string $submitter Submitter id.
	 * @return string|null
	 */
	private static function unit_owner( array $counts, $submitter ) {
		if ( '' !== $submitter && ! empty( $counts[ $submitter ] ) ) {
			return $submitter;
		}
		foreach ( $counts as $k => $v ) {
			if ( (int) $v > 0 ) {
				return (string) $k;
			}
		}

		return null;
	}

	/**
	 * First assignee id of a task, or ''.
	 *
	 * @param array $task Task.
	 * @return string
	 */
	private static function first_assignee( array $task ) {
		$assignees = (array) ( $task['assignees'] ?? array() );

		return (string) ( $assignees[0]['id'] ?? '' );
	}
}
