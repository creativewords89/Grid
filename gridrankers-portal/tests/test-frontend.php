<?php
/**
 * Tests for GRP_Frontend: portal page, shortcode, assets, redirects, noindex, no-store.
 *
 * @package GridRankers_Portal
 */

/**
 * Front end.
 */
class Test_GRP_Frontend extends WP_UnitTestCase {

	/**
	 * Portal page id.
	 *
	 * @var int
	 */
	private $page_id;

	public function set_up() {
		parent::set_up();
		$this->page_id = GRP_Frontend::install_page();
	}

	public function test_activation_creates_portal_page_as_front_page() {
		$page = get_post( $this->page_id );

		$this->assertSame( 'page', $page->post_type );
		$this->assertSame( 'publish', $page->post_status );
		$this->assertSame( '[gridrankers_portal]', $page->post_content );
		$this->assertSame( 'page', get_option( 'show_on_front' ) );
		$this->assertSame( $this->page_id, (int) get_option( 'page_on_front' ) );

		$this->assertSame( $this->page_id, GRP_Frontend::install_page(), 'idempotent' );

		wp_trash_post( $this->page_id );
		$this->assertNotSame( $this->page_id, GRP_Frontend::install_page(), 'recreated when trashed' );
	}

	public function test_shortcode_mounts_app_with_config() {
		$html = do_shortcode( '[gridrankers_portal]' );

		$this->assertStringContainsString( '<div id="grp-portal-root"></div>', $html );

		if ( GRP_Frontend::assets() ) {
			$this->assertTrue( wp_script_is( GRP_Frontend::HANDLE, 'enqueued' ) );
			$before = implode( '', (array) wp_scripts()->get_data( GRP_Frontend::HANDLE, 'before' ) );
			$this->assertStringContainsString( 'window.GRP_CONFIG', $before );
			$this->assertStringContainsString( wp_create_nonce( 'wp_rest' ), $before );
			$this->assertStringContainsString( 'gr-portal\/v1', $before );
			$this->assertStringContainsString( '/app/dist/assets/', wp_scripts()->registered[ GRP_Frontend::HANDLE ]->src );
		}
	}

	public function test_built_assets_are_present() {
		$assets = GRP_Frontend::assets();

		$this->assertNotNull( $assets, 'run npm run build in app/' );
		$this->assertFileExists( GRP_PLUGIN_DIR . 'app/dist/' . $assets['js'] );
		$this->assertNotEmpty( $assets['css'] );
	}

	public function test_script_is_a_module() {
		// phpcs:disable WordPress.WP.EnqueuedResources.NonEnqueuedScript -- testing the tag filter.
		$tag = GRP_Frontend::module_tag( "<script id=\"grp-portal-js-before\">\nwindow.GRP_CONFIG = {};\n</script>\n<script src=\"x.js\" id=\"grp-portal-js\"></script>", GRP_Frontend::HANDLE );
		$this->assertStringContainsString( '<script type="module" src="x.js"', $tag );
		$this->assertStringContainsString( '<script id="grp-portal-js-before">', $tag, 'inline config stays classic' );

		$other = '<script src="y.js"></script>';
		$this->assertSame( $other, GRP_Frontend::module_tag( $other, 'jquery' ) );
		// phpcs:enable
	}

	public function test_portal_page_is_served_and_everything_else_redirects() {
		$this->go_to( home_url( '/' ) );
		$this->assertTrue( GRP_Frontend::is_portal() );
		$this->assertNull( GRP_Frontend::redirect_target() );
		$this->assertSame( GRP_PLUGIN_DIR . 'templates/portal.php', GRP_Frontend::template_include( '/theme/page.php' ) );

		$post = self::factory()->post->create();
		$this->go_to( get_permalink( $post ) );
		$this->assertFalse( GRP_Frontend::is_portal() );
		$this->assertSame( home_url( '/' ), GRP_Frontend::redirect_target() );
		$this->assertSame( '/theme/single.php', GRP_Frontend::template_include( '/theme/single.php' ) );

		$this->go_to( home_url( '/?s=plumbing' ) );
		$this->assertSame( home_url( '/' ), GRP_Frontend::redirect_target() );

		$this->go_to( home_url( '/?feed=rss2' ) );
		$this->assertSame( home_url( '/' ), GRP_Frontend::redirect_target() );
	}

	public function test_portal_template_renders_mount_point() {
		$this->go_to( home_url( '/' ) );

		ob_start();
		include GRP_PLUGIN_DIR . 'templates/portal.php';
		$html = ob_get_clean();

		$this->assertStringContainsString( '<div id="grp-portal-root"></div>', $html );
		$this->assertStringContainsString( 'noindex', $html );
	}

	public function test_noindex_and_no_sitemaps() {
		$robots = GRP_Frontend::robots( array( 'max-image-preview' => 'large' ) );

		$this->assertTrue( $robots['noindex'] );
		$this->assertTrue( $robots['nofollow'] );
		$this->assertFalse( apply_filters( 'wp_sitemaps_enabled', true ) );
	}

	public function test_api_responses_are_no_store() {
		$portal = GRP_Frontend::rest_no_store( new WP_REST_Response( array() ), rest_get_server(), new WP_REST_Request( 'GET', '/gr-portal/v1/auth/me' ) );
		$this->assertSame( 'no-store', $portal->get_headers()['Cache-Control'] );

		$other = GRP_Frontend::rest_no_store( new WP_REST_Response( array() ), rest_get_server(), new WP_REST_Request( 'GET', '/wp/v2/posts' ) );
		$this->assertArrayNotHasKey( 'Cache-Control', $other->get_headers() );
	}
}
