<?php
/**
 * Updates from GitHub releases.
 *
 * Every change merged to main is tested on GitHub and published as a release with two files:
 * `gridrankers-portal.zip` and `update.json` ({version, package, requires, requires_php, notes}).
 * WordPress finds the release through the plugin's `Update URI` header, offers it on the
 * Plugins screen and installs it automatically (auto-updates are on for this plugin).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Hooks this plugin into WordPress' own update and auto-update system.
 */
class GRP_Updater {

	/**
	 * GitHub repository the releases come from.
	 */
	const REPO_URL = 'https://github.com/creativewords89/Grid';

	/**
	 * Manifest of the latest release (a plain download, not the rate-limited GitHub API).
	 */
	const MANIFEST_URL = self::REPO_URL . '/releases/latest/download/update.json';

	/**
	 * Packages are only accepted from this repository's releases.
	 */
	const PACKAGE_PREFIX = self::REPO_URL . '/releases/download/';

	/**
	 * Plugin slug (folder name).
	 */
	const SLUG = 'gridrankers-portal';

	/**
	 * Transient caching the manifest.
	 */
	const CACHE = 'grp_update_manifest';

	/**
	 * Option holding the outcome of the last request to GitHub (for GridRankers → Settings).
	 */
	const STATUS = 'grp_update_status';

	/**
	 * Hourly check, so a new release is installed within about an hour.
	 */
	const HOOK = 'grp_check_update';

	/**
	 * Hooks the update filters and the hourly check.
	 */
	public static function init() {
		add_filter( 'update_plugins_github.com', array( __CLASS__, 'check_update' ), 10, 3 );
		add_filter( 'auto_update_plugin', array( __CLASS__, 'auto_update' ), 10, 2 );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_info' ), 10, 3 );
		add_action( self::HOOK, array( __CLASS__, 'check_now' ) );
		add_action( 'init', array( __CLASS__, 'schedule' ) );
	}

