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
