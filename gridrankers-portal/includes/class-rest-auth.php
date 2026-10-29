<?php
/**
 * REST: /auth/login, /auth/logout, /auth/me, /auth/setup, /auth/device (desktop tracker), plus the API-wide auth gate.
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
	 * Routes (under the namespace) a desktop tracker device token may use (SPEC.md 6.21): exact
	 * paths, and prefixes ending in `/`.
	 */
	const DEVICE_ROUTES = array( '/auth/me', '/auth/device', '/timer', '/timer/', '/time-entries', '/time-entries/' );

	/**
	 * Days of schedule the desktop tracker gets when it signs in.
	 */
	const DEVICE_SCHEDULE_DAYS = 14;

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
			'/auth/device',
			array(
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'device_login' ),
					'permission_callback' => '__return_true',
					'args'                => array(
						'code'        => array(
							'type'     => 'string',
							'required' => true,
						),
						'device_name' => array(
							'type'    => 'string',
							'default' => '',
						),
						'platform'    => array(
							'type'    => 'string',
							'default' => '',
						),
						'app_version' => array(
							'type'    => 'string',
							'default' => '',
						),
					),
				),
				array(
					'methods'             => WP_REST_Server::DELETABLE,
					'callback'            => array( __CLASS__, 'device_logout' ),
					'permission_callback' => '__return_true',
				),
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
	 * A desktop tracker sends its device token as `Authorization: Bearer …` instead (SPEC.md 6.21):
	 * no nonce (nothing for a browser to forge), only the DEVICE_ROUTES (403 elsewhere), and a valid
	 * token on every one of them but POST /auth/device, the sign-in itself (401 otherwise).
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
		$path = substr( $route, strlen( $prefix ) );

		// The tracker portal's calls (SPEC.md 6.22): the link key only, on a main portal only.
		if ( self::link_route( $path ) ) {
			$ok = GRP_Link::guard( $request );
			return true === $ok ? $result : $ok;
		}

		if ( preg_match( '/^Bearer\s+(\S*)$/i', trim( (string) $request->get_header( 'Authorization' ) ), $m ) ) {
			if ( GRP_Link::key_ok( $m[1] ) ) {
				return new WP_Error( 'grp_link_route', __( 'A link key works only for the tracker portal’s link.', 'gridrankers-portal' ), array( 'status' => 403 ) );
			}
			if ( ! self::device_route( $path ) ) {
				return new WP_Error( 'grp_device_route', __( 'Open the portal in your browser to do this.', 'gridrankers-portal' ), array( 'status' => 403 ) );
			}
			GRP_Auth::use_bearer( $m[1] );
			if ( ! ( '/auth/device' === $path && 'POST' === $request->get_method() ) && ! GRP_Auth::current_member() ) {
				return new WP_Error( 'grp_unauthorized', __( 'Sign in again.', 'gridrankers-portal' ), array( 'status' => 401 ) );
			}
			return $result;
		}

		// The desktop tracker signs in without a nonce: it has no browser session to protect.
		if ( '/auth/device' === $path ) {
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
	 * Whether a route (path under the namespace) is one of the link's `/link/*` routes.
	 *
	 * @param string $path Path, e.g. `/link/ping`.
	 * @return bool
	 */
	public static function link_route( $path ) {
		return '/link' === $path || str_starts_with( $path, '/link/' );
	}

	/**
	 * Whether a device token may use a route (path under the namespace).
	 *
	 * @param string $path Path, e.g. `/timer/start`.
	 * @return bool
	 */
	public static function device_route( $path ) {
		foreach ( self::DEVICE_ROUTES as $allowed ) {
			if ( str_ends_with( $allowed, '/' ) ? str_starts_with( $path, $allowed ) : $path === $allowed ) {
				return true;
			}
		}

		return false;
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

		$out = array(
			'member'     => $member ? self::me_payload( $member ) : null,
			'needsSetup' => ! $member && GRP_Auth::needs_setup(),
		);
		if ( GRP_Auth::uses_device() ) {
			$out['device'] = GRP_Auth::current_device();
		}

		return rest_ensure_response( $out );
	}

	/**
	 * POST /auth/device `{code, device_name?, platform?, app_version?}`: the desktop tracker signs in
	 * (SPEC.md 6.21). Answers the device token once, with the person and their working day and schedule.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function device_login( WP_REST_Request $request ) {
		$result = GRP_Auth::device_login(
			(string) $request['code'],
			GRP_Auth::client_ip(),
			(string) $request['device_name'],
			(string) $request['platform'],
			(string) $request['app_version']
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return rest_ensure_response(
			array(
				'token'  => $result['token'],
				'device' => $result['device'],
			) + self::device_payload( $result['member'] ) + array(
				'tasks' => GRP_Time_Entries::tasks_for( $result['member'] ),
				'timer' => GRP_Time_Entries::running( (string) $result['member']['id'] ),
			)
		);
	}

	/**
	 * DELETE /auth/device: the desktop tracker signs out; its token stops working.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function device_logout() {
		$device = GRP_Auth::uses_device() ? GRP_Auth::current_device() : null;
		if ( ! $device ) {
			return new WP_Error( 'grp_unauthorized', __( 'Sign in again.', 'gridrankers-portal' ), array( 'status' => 401 ) );
		}
		GRP_Auth::revoke_device( $device['id'] );

		return rest_ensure_response( array( 'ok' => true ) );
	}

	/**
	 * What the desktop tracker needs about the person, all their own (SPEC.md 6.21): who they are,
	 * their working day and their schedule (working or not, and why — never a leave type or reason).
	 *
	 * @param array $member Member row.
	 * @param int   $days   Days of schedule.
	 * @return array `{member, work_day, schedule}`.
	 */
	public static function device_payload( array $member, $days = self::DEVICE_SCHEDULE_DAYS ) {
		$start    = (array) GRP_REST_People::setting( GRP_Time::START_KEY );
		$work_day = GRP_Time::work_day( $member, $start['start'] ?? null, GRP_Store::get( 'grp_pay', (string) $member['id'] ) );
		$leaves   = GRP_Store::find(
			'grp_leave',
			array(
				'member_id' => $member['id'],
				'status'    => 'approved',
			)
		);

		return array(
			'member'   => self::me_payload( $member ),
			'work_day' => $work_day,
			'schedule' => GRP_Time::schedule( GRP_Cycles::today(), $days, $member, GRP_REST_People::team_weekly(), GRP_REST_People::days_off(), $leaves, $work_day ),
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
