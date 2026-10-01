<?php
/**
 * Portal page: shortcode, assets, front-page takeover, noindex and no-store (SPEC.md section 2).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Mounts the React app via [gridrankers_portal] on one page, makes that page the site's
 * front page and blocks the normal WordPress front end.
 */
class GRP_Frontend {

	const SHORTCODE = 'gridrankers_portal';

	const PAGE_OPTION = 'grp_portal_page_id';

	const HANDLE = 'grp-portal';

	/**
	 * Hooks.
	 */
	public static function init() {
		add_shortcode( self::SHORTCODE, array( __CLASS__, 'shortcode' ) );
		add_action( 'template_redirect', array( __CLASS__, 'template_redirect' ), 0 );
		add_filter( 'template_include', array( __CLASS__, 'template_include' ), 99 );
		add_filter( 'wp_robots', array( __CLASS__, 'robots' ) );
		add_filter( 'wp_sitemaps_enabled', '__return_false' );
		add_filter( 'script_loader_tag', array( __CLASS__, 'module_tag' ), 10, 2 );
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'rest_no_store' ), 10, 3 );
		add_action( 'send_headers', array( __CLASS__, 'robots_header' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'isolate_assets' ), PHP_INT_MAX );
		add_action( 'wp', array( __CLASS__, 'strip_head' ) );
		add_filter( 'show_admin_bar', array( __CLASS__, 'show_admin_bar' ) );
	}

	/**
	 * On the portal page, only the app's own styles and scripts load (theme and block
	 * styles would change its look).
	 */
	public static function isolate_assets() {
		if ( ! self::is_portal() ) {
			return;
		}
		foreach ( array( wp_styles(), wp_scripts() ) as $deps ) {
			foreach ( (array) $deps->queue as $handle ) {
				if ( ! str_starts_with( $handle, self::HANDLE ) ) {
					$deps->dequeue( $handle );
				}
			}
		}
	}

	/**
	 * Removes emoji, global-styles and other front-end head output on the portal page.
	 */
	public static function strip_head() {
		if ( ! self::is_portal() ) {
			return;
		}
		remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
		remove_action( 'wp_print_styles', 'print_emoji_styles' );
		remove_action( 'wp_enqueue_scripts', 'wp_enqueue_global_styles' );
		remove_action( 'wp_footer', 'wp_enqueue_global_styles', 1 );
		remove_action( 'wp_enqueue_scripts', 'wp_enqueue_classic_theme_styles' );
		remove_action( 'wp_footer', 'wp_enqueue_stored_styles', 1 );
		remove_action( 'wp_head', 'wp_print_auto_sizes_contain_css_fix', 1 );
	}

	/**
	 * No WordPress admin bar on the portal page.
	 *
	 * @param bool $show Whether to show it.
	 * @return bool
	 */
	public static function show_admin_bar( $show ) {
		return self::is_portal() ? false : $show;
	}

	/**
	 * Creates the portal page if needed and makes it the static front page.
	 *
	 * @return int Page id.
	 */
	public static function install_page() {
		$page_id = (int) get_option( self::PAGE_OPTION );
		$page    = $page_id ? get_post( $page_id ) : null;

		if ( ! $page || 'page' !== $page->post_type || 'trash' === $page->post_status ) {
			$page_id = wp_insert_post(
				array(
					'post_type'    => 'page',
					'post_status'  => 'publish',
					'post_title'   => 'GridRankers',
					'post_name'    => 'portal',
					'post_content' => '[' . self::SHORTCODE . ']',
				)
			);
			update_option( self::PAGE_OPTION, $page_id, false );
		}

		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $page_id );

		return (int) $page_id;
	}

	/**
	 * The portal page id (0 when not installed).
	 *
	 * @return int
	 */
	public static function page_id() {
		return (int) get_option( self::PAGE_OPTION );
	}

	/**
	 * Whether the current request is for the portal page.
	 *
	 * @return bool
	 */
	public static function is_portal() {
		$id = self::page_id();

		return $id && ( is_page( $id ) || ( is_front_page() && (int) get_option( 'page_on_front' ) === $id ) );
	}

	/**
	 * [gridrankers_portal]: the mount point. Enqueues the app and its config.
	 *
	 * @return string
	 */
	public static function shortcode() {
		self::enqueue();

		return '<div id="grp-portal-root"></div><noscript>' . esc_html__( 'The GridRankers portal needs JavaScript.', 'gridrankers-portal' ) . '</noscript>';
	}

	/**
	 * Enqueues the built app (app/dist, from the Vite manifest) and its config.
	 *
	 * @return bool Whether the build was found.
	 */
	public static function enqueue() {
		$assets = self::assets();
		if ( ! $assets ) {
			return false;
		}

		foreach ( $assets['css'] as $i => $css ) {
			wp_enqueue_style( self::HANDLE . '-' . $i, GRP_PLUGIN_URL . 'app/dist/' . $css, array(), null ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- hashed file names.
		}
		wp_enqueue_script( self::HANDLE, GRP_PLUGIN_URL . 'app/dist/' . $assets['js'], array(), null, true ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- hashed file names.
		wp_add_inline_script( self::HANDLE, 'window.GRP_CONFIG = ' . wp_json_encode( self::config() ) . ';', 'before' );

		return true;
	}

	/**
	 * Config passed to the app.
	 *
	 * @return array
	 */
	public static function config() {
		$user = wp_get_current_user();

		return array(
			'restRoot'   => esc_url_raw( rest_url( GRP_REST_Auth::REST_NAMESPACE . '/' ) ),
			'nonce'      => wp_create_nonce( 'wp_rest' ),
			'loginUrl'   => wp_login_url( home_url( '/' ) ),
			'isWpAdmin'  => current_user_can( 'manage_options' ),
			'wpUserName' => $user->exists() ? $user->display_name : '',
			'version'    => GRP_VERSION,
		);
	}

	/**
	 * Entry JS and CSS files from app/dist/.vite/manifest.json.
	 *
	 * @return array|null `{js, css[]}`.
	 */
	public static function assets() {
		$manifest = GRP_PLUGIN_DIR . 'app/dist/.vite/manifest.json';
		if ( ! is_readable( $manifest ) ) {
			return null;
		}

		$data  = json_decode( (string) file_get_contents( $manifest ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		$entry = $data['src/main.jsx'] ?? null;
		if ( ! $entry || empty( $entry['file'] ) ) {
			return null;
		}

		return array(
			'js'  => $entry['file'],
			'css' => $entry['css'] ?? array(),
		);
	}

	/**
	 * Loads the app script as an ES module.
	 *
	 * @param string $tag    Script tag.
	 * @param string $handle Handle.
	 * @return string
	 */
	public static function module_tag( $tag, $handle ) {
		if ( self::HANDLE === $handle ) {
			// Only the external file; the inline config before it stays a classic script. Themes without
			// HTML5 script support make WordPress print type='text/javascript', which must be replaced.
			$tag = preg_replace_callback(
				'/<script\b[^>]*\bsrc=[^>]*>/',
				static function ( $m ) {
					$open = preg_replace( '/\s+type=(["\'])[^"\']*\1/', '', $m[0] );
					return preg_replace( '/^<script\b/', '<script type="module"', $open );
				},
				$tag
			);
		}

		return $tag;
	}

	/**
	 * Where to send a front-end request, or null to serve it.
	 *
	 * Everything except the portal page goes to the portal (posts, archives, search,
	 * feeds, attachments). wp-admin, login, REST, cron and AJAX are not front-end requests.
	 *
	 * @return string|null
	 */
	public static function redirect_target() {
		if ( is_admin() || wp_doing_ajax() || wp_doing_cron() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) || ! self::page_id() ) {
			return null;
		}
		if ( self::is_portal() && ! is_search() && ! is_feed() ) {
			return null;
		}

		return home_url( '/' );
	}

	/**
	 * Redirects non-portal pages; sends no-store headers on the portal page.
	 */
	public static function template_redirect() {
		$target = self::redirect_target();
		if ( $target ) {
			wp_safe_redirect( $target, 302 );
			exit;
		}
		if ( self::is_portal() ) {
			nocache_headers();
			header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0' );
		}
	}

	/**
	 * Serves the portal page with the plugin's bare template (no theme chrome).
	 *
	 * @param string $template Theme template.
	 * @return string
	 */
	public static function template_include( $template ) {
		return self::is_portal() ? GRP_PLUGIN_DIR . 'templates/portal.php' : $template;
	}

	/**
	 * Adds noindex, nofollow everywhere on the front end.
	 *
	 * @param array $robots Robots directives.
	 * @return array
	 */
	public static function robots( array $robots ) {
		$robots['noindex']  = true;
		$robots['nofollow'] = true;
		unset( $robots['max-image-preview'] );

		return $robots;
	}

	/**
	 * X-Robots-Tag on every front-end response.
	 */
	public static function robots_header() {
		if ( ! headers_sent() ) {
			header( 'X-Robots-Tag: noindex, nofollow', true );
		}
	}

	/**
	 * Cache-Control: no-store on every portal API response.
	 *
	 * @param WP_HTTP_Response $response Response.
	 * @param WP_REST_Server   $server   Server.
	 * @param WP_REST_Request  $request  Request.
	 * @return WP_HTTP_Response
	 */
	public static function rest_no_store( $response, $server, $request ) {
		if ( str_starts_with( $request->get_route(), '/' . GRP_REST_Auth::REST_NAMESPACE ) && $response instanceof WP_HTTP_Response ) {
			$response->header( 'Cache-Control', 'no-store' );
		}

		return $response;
	}
}
