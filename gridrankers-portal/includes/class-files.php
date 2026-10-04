<?php
/**
 * Files attached to a submission or a comment (SPEC.md 6.6): stored privately under uploads, never
 * linked directly, and handed out only through GET /files/{id} to signed-in team members.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Private file storage: `grp_files` rows point at randomly named files in `uploads/grp-private/`,
 * which a deny-all .htaccess keeps away from direct requests.
 */
class GRP_Files {

	/**
	 * Largest file accepted, in bytes (10 MB).
	 */
	const MAX_BYTES = 10485760;

	/**
	 * Accepted types: extension => MIME type (PDF, images, Word, Excel, CSV, text).
	 */
	const TYPES = array(
		'pdf'  => 'application/pdf',
		'png'  => 'image/png',
		'jpg'  => 'image/jpeg',
		'jpeg' => 'image/jpeg',
		'gif'  => 'image/gif',
		'webp' => 'image/webp',
		'doc'  => 'application/msword',
		'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'xls'  => 'application/vnd.ms-excel',
		'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'csv'  => 'text/csv',
		'txt'  => 'text/plain',
	);

	/**
	 * Folder under uploads.
	 */
	const DIR = 'grp-private';

	/**
	 * Public fields of a stored file.
	 *
	 * @param array $file `grp_files` row.
	 * @return array `{id, mime, name, size}`.
	 */
	public static function meta( array $file ) {
		// Keys in the order stored JSON keeps them (GRP_Store::canonical sorts them).
		return array(
			'id'   => $file['id'],
			'mime' => $file['mime'],
			'name' => $file['name'],
			'size' => (int) $file['size'],
		);
	}

	/**
	 * The private folder (created with its deny-all guards on first use).
	 *
	 * @return string|WP_Error Absolute path without trailing slash.
	 */
	public static function base_dir() {
		$uploads = wp_upload_dir( null, false );
		if ( ! empty( $uploads['error'] ) ) {
			return new WP_Error( 'grp_upload_dir', __( 'The uploads folder is not writable.', 'gridrankers-portal' ), array( 'status' => 500 ) );
		}
		$dir = trailingslashit( $uploads['basedir'] ) . self::DIR;
		if ( ! wp_mkdir_p( $dir ) ) {
			return new WP_Error( 'grp_upload_dir', __( 'The uploads folder is not writable.', 'gridrankers-portal' ), array( 'status' => 500 ) );
		}
		$guards = array(
			'.htaccess'  => "Require all denied\nDeny from all\n",
			'index.php'  => "<?php\n// Silence is golden.\n",
			'web.config' => "<?xml version=\"1.0\"?>\n<configuration><system.webServer><authorization><deny users=\"*\" /></authorization></system.webServer></configuration>\n",
		);
		foreach ( $guards as $name => $content ) {
			if ( ! file_exists( "$dir/$name" ) ) {
				file_put_contents( "$dir/$name", $content ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			}
		}

		return $dir;
	}

	/**
	 * Stores an uploaded file and records it.
	 *
	 * @param array $upload One entry of `$_FILES` (`name`, `tmp_name`, `size`, `error`).
	 * @param array $actor  Uploading member.
	 * @return array|WP_Error The `grp_files` row.
	 */
	public static function store( array $upload, array $actor ) {
		if ( ! empty( $upload['error'] ) || empty( $upload['tmp_name'] ) ) {
			$too_big = in_array( (int) ( $upload['error'] ?? 0 ), array( UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE ), true );
			return self::error( $too_big ? __( 'That file is larger than 10 MB.', 'gridrankers-portal' ) : __( 'The file did not arrive. Try again.', 'gridrankers-portal' ) );
		}
		$size = (int) ( $upload['size'] ?? 0 );
		if ( $size <= 0 ) {
			return self::error( __( 'That file is empty.', 'gridrankers-portal' ) );
		}
		if ( $size > self::MAX_BYTES ) {
			return self::error( __( 'That file is larger than 10 MB.', 'gridrankers-portal' ) );
		}

		$name  = sanitize_file_name( wp_basename( (string) ( $upload['name'] ?? '' ) ) );
		$check = wp_check_filetype_and_ext( $upload['tmp_name'], $name, self::TYPES );
		$ext   = strtolower( (string) ( $check['ext'] ?? '' ) );
		if ( '' === $name || ! $ext || ! isset( self::TYPES[ $ext ] ) ) {
			return self::error( __( 'Only PDF, images, Word, Excel, CSV and text files can be attached.', 'gridrankers-portal' ) );
		}

		$dir = self::base_dir();
		if ( is_wp_error( $dir ) ) {
			return $dir;
		}
		$sub = gmdate( 'Y/m' );
		if ( ! wp_mkdir_p( "$dir/$sub" ) ) {
			return self::error( __( 'The uploads folder is not writable.', 'gridrankers-portal' ), 500 );
		}
		$id   = GRP_Ids::ulid();
		$path = $sub . '/' . strtolower( $id ) . '-' . strtolower( wp_generate_password( 12, false ) ) . '.' . $ext;

		/**
		 * Moves the uploaded file into place. Tests replace it; on a site it must stay
		 * move_uploaded_file(), which only accepts real uploads.
		 *
		 * @param bool|null $moved    Null to use move_uploaded_file().
		 * @param string    $tmp_name Temporary file.
		 * @param string    $dest     Destination.
		 */
		$moved = apply_filters( 'grp_files_move', null, $upload['tmp_name'], "$dir/$path" );
		if ( null === $moved ) {
			$moved = is_uploaded_file( $upload['tmp_name'] ) && move_uploaded_file( $upload['tmp_name'], "$dir/$path" );
		}
		if ( ! $moved ) {
			return self::error( __( 'The file could not be saved. Try again.', 'gridrankers-portal' ), 500 );
		}

		return GRP_Store::insert(
			'grp_files',
			array(
				'id'         => $id,
				'name'       => mb_substr( $name, 0, 191 ),
				'mime'       => self::TYPES[ $ext ],
				'size'       => $size,
				'path'       => $path,
				'created_by' => $actor['id'],
			)
		);
	}

	/**
	 * Absolute path of a stored file, or null when it is gone.
	 *
	 * @param array $file `grp_files` row.
	 * @return string|null
	 */
	public static function path( array $file ) {
		$dir = self::base_dir();
		if ( is_wp_error( $dir ) || ! preg_match( '#^\d{4}/\d{2}/[a-z0-9-]+\.[a-z]+$#', (string) $file['path'] ) ) {
			return null;
		}
		$path = "$dir/{$file['path']}";

		return is_file( $path ) ? $path : null;
	}

	/**
	 * 400 (or other) error.
	 *
	 * @param string $message Message.
	 * @param int    $status  HTTP status.
	 * @return WP_Error
	 */
	private static function error( $message, $status = 400 ) {
		return new WP_Error( 'grp_file', $message, array( 'status' => $status ) );
	}
}