	/**
	 * Schedules the hourly check if it isn't yet.
	 */
	public static function schedule() {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time() + 300, 'hourly', self::HOOK );
		}
	}

	/**
	 * Removes the schedule (deactivation).
	 */
	public static function unschedule() {
		wp_clear_scheduled_hook( self::HOOK );
	}

	/**
	 * This plugin's basename, e.g. `gridrankers-portal/gridrankers-portal.php`.
	 *
	 * @return string
	 */
	public static function basename() {
		return plugin_basename( GRP_PLUGIN_FILE );
	}

	/**
	 * The latest release's manifest, validated, or null. Cached for an hour (15 minutes after a failure).
	 *
	 * @param bool $refresh Skip the cache.
	 * @return array|null `{version, package, requires, requires_php, notes}`.
	 */
	public static function manifest( $refresh = false ) {
		$cached = $refresh ? false : get_transient( self::CACHE );
		if ( is_array( $cached ) ) {
			return $cached ? $cached : null;
		}

		$manifest = null;
		$response = wp_remote_get(
			self::MANIFEST_URL,
			array(
				'timeout'     => 10,
				'redirection' => 5,
				'headers'     => array( 'Accept' => 'application/json' ),
			)
		);
		$code     = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
		if ( 200 === $code ) {
			$manifest = self::validate( json_decode( (string) wp_remote_retrieve_body( $response ), true ) );
		}

		if ( is_wp_error( $response ) ) {
			/* translators: %s: error from the HTTP request, e.g. "Connection timed out". */
			$message = sprintf( __( "Couldn't reach GitHub: %s", 'gridrankers-portal' ), $response->get_error_message() );
		} elseif ( 200 !== $code ) {
			/* translators: %d: HTTP status code. */
			$message = sprintf( __( 'GitHub answered with HTTP %d (no release file found).', 'gridrankers-portal' ), $code );
		} elseif ( ! $manifest ) {
			$message = __( 'Reached GitHub, but the release file is not valid.', 'gridrankers-portal' );
		} else {
			$message = __( 'Reached GitHub.', 'gridrankers-portal' );
		}
		update_option(
			self::STATUS,
			array(
				'at'      => time(),
				'ok'      => (bool) $manifest,
				'version' => $manifest ? $manifest['version'] : null,
				'message' => $message,
			),
			false
		);

		set_transient( self::CACHE, $manifest ? $manifest : array(), $manifest ? HOUR_IN_SECONDS : 15 * MINUTE_IN_SECONDS );

		return $manifest;
	}

	/**
	 * Outcome of the last request to GitHub, or null before the first one.
	 *
	 * @return array|null `{at, ok, version, message}`.
	 */
	public static function status() {
		$status = get_option( self::STATUS );

		return is_array( $status ) ? $status : null;
	}

	/**
	 * "Check now": asks GitHub (skipping the cache) and refreshes WordPress' list of updates.
	 *
	 * @return array|null The new status.
	 */
	public static function run_check() {
		self::manifest( true );
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();

		return self::status();
	}

	/**
	 * Whether automatic installs are on (`GRP_AUTO_UPDATE` not set to false).
	 *
	 * @return bool
	 */
	public static function auto_enabled() {
		return ! ( defined( 'GRP_AUTO_UPDATE' ) && ! GRP_AUTO_UPDATE );
	}

	/**
	 * WordPress' own one-click "update this plugin" link.
	 *
	 * @return string
	 */
	public static function update_url() {
		$plugin = self::basename();

		return wp_nonce_url( self_admin_url( 'update.php?action=upgrade-plugin&plugin=' . rawurlencode( $plugin ) ), 'upgrade-plugin_' . $plugin );
	}

	/**
	 * Keeps a manifest only if its version is x.y.z and its package is a zip from this repository.
	 *
	 * @param mixed $data Decoded update.json.
	 * @return array|null
	 */
	public static function validate( $data ) {
		if ( ! is_array( $data ) ) {
			return null;
		}
		$version = (string) ( $data['version'] ?? '' );
		$package = (string) ( $data['package'] ?? '' );
		if ( ! preg_match( '/^\d+\.\d+\.\d+$/', $version )
			|| ! str_starts_with( $package, self::PACKAGE_PREFIX )
			|| ! str_ends_with( $package, '.zip' )
			|| str_contains( $package, '..' ) ) {
			return null;
		}

		return array(
			'version'      => $version,
			'package'      => $package,
			'requires'     => (string) ( $data['requires'] ?? '' ),
			'requires_php' => (string) ( $data['requires_php'] ?? '' ),
			'notes'        => (string) ( $data['notes'] ?? '' ),
		);
	}

	/**
	 * `update_plugins_github.com`: the latest release for this plugin. WordPress compares the
	 * version with the installed one and offers the update when it is newer.
	 *
	 * @param array|false $update      Update data from another filter, or false.
	 * @param array       $plugin_data Plugin headers.
	 * @param string      $plugin_file Plugin basename.
	 * @return array|false
	 */
	public static function check_update( $update, $plugin_data, $plugin_file ) {
		if ( self::basename() !== $plugin_file ) {
			return $update;
		}

		// "Check again" on Dashboard → Updates skips the cache.
		$force    = is_admin() && ! empty( $_GET['force-check'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only flag, same as WordPress core.
		$manifest = self::manifest( $force );
		if ( ! $manifest ) {
			return $update;
		}

		return array(
			'slug'         => self::SLUG,
			'version'      => $manifest['version'],
			'package'      => $manifest['package'],
			'url'          => self::REPO_URL,
			'requires'     => $manifest['requires'],
			'requires_php' => $manifest['requires_php'],
		);
	}

	/**
	 * `auto_update_plugin`: this plugin always updates itself, unless
	 * `define( 'GRP_AUTO_UPDATE', false );` is in wp-config.php.
	 *
	 * @param bool|null $update Whether to update.
	 * @param object    $item   Update offer.
	 * @return bool|null
	 */
	public static function auto_update( $update, $item ) {
		if ( isset( $item->plugin ) && self::basename() === $item->plugin ) {
			return self::auto_enabled();
		}

		return $update;
	}

	/**
	 * `plugins_api`: the "View details" popup.
	 *
	 * @param false|object|array $result Result.
	 * @param string             $action API action.
	 * @param object             $args   Arguments.
	 * @return false|object|array
	 */
	public static function plugin_info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || self::SLUG !== ( $args->slug ?? '' ) ) {
			return $result;
		}
		$manifest = self::manifest();
		if ( ! $manifest ) {
			return $result;
		}

		return (object) array(
			'name'          => 'GridRankers Portal',
			'slug'          => self::SLUG,
			'version'       => $manifest['version'],
			'author'        => 'GridRankers',
			'homepage'      => self::REPO_URL,
			'requires'      => $manifest['requires'],
			'requires_php'  => $manifest['requires_php'],
			'download_link' => $manifest['package'],
			'sections'      => array(
				'changelog' => '<p>' . esc_html( $manifest['notes'] ) . '</p><p><a href="' . esc_url( self::REPO_URL . '/releases' ) . '">' . esc_html__( 'All releases', 'gridrankers-portal' ) . '</a></p>',
			),
		);
	}

	/**
	 * Hourly: when a newer release exists, refresh WordPress' update list and run its
	 * automatic updater now instead of waiting for its twice-daily run.
	 *
	 * @return bool Whether a newer release was found.
	 */
	public static function check_now() {
		$manifest = self::manifest( true );
		if ( ! $manifest || ! version_compare( $manifest['version'], GRP_VERSION, '>' ) ) {
			return false;
		}

		delete_site_transient( 'update_plugins' );
		wp_update_plugins();

		/**
		 * Filters whether the hourly check runs WordPress' automatic updater.
		 *
		 * @param bool  $run      Run it (default true).
		 * @param array $manifest The newer release.
		 */
		if ( apply_filters( 'grp_run_auto_update', true, $manifest ) && function_exists( 'wp_maybe_auto_update' ) ) {
			wp_maybe_auto_update();
		}

		return true;
	}
}
