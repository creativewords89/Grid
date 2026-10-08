<?php
/**
 * REST: /records (recurring task progress per period).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Cycle records: ticks (whole task, a person's share, a breakdown row) and status moves.
 * Ports the reference `writeRec` and its `mstep` / `mshare` / `mpart` / `mset` handlers.
 */
class GRP_REST_Records extends GRP_REST_Controller {

	const TABLE = 'grp_cycle_records';

	const STATUSES = array( 'todo', 'doing', 'done', 'skipped' );

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/records', WP_REST_Server::READABLE, 'index' );
		self::route( '/records/tick', WP_REST_Server::CREATABLE, 'tick' );
		self::route( '/records/step', WP_REST_Server::CREATABLE, 'step' );
		self::route( '/records/status', WP_REST_Server::CREATABLE, 'set_status' );
		self::route( '/records/undo', WP_REST_Server::CREATABLE, 'request_undo' );
		self::route( '/records/undo/decide', WP_REST_Server::CREATABLE, 'decide_undo' );
		self::route( '/records/submission', 'PATCH', 'edit_submission' );
	}

	/**
	 * PATCH /records/submission `{taskId, periodKey, note, links, files, comment}`: edit the saved
	 * submission of a period (SPEC.md 6.6, design SF-B).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function edit_submission( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, , , $rec ) = $ctx;
		$completion             = self::edited_submission( $rec ? ( $rec['completion'] ?? null ) : null, $request );
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $rec, $completion ) {
					$record = GRP_Store::update( self::TABLE, $rec['id'], array( 'completion' => $completion ) );
					GRP_Activity::audit( 'edit', 'monthly', $task, self::actor(), self::period_label( $task, $rec['week'] ) . ' · submission edited' );
					return array(
						'record' => $record,
						'id'     => $record['id'],
					);
				}
			)
		);
	}

	/**
	 * GET /records `?project=&period=`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function index( WP_REST_Request $request ) {
		$where = array();
		if ( $request['project'] ) {
			$where['project_id'] = (string) $request['project'];
		}
		if ( $request['period'] ) {
			$where['period_key'] = (string) $request['period'];
		}

		return rest_ensure_response( GRP_Store::find( self::TABLE, $where, array( 'order_by' => 'updated_at' ) ) );
	}

	/**
	 * POST /records/tick `{taskId, periodKey, partId?, memberId?, delta, note?, link?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function tick( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, $period_key, $week, $rec ) = $ctx;

		$delta = (int) $request['delta'];
		if ( 1 !== abs( $delta ) ) {
			return self::invalid( __( 'Progress changes one unit at a time.', 'gridrankers-portal' ) );
		}
		if ( GRP_Steps::on( $task ) ) {
			return self::invalid( __( 'This task has steps — tick the steps instead.', 'gridrankers-portal' ), 'grp_has_steps' );
		}

		$n         = max( 1, (int) $task['target'] );
		$actor_id  = self::actor()['id'];
		$part_id   = (string) ( $request['partId'] ?? '' );
		$member_id = (string) ( $request['memberId'] ?? '' );
		$count     = self::count_of( $rec );
		$plan      = null;

		if ( '' !== $part_id ) {
			$part = wp_list_filter( (array) $task['parts'], array( 'id' => $part_id ) );
			if ( ! $part ) {
				return self::invalid( __( 'That breakdown row no longer exists.', 'gridrankers-portal' ) );
			}
			$part   = reset( $part );
			$people = (array) ( $part['people'] ?? array() );
			if ( '' !== $member_id && ! wp_list_filter( $people, array( 'id' => $member_id ) ) ) {
				return self::invalid( __( "That person doesn't do this part.", 'gridrankers-portal' ) );
			}
			$worker = '' !== $member_id ? $member_id : ( 1 === count( $people ) ? $people[0]['id'] : '' );
			$parts  = (array) ( $rec['parts'] ?? array() );

			if ( '' !== $member_id ) {
				$person   = wp_list_filter( $people, array( 'id' => $member_id ) );
				$share    = (int) reset( $person )['n'];
				$key      = $part['id'] . '|' . $member_id;
				$mine     = max( 0, min( $share, (int) ( $parts[ $key ] ?? 0 ) + $delta ) );
				$had_mine = (int) ( $parts[ $key ] ?? 0 );
				if ( $had_mine === $mine || ( $delta > 0 && (int) ( $parts[ $part['id'] ] ?? 0 ) >= (int) $part['n'] ) ) {
					return self::unchanged( $rec );
				}
				$parts[ $key ] = $mine;
			}
			$row_now = max( 0, min( (int) $part['n'], (int) ( $parts[ $part['id'] ] ?? 0 ) + $delta ) );
			$row_was = (int) ( $parts[ $part['id'] ] ?? 0 );
			if ( $row_was === $row_now ) {
				return self::unchanged( $rec );
			}
			$parts[ $part['id'] ] = $row_now;

			$total = 0;
			foreach ( (array) $task['parts'] as $x ) {
				$total += (int) ( $parts[ $x['id'] ] ?? 0 );
			}
			$total = min( $n, $total );

			$who = self::shared( $task ) ? ( '' !== $worker ? $worker : self::worker_for( $task, $rec, $delta ) ) : null;
			if ( $who ) {
				$plan = array( self::done_by( $rec, $who ) + $delta, $who, $parts, $part['name'] );
			} else {
				$plan = array( $total, '' !== $worker ? $worker : null, $parts, $part['name'] );
			}
			$credit_to = '' !== $worker ? $worker : $actor_id;
			$after     = $total;
		} elseif ( '' !== $member_id ) {
			if ( ! wp_list_filter( (array) $task['assignees'], array( 'id' => $member_id ) ) ) {
				return self::invalid( __( "That person isn't responsible for this task.", 'gridrankers-portal' ) );
			}
			$plan      = array( self::done_by( $rec, $member_id ) + $delta, $member_id, null, '' );
			$credit_to = $member_id;
			$after     = max( 0, $count + $delta );
		} else {
			$plan      = array( $count + $delta, null, null, '' );
			$credit_to = $actor_id;
			$after     = max( 0, $count + $delta );
		}

		if ( ! self::can(
			GRP_Permissions::TICK_PROGRESS,
			array(
				'task'        => self::as_task( $task, $rec ),
				'member_id'   => $credit_to,
				'delta'       => $delta,
				'total_after' => $after,
			)
		) ) {
			return self::forbidden( self::denied_message( $task, $rec ) );
		}

		// The last unit completes the task: everyone fills in the submission (SPEC.md 6.6).
		$finishes   = $delta > 0 && $after >= $n && self::count_of( $rec ) < $n;
		$completion = self::completion( $request, $finishes );
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		list( $new_count, $pid, $parts, $label ) = $plan;

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $period_key, $week, $rec, $new_count, $pid, $parts, $label, $completion ) {
					return self::write( $task, $period_key, $week, $rec, $new_count, 'doing', $pid, $parts, $label, $completion );
				}
			)
		);
	}

	/**
	 * POST /records/step `{taskId, periodKey, step, status | delta, note?, links?, files?, comment?, reviewer?}`
	 * (SPEC.md 6.16): one step of this period moves by one unit. Same rules as a meeting task's steps.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function step( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, $period_key, $week, $rec ) = $ctx;
		if ( ! GRP_Steps::on( $task ) ) {
			return self::invalid( __( 'This task has no steps.', 'gridrankers-portal' ) );
		}
		$change = GRP_Steps::change( $request );
		if ( is_wp_error( $change ) ) {
			return $change;
		}
		if ( $rec && 'skipped' === $rec['status'] ) {
			return self::invalid( __( 'This period was skipped.', 'gridrankers-portal' ) );
		}
		$steps = array_values( $task['steps'] );
		$i     = GRP_Steps::index( $steps, (string) $request['step'] );
		if ( $i < 0 ) {
			return self::invalid( __( 'That step no longer exists.', 'gridrankers-portal' ) );
		}
		$step   = $steps[ $i ];
		$n      = max( 1, (int) $task['target'] );
		$before = GRP_Steps::fit( $steps, $rec['step_done'] ?? null, $n );
		$delta  = GRP_Steps::direction( $change, $before, $step['id'], $n );
		if ( ! self::can(
			GRP_Permissions::TICK_STEP,
			array(
				'task'  => self::as_task( $task, $rec ),
				'step'  => $step,
				'delta' => $delta,
			)
		) ) {
			if ( 'done' === self::state( $task, $rec ) ) {
				return self::forbidden( self::denied_message( $task, $rec ) );
			}
			return self::forbidden(
				$delta < 0
					? __( 'Only a Team Leader or Super Admin can move a step back.', 'gridrankers-portal' )
					/* translators: 1: step name, 2: person's name. */
					: sprintf( __( '“%1$s” is %2$s’s step.', 'gridrankers-portal' ), $step['name'], self::name_of( $step['member'] ) )
			);
		}

		$done = GRP_Steps::apply( $steps, $before, $step['id'], $change, $n, self::actor()['id'] );
		if ( is_wp_error( $done ) ) {
			return $done;
		}
		$count      = GRP_Steps::count( $steps, $done );
		$finishes   = $count >= $n && self::count_of( $rec ) < $n;
		$completion = self::completion( $request, $finishes );
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $period_key, $week, $rec, $steps, $step, $before, $done, $count, $n, $completion ) {
					$id   = GRP_Cycles::record_id( $task['id'], $period_key );
					$prev = $rec ? $rec : array();
					$row  = array(
						'task_id'      => $task['id'],
						'project_id'   => $task['project_id'],
						'period_key'   => $period_key,
						'week'         => $week,
						'step_done'    => $done,
						'count'        => $count,
						'status'       => $count >= $n ? 'done' : ( GRP_Steps::begun( $steps, $done, $n ) ? 'doing' : 'todo' ),
						'done_at'      => $count >= $n ? ( $prev['done_at'] ?? GRP_Ids::now() ) : null,
						'undo_request' => null,
					);
					if ( $count >= $n ) {
						$row['review']     = (int) ( $prev['count'] ?? 0 ) >= $n && ! empty( $prev['review'] ) ? $prev['review'] : self::new_review();
						$row['completion'] = $completion ? $completion : ( $prev['completion'] ?? null );
					} else {
						$review        = $prev['review'] ?? null;
						$row['review'] = is_array( $review ) && in_array( $review['state'] ?? '', array( 'revision', 'rejected' ), true ) ? $review : null;
					}

					$was = GRP_Steps::n( $before, $step['id'] );
					$k   = GRP_Steps::n( $done, $step['id'] );
					$ref = GRP_Steps::ref( 'stepr', $id, $step['id'] );
					if ( $k > $was ) {
						GRP_Activity::credit( $step['member'], $task['project_id'], $task['title'], $step['name'] . ' · ' . self::period_label( $task, $week ) . " · $k/$n", $k - $was, 'monthly', $ref );
					} elseif ( $k < $was ) {
						GRP_Activity::uncredit( $ref, $was - $k );
					}
					$text = array(
						'todo'  => 'Not started',
						'doing' => 'In progress',
						'done'  => 'Completed',
					);
					GRP_Activity::audit( $count >= $n ? 'done' : 'progress', 'monthly', $task, self::actor(), self::period_label( $task, $week ) . ' · ' . $step['name'] . ' · ' . self::name_of( $step['member'] ) . ': ' . $text[ GRP_Steps::state( $before, $step['id'], $n ) ] . ' → ' . $text[ GRP_Steps::state( $done, $step['id'], $n ) ] . ( $n > 1 ? " · $k of $n" : '' ) );

					return self::save( $id, $prev, $row );
				}
			)
		);
	}

	/**
	 * POST /records/status `{taskId, periodKey, status, note?, link?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_status( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, $period_key, $week, $rec ) = $ctx;

		$to = (string) $request['status'];
		if ( ! in_array( $to, self::STATUSES, true ) ) {
			return self::invalid( __( 'Invalid status.', 'gridrankers-portal' ) );
		}

		$state = self::state( $task, $rec );
		if ( $to === $state ) {
			return self::unchanged( $rec );
		}

		if ( 'skipped' === $to ) {
			if ( ! self::can( GRP_Permissions::SKIP_PERIOD ) || 'done' === $state ) {
				return self::forbidden( __( 'Only a Super Admin or Team Leader can skip open work.', 'gridrankers-portal' ) );
			}
		} elseif ( GRP_Steps::on( $task ) && ! ( 'skipped' === $state && 'todo' === $to ) ) {
			return self::invalid( __( 'This task has steps — tick the steps instead.', 'gridrankers-portal' ), 'grp_has_steps' );
		} elseif ( ! self::can(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => self::as_task( $task, $rec ),
				'to'   => $to,
			)
		) ) {
			return self::forbidden( self::denied_message( $task, $rec ) );
		}

		$completion = 'done' === $to ? self::completion( $request, true ) : null;
		if ( is_wp_error( $completion ) ) {
			return $completion;
		}

		$n     = max( 1, (int) $task['target'] );
		$count = 'done' === $to ? $n : ( 'doing' === $to ? min( self::count_of( $rec ), $n - 1 ) : 0 );

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $period_key, $week, $rec, $count, $to, $completion ) {
					return self::write( $task, $period_key, $week, $rec, $count, $to, null, null, '', $completion );
				}
			)
		);
	}

	/**
	 * POST /records/undo `{taskId, periodKey, reason}`: a Team Member asks to put a period they
	 * moved to In progress by mistake back to Not started (SPEC.md 6.6).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function request_undo( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, , , $rec ) = $ctx;
		if ( ! $rec || ! self::can( GRP_Permissions::REQUEST_UNDO, array( 'task' => self::as_task( $task, $rec ) ) ) ) {
			return self::forbidden( __( 'Only the person working on a task that is In progress can ask to undo it.', 'gridrankers-portal' ) );
		}
		if ( GRP_Undo::pending( $rec ) ) {
			return self::conflict( __( 'An undo is already requested for this task.', 'gridrankers-portal' ), 'grp_undo_pending' );
		}
		$undo = GRP_Undo::request( $request['reason'] ?? '', self::actor() );
		if ( is_wp_error( $undo ) ) {
			return $undo;
		}
		$record = GRP_Store::update( self::TABLE, $rec['id'], array( 'undo_request' => $undo ) );
		GRP_Activity::audit( 'progress', 'monthly', $task, self::actor(), self::period_label( $task, $rec['week'] ) . ' · undo requested' );

		return rest_ensure_response(
			array(
				'record' => $record,
				'id'     => $rec['id'],
			)
		);
	}

	/**
	 * POST /records/undo/decide `{taskId, periodKey, action: undo|keep, note?}`. Team Leaders and
	 * the Super Admin; the person who asked gets a notice with the answer.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function decide_undo( WP_REST_Request $request ) {
		$ctx = self::context( $request );
		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}
		list( $task, $period_key, $week, $rec ) = $ctx;
		if ( ! self::can( GRP_Permissions::DECIDE_UNDO ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can answer a request to undo.', 'gridrankers-portal' ) );
		}
		$undo = GRP_Undo::pending( $rec );
		if ( ! $undo ) {
			return self::conflict( __( 'There is no request to undo on this task.', 'gridrankers-portal' ), 'grp_undo_none' );
		}
		$action = (string) $request['action'];
		if ( ! in_array( $action, array( 'undo', 'keep' ), true ) ) {
			return self::invalid( __( 'Choose Undo or Keep.', 'gridrankers-portal' ) );
		}
		$approved = 'undo' === $action && 'doing' === $rec['status'];
		$note     = $request['note'] ?? '';

		return rest_ensure_response(
			GRP_Store::transaction(
				static function () use ( $task, $period_key, $week, $rec, $undo, $approved, $note ) {
					$out = $approved
						? self::write( $task, $period_key, $week, $rec, 0, 'todo' )
						: array(
							'record' => GRP_Store::update( self::TABLE, $rec['id'], array( 'undo_request' => null ) ),
							'id'     => $rec['id'],
						);
					GRP_Undo::answer( $undo, $approved, $task['title'], $note, self::actor() );
					return $out;
				}
			)
		);
	}

	/**
	 * Port of the reference `writeRec`: stores a period's count, per-person and per-row
	 * counts, credits or removes activity for the difference, and handles completion/review.
	 *
	 * @param array       $task       Monthly task.
	 * @param string      $period_key Period key.
	 * @param int|null    $week       Week (weekly) or two-week period (bi-weekly) number.
	 * @param array|null  $prev       Existing record.
	 * @param int         $count      New count (whole task, or the person's own count with `$pid`).
	 * @param string      $status     doing, done, todo or skipped.
	 * @param string|null $pid        Person whose share changes.
	 * @param array|null  $parts_in   New breakdown counts.
	 * @param string      $label      Breakdown row name for the activity detail.
	 * @param array|null  $completion Completion note.
	 * @return array `{record, id}` — record is null when the period was reset.
	 */
	public static function write( array $task, $period_key, $week, $prev, $count, $status, $pid = null, $parts_in = null, $label = '', $completion = null ) {
		$n          = max( 1, (int) $task['target'] );
		$id         = GRP_Cycles::record_id( $task['id'], $period_key );
		$prev       = $prev ? $prev : array();
		$prev_count = 'skipped' === ( $prev['status'] ?? '' ) ? 0 : (int) ( $prev['count'] ?? 0 );
		$count      = max( 0, min( $n, (int) $count ) );
		$by         = (array) ( $prev['by_person'] ?? array() );

		if ( $pid ) {
			$share      = self::share_of( $task, $pid );
			$by[ $pid ] = max( 0, min( $share ? $share : $n, $count ) );
			$count      = min( $n, (int) array_sum( $by ) );
		} elseif ( self::shared( $task ) ) {
			if ( $count <= 0 ) {
				$by = array();
			} elseif ( $count >= $n ) {
				foreach ( (array) $task['assignees'] as $a ) {
					$by[ $a['id'] ] = (int) $a['n'];
				}
			}
		}

		$parts = null;
		if ( ! empty( $task['parts'] ) ) {
			$parts = null !== $parts_in ? $parts_in : (array) ( $prev['parts'] ?? array() );
			if ( null === $parts_in ) {
				if ( $count <= 0 ) {
					$parts = array();
				} elseif ( $count >= $n ) {
					foreach ( $task['parts'] as $x ) {
						$parts[ $x['id'] ] = (int) $x['n'];
					}
				}
			}
		}

		$where = self::period_label( $task, $week );
		$delta = ( 'skipped' === $status ? 0 : $count ) - $prev_count;
		if ( $delta > 0 ) {
			$detail = ( $label ? $label . ' · ' : '' ) . ( $n > 1 ? "$where · $count/$n" : $where );
			GRP_Activity::credit( self::actor()['id'], $task['project_id'], $task['title'], $detail, $delta, 'monthly', 'rec:' . $id );
		} elseif ( $delta < 0 ) {
			GRP_Activity::uncredit( 'rec:' . $id, -$delta );
		}

		$base = array(
			'task_id'      => $task['id'],
			'project_id'   => $task['project_id'],
			'period_key'   => $period_key,
			'week'         => $week,
			'by_person'    => $by,
			'parts'        => $parts,
			// Any change answers a pending request to undo (SPEC.md 6.6).
			'undo_request' => null,
		);

		if ( 'skipped' === $status ) {
			// Skipping takes back what the steps had done this period (SPEC.md 6.16).
			if ( GRP_Steps::on( $task ) ) {
				foreach ( $task['steps'] as $step ) {
					GRP_Activity::uncredit( GRP_Steps::ref( 'stepr', $id, $step['id'] ) );
				}
				$base['step_done'] = null;
			}
			GRP_Activity::audit( 'progress', 'monthly', $task, self::actor(), "$where · skipped" );
			return self::save(
				$id,
				$prev,
				$base + array(
					'count'     => 0,
					'status'    => 'skipped',
					'by_person' => array(),
					'review'    => null,
					'done_at'   => null,
				)
			);
		}

		if ( ! $count && 'doing' !== $status ) {
			GRP_Activity::audit( 'progress', 'monthly', $task, self::actor(), "$where · reset to not started" );
			if ( $prev ) {
				GRP_Store::delete( self::TABLE, $id );
			}
			return array(
				'record' => null,
				'id'     => $id,
			);
		}

		$done = $count >= $n;
		$rec  = $base + array(
			'count'   => $count,
			'status'  => $done ? 'done' : 'doing',
			'done_at' => $done ? ( $prev['done_at'] ?? GRP_Ids::now() ) : null,
		);
		if ( $done ) {
			$rec['review']     = $prev_count >= $n && ! empty( $prev['review'] ) ? $prev['review'] : self::new_review();
			$rec['completion'] = $prev_count >= $n ? ( $prev['completion'] ?? null ) : ( $completion ? $completion : ( $prev['completion'] ?? null ) );
		} else {
			$review        = $prev['review'] ?? null;
			$rec['review'] = is_array( $review ) && in_array( $review['state'] ?? '', array( 'revision', 'rejected' ), true ) ? $review : null;
		}

		GRP_Activity::audit( $done ? 'done' : 'progress', 'monthly', $task, self::actor(), $n > 1 ? "$where · $prev_count/$n → $count/$n" : "$where · " . ( $done ? 'done' : 'in progress' ) );

		return self::save( $id, $prev, $rec );
	}

	/**
	 * Inserts or updates a record.
	 *
	 * @param string $id   Record id.
	 * @param array  $prev Existing record (empty when new).
	 * @param array  $row  Columns.
	 * @return array `{record, id}`.
	 */
	private static function save( $id, array $prev, array $row ) {
		$record = $prev ? GRP_Store::update( self::TABLE, $id, $row ) : GRP_Store::insert( self::TABLE, array( 'id' => $id ) + $row );

		return array(
			'record' => $record,
			'id'     => $id,
		);
	}

	/**
	 * Loads task + period from a request and validates the period key.
	 *
	 * Weekly: `{cycle key}-wN`, a started week of the project's cycle. Monthly: the key of a current or past cycle of the project
	 * (waived transition periods cannot be worked on).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error `[task, period_key, week, record]`.
	 */
	private static function context( WP_REST_Request $request ) {
		$task = GRP_Store::get( 'grp_monthly_tasks', (string) $request['taskId'] );
		if ( ! $task ) {
			return self::not_found();
		}
		$project = GRP_Store::get( 'grp_projects', $task['project_id'] );
		if ( ! $project ) {
			return self::not_found();
		}

		$key   = (string) $request['periodKey'];
		$today = GRP_Cycles::today();
		$week  = null;

		if ( GRP_Cycles::is_weekly( $task ) || GRP_Cycles::is_biweekly( $task ) ) {
			// `{cycle key}-wN` (weekly) or `-hN` (bi-weekly): a started week or two-week period
			// of a current or past cycle of the project.
			$letter = GRP_Cycles::is_weekly( $task ) ? 'w' : 'h';
			$period = null;
			if ( preg_match( '/^(.+)-' . $letter . '([1-9])$/', $key, $m ) ) {
				$period = wp_list_filter( GRP_Cycles::periods_of( $project, $today ), array( 'key' => $m[1] ) );
				$period = $period ? reset( $period ) : null;
			}
			$slots = $period ? GRP_Cycles::slots_in( $task, $period ) : array();
			$week  = $period ? (int) $m[2] : 0;
			if ( ! $period || $week > count( $slots ) || $slots[ $week - 1 ]['start'] > $today ) {
				return self::invalid( 'w' === $letter ? __( 'Invalid week.', 'gridrankers-portal' ) : __( 'Invalid two-week period.', 'gridrankers-portal' ) );
			}
		} else {
			$period = wp_list_filter( GRP_Cycles::periods_of( $project, $today ), array( 'key' => $key ) );
			$period = $period ? reset( $period ) : null;
			if ( ! $period || $period['start'] > $today ) {
				return self::invalid( __( 'Invalid cycle.', 'gridrankers-portal' ) );
			}
			if ( 'waived' === $period['monthly'] ) {
				return self::invalid( __( 'Monthly tasks are waived in this transition period.', 'gridrankers-portal' ) );
			}
		}

		return array( $task, $key, $week, GRP_Store::get( self::TABLE, GRP_Cycles::record_id( $task['id'], $key ) ) );
	}

	/**
	 * Record state as the reference `mState` sees it.
	 *
	 * @param array      $task Task.
	 * @param array|null $rec  Record.
	 * @return string todo, doing, done or skipped.
	 */
	private static function state( array $task, $rec ) {
		if ( $rec && 'skipped' === $rec['status'] ) {
			return 'skipped';
		}
		$count = self::count_of( $rec );
		if ( $count >= max( 1, (int) $task['target'] ) ) {
			return 'done';
		}

		return ( $rec && ( 'doing' === $rec['status'] || $count > 0 ) ) ? 'doing' : 'todo';
	}

	/**
	 * Task shaped for GRP_Permissions, with the period's state as status.
	 *
	 * @param array      $task Task.
	 * @param array|null $rec  Record.
	 * @return array
	 */
	private static function as_task( array $task, $rec ) {
		$state = self::state( $task, $rec );

		return array(
			'status'    => 'skipped' === $state ? 'todo' : $state,
			'assignees' => $task['assignees'],
			'target'    => $task['target'],
		);
	}

	/**
	 * Count of a record (skipped counts as 0).
	 *
	 * @param array|null $rec Record.
	 * @return int
	 */
	private static function count_of( $rec ) {
		return $rec && 'skipped' !== $rec['status'] ? (int) $rec['count'] : 0;
	}

	/**
	 * Units a person has done in a record.
	 *
	 * @param array|null $rec Record.
	 * @param string     $id  Member id.
	 * @return int
	 */
	private static function done_by( $rec, $id ) {
		return (int) ( ( $rec['by_person'] ?? array() )[ $id ] ?? 0 );
	}

	/**
	 * A person's share of a task.
	 *
	 * @param array  $task Task.
	 * @param string $id   Member id.
	 * @return int
	 */
	private static function share_of( array $task, $id ) {
		$match = wp_list_filter( (array) $task['assignees'], array( 'id' => $id ) );

		return $match ? (int) reset( $match )['n'] : 0;
	}

	/**
	 * Shared task: several people with their own numbers (reference `sharedTask`).
	 *
	 * @param array $task Task.
	 * @return bool
	 */
	private static function shared( array $task ) {
		return ! (int) $task['team'] && count( (array) $task['assignees'] ) > 1;
	}

	/**
	 * Whose share a breakdown tick counts for when the row has no single person:
	 * the actor when assigned, else the first person with room (or with units to undo).
	 *
	 * @param array      $task  Task.
	 * @param array|null $rec   Record.
	 * @param int        $delta +1 or -1.
	 * @return string|null
	 */
	private static function worker_for( array $task, $rec, $delta ) {
		$actor_id = self::actor()['id'];
		if ( self::share_of( $task, $actor_id ) ) {
			return $actor_id;
		}
		foreach ( (array) $task['assignees'] as $a ) {
			$done = self::done_by( $rec, $a['id'] );
			if ( $delta > 0 ? $done < (int) $a['n'] : $done > 0 ) {
				return $a['id'];
			}
		}

		return null;
	}

	/**
	 * "Week N", "2-week period N" or "This cycle".
	 *
	 * @param array    $task Task.
	 * @param int|null $week Week or two-week period number.
	 * @return string
	 */
	private static function period_label( array $task, $week ) {
		if ( GRP_Cycles::is_biweekly( $task ) ) {
			return "2-week period $week";
		}

		return GRP_Cycles::is_weekly( $task ) ? "Week $week" : 'This cycle';
	}

	/**
	 * The record unchanged.
	 *
	 * @param array|null $rec Record.
	 * @return WP_REST_Response
	 */
	private static function unchanged( $rec ) {
		return rest_ensure_response(
			array(
				'record' => $rec,
				'id'     => $rec['id'] ?? null,
			)
		);
	}

	/**
	 * Why a change was refused.
	 *
	 * @param array      $task Task.
	 * @param array|null $rec  Record.
	 * @return string
	 */
	private static function denied_message( array $task, $rec ) {
		$state      = self::state( $task, $rec );
		$unassigned = self::not_assigned_message( $task );
		if ( null !== $unassigned && 'done' !== $state ) {
			return $unassigned;
		}
		if ( 'done' === $state ) {
			return __( "It's completed. Only a Team Leader or Super Admin can send it back (Revise or Reject).", 'gridrankers-portal' );
		}
		if ( 'doing' === $state && self::can(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => self::as_task( $task, $rec ),
				'to'   => 'doing',
			)
		) ) {
			return __( "It's in progress — only a Team Leader or Super Admin can move it back to the start.", 'gridrankers-portal' );
		}

		return __( 'Only people assigned to this task can tick it off.', 'gridrankers-portal' );
	}
}
