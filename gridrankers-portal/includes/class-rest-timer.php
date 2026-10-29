<?php
/**
 * REST: /timer, /time-entries and /settings/work-start (SPEC.md 6.21).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The timer and time entries, for the desktop tracker (device token) and the portal (session).
 */
class GRP_REST_Timer extends GRP_REST_Controller {

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/timer', WP_REST_Server::READABLE, 'show' );
		self::route( '/timer/start', WP_REST_Server::CREATABLE, 'start' );
		self::route( '/timer/stop', WP_REST_Server::CREATABLE, 'stop' );
		self::route( '/timer/schedule', WP_REST_Server::READABLE, 'schedule' );
		self::route( '/timer/tasks', WP_REST_Server::READABLE, 'tasks' );
		self::route( '/time-entries', WP_REST_Server::READABLE, 'index' );
		self::route( '/time-entries/batch', WP_REST_Server::CREATABLE, 'batch' );
		self::route( '/time-entries/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/time-entries/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/time-entries/(?P<id>[\w-]+)/restore', WP_REST_Server::CREATABLE, 'restore' );
		self::route( '/settings/work-start', 'PUT', 'work_start' );
	}

	/**
	 * GET /timer: the actor's running timer, or null, and the server's clock (the app compares it with its own).
	 *
	 * @return WP_REST_Response
	 */
	public static function show() {
		return rest_ensure_response(
			array(
				'timer' => GRP_Time_Entries::running( (string) self::actor()['id'] ),
				'now'   => GRP_Ids::now(),
			)
		);
	}

	/**
	 * POST /timer/start `{id?, project_id?, ref_kind?, ref_id?, period_key?, note?, started_at?}`: starts
	 * the actor's timer; one already running is stopped when this one starts.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function start( WP_REST_Request $request ) {
		$raw = self::entry_params( $request );
		unset( $raw['ended_at'] );
		if ( empty( $raw['started_at'] ) ) {
			$raw['started_at'] = GRP_Ids::now();
		}

		$result = GRP_Time_Entries::save( self::actor(), $raw, self::context( $request ) + array( 'stop_running' => true ) );
		if ( 'refused' === $result['status'] ) {
			return self::refusal( $result );
		}

		return rest_ensure_response(
			array(
				'timer'   => $result['entry'],
				'stopped' => $result['stopped'] ?? null,
			)
		);
	}

	/**
	 * POST /timer/stop `{ended_at?, idle_seconds?}`: stops the actor's running timer.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function stop( WP_REST_Request $request ) {
		$actor   = self::actor();
		$running = GRP_Time_Entries::running( (string) $actor['id'] );
		if ( ! $running ) {
			return self::conflict( __( 'No timer is running.', 'gridrankers-portal' ), 'grp_time_not_running' );
		}
		$raw = array(
			'id'           => $running['id'],
			// Stopped right after starting (same second): it still ends a second after it began.
			'ended_at'     => self::param( $request, 'ended_at' ) ?? max( GRP_Ids::now(), GRP_Ids::now( strtotime( $running['started_at'] . ' UTC' ) + 1 ) ),
			'idle_seconds' => (int) $request['idle_seconds'],
		);

		$result = GRP_Time_Entries::save( $actor, $raw, self::context( $request ) );
		if ( 'refused' === $result['status'] ) {
			return self::refusal( $result );
		}

		return rest_ensure_response( array( 'entry' => $result['entry'] ) );
	}

	/**
	 * GET /timer/schedule?days=14: the actor's working day and schedule (SPEC.md 6.21).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function schedule( WP_REST_Request $request ) {
		$payload = GRP_REST_Auth::device_payload( self::actor(), self::int( $request['days'], 1, 62, GRP_REST_Auth::DEVICE_SCHEDULE_DAYS ) );

		return rest_ensure_response(
			array(
				'work_day' => $payload['work_day'],
				'schedule' => $payload['schedule'],
			)
		);
	}

	/**
	 * GET /timer/tasks: what the actor can track time on.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function tasks() {
		$actor = self::actor();
		if ( GRP_Permissions::ROLE_ADMIN === GRP_Permissions::effective_role( $actor ) ) {
			return self::forbidden( __( 'The Super Admin doesn’t track time.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response( GRP_Time_Entries::tasks_for( $actor ) );
	}

	/**
	 * GET /time-entries?member=&from=&to=: a person's entries (the actor's own by default; up to 62 days,
	 * today by default).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index( WP_REST_Request $request ) {
		$id     = (string) ( $request['member'] ?? '' );
		$member = '' === $id ? self::actor() : GRP_Store::get( 'grp_members', $id );
		if ( ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::VIEW_TIME, self::owner( $member ) ) ) {
			return self::forbidden();
		}
		$today = GRP_Cycles::today();
		$from  = self::date( $request['from'], 'from' );
		$to    = self::date( $request['to'], 'to' );
		if ( is_wp_error( $from ) || is_wp_error( $to ) ) {
			return is_wp_error( $from ) ? $from : $to;
		}
		$from = $from ?? $today;
		$to   = $to ?? $from;
		if ( $to < $from || $to > GRP_People::add_days( $from, 61 ) ) {
			return self::invalid( __( 'Pick up to 62 days.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response( GRP_Time_Entries::between( (string) $member['id'], $from, $to ) );
	}

	/**
	 * POST /time-entries/batch `{entries: [..≤200], clock_offset?}`: the desktop app's outbox. Each entry
	 * gets its own answer — saved, already there, or refused with why — and one refusal never blocks
	 * the others.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function batch( WP_REST_Request $request ) {
		$entries = $request['entries'];
		if ( ! is_array( $entries ) || ! $entries ) {
			return self::invalid( __( 'Nothing to send.', 'gridrankers-portal' ) );
		}
		if ( count( $entries ) > GRP_Time_Entries::MAX_BATCH ) {
			/* translators: %d: most entries. */
			return self::invalid( sprintf( __( 'Send at most %d entries at a time.', 'gridrankers-portal' ), GRP_Time_Entries::MAX_BATCH ) );
		}

		$context = self::context( $request );
		$actor   = self::actor();
		$results = array();
		// Oldest first, so a running entry sent before its stop is stopped by it.
		$entries = array_values( array_filter( $entries, 'is_array' ) );
		usort( $entries, static fn ( $a, $b ) => strcmp( (string) ( $a['started_at'] ?? '' ), (string) ( $b['started_at'] ?? '' ) ) );
		foreach ( $entries as $raw ) {
			$result    = GRP_Time_Entries::save( $actor, self::clean_raw( $raw ), $context );
			$results[] = array( 'id' => (string) ( $result['entry']['id'] ?? $raw['id'] ?? '' ) ) + $result;
		}

		return rest_ensure_response(
			array(
				'results' => $results,
				'now'     => GRP_Ids::now(),
			)
		);
	}

	/**
	 * PATCH /time-entries/{id} `{started_at?, ended_at?, project_id?, ref_kind?, ref_id?, period_key?, note?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$entry = self::editable( $request );
		if ( is_wp_error( $entry ) ) {
			return $entry;
		}
		$raw = self::entry_params( $request );
		// Moving an entry to another day needs the right to change that day too.
		if ( isset( $raw['started_at'] ) && GRP_Time::is_datetime( $raw['started_at'] ) && GRP_Time::day_of( $raw['started_at'] ) !== $entry['day'] ) {
			$member = GRP_Store::get( 'grp_members', (string) $entry['member_id'] );
			if ( ! self::can( GRP_Permissions::EDIT_TIME, self::owner( $member ) + array( 'day' => GRP_Time::day_of( $raw['started_at'] ) ) ) ) {
				return self::forbidden( __( 'You can change your own time on the same day only. Ask to change the report instead.', 'gridrankers-portal' ) );
			}
		}

		$result = GRP_Time_Entries::edit( $entry, $raw, (string) self::actor()['id'] );
		if ( 'refused' === $result['status'] ) {
			return self::refusal( $result );
		}

		return rest_ensure_response( $result['entry'] );
	}

	/**
	 * DELETE /time-entries/{id}: takes the time out of the person's report.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$entry = self::editable( $request );
		if ( is_wp_error( $entry ) ) {
			return $entry;
		}

		$result = GRP_Time_Entries::delete( $entry, (string) self::actor()['id'] );
		if ( 'refused' === $result['status'] ) {
			return self::refusal( $result );
		}

		return rest_ensure_response( array( 'deleted' => true ) );
	}

	/**
	 * POST /time-entries/{id}/restore: brings a deleted entry back (within 30 days) by whoever may
	 * change it; its time returns to the report.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function restore( WP_REST_Request $request ) {
		$entry  = GRP_Store::get( GRP_Time_Entries::TABLE, (string) $request['id'] );
		$member = $entry ? GRP_Store::get( 'grp_members', (string) $entry['member_id'] ) : null;
		if ( ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::EDIT_TIME, self::owner( $member ) + array( 'day' => $entry['day'] ) ) ) {
			return self::forbidden();
		}

		$result = GRP_Time_Entries::restore( $entry, (string) self::actor()['id'] );
		if ( 'refused' === $result['status'] ) {
			return self::refusal( $result );
		}

		return rest_ensure_response( $result['entry'] );
	}

	/**
	 * PUT /settings/work-start `{start}`: the team's start of the working day (Super Admin).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function work_start( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::SET_WORK_START ) ) {
			return self::forbidden( __( 'Only the Super Admin sets the team’s start of the day.', 'gridrankers-portal' ) );
		}
		$start = GRP_Time::start_time( (string) $request['start'] );
		if ( null === $start ) {
			return self::invalid( __( 'Pick a time like 09:00.', 'gridrankers-portal' ) );
		}
		GRP_REST_People::set_setting( GRP_Time::START_KEY, array( 'start' => $start ) );

		return rest_ensure_response( array( 'start' => $start ) );
	}

	/**
	 * The entry of a request that the actor may change, or an error.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	private static function editable( WP_REST_Request $request ) {
		$entry  = GRP_Store::get( GRP_Time_Entries::TABLE, (string) $request['id'] );
		$member = $entry && empty( $entry['deleted_at'] ) ? GRP_Store::get( 'grp_members', (string) $entry['member_id'] ) : null;
		if ( ! $member ) {
			return self::not_found();
		}
		$context = self::owner( $member ) + array( 'day' => $entry['day'] );
		if ( ! self::can( GRP_Permissions::EDIT_TIME, $context ) ) {
			$own = (string) self::actor()['id'] === (string) $entry['member_id'];

			return self::forbidden( $own ? __( 'You can change your own time on the same day only. Ask to change the report instead.', 'gridrankers-portal' ) : '' );
		}

		return $entry;
	}

	/**
	 * Entry fields of a request.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	private static function entry_params( WP_REST_Request $request ) {
		$raw = array();
		foreach ( array( 'id', 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at', 'idle_seconds' ) as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$raw[ $key ] = $request->get_param( $key );
			}
		}

		return self::clean_raw( $raw );
	}

	/**
	 * Entry fields as plain scalars.
	 *
	 * @param array $raw Entry as sent.
	 * @return array
	 */
	private static function clean_raw( array $raw ) {
		$out = array();
		foreach ( array( 'id', 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at' ) as $key ) {
			if ( array_key_exists( $key, $raw ) ) {
				$out[ $key ] = is_scalar( $raw[ $key ] ) ? (string) $raw[ $key ] : null;
			}
		}
		if ( isset( $raw['idle_seconds'] ) && is_numeric( $raw['idle_seconds'] ) ) {
			$out['idle_seconds'] = (int) $raw['idle_seconds'];
		}

		return $out;
	}

	/**
	 * A request parameter as a string, or null when absent or empty.
	 *
	 * @param WP_REST_Request $request Request.
	 * @param string          $key     Parameter.
	 * @return string|null
	 */
	private static function param( WP_REST_Request $request, $key ) {
		$value = $request->get_param( $key );

		return is_scalar( $value ) && '' !== (string) $value ? (string) $value : null;
	}

	/**
	 * Where a save comes from: the desktop app (its device) or the portal; the app's clock offset.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	private static function context( WP_REST_Request $request ) {
		$device = GRP_Auth::uses_device() ? GRP_Auth::current_device() : null;

		return array(
			'source'       => $device ? 'desktop' : 'web',
			'device_id'    => $device['id'] ?? null,
			'clock_offset' => is_numeric( $request['clock_offset'] ) ? (int) $request['clock_offset'] : 0,
		);
	}

	/**
	 * A refused save as an error response.
	 *
	 * @param array $result Refusal.
	 * @return WP_Error
	 */
	private static function refusal( array $result ) {
		$status = in_array( $result['code'], array( 'grp_forbidden', 'grp_profile_incomplete' ), true ) ? 403 : 409;
		if ( in_array( $result['code'], array( 'grp_time_invalid', 'grp_time_order', 'grp_time_too_long', 'grp_time_future', 'grp_time_task', 'grp_time_too_old' ), true ) ) {
			$status = 400;
		}

		return new WP_Error( $result['code'], $result['message'], array( 'status' => $status ) );
	}

	/**
	 * Permission context of an entry's person.
	 *
	 * @param array $member Person.
	 * @return array `{member_id, role}`.
	 */
	private static function owner( array $member ) {
		return array(
			'member_id' => (string) $member['id'],
			'role'      => GRP_Permissions::effective_role( $member ),
		);
	}
}
