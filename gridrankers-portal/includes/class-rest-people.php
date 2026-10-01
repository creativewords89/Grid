<?php
/**
 * REST: /days-off, /settings/messages (SPEC.md 6.10).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Days off (team weekly, a person's own weekly, events and seasons) and the automatic
 * message texts. Reading is for everyone; changing is for the Super Admin.
 */
class GRP_REST_People extends GRP_REST_Controller {

	const TABLE = 'grp_days_off';

	/**
	 * Settings key of the team's weekly day off: value `{days: [0-6]}`.
	 */
	const WEEKLY_KEY = 'weekly_off';

	/**
	 * Settings key of the automatic messages: value `{birthday, day_off, leave_approved}`.
	 */
	const MESSAGES_KEY = 'messages';

	/**
	 * Default automatic messages (`{name}` = first name).
	 */
	const DEFAULT_MESSAGES = array(
		'birthday'       => 'Happy birthday, {name}! The whole GridRankers team wishes you a wonderful year ahead.',
		'day_off'        => 'Today is your day off, {name} — but you’re here anyway. We really appreciate it. Don’t forget to rest too.',
		'leave_approved' => 'Your leave was approved. Enjoy your time off, {name}!',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/days-off', WP_REST_Server::READABLE, 'index' );
		self::route( '/days-off', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/days-off/weekly', WP_REST_Server::EDITABLE, 'set_weekly' );
		self::route( '/days-off/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/settings/messages', WP_REST_Server::READABLE, 'messages' );
		self::route( '/settings/messages', WP_REST_Server::EDITABLE, 'set_messages' );
	}

	/**
	 * A setting's value, or null.
	 *
	 * @param string $key Setting key.
	 * @return mixed
	 */
	public static function setting( $key ) {
		$rows = GRP_Store::find( 'grp_settings', array( 'setting_key' => $key ) );

		return $rows ? $rows[0]['value'] : null;
	}

	/**
	 * Stores a setting.
	 *
	 * @param string $key   Setting key.
	 * @param array  $value Value (a JSON object).
	 * @return array The row.
	 */
	public static function set_setting( $key, array $value ) {
		$rows = GRP_Store::find( 'grp_settings', array( 'setting_key' => $key ) );
		if ( $rows ) {
			return GRP_Store::update( 'grp_settings', $rows[0]['id'], array( 'value' => $value ) );
		}

		return GRP_Store::insert(
			'grp_settings',
			array(
				'id'          => 's_' . md5( $key ),
				'setting_key' => $key,
				'value'       => $value,
			)
		);
	}

	/**
	 * The team's weekly day off.
	 *
	 * @return int[]
	 */
	public static function team_weekly() {
		$days = GRP_People::weekdays( ( (array) self::setting( self::WEEKLY_KEY ) )['days'] ?? null );

		return null === $days ? GRP_People::DEFAULT_WEEKLY_OFF : $days;
	}

	/**
	 * Every whole-team day off.
	 *
	 * @return array[]
	 */
	public static function days_off() {
		return GRP_Store::find( self::TABLE, array(), array( 'order_by' => 'from_date' ) );
	}

	/**
	 * The automatic messages, defaults filled in.
	 *
	 * @return array
	 */
	public static function message_texts() {
		$stored = (array) self::setting( self::MESSAGES_KEY );
		$out    = array();
		foreach ( self::DEFAULT_MESSAGES as $key => $default ) {
			$out[ $key ] = isset( $stored[ $key ] ) && '' !== trim( (string) $stored[ $key ] ) ? (string) $stored[ $key ] : $default;
		}

		return $out;
	}

	/**
	 * GET /days-off: `{weekly, days_off}`.
	 *
	 * @return WP_REST_Response
	 */
	public static function index() {
		return rest_ensure_response(
			array(
				'weekly'   => self::team_weekly(),
				'days_off' => self::days_off(),
			)
		);
	}

	/**
	 * POST /days-off `{kind: event|seasonal, name, from, to?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PEOPLE_SETTINGS ) ) {
			return self::forbidden( __( 'Only the Super Admin can set days off.', 'gridrankers-portal' ) );
		}
		$kind = 'seasonal' === $request['kind'] ? 'seasonal' : 'event';
		$name = self::text( $request['name'] ?? '', 191 );
		if ( '' === $name ) {
			return self::invalid( __( 'Give the day off a name.', 'gridrankers-portal' ) );
		}
		$from = self::date( $request['from'] ?? '', 'date' );
		$to   = 'event' === $kind ? $from : self::date( $request['to'] ?? '', 'end date' );
		if ( is_wp_error( $from ) || is_wp_error( $to ) ) {
			return is_wp_error( $from ) ? $from : $to;
		}
		if ( ! $from || ! $to || $to < $from ) {
			return self::invalid( __( 'Pick the dates of the day off.', 'gridrankers-portal' ) );
		}

		$row = GRP_Store::transaction(
			static function () use ( $kind, $name, $from, $to ) {
				$row = GRP_Store::insert(
					self::TABLE,
					array(
						'kind'       => $kind,
						'name'       => $name,
						'from_date'  => $from,
						'to_date'    => $to,
						'created_by' => self::actor()['id'],
					)
				);
				GRP_Activity::audit( 'add', 'days_off', $row, self::actor(), $from === $to ? $from : "$from – $to" );
				return $row;
			}
		);

		return new WP_REST_Response( $row, 201 );
	}

	/**
	 * DELETE /days-off/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PEOPLE_SETTINGS ) ) {
			return self::forbidden( __( 'Only the Super Admin can set days off.', 'gridrankers-portal' ) );
		}
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		GRP_Store::transaction(
			static function () use ( $row ) {
				GRP_Store::delete( self::TABLE, $row['id'] );
				GRP_Activity::audit( 'delete', 'days_off', $row, self::actor() );
			}
		);

		return rest_ensure_response( array( 'deleted' => true ) );
	}

	/**
	 * PUT /days-off/weekly `{weekdays: [0-6], member?}`. With `member`, sets that person's own
	 * weekly day off (`weekdays: null` goes back to the team's).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_weekly( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PEOPLE_SETTINGS ) ) {
			return self::forbidden( __( 'Only the Super Admin can set days off.', 'gridrankers-portal' ) );
		}
		$raw  = $request->get_param( 'weekdays' );
		$days = GRP_People::weekdays( $raw );

		if ( ! empty( $request['member'] ) ) {
			$member = GRP_Store::get( 'grp_members', (string) $request['member'] );
			if ( ! $member ) {
				return self::not_found();
			}
			if ( null !== $raw && null === $days ) {
				return self::invalid( __( 'Pick the weekdays.', 'gridrankers-portal' ) );
			}
			$updated = GRP_Store::transaction(
				static function () use ( $member, $days ) {
					$updated = GRP_Store::update( 'grp_members', $member['id'], array( 'weekly_off' => $days ) );
					GRP_Activity::audit( 'edit', 'team', $updated, self::actor(), null === $days ? 'Weekly day off: same as the team' : 'Own weekly day off' );
					return $updated;
				}
			);
			return rest_ensure_response( GRP_REST_Members::visible( $updated ) );
		}

		if ( null === $days ) {
			return self::invalid( __( 'Pick the weekdays.', 'gridrankers-portal' ) );
		}
		GRP_Store::transaction(
			static function () use ( $days ) {
				$row = self::set_setting( self::WEEKLY_KEY, array( 'days' => $days ) );
				GRP_Activity::audit( 'edit', 'settings', array( 'id' => $row['id'] ), self::actor(), 'Team weekly day off' );
			}
		);

		return rest_ensure_response( array( 'weekly' => $days ) );
	}

	/**
	 * GET /settings/messages.
	 *
	 * @return WP_REST_Response
	 */
	public static function messages() {
		return rest_ensure_response( self::message_texts() );
	}

	/**
	 * PUT /settings/messages `{birthday?, day_off?, leave_approved?}` (empty = back to the default).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_messages( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_PEOPLE_SETTINGS ) ) {
			return self::forbidden( __( 'Only the Super Admin can change the automatic messages.', 'gridrankers-portal' ) );
		}
		$stored = (array) self::setting( self::MESSAGES_KEY );
		foreach ( array_keys( self::DEFAULT_MESSAGES ) as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$stored[ $key ] = self::textarea( $request[ $key ], 500 );
			}
		}
		GRP_Store::transaction(
			static function () use ( $stored ) {
				$row = self::set_setting( self::MESSAGES_KEY, $stored );
				GRP_Activity::audit( 'edit', 'settings', array( 'id' => $row['id'] ), self::actor(), 'Automatic messages' );
			}
		);

		return rest_ensure_response( self::message_texts() );
	}
}
