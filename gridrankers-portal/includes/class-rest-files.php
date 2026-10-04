<?php
/**
 * REST: files for submissions and comments (SPEC.md 6.6, designs SF-A / SF-B).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * POST /files (multipart `file`) uploads one file; GET /files/{id} sends it back to a signed-in
 * team member. Files are attached to a submission or a comment by id.
 */
class GRP_REST_Files extends GRP_REST_Controller {

	/**
	 * Absolute path of the file this request sends (set by show(), read by serve()).
	 *
	 * @var array|null `{path, name, mime, inline}`
	 */
	private static $sending = null;

	/**
	 * Hooks.
	 */
	public static function init() {
		parent::init();
		add_filter( 'rest_pre_serve_request', array( __CLASS__, 'serve' ), 10, 4 );
	}

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/files', WP_REST_Server::CREATABLE, 'upload' );
		self::route( '/files/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
	}

	/**
	 * POST /files: `{id, mime, name, size}` of the stored file.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function upload( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::UPLOAD_FILE ) ) {
			return self::forbidden( __( 'You can’t attach files.', 'gridrankers-portal' ) );
		}
		$files = $request->get_file_params();
		if ( empty( $files['file'] ) || ! is_array( $files['file'] ) ) {
			return self::invalid( __( 'Choose a file to attach.', 'gridrankers-portal' ) );
		}
		$file = GRP_Files::store( $files['file'], self::actor() );
		if ( is_wp_error( $file ) ) {
			return $file;
		}

		$response = rest_ensure_response( GRP_Files::meta( $file ) );
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * GET /files/{id}[?download=1]: the file itself (the JSON body is its meta, which the REST
	 * server replaces with the bytes in serve()).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::DOWNLOAD_FILE ) ) {
			return self::forbidden();
		}
		$file = GRP_Store::get( 'grp_files', (string) $request['id'] );
		$path = $file ? GRP_Files::path( $file ) : null;
		if ( ! $path ) {
			return self::not_found();
		}

		self::$sending = array(
			'path'   => $path,
			'name'   => $file['name'],
			'mime'   => $file['mime'],
			'inline' => ! $request['download'] && ( 0 === strpos( $file['mime'], 'image/' ) || 'application/pdf' === $file['mime'] ),
		);

		return rest_ensure_response( GRP_Files::meta( $file ) );
	}

	/**
	 * Sends the file's bytes instead of JSON for GET /files/{id}.
	 *
	 * @param bool             $served  Whether the request was already served.
	 * @param WP_HTTP_Response $result  Response.
	 * @param WP_REST_Request  $request Request.
	 * @return bool
	 */
	public static function serve( $served, $result, $request ) {
		if ( $served || ! self::$sending || ! $result instanceof WP_HTTP_Response || 200 !== $result->get_status() || ! preg_match( '#^/' . preg_quote( GRP_REST_Auth::REST_NAMESPACE, '#' ) . '/files/#', $request->get_route() ) ) {
			return $served;
		}
		$file          = self::$sending;
		self::$sending = null;
		$name          = str_replace( array( '"', "\r", "\n" ), '', $file['name'] );

		header( 'Content-Type: ' . $file['mime'] );
		header( 'Content-Length: ' . filesize( $file['path'] ) );
		header( 'Content-Disposition: ' . ( $file['inline'] ? 'inline' : 'attachment' ) . '; filename="' . $name . '"; filename*=UTF-8\'\'' . rawurlencode( $file['name'] ) );
		header( 'X-Content-Type-Options: nosniff' );
		header( "Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" );
		header( 'Cache-Control: private, max-age=0, no-store' );
		readfile( $file['path'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile

		return true;
	}
}
