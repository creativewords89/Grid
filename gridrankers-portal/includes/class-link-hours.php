<?php
/**
 * Hours sent from the tracker portal to the main portal (SPEC.md 6.22).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The tracker portal sends every time entry made, changed, deleted or restored there to the main
 * portal (`POST /link/time-entries`), which saves it with every 6.21 check into its daily reports
 * and pay. On a main portal linked to a tracker, time comes only through the link.
 */
class GRP_Link_Hours {

	/**
	 * Entries sent at a time.
	 */
	const BATCH = 200;

	/**
	 * Batches sent in one go (the rest waits for the next run).
	 */
	const ROUNDS = 10;

	/**
	 * Fields of an entry that the main portal receives.
	 */
	const FIELDS = array( 'id', 'member_id', 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at', 'idle_seconds', 'source', 'flags', 'edited_by', 'deleted_at' );

	/**
	 * Hooks the push after time changes and the main portal's closed time routes.
	 */
	public static function init() {
		add_filter( 'rest_request_after_callbacks', array( __CLASS__, 'after_change' ), 10, 3 );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'main_closed' ), 11, 3 );
	}

	/**
	 * Whether this site is a main portal linked to a tracker portal.
	 *
	 * @return bool
	 */
	public static function main_linked() {
		return GRP_Link::has_key();
	}

	/**
	 * Filter rest_pre_dispatch on a linked main portal: time is tracked on the tracker portal, so
	 * its own timer and time changes (and the desktop sign-in) are refused with `grp_tracker_portal`.
	 *
	 * @param mixed           $result  Response so far.
	 * @param WP_REST_Server  $server  Server.
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function main_closed( $result, $server, $request ) {
		$base = '/' . GRP_REST_Auth::REST_NAMESPACE;
		$path = (string) $request->get_route();
		if ( null !== $result || ! self::main_linked() || ! str_starts_with( $path, $base . '/' ) || in_array( $request->get_method(), array( 'GET', 'HEAD', 'OPTIONS' ), true ) ) {
			return $result;
		}
		$path = substr( $path, strlen( $base ) );
		$time = '/timer' === $path || str_starts_with( $path, '/timer/' ) || str_starts_with( $path, '/time-entries' );
		// Signing a computer out still works (DELETE /auth/device); signing one in doesn't.
		$sign_in = '/auth/device' === $path && 'POST' === $request->get_method();
		if ( ! $time && ! $sign_in ) {
			return $result;
		}
		$host = (string) wp_parse_url( GRP_Link::settings()['tracker_url'], PHP_URL_HOST );

		/* translators: %s: the tracker portal's address, e.g. tracker.gridrankers.com. */
		return new WP_Error( 'grp_tracker_portal', sprintf( __( 'Time is tracked on %s. Sign in there.', 'gridrankers-portal' ), $host ), array( 'status' => 403 ) );
	}

	/**
	 * Filter rest_request_after_callbacks on a tracker portal: a change to time sends it to the main
	 * portal when the request ends.
	 *
	 * @param WP_REST_Response|WP_Error $response Response.
	 * @param array                     $handler  Route handler.
	 * @param WP_REST_Request           $request  Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function after_change( $response, $handler, $request ) {
		$path = (string) $request->get_route();
		$base = '/' . GRP_REST_Auth::REST_NAMESPACE;
		if ( GRP_Link::is_tracker() && false === has_action( 'shutdown', array( __CLASS__, 'push_on_shutdown' ) ) && ! in_array( $request->get_method(), array( 'GET', 'HEAD', 'OPTIONS' ), true )
			&& ( str_starts_with( $path, $base . '/timer' ) || str_starts_with( $path, $base . '/time-entries' ) ) ) {
			add_action( 'shutdown', array( __CLASS__, 'push_on_shutdown' ) );
		}

		return $response;
	}

	/**
	 * Sends the changes after the answer has gone to the browser or the app.
	 */
	public static function push_on_shutdown() {
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		}
		self::push();
	}

	/**
	 * Tracker portal: entries not on the main portal yet (new, changed since sent, or never sent).
	 *
	 * @param int $limit Most entries.
	 * @return array[]
	 */
	public static function pending( $limit = self::BATCH ) {
		global $wpdb;

		// Changed in the second it was marked, or after; what was sent last is skipped by its hash.
		$rows = $wpdb->get_results( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT * FROM %i WHERE main_synced_at IS NULL OR updated_at >= main_synced_at ORDER BY started_at ASC, id ASC LIMIT %d',
				GRP_Install::table( GRP_Time_Entries::TABLE ),
				$limit
			),
			ARRAY_A
		);
		$out  = array();
		foreach ( $rows ? $rows : array() as $row ) {
			$row = GRP_Store::decode( GRP_Time_Entries::TABLE, $row );
			if ( self::hash( $row ) !== (string) $row['main_sent'] ) {
				$out[] = $row;
			}
		}

		return $out;
	}

	/**
	 * Tracker portal: sends what is pending to the main portal and keeps each answer on its entry.
	 *
	 * @return array|WP_Error `{sent, saved, refused}`.
	 */
	public static function push() {
		if ( ! GRP_Link::is_tracker() ) {
			return new WP_Error( 'grp_link_off', __( 'This site isn’t a tracker portal.', 'gridrankers-portal' ) );
		}
		$count = array(
			'sent'    => 0,
			'saved'   => 0,
			'refused' => 0,
		);
		for ( $round = 0; $round < self::ROUNDS; $round++ ) {
			$rows = self::pending();
			if ( ! $rows ) {
				break;
			}
			$sent = array_map( array( __CLASS__, 'outgoing' ), $rows );
			$res  = GRP_Link::call( 'POST', 'time-entries', array( 'entries' => $sent ) );
			if ( is_wp_error( $res ) ) {
				return $count['sent'] ? $count : $res;
			}
			$answers = array();
			foreach ( (array) ( $res['results'] ?? array() ) as $answer ) {
				if ( is_array( $answer ) && isset( $answer['id'] ) ) {
					$answers[ (string) $answer['id'] ] = $answer;
				}
			}
			foreach ( $sent as $entry ) {
				$answer = $answers[ $entry['id'] ] ?? null;
				if ( $answer ) {
					$refused = 'refused' === ( $answer['status'] ?? '' );
					// Not marked when it changed meanwhile: it goes again in the next round.
					self::mark( $entry, $refused ? (string) ( $answer['message'] ?? $answer['code'] ?? '' ) : null );
					++$count[ $refused ? 'refused' : 'saved' ];
				}
			}
			$count['sent'] += count( $sent );
			if ( ! $answers ) {
				break;
			}
		}

		return $count;
	}

	/**
	 * An entry as the main portal receives it.
	 *
	 * @param array $row Entry.
	 * @return array
	 */
	private static function outgoing( array $row ) {
		$out = array();
		foreach ( self::FIELDS as $field ) {
			$out[ $field ] = $row[ $field ] ?? null;
		}

		return $out;
	}

	/**
	 * What was sent of an entry, as a hash.
	 *
	 * @param array $row Entry.
	 * @return string
	 */
	private static function hash( array $row ) {
		return md5( (string) wp_json_encode( self::outgoing( $row ) ) );
	}

	/**
	 * Records the main portal's answer on an entry, unless it changed while it was being sent (then it
	 * goes again). `updated_at` moves with it, so the portal's live updates show the mark.
	 *
	 * @param array       $sent  Entry as sent.
	 * @param string|null $error Why the main portal refused it, or null.
	 * @return bool Whether it was marked.
	 */
	private static function mark( array $sent, $error ) {
		global $wpdb;

		$now = GRP_Store::get( GRP_Time_Entries::TABLE, $sent['id'] );
		if ( ! $now || wp_json_encode( self::outgoing( $now ) ) !== wp_json_encode( $sent ) ) {
			return false;
		}
		$at = GRP_Ids::now();

		return (bool) $wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			GRP_Install::table( GRP_Time_Entries::TABLE ),
			array(
				'main_synced_at' => $at,
				'main_sent'      => self::hash( $now ),
				'main_error'     => null === $error ? null : substr( $error, 0, 255 ),
				'updated_at'     => $at,
			),
			array( 'id' => $sent['id'] )
		);
	}

	/**
	 * Main portal: saves the tracker portal's entries (POST /link/time-entries) with every 6.21 check.
	 * An answer per entry: saved, already there, or refused with why.
	 *
	 * @param array $entries Entries as the tracker portal sends them.
	 * @return array[]
	 */
	public static function receive( array $entries ) {
		$entries = array_values( array_filter( $entries, 'is_array' ) );
		// Oldest first, so a running entry is stopped by its later version.
		usort( $entries, static fn ( $a, $b ) => strcmp( (string) ( $a['started_at'] ?? '' ), (string) ( $b['started_at'] ?? '' ) ) );

		$results = array();
		foreach ( $entries as $raw ) {
			$id        = (string) ( $raw['id'] ?? '' );
			$results[] = array( 'id' => $id ) + self::receive_one( $raw );
		}

		return $results;
	}

	/**
	 * Main portal: one entry from the tracker portal.
	 *
	 * @param array $raw Entry.
	 * @return array `{status, code?, message?}`.
	 */
	private static function receive_one( array $raw ) {
		$member = GRP_Store::get( 'grp_members', (string) ( $raw['member_id'] ?? '' ) );
		if ( ! $member ) {
			return self::refused( 'grp_time_member', __( 'That person isn’t on the main portal.', 'gridrankers-portal' ) );
		}
		$id     = (string) ( $raw['id'] ?? '' );
		$known  = '' === $id ? null : GRP_Store::get( GRP_Time_Entries::TABLE, $id );
		$editor = '' !== (string) ( $raw['edited_by'] ?? '' ) ? (string) $raw['edited_by'] : (string) $member['id'];
		if ( $known && (string) $known['member_id'] !== (string) $member['id'] ) {
			return self::refused( 'grp_time_id_taken', __( 'That entry id is taken.', 'gridrankers-portal' ) );
		}

		// Deleted on the tracker portal.
		if ( ! empty( $raw['deleted_at'] ) ) {
			if ( ! $known || ! empty( $known['deleted_at'] ) ) {
				return array( 'status' => 'exists' );
			}
			return self::answer( GRP_Time_Entries::delete( $known, $editor ) );
		}

		$fields = self::clean( $raw );
		if ( ! $known ) {
			$result = GRP_Time_Entries::save( $member, $fields, array( 'source' => 'desktop' === ( $raw['source'] ?? '' ) ? 'desktop' : 'web' ) );
			if ( 'saved' === $result['status'] && is_array( $raw['flags'] ?? null ) ) {
				// The tracker portal saw when it was sent and the computer's clock.
				GRP_Store::update( GRP_Time_Entries::TABLE, $id, array( 'flags' => array_merge( (array) ( $result['entry']['flags'] ?? array() ), array_intersect_key( $raw['flags'], array_flip( array( 'late_sync', 'clock_skew', 'auto_stopped' ) ) ) ) ) );
			}
			return self::answer( $result );
		}

		$done = false;
		// Restored on the tracker portal.
		if ( ! empty( $known['deleted_at'] ) ) {
			$restored = GRP_Time_Entries::restore( $known, $editor );
			if ( 'saved' !== $restored['status'] ) {
				return self::answer( $restored );
			}
			$known = $restored['entry'];
			$done  = true;
		}

		// Stopped on the tracker portal.
		if ( empty( $known['ended_at'] ) && null !== $fields['ended_at'] && $fields['started_at'] === (string) $known['started_at'] ) {
			$stopped = GRP_Time_Entries::save( $member, $fields, array() );
			$known   = $stopped['entry'] ?? $known;
			if ( 'refused' === $stopped['status'] ) {
				return self::answer( $stopped );
			}
			$done = $done || 'saved' === $stopped['status'];
		}

		// Corrected on the tracker portal.
		$changes = array();
		foreach ( array( 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at' ) as $field ) {
			if ( (string) ( $known[ $field ] ?? '' ) !== (string) ( $fields[ $field ] ?? '' ) ) {
				$changes[ $field ] = $fields[ $field ];
			}
		}
		if ( ! $changes ) {
			return array( 'status' => $done ? 'saved' : 'exists' );
		}
		$changes += array_intersect_key( $fields, array_flip( array( 'project_id', 'ref_kind', 'ref_id', 'period_key' ) ) );

		return self::answer( GRP_Time_Entries::edit( $known, $changes, $editor ) );
	}

	/**
	 * Entry fields as plain values.
	 *
	 * @param array $raw Entry.
	 * @return array
	 */
	private static function clean( array $raw ) {
		$out = array();
		foreach ( array( 'id', 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at' ) as $key ) {
			$out[ $key ] = isset( $raw[ $key ] ) && is_scalar( $raw[ $key ] ) && '' !== (string) $raw[ $key ] ? (string) $raw[ $key ] : null;
		}
		$out['idle_seconds'] = isset( $raw['idle_seconds'] ) && is_numeric( $raw['idle_seconds'] ) ? (int) $raw['idle_seconds'] : 0;

		return $out;
	}

	/**
	 * A save's result as the answer for the tracker portal.
	 *
	 * @param array $result `{status, code?, message?}`.
	 * @return array
	 */
	private static function answer( array $result ) {
		return array_intersect_key( $result, array_flip( array( 'status', 'code', 'message' ) ) );
	}

	/**
	 * A refusal.
	 *
	 * @param string $code    Code.
	 * @param string $message Message.
	 * @return array
	 */
	private static function refused( $code, $message ) {
		return array(
			'status'  => 'refused',
			'code'    => $code,
			'message' => $message,
		);
	}
}
