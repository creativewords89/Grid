<?php
/**
 * WP-admin settings page: schema version and updates.
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
		add_action( 'admin_post_grp_update_check', array( __CLASS__, 'handle_update_check' ) );
	}

	/**
	 * "Check now" on the Updates box: asks GitHub and comes back to the settings page.
	 */
	public static function handle_update_check() {
		if ( ! current_user_can( 'update_plugins' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'gridrankers-portal' ), 403 );
		}
		check_admin_referer( 'grp_update_check' );

		GRP_Updater::run_check();
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::PAGE_SLUG . '&grp_checked=1' ) );
		exit;
	}

	/**
	 * Adds the top-level GridRankers menu (Settings, Import, Export). Administrators only.
	 */
	public static function register_menu() {
		add_menu_page(
			__( 'GridRankers Portal', 'gridrankers-portal' ),
			__( 'GridRankers', 'gridrankers-portal' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render' ),
			'dashicons-groups',
			3
		);
		add_submenu_page(
			self::PAGE_SLUG,
			__( 'GridRankers Portal', 'gridrankers-portal' ),
			__( 'Settings', 'gridrankers-portal' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * Renders the settings page: schema version and the Updates box.
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
			<?php self::render_updates(); ?>
		</div>
		<?php
	}

	/**
	 * Updates box: installed and latest version, the last check and its outcome, Check now,
	 * and Update now when a newer release exists (README, Updates).
	 */
	public static function render_updates() {
		$status = GRP_Updater::status();
		$latest = $status['version'] ?? null;
		$newer  = $latest && version_compare( $latest, GRP_VERSION, '>' );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display flag only.
		$checked = ! empty( $_GET['grp_checked'] );
		?>
		<h2><?php esc_html_e( 'Updates', 'gridrankers-portal' ); ?></h2>
		<?php if ( $checked && $status ) : ?>
			<div class="notice notice-<?php echo $status['ok'] ? 'success' : 'error'; ?> inline"><p><?php echo esc_html( $status['message'] ); ?></p></div>
		<?php endif; ?>
		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><?php esc_html_e( 'Installed version', 'gridrankers-portal' ); ?></th>
				<td><?php echo esc_html( GRP_VERSION ); ?></td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Latest on GitHub', 'gridrankers-portal' ); ?></th>
				<td>
					<?php
					if ( ! $latest ) {
						esc_html_e( 'Not known yet — click Check now.', 'gridrankers-portal' );
					} elseif ( $newer ) {
						/* translators: %s: version number. */
						echo esc_html( sprintf( __( '%s — an update is available', 'gridrankers-portal' ), $latest ) );
					} else {
						/* translators: %s: version number. */
						echo esc_html( sprintf( __( '%s — you are up to date', 'gridrankers-portal' ), $latest ) );
					}
					?>
				</td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Last check', 'gridrankers-portal' ); ?></th>
				<td>
					<?php
					if ( $status ) {
						/* translators: 1: how long ago, e.g. "5 mins", 2: outcome message. */
						echo esc_html( sprintf( __( '%1$s ago · %2$s', 'gridrankers-portal' ), human_time_diff( (int) $status['at'] ), $status['message'] ) );
					} else {
						esc_html_e( 'Never', 'gridrankers-portal' );
					}
					?>
				</td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Automatic updates', 'gridrankers-portal' ); ?></th>
				<td>
					<?php
					echo esc_html(
						GRP_Updater::auto_enabled()
							? __( 'On — new releases install by themselves within about an hour.', 'gridrankers-portal' )
							: __( 'Off (GRP_AUTO_UPDATE is false in wp-config.php) — updates are offered but not installed.', 'gridrankers-portal' )
					);
					?>
				</td>
			</tr>
		</table>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px">
			<input type="hidden" name="action" value="grp_update_check">
			<?php wp_nonce_field( 'grp_update_check' ); ?>
			<?php submit_button( __( 'Check now', 'gridrankers-portal' ), 'secondary', 'submit', false ); ?>
		</form>
		<?php if ( $newer && current_user_can( 'update_plugins' ) ) : ?>
			<a class="button button-primary" href="<?php echo esc_url( GRP_Updater::update_url() ); ?>">
				<?php
				/* translators: %s: version number. */
				echo esc_html( sprintf( __( 'Update now to %s', 'gridrankers-portal' ), $latest ) );
				?>
			</a>
		<?php endif; ?>
		<?php
	}
}
