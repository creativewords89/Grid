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
		add_action( 'admin_post_grp_link', array( __CLASS__, 'handle_link' ) );
		add_filter( 'plugin_row_meta', array( __CLASS__, 'row_meta' ), 10, 2 );
		add_action( 'admin_notices', array( __CLASS__, 'plugins_notice' ) );
	}

	/**
	 * Check-now URL. From the Plugins screen it comes back there.
	 *
	 * @param string $from `plugins` or `settings`.
	 * @return string
	 */
	public static function check_url( $from = 'settings' ) {
		return wp_nonce_url( admin_url( 'admin-post.php?action=grp_update_check&from=' . rawurlencode( $from ) ), 'grp_update_check' );
	}

	/**
	 * "Check for updates" link in this plugin's row on the Plugins screen.
	 *
	 * @param string[] $links Row meta links.
	 * @param string   $file  Plugin basename.
	 * @return string[]
	 */
	public static function row_meta( $links, $file ) {
		if ( GRP_Updater::basename() === $file && current_user_can( 'update_plugins' ) ) {
			$links[] = sprintf( '<a href="%s">%s</a>', esc_url( self::check_url( 'plugins' ) ), esc_html__( 'Check for updates', 'gridrankers-portal' ) );
		}

		return $links;
	}

	/**
	 * The result of "Check for updates" on the Plugins screen.
	 */
	public static function plugins_notice() {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display flag only.
		if ( empty( $_GET['grp_checked'] ) || ! $screen || 'plugins' !== $screen->id ) {
			return;
		}
		$status = GRP_Updater::status();
		if ( ! $status ) {
			return;
		}
		$newer = ! empty( $status['version'] ) && version_compare( $status['version'], GRP_VERSION, '>' );
		$text  = $newer
			/* translators: %s: version number. */
			? sprintf( __( 'version %s is available. Use “update now” in the plugin’s row below.', 'gridrankers-portal' ), $status['version'] )
			: $status['message'];
		printf(
			'<div class="notice notice-%1$s is-dismissible"><p><strong>GridRankers Portal:</strong> %2$s</p></div>',
			esc_attr( $status['ok'] ? ( $newer ? 'warning' : 'success' ) : 'error' ),
			esc_html( $text )
		);
	}

	/**
	 * "Check now" on the Updates box (or "Check for updates" on the Plugins screen): asks
	 * GitHub and comes back to where it was clicked.
	 */
	public static function handle_update_check() {
		if ( ! current_user_can( 'update_plugins' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'gridrankers-portal' ), 403 );
		}
		check_admin_referer( 'grp_update_check' );

		GRP_Updater::run_check();
		$from = isset( $_GET['from'] ) ? sanitize_key( wp_unslash( $_GET['from'] ) ) : ''; // Nonce checked above.
		$back = 'plugins' === $from ? 'plugins.php?grp_checked=1' : 'admin.php?page=' . self::PAGE_SLUG . '&grp_checked=1';
		wp_safe_redirect( admin_url( $back ) );
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
			<?php self::render_sites(); ?>
			<?php self::render_updates(); ?>
		</div>
		<?php
	}

	/**
	 * Sites box (SPEC.md 6.22): on its own, main portal (tracker address, Make a link key, Unlink) or
	 * tracker portal (main portal address, link key, Test connection).
	 */
	public static function render_sites() {
		$link    = GRP_Link::settings();
		$part    = GRP_Link::part();
		$user    = get_current_user_id();
		$new_key = get_transient( 'grp_link_new_key_' . $user );
		$notice  = get_transient( 'grp_link_notice_' . $user );
		delete_transient( 'grp_link_new_key_' . $user );
		delete_transient( 'grp_link_notice_' . $user );
		$has_key = '' !== (string) get_option( GRP_Link::KEY_OPTION, '' );
		?>
		<h2><?php esc_html_e( 'Sites', 'gridrankers-portal' ); ?></h2>
		<p><?php esc_html_e( 'Profiles are made once, on the main portal. A tracker portal copies them, signs the desktop tracker in with the same codes and sends the hours back.', 'gridrankers-portal' ); ?></p>
		<?php if ( is_array( $notice ) ) : ?>
			<div class="notice grp-link-notice notice-<?php echo esc_attr( $notice['ok'] ? 'success' : 'error' ); ?> inline"><p><?php echo esc_html( $notice['message'] ); ?></p></div>
		<?php endif; ?>
		<?php if ( $new_key ) : ?>
			<div class="notice notice-warning inline">
				<p><strong><?php esc_html_e( 'Your new link key — copy it now, it is shown only once:', 'gridrankers-portal' ); ?></strong></p>
				<p><input type="text" class="large-text code" readonly value="<?php echo esc_attr( $new_key ); ?>" onclick="this.select()"></p>
				<p><?php esc_html_e( 'Paste it on the tracker portal: WP admin → GridRankers → Settings → Sites → Tracker portal.', 'gridrankers-portal' ); ?></p>
			</div>
		<?php endif; ?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="grp_link">
			<?php wp_nonce_field( 'grp_link' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'This site is', 'gridrankers-portal' ); ?></th>
					<td>
						<fieldset>
							<label><input type="radio" name="part" value="alone" <?php checked( GRP_Link::ALONE, $part ); ?>> <?php esc_html_e( 'On its own', 'gridrankers-portal' ); ?></label><br>
							<label><input type="radio" name="part" value="main" <?php checked( GRP_Link::MAIN, $part ); ?>> <?php esc_html_e( 'Main portal — profiles, reports and pay live here', 'gridrankers-portal' ); ?></label><br>
							<label><input type="radio" name="part" value="tracker" <?php checked( GRP_Link::TRACKER, $part ); ?>> <?php esc_html_e( 'Tracker portal — copies profiles from the main portal', 'gridrankers-portal' ); ?></label>
						</fieldset>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="grp-tracker-url"><?php esc_html_e( 'Tracker site (main portal)', 'gridrankers-portal' ); ?></label></th>
					<td>
						<input type="url" id="grp-tracker-url" name="tracker_url" class="regular-text" placeholder="https://tracker.gridrankers.com" value="<?php echo esc_attr( $link['tracker_url'] ); ?>">
						<p class="description">
							<?php
							if ( GRP_Link::has_key() ) {
								/* translators: %s: date and time. */
								echo esc_html( sprintf( __( 'Linked · key made %s (UTC).', 'gridrankers-portal' ), $link['made_at'] ) );
							} else {
								esc_html_e( 'Not linked: make a link key.', 'gridrankers-portal' );
							}
							?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="grp-main-url"><?php esc_html_e( 'Main portal (tracker portal)', 'gridrankers-portal' ); ?></label></th>
					<td>
						<input type="url" id="grp-main-url" name="main_url" class="regular-text" placeholder="https://bot.gridrankers.com" value="<?php echo esc_attr( $link['main_url'] ); ?>"><br>
						<input type="password" name="key" class="regular-text code" autocomplete="off" placeholder="<?php echo esc_attr( $has_key ? __( 'Saved — paste a new key to change it', 'gridrankers-portal' ) : __( 'Link key from the main portal', 'gridrankers-portal' ) ); ?>">
						<?php if ( GRP_Link::is_tracker() && $link['last_error'] ) : ?>
							<p class="description"><?php echo esc_html( $link['last_error'] ); ?></p>
						<?php elseif ( GRP_Link::is_tracker() && $link['last_copy_at'] ) : ?>
							<?php /* translators: %s: how long ago, e.g. "3 mins". */ ?>
							<p class="description"><?php echo esc_html( sprintf( __( 'Profiles copied %s ago. They are copied every 5 minutes.', 'gridrankers-portal' ), human_time_diff( (int) strtotime( $link['last_copy_at'] . ' UTC' ) ) ) ); ?></p>
						<?php endif; ?>
					</td>
				</tr>
			</table>
			<p>
				<button type="submit" name="do" value="save" class="button button-primary"><?php esc_html_e( 'Save', 'gridrankers-portal' ); ?></button>
				<?php if ( GRP_Link::is_main() ) : ?>
					<button type="submit" name="do" value="make_key" class="button"><?php esc_html_e( 'Make a link key', 'gridrankers-portal' ); ?></button>
					<?php if ( GRP_Link::has_key() ) : ?>
						<button type="submit" name="do" value="unlink" class="button"><?php esc_html_e( 'Unlink', 'gridrankers-portal' ); ?></button>
					<?php endif; ?>
				<?php endif; ?>
				<?php if ( GRP_Link::is_tracker() ) : ?>
					<button type="submit" name="do" value="test" class="button"><?php esc_html_e( 'Test connection', 'gridrankers-portal' ); ?></button>
					<button type="submit" name="do" value="sync" class="button"><?php esc_html_e( 'Sync now', 'gridrankers-portal' ); ?></button>
				<?php endif; ?>
			</p>
		</form>
		<?php
	}

	/**
	 * Saves the Sites box and runs its buttons, then comes back to the settings page.
	 */
	public static function handle_link() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'gridrankers-portal' ), 403 );
		}
		check_admin_referer( 'grp_link' );

		$input = array();
		foreach ( array( 'do', 'part', 'tracker_url', 'main_url', 'key' ) as $field ) {
			$input[ $field ] = isset( $_POST[ $field ] ) ? sanitize_text_field( wp_unslash( $_POST[ $field ] ) ) : ''; // Nonce checked above.
		}
		$result = self::apply_link( $input );
		$user   = get_current_user_id();
		if ( ! empty( $result['key'] ) ) {
			set_transient( 'grp_link_new_key_' . $user, $result['key'], 10 * MINUTE_IN_SECONDS );
		}
		set_transient( 'grp_link_notice_' . $user, array_intersect_key( $result, array_flip( array( 'ok', 'message' ) ) ), 10 * MINUTE_IN_SECONDS );

		wp_safe_redirect( admin_url( 'admin.php?page=' . self::PAGE_SLUG ) );
		exit;
	}

	/**
	 * What the Sites box's buttons do.
	 *
	 * @param array $input `{do: save|make_key|unlink|test, part, tracker_url, main_url, key}`.
	 * @return array `{ok, message, key?}` (key: a new link key, to show once).
	 */
	public static function apply_link( array $input ) {
		$do = (string) ( $input['do'] ?? 'save' );
		if ( 'sync' === $do ) {
			$copy = GRP_Link_Copy::run();
			return is_wp_error( $copy ) ? self::link_failed( $copy ) : array(
				'ok'      => true,
				'message' => self::copy_message( $copy ),
			);
		}
		if ( 'make_key' === $do || 'unlink' === $do || 'test' === $do ) {
			if ( 'make_key' === $do ) {
				$key = GRP_Link::make_key();
				return is_wp_error( $key ) ? self::link_failed( $key ) : array(
					'ok'      => true,
					'message' => __( 'New link key made. The old one no longer works.', 'gridrankers-portal' ),
					'key'     => $key,
				);
			}
			if ( 'unlink' === $do ) {
				GRP_Link::unlink();
				return array(
					'ok'      => true,
					'message' => __( 'Unlinked. The tracker portal can no longer reach this site.', 'gridrankers-portal' ),
				);
			}
			return self::test_and_copy();
		}

		$part = (string) ( $input['part'] ?? '' );
		if ( GRP_Link::MAIN === $part ) {
			$saved = GRP_Link::set_main( (string) ( $input['tracker_url'] ?? '' ) );
			if ( is_wp_error( $saved ) ) {
				return self::link_failed( $saved );
			}
			return array(
				'ok'      => true,
				'message' => GRP_Link::has_key() ? __( 'Saved.', 'gridrankers-portal' ) : __( 'Saved. Now make a link key.', 'gridrankers-portal' ),
			);
		}
		if ( GRP_Link::TRACKER === $part ) {
			$saved = GRP_Link::set_tracker( (string) ( $input['main_url'] ?? '' ), (string) ( $input['key'] ?? '' ) );
			if ( is_wp_error( $saved ) ) {
				return self::link_failed( $saved );
			}
			return self::test_and_copy();
		}
		GRP_Link::set_alone();

		return array(
			'ok'      => true,
			'message' => __( 'Saved. This site works on its own.', 'gridrankers-portal' ),
		);
	}

	/**
	 * Test connection, then the first copy of the profiles when it works.
	 *
	 * @return array `{ok, message}`.
	 */
	private static function test_and_copy() {
		$test = GRP_Link::test();
		if ( is_wp_error( $test ) ) {
			return self::link_failed( $test );
		}
		$copy = GRP_Link_Copy::run();

		return array(
			'ok'      => ! is_wp_error( $copy ),
			'message' => $test['message'] . ' · ' . ( is_wp_error( $copy ) ? $copy->get_error_message() : self::copy_message( $copy ) ),
		);
	}

	/**
	 * What a copy changed, in words.
	 *
	 * @param array $copy GRP_Link_Copy::apply()'s summary.
	 * @return string
	 */
	private static function copy_message( array $copy ) {
		$people = $copy['members'] ?? array();

		/* translators: 1: people added, 2: people changed, 3: people made inactive. */
		return sprintf( __( 'Profiles copied: %1$d new, %2$d changed, %3$d removed.', 'gridrankers-portal' ), (int) ( $people['added'] ?? 0 ), (int) ( $people['changed'] ?? 0 ), (int) ( $people['removed'] ?? 0 ) );
	}

	/**
	 * A failed Sites action.
	 *
	 * @param WP_Error $error Why.
	 * @return array
	 */
	private static function link_failed( WP_Error $error ) {
		return array(
			'ok'      => false,
			'message' => $error->get_error_message(),
		);
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
