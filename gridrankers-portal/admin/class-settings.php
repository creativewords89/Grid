<?php
/**
 * WP-admin settings page (stub).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers the GridRankers Portal settings screen under Settings.
 */
class GRP_Admin_Settings {

	/**
	 * Admin page slug.
	 */
	const PAGE_SLUG = 'gridrankers-portal';

	/**
	 * Hooks the menu registration.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
	}

	/**
	 * Adds the page under Settings. Only administrators (manage_options) can open it.
	 */
	public static function register_menu() {
		add_options_page(
			__( 'GridRankers Portal', 'gridrankers-portal' ),
			__( 'GridRankers Portal', 'gridrankers-portal' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * Renders the (empty) settings page.
	 */
	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'gridrankers-portal' ) );
		}
		?>
		<div class="wrap">
			<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
			<p>
				<?php
				printf(
					/* translators: %d: database schema version number. */
					esc_html__( 'Database schema version: %d', 'gridrankers-portal' ),
					(int) GRP_Install::installed_version()
				);
				?>
			</p>
		</div>
		<?php
	}
}
