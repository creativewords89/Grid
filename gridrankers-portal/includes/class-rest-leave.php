<?php
/**
 * REST: /leave (SPEC.md 6.10).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Day leave: Team Members request it (pending until a Team Leader or the Super Admin
 * decides), Team Leaders take it (approved straight away), the Super Admin has none.
 * Team Leaders and the Super Admin may also issue a day off to someone else: approved day
 * leave for that person, counted like any other.
 * Settlement and year-end counts are for the Super Admin.
 */
class GRP_REST_Leave extends GRP_REST_Controller {

	const TABLE = 'grp_leave';

	/**
	 * Leave may end at most this many days ahead.
	 */
	const FUTURE_DAYS = 366;

	/**
	 * Decisions: action => new status.
	 */
	const ACTIONS = array(
		'approve' => 'approved',
		'reject'  => 'rejected',
		'cancel'  => 'cancelled',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/leave', WP_REST_Server::READABLE, 'index' );
		self::route( '/leave', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/leave/report', WP_REST_Server::READABLE, 'report' );
		self::route( '/leave/(?P<id>[\w-]+)', 'PATCH', 'decide' );
	}

	/**
	 * GET /leave `?member=&status=&month=YYYY-MM`. Team Members get their own leave only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index( WP_REST_Request $request ) {
		$where = array();
		if ( ! self::is_manager() ) {
			$where['member_id'] = self::actor()['id'];
		} elseif ( ! empty( $request['member'] ) ) {
			$where['member_id'] = (string) $request['member'];
		}
		if ( in_array( $request['status'], array( 'pending', 'approved', 'rejected', 'cancelled' ), true ) ) {
			$where['status'] = (string) $request['status'];
		}
		$rows = GRP_Store::find( self::TABLE, $where, array( 'order_by' => 'from_date' ) );

		$month = (string) $request['month'];
		if ( preg_match( '/^\d{4}-\d{2}$/', $month ) ) {
			$rows = array_values(
				array_filter(
					$rows,
					static function ( $row ) use ( $month ) {
						return substr( $row['from_date'], 0, 7 ) <= $month && substr( $row['to_date'], 0, 7 ) >= $month;
					}
				)
			);
		}

		return rest_ensure_response( array_reverse( $rows ) );
	}

	/**
	 * POST /leave `{type: day|sick, from, to, reason?}` for oneself, or `{member_id, from, to,
	 * note?}` to issue a day off to someone else (Team Leaders and the Super Admin).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$actor     = self::actor();
		$member_id = (string) ( $request['member_id'] ?? $actor['id'] );
		if ( '' === $member_id ) {
			$member_id = $actor['id'];
		}
		$issue  = $member_id !== $actor['id'];
		$person = $issue ? GRP_Store::get( 'grp_members', $member_id ) : $actor;
		if ( $issue ) {
			if ( ! $person || ! (int) $person['active'] ) {
				return self::invalid( __( 'Pick someone on the team.', 'gridrankers-portal' ) );
			}
			$context = array(
				'member_id' => $member_id,
				'role'      => GRP_Permissions::effective_role( $person ),
			);
			if ( ! self::can( GRP_Permissions::ISSUE_LEAVE, $context ) ) {
				return self::is_manager()
					? self::forbidden( __( "You can't give a day off to this person.", 'gridrankers-portal' ) )
					: self::forbidden( __( 'You can only ask for your own leave.', 'gridrankers-portal' ) );
			}
		} elseif ( ! self::can( GRP_Permissions::TAKE_LEAVE, array( 'member_id' => $member_id ) ) ) {
			return self::forbidden( __( 'The Super Admin has no leave in the portal.', 'gridrankers-portal' ) );
		}

		$from = self::date( $request['from'] ?? '', 'start date' );
		$to   = self::date( $request['to'] ?? ( $request['from'] ?? '' ), 'end date' );
		if ( is_wp_error( $from ) || is_wp_error( $to ) ) {
			return is_wp_error( $from ) ? $from : $to;
		}
		if ( ! $from || ! $to || $to < $from ) {
			return self::invalid( __( 'Pick the first and last day of your leave.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		if ( $from < GRP_People::add_days( $today, -GRP_People::PAST_DAYS ) ) {
			/* translators: %d: number of days. */
			return self::invalid( sprintf( __( 'Leave can start at most %d days ago.', 'gridrankers-portal' ), GRP_People::PAST_DAYS ) );
		}
		if ( $to > GRP_People::add_days( $today, self::FUTURE_DAYS ) ) {
			return self::invalid( __( 'That is too far ahead.', 'gridrankers-portal' ) );
		}

