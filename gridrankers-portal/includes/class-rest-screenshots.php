<?php
/**
 * REST: screenshots (SPEC.md 6.23, tracker portal).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * POST /time-entries/{id}/screenshots (the desktop app), GET /screenshots, GET and DELETE
 * /screenshots/{id}, PUT /settings/screenshots.
 */
class GRP_REST_Screenshots extends GRP_REST_Controller {

	/**
	 * The picture GET /screenshots/{id} sends instead of JSON.
	 *
	 * @var string|null
	 */
	private static $sending = null;

	/**
	 * Hooks routes and sending the picture.
	 */
	public static function init() {
		parent::init();
		add_filter( 'rest_pre_serve_request', array( __CLASS__, 'serve' ), 10, 4 );
	}

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/time-entries/(?P<entry>[\w-]+)/screenshots', WP_REST_Server::CREATABLE, 'upload' );
		self::route( '/screenshots', WP_REST_Server::READABLE, 'index' );
		self::route( '/screenshots/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
		self::route( '/screenshots/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/settings/screenshots', 'PUT', 'settings' );
	}

	/**
	 * POST /time-entries/{entry}/screenshots (multipart `file`, `id`, `taken_at`): a screenshot of the
	 * actor's running or finished timer.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function upload( WP_REST_Request $request ) {
		$entry = GRP_Store::get( GRP_Time_Entries::TABLE, (string) $request['entry'] );
		if ( ! $entry ) {
			return self::not_found();
		}
		$files  = $request->get_file_params();
		$result = GRP_Screenshots::store( self::actor(), $entry, (array) ( $files['file'] ?? array() ), (string) $request['id'], (string) $request['taken_at'] );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return new WP_REST_Response( $result, 'saved' === $result['status'] ? 201 : 200 );
	}

	/**
	 * GET /screenshots?member=&day=: a person's screenshots on a day (the actor's own, today, by default).
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
		if ( ! self::can( GRP_Permissions::VIEW_SCREENSHOTS, self::owner( $member ) ) ) {
			return self::forbidden();
		}
		$day = (string) ( $request['day'] ?? '' );
		if ( '' === $day ) {
			$day = GRP_Cycles::today();
		} elseif ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $day ) ) {
			return self::invalid( __( 'Pick a day.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response(
			array(
				'every'       => GRP_Screenshots::every(),
				'screenshots' => GRP_Screenshots::of_day( (string) $member['id'], $day ),
			)
		);
	}

	/**
	 * GET /screenshots/{id}: the picture.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		$row = self::visible( (string) $request['id'] );
		if ( is_wp_error( $row ) ) {
			return $row;
		}
		$path = GRP_Screenshots::path( $row );
		if ( ! $path ) {
			return self::not_found();
		}
		self::$sending = $path;

		return rest_ensure_response( GRP_Screenshots::meta( $row ) );
	}

	/**
	 * DELETE /screenshots/{id}: the Super Admin only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$row = GRP_Store::get( GRP_Screenshots::TABLE, (string) $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_SCREENSHOTS ) ) {
			return self::forbidden( __( 'Only the Super Admin deletes screenshots.', 'gridrankers-portal' ) );
		}
		GRP_Screenshots::delete( $row );

		return rest_ensure_response( array( 'deleted' => true ) );
	}

	/**
	 * PUT /settings/screenshots `{every: 0|5|10|15|30}`: the Super Admin, on a tracker portal.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function settings( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::MANAGE_SCREENSHOTS ) ) {
			return self::forbidden( __( 'Only the Super Admin sets screenshots.', 'gridrankers-portal' ) );
		}
		$every = GRP_Screenshots::set_every( $request['every'] );
		if ( is_wp_error( $every ) ) {
			return $every;
		}

		return rest_ensure_response( array( 'every' => $every ) );
	}

	/**
	 * A screenshot the actor may see, or an error.
	 *
	 * @param string $id Id.
	 * @return array|WP_Error
	 */
	private static function visible( $id ) {
		$row    = GRP_Store::get( GRP_Screenshots::TABLE, $id );
		$member = $row ? GRP_Store::get( 'grp_members', (string) $row['member_id'] ) : null;
		if ( ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::VIEW_SCREENSHOTS, self::owner( $member ) ) ) {
			return self::forbidden();
		}

		return $row;
	}

	/**
	 * Sends the picture instead of JSON for GET /screenshots/{id}.
	 *
	 * @param bool             $served  Whether the request was already served.
	 * @param WP_HTTP_Response $result  Response.
	 * @param WP_REST_Request  $request Request.
	 * @return bool
	 */
	public static function serve( $served, $result, $request ) {
		if ( $served || ! self::$sending || ! $result instanceof WP_HTTP_Response || 200 !== $result->get_status() || ! preg_match( '#^/' . preg_quote( GRP_REST_Auth::REST_NAMESPACE, '#' ) . '/screenshots/#', $request->get_route() ) ) {
			return $served;
		}
		$path          = self::$sending;
		self::$sending = null;

		header( 'Content-Type: ' . ( str_ends_with( $path, '.png' ) ? 'image/png' : 'image/jpeg' ) );
		header( 'Content-Length: ' . filesize( $path ) );
		header( 'X-Content-Type-Options: nosniff' );
		header( "Content-Security-Policy: default-src 'none'; sandbox" );
		header( 'Cache-Control: private, max-age=0, no-store' );
		readfile( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile

		return true;
	}

	/**
	 * Permission context of a person.
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
