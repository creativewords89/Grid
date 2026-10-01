<?php
/**
 * WP-admin Import and Export screens.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * GridRankers → Import / Export. WordPress administrators only (manage_options + nonce).
 */
class GRP_Admin_Import_Export {

	const IMPORT_SLUG = 'gridrankers-portal-import';

	const EXPORT_SLUG = 'gridrankers-portal-export';

	/**
	 * Largest accepted upload, in bytes.
	 */
	const MAX_BYTES = 50 * MB_IN_BYTES;

	/**
	 * Hooks menus and form handlers.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ), 20 );
		add_action( 'admin_post_grp_import', array( __CLASS__, 'handle_import' ) );
		add_action( 'admin_post_grp_export', array( __CLASS__, 'handle_export' ) );
	}

	/**
	 * Adds the Import and Export submenus.
	 */
	public static function register_menu() {
		add_submenu_page( GRP_Admin_Settings::PAGE_SLUG, __( 'Import', 'gridrankers-portal' ), __( 'Import', 'gridrankers-portal' ), 'manage_options', self::IMPORT_SLUG, array( __CLASS__, 'render_import' ) );
		add_submenu_page( GRP_Admin_Settings::PAGE_SLUG, __( 'Export', 'gridrankers-portal' ), __( 'Export', 'gridrankers-portal' ), 'manage_options', self::EXPORT_SLUG, array( __CLASS__, 'render_export' ) );
	}

	/**
	 * Import screen: upload form and the last result.
	 */
	public static function render_import() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'gridrankers-portal' ) );
		}

		$result = get_transient( self::result_key() );
		delete_transient( self::result_key() );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Import from the current portal', 'gridrankers-portal' ); ?></h1>
			<p><?php esc_html_e( 'In the current portal open Team → Settings → Export all data, then upload the JSON file here. Importing again is safe: rows are matched by id and updated.', 'gridrankers-portal' ); ?></p>
			<?php self::render_result( $result ); ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" enctype="multipart/form-data">
				<input type="hidden" name="action" value="grp_import">
				<?php wp_nonce_field( 'grp_import' ); ?>
				<p>
					<label for="grp_import_file"><?php esc_html_e( 'Export file (.json)', 'gridrankers-portal' ); ?></label><br>
					<input type="file" id="grp_import_file" name="grp_import_file" accept="application/json,.json" required>
				</p>
				<p>
					<label><input type="checkbox" name="grp_dry_run" value="1" checked> <?php esc_html_e( 'Dry run (check and count only, change nothing)', 'gridrankers-portal' ); ?></label>
				</p>
				<?php submit_button( __( 'Import', 'gridrankers-portal' ) ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Export screen.
	 */
	public static function render_export() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'gridrankers-portal' ) );
		}
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Export all data', 'gridrankers-portal' ); ?></h1>
			<p><?php esc_html_e( 'Downloads every project, task, record, team member, activity and log as one JSON file (same format as the old portal export). Keep it somewhere safe: it contains hashed sign-in codes.', 'gridrankers-portal' ); ?></p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="grp_export">
				<?php wp_nonce_field( 'grp_export' ); ?>
				<?php submit_button( __( 'Download export', 'gridrankers-portal' ) ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Handles the import form.
	 */
	public static function handle_import() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'gridrankers-portal' ), 403 );
		}
		check_admin_referer( 'grp_import' );

		$file = $_FILES['grp_import_file'] ?? null; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- validated below.
		if ( ! is_array( $file ) || UPLOAD_ERR_OK !== ( $file['error'] ?? UPLOAD_ERR_NO_FILE ) || ! is_uploaded_file( $file['tmp_name'] ) ) {
			$result = new WP_Error( 'grp_import_upload', __( 'Upload failed. Pick the export file and try again.', 'gridrankers-portal' ) );
		} else {
			$result = self::import_file( $file['tmp_name'], ! empty( $_POST['grp_dry_run'] ) );
		}

		set_transient( self::result_key(), $result, 10 * MINUTE_IN_SECONDS );
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::IMPORT_SLUG ) );
		exit;
	}

	/**
	 * Imports a JSON file from disk.
	 *
	 * @param string $path    File path.
	 * @param bool   $dry_run Count only.
	 * @return array|WP_Error Summary.
	 */
	public static function import_file( $path, $dry_run ) {
		if ( ! is_readable( $path ) || filesize( $path ) > self::MAX_BYTES ) {
			return new WP_Error( 'grp_import_size', __( 'The file is missing or larger than 50 MB.', 'gridrankers-portal' ) );
		}

		$export = json_decode( (string) file_get_contents( $path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		if ( null === $export ) {
			return new WP_Error( 'grp_import_json', __( "That file isn't valid JSON.", 'gridrankers-portal' ) );
		}

		$summary = GRP_Import::run( $export, $dry_run );
		if ( ! is_wp_error( $summary ) && ! $summary['dry_run'] ) {
			GRP_Activity::audit( 'import', 'team', array( 'title' => 'Data import' ), GRP_Auth::current_member(), GRP_REST_Data::summary_line( $summary ) );
		}

		return $summary;
	}

	/**
	 * Streams the export as a download.
	 */
	public static function handle_export() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'gridrankers-portal' ), 403 );
		}
		check_admin_referer( 'grp_export' );

		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="gridrankers-portal-export-' . GRP_Cycles::today() . '.json"' );
		echo wp_json_encode( GRP_Export::build( GRP_Auth::current_member() ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		exit;
	}

	/**
	 * Prints an import result.
	 *
	 * @param mixed $result Summary, WP_Error or false.
	 */
	public static function render_result( $result ) {
		if ( is_wp_error( $result ) ) {
			printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $result->get_error_message() ) );
			return;
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		?>
		<div class="notice notice-<?php echo $result['dry_run'] ? 'info' : 'success'; ?>">
			<p><strong><?php echo esc_html( $result['dry_run'] ? __( 'Dry run: nothing was changed. This is what an import would do:', 'gridrankers-portal' ) : __( 'Import finished.', 'gridrankers-portal' ) ); ?></strong></p>
			<table class="widefat striped" style="max-width:640px">
				<thead><tr><th><?php esc_html_e( 'Collection', 'gridrankers-portal' ); ?></th><th><?php esc_html_e( 'New', 'gridrankers-portal' ); ?></th><th><?php esc_html_e( 'Updated', 'gridrankers-portal' ); ?></th><th><?php esc_html_e( 'Skipped', 'gridrankers-portal' ); ?></th></tr></thead>
				<tbody>
				<?php foreach ( $result['counts'] as $collection => $c ) : ?>
					<tr><td><?php echo esc_html( $collection ); ?></td><td><?php echo (int) $c['inserted']; ?></td><td><?php echo (int) $c['updated']; ?></td><td><?php echo (int) $c['skipped']; ?></td></tr>
				<?php endforeach; ?>
				</tbody>
			</table>
			<?php if ( $result['warnings'] ) : ?>
				<ul>
				<?php foreach ( $result['warnings'] as $warning ) : ?>
					<li><?php echo esc_html( $warning ); ?></li>
				<?php endforeach; ?>
				</ul>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * Per-user transient key for the last import result.
	 *
	 * @return string
	 */
	private static function result_key() {
		return 'grp_import_result_' . get_current_user_id();
	}
}