		$leaves = GRP_Store::find( self::TABLE, array( 'member_id' => $member_id ) );
		if ( GRP_People::overlaps( $member_id, $from, $to, $leaves ) ) {
			return $issue
				? self::conflict( __( 'They already have leave on some of those days.', 'gridrankers-portal' ), 'grp_leave_overlap' )
				: self::conflict( __( 'You already have leave on some of those days.', 'gridrankers-portal' ), 'grp_leave_overlap' );
		}
		$days = array_sum( GRP_People::leave_days( $from, $to, $person, GRP_REST_People::team_weekly(), GRP_REST_People::days_off() ) );
		if ( ! $days ) {
			return self::invalid( __( 'Those days are all days off already.', 'gridrankers-portal' ), 'grp_leave_no_days' );
		}

		$lead = GRP_Permissions::ROLE_LEAD === GRP_Permissions::effective_role( $actor );
		$row  = array(
			'member_id'  => $member_id,
			// An issued day off is day leave.
			'type'       => ! $issue && 'sick' === $request['type'] ? 'sick' : 'day',
			'from_date'  => $from,
			'to_date'    => $to,
			'days'       => min( 255, $days ),
			'reason'     => $issue ? '' : self::textarea( $request['reason'] ?? '', 500 ),
			'status'     => $lead || $issue ? 'approved' : 'pending',
			'created_by' => $actor['id'],
		);
		if ( $lead || $issue ) {
			// Team Leaders' leave and an issued day off are approved straight away (SPEC.md 6.10).
			$row['decided_by'] = $actor['id'];
			$row['decided_at'] = GRP_Ids::now();
		}
		if ( $issue ) {
			// The note for them: shown with the message they get.
			$note           = self::textarea( $request['note'] ?? '', 500 );
			$row['message'] = '' !== $note ? $note : null;
		}

		$saved = GRP_Store::transaction(
			static function () use ( $row, $actor ) {
				$saved = GRP_Store::insert( self::TABLE, $row );
				GRP_Activity::audit( 'add', 'leave', self::audit_doc( $saved ), $actor, self::audit_text( $saved ) );
				return $saved;
			}
		);

