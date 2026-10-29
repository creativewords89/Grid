<?php
/**
 * REST: /link/* — the main portal's side of the link with the tracker portal.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Routes the tracker portal calls on the main portal with the link key (SPEC.md 6.22). The API
 * guard lets only the link key in, and only on a main portal.
 */
class GRP_REST_Link {

	/**
	 * Hooks route registration.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		register_rest_route(
			GRP_REST_Auth::REST_NAMESPACE,
			'/link/ping',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'ping' ),
				'permission_callback' => array( 'GRP_Link', 'request_ok' ),
			)
		);
		register_rest_route(
			GRP_REST_Auth::REST_NAMESPACE,
			'/link/verify',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'verify' ),
				'permission_callback' => array( 'GRP_Link', 'request_ok' ),
				'args'                => array(
					'code' => array(
						'type'     => 'string',
						'required' => true,
					),
					'ip'   => array(
						'type'    => 'string',
						'default' => '',
					),
				),
			)
		);
		register_rest_route(
			GRP_REST_Auth::REST_NAMESPACE,
			'/link/time-entries',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'time_entries' ),
				'permission_callback' => array( 'GRP_Link', 'request_ok' ),
			)
		);
		register_rest_route(
			GRP_REST_Auth::REST_NAMESPACE,
			'/link/people',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'people' ),
				'permission_callback' => array( 'GRP_Link', 'request_ok' ),
			)
		);
	}

	/**
	 * POST /link/verify `{code, ip}`: whose code this is, with this site's lockout on the person's IP
	 * (not the tracker portal's). The generic error when it matches nobody who signs in with a code.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function verify( WP_REST_Request $request ) {
		$ip     = (string) $request['ip'];
		$ip     = false !== filter_var( $ip, FILTER_VALIDATE_IP ) ? $ip : 'tracker-portal';
		$member = GRP_Auth::check_code( (string) $request['code'], $ip );
		if ( is_wp_error( $member ) ) {
			return $member;
		}

		return rest_ensure_response( array( 'member_id' => (string) $member['id'] ) );
	}

	/**
	 * POST /link/time-entries `{entries: [..≤200]}`: hours from the tracker portal, an answer per entry.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function time_entries( WP_REST_Request $request ) {
		$entries = $request['entries'];
		if ( ! is_array( $entries ) || count( $entries ) > GRP_Link_Hours::BATCH ) {
			/* translators: %d: most entries. */
			return new WP_Error( 'grp_invalid', sprintf( __( 'Send 1 to %d entries at a time.', 'gridrankers-portal' ), GRP_Link_Hours::BATCH ), array( 'status' => 400 ) );
		}

		return rest_ensure_response( array( 'results' => GRP_Link_Hours::receive( $entries ) ) );
	}

	/**
	 * GET /link/people: the profiles, schedule and tasks the tracker portal copies.
	 *
	 * @return WP_REST_Response
	 */
	public static function people() {
		return rest_ensure_response( GRP_Link_Copy::payload() );
	}

	/**
	 * GET /link/ping: which portal this is and how many people it has (Test connection).
	 *
	 * @return WP_REST_Response
	 */
	public static function ping() {
		global $wpdb;
		$table  = GRP_Install::table( 'grp_members' );
		$people = (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM %i WHERE active = 1', $table ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		return rest_ensure_response(
			array(
				'site'    => get_bloginfo( 'name' ),
				'url'     => home_url(),
				'version' => GRP_VERSION,
				'people'  => $people,
			)
		);
	}
}
