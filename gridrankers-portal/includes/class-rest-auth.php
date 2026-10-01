<?php
/**
 * REST: /auth/login, /auth/logout, /auth/me, /auth/setup, plus the API-wide auth gate.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Auth endpoints and the guard that protects every other portal route.
 */
class GRP_REST_Auth {

	/**
	 * REST namespace for the whole portal API.
	 */
	const REST_NAMESPACE = 'gr-portal/v1';

	/**
	 * Hooks route registration and the API guard.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'guard' ), 10, 3 );
	}

	/**
	 * Registers the /auth/* routes.
	 */
	public static function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/auth/login',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'login' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'code' => array(
						'type'     => 'string',
						'required' => true,
					),
				),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/auth/logout',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'logout' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/auth/me',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'me' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/auth/setup',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'setup' ),
				'permission_callback' => array( 'GRP_Auth', 'needs_setup' ),
				'args'                => array(
					'name' => array(
						'type'    => 'string',
						'default' => '',
					),
				),
			)
		);
	}

	/**
	 * Runs before every REST request. For portal routes: requires a valid `wp_rest` nonce
	 * (X-WP-Nonce header) and, outside /auth/*, a signed-in team member (401 otherwise).
	 *
	 * @param mixed           $result  Response to short-circuit with, or null.
	 * @param WP_REST_Server  $server  Server instance.
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function guard( $result, $server, $request ) {
		$route  = $request->get_route();
		$prefix = '/' . self::REST_NAMESPACE;

		if ( null !== $result || ( $route !== $prefix && ! str_starts_with( $route, $prefix . '/' ) ) ) {
			return $result;
		}

		if ( ! wp_verify_nonce( (string) $request->get_header( 'X-WP-Nonce' ), 'wp_rest' ) ) {
			return new WP_Error( 'grp_bad_nonce', __( 'Your session expired. Reload the page.', 'gridrankers-portal' ), array( 'status' => 403 ) );
		}

		if ( ! str_starts_with( $route, $prefix . '/auth/' ) && ! GRP_Auth::current_member() ) {
			return new WP_Error( 'grp_unauthorized', __( 'Sign in to continue.', 'gridrankers-portal' ), array( 'status' => 401 ) );
		}

		return $result;
	}

	/**
	 * POST /auth/login `{code}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function login( WP_REST_Request $request ) {
		$result = GRP_Auth::login(
			(string) $request['code'],
			GRP_Auth::client_ip(),
			(string) $request->get_header( 'User-Agent' )
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return rest_ensure_response( array( 'member' => self::me_payload( $result['member'] ) ) );
	}

	/**
	 * POST /auth/logout.
	 *
	 * @return WP_REST_Response
	 */
	public static function logout() {
		GRP_Auth::logout();

		return rest_ensure_response( array( 'ok' => true ) );
	}

	/**
	 * GET /auth/me: the signed-in member, or null; `needsSetup` for an unlinked WP administrator.
	 *
	 * @return WP_REST_Response
	 */
	public static function me() {
		$member = GRP_Auth::current_member();

		return rest_ensure_response(
			array(
				'member'     => $member ? self::me_payload( $member ) : null,
				'needsSetup' => ! $member && GRP_Auth::needs_setup(),
			)
		);
	}

	/**
	 * POST /auth/setup `{name}`: "Set up GridRankers" for a WordPress administrator.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function setup( WP_REST_Request $request ) {
		$member = GRP_Auth::setup_admin_member( (string) $request['name'] );
		if ( is_wp_error( $member ) ) {
			return $member;
		}

		return rest_ensure_response( array( 'member' => self::me_payload( $member ) ) );
	}

	/**
	 * The signed-in member for the app, with the role they actually hold
	 * (an `admin` not linked to a WordPress administrator acts as a member).
	 *
	 * @param array $member Member row.
	 * @return array
	 */
	private static function me_payload( array $member ) {
		$out         = GRP_Auth::public_member( $member );
		$out['role'] = GRP_Permissions::effective_role( $member );

		return $out;
	}
}