		return new WP_REST_Response( $saved, 201 );
	}

	/**
	 * PATCH /leave/{id} `{action: approve|reject|cancel, message?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function decide( WP_REST_Request $request ) {
		$leave = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $leave ) {
			return self::not_found();
		}
		$action = (string) $request['action'];
		if ( ! isset( self::ACTIONS[ $action ] ) ) {
			return self::invalid( __( 'Invalid leave action.', 'gridrankers-portal' ) );
		}
		$owner = GRP_Store::get( 'grp_members', $leave['member_id'] );
		$role  = $owner ? GRP_Permissions::effective_role( $owner ) : null;

		if ( 'cancel' === $action ) {
			$context = array(
				'member_id'  => $leave['member_id'],
				'role'       => $role,
				'status'     => $leave['status'],
				'created_by' => $leave['created_by'],
			);
			if ( ! self::can( GRP_Permissions::CANCEL_LEAVE, $context ) ) {
				return self::forbidden( __( "You can't cancel this leave.", 'gridrankers-portal' ) );
			}
		} else {
			if ( ! self::can( GRP_Permissions::DECIDE_LEAVE, array( 'role' => $role ) ) ) {
				return self::forbidden( __( 'Only a Team Leader or the Super Admin can decide leave requests.', 'gridrankers-portal' ) );
			}
			if ( 'pending' !== $leave['status'] ) {
				return self::conflict( __( 'This request has already been decided.', 'gridrankers-portal' ), 'grp_leave_decided' );
			}
		}

		$changes = array(
			'status'     => self::ACTIONS[ $action ],
			'decided_by' => self::actor()['id'],
			'decided_at' => GRP_Ids::now(),
		);
		$message = self::textarea( $request['message'] ?? '', 500 );
		if ( '' !== $message || 'cancel' !== $action ) {
			$changes['message'] = '' !== $message ? $message : null;
		}

		$updated = GRP_Store::transaction(
			static function () use ( $leave, $changes ) {
				$updated = GRP_Store::update( self::TABLE, $leave['id'], $changes );
				GRP_Activity::audit( 'edit', 'leave', self::audit_doc( $updated ), self::actor(), self::audit_text( $updated ) );
				return $updated;
			}
		);

		return rest_ensure_response( $updated );
	}

	/**
	 * GET /leave/report `?month=YYYY-MM` (settlement) or `?year=YYYY` (counts). Super Admin.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function report( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::VIEW_LEAVE_REPORT ) ) {
			return self::forbidden( __( 'Only the Super Admin can see leave reports.', 'gridrankers-portal' ) );
		}
		$people   = array_values(
			array_filter(
				GRP_Store::find( 'grp_members', array( 'active' => 1 ), array( 'order_by' => 'name' ) ),
				static function ( $m ) {
					return GRP_Permissions::ROLE_ADMIN !== GRP_Permissions::effective_role( $m );
				}
			)
		);
		$leaves   = GRP_Store::find( self::TABLE, array( 'status' => 'approved' ) );
		$weekly   = GRP_REST_People::team_weekly();
		$days_off = GRP_REST_People::days_off();

		$month = (string) $request['month'];
		if ( preg_match( '/^(\d{4})-(0[1-9]|1[0-2])$/', $month ) ) {
			$rows = array();
			foreach ( $people as $person ) {
				$rows[] = array( 'member_id' => $person['id'] ) + GRP_People::settlement( GRP_People::taken_in_month( $person, $month, $leaves, $weekly, $days_off ) );
			}
			return rest_ensure_response(
				array(
					'month' => $month,
					'rows'  => $rows,
				)
			);
		}

		$year = (int) $request['year'];
		if ( $year >= 2000 && $year <= 2100 ) {
			return rest_ensure_response(
				array(
					'year' => $year,
					'rows' => GRP_People::year_report( $year, $people, $leaves, $weekly, $days_off ),
				)
			);
		}

		return self::invalid( __( 'Pick a month or a year.', 'gridrankers-portal' ) );
	}

	/**
	 * A leave row as other people may see it (Who's out today): no type, reason or message.
	 *
	 * @param array $row Leave row.
	 * @return array
	 */
	public static function public_row( array $row ) {
		return array_intersect_key( $row, array_flip( array( 'id', 'member_id', 'from_date', 'to_date', 'status', 'updated_at' ) ) );
	}

	/**
	 * Audit document: titled with the person's name (the log is readable by everyone, so no
	 * type or reason).
	 *
	 * @param array $leave Leave row.
	 * @return array
	 */
	private static function audit_doc( array $leave ) {
		return array(
			'id'   => $leave['id'],
			'name' => self::name_of( $leave['member_id'] ),
		);
	}

	/**
	 * Audit detail, e.g. "Leave 2026-10-19 – 2026-10-21 (3 days): pending".
	 *
	 * @param array $leave Leave row.
	 * @return string
	 */
	private static function audit_text( array $leave ) {
		$range = $leave['from_date'] === $leave['to_date'] ? $leave['from_date'] : $leave['from_date'] . ' – ' . $leave['to_date'];

		return sprintf( 'Leave %s (%d %s): %s', $range, $leave['days'], 1 === (int) $leave['days'] ? 'day' : 'days', $leave['status'] );
	}
}
