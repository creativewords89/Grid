<?php
/**
 * Tests for GRP_Updater (updates from GitHub releases).
 *
 * @package GridRankers_Portal
 */

/**
 * Update checks, validation, auto-update and the hourly check.
 */
class Test_GRP_Updater extends WP_UnitTestCase {

	/**
	 * URLs requested during the test.
	 *
	 * @var string[]
	 */
	private $requests = array();

	/**
	 * Response for the manifest: array (JSON body), int (HTTP status) or WP_Error.
	 *
	 * @var mixed
	 */
	private $manifest_response;

	public function set_up() {
		parent::set_up();
		delete_transient( GRP_Updater::CACHE );
		$this->requests          = array();
		$this->manifest_response = $this->release( '9.9.9' );
		add_filter( 'pre_http_request', array( $this, 'fake_http' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'fake_http' ) );
		parent::tear_down();
	}

	/**
	 * A release manifest.
	 *
	 * @param string $version Version.
	 * @return array
	 */
	private function release( $version ) {
		return array(
			'version'      => $version,
			'package'      => GRP_Updater::PACKAGE_PREFIX . 'v' . $version . '/gridrankers-portal.zip',
			'requires'     => '6.4',
			'requires_php' => '8.1',
			'notes'        => 'Fix <b>things</b>',
		);
	}

	/**
	 * Fakes GitHub (and api.wordpress.org) responses.
	 *
	 * @param false|array $pre  Short-circuit value.
	 * @param array       $args Request arguments.
	 * @param string      $url  URL.
	 * @return array|WP_Error
	 */
	public function fake_http( $pre, $args, $url ) {
		$this->requests[] = $url;
		if ( GRP_Updater::MANIFEST_URL !== $url ) {
			return array(
				'headers'  => array(),
				'body'     => wp_json_encode(
					array(
						'plugins'      => array(),
						'translations' => array(),
						'no_update'    => array(),
					)
				),
				'response' => array(
					'code'    => 200,
					'message' => 'OK',
				),
				'cookies'  => array(),
			);
		}
		if ( is_wp_error( $this->manifest_response ) ) {
			return $this->manifest_response;
		}
		$code = is_int( $this->manifest_response ) ? $this->manifest_response : 200;
		return array(
			'headers'  => array(),
			'body'     => is_array( $this->manifest_response ) ? wp_json_encode( $this->manifest_response ) : (string) $this->manifest_response,
			'response' => array(
				'code'    => $code,
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * Requests made to the manifest URL.
	 *
	 * @return int
	 */
	private function manifest_requests() {
		return count( array_keys( $this->requests, GRP_Updater::MANIFEST_URL, true ) );
	}

	public function test_plugin_header_points_wordpress_at_the_github_filter() {
		$data = get_plugin_data( GRP_PLUGIN_FILE, false, false );

		$this->assertSame( GRP_Updater::REPO_URL, $data['UpdateURI'] );
		$this->assertSame( 'github.com', wp_parse_url( $data['UpdateURI'], PHP_URL_HOST ) );
		$this->assertNotFalse( has_filter( 'update_plugins_github.com', array( 'GRP_Updater', 'check_update' ) ) );
		$this->assertSame( GRP_VERSION, $data['Version'] );
	}

	public function test_offers_the_latest_release() {
		$update = GRP_Updater::check_update( false, array(), GRP_Updater::basename() );

		$this->assertSame( '9.9.9', $update['version'] );
		$this->assertSame( GRP_Updater::PACKAGE_PREFIX . 'v9.9.9/gridrankers-portal.zip', $update['package'] );
		$this->assertSame( 'gridrankers-portal', $update['slug'] );
		$this->assertSame( '8.1', $update['requires_php'] );
	}

	public function test_other_plugins_are_left_alone() {
		$this->assertFalse( GRP_Updater::check_update( false, array(), 'other/other.php' ) );
		$this->assertSame( 0, $this->manifest_requests() );
	}

	public function test_manifest_is_cached() {
		GRP_Updater::check_update( false, array(), GRP_Updater::basename() );
		GRP_Updater::check_update( false, array(), GRP_Updater::basename() );

		$this->assertSame( 1, $this->manifest_requests() );
	}

	/**
	 * Broken, missing or unsafe manifests are ignored.
	 *
	 * @dataProvider bad_manifests
	 *
	 * @param mixed $response Manifest response.
	 */
	public function test_bad_or_missing_manifests_offer_nothing( $response ) {
		$this->manifest_response = $response;

		$this->assertFalse( GRP_Updater::check_update( false, array(), GRP_Updater::basename() ) );
		// The failure is cached too, so a broken release doesn't hammer GitHub.
		$this->assertFalse( GRP_Updater::check_update( false, array(), GRP_Updater::basename() ) );
		$this->assertSame( 1, $this->manifest_requests() );
	}

	public function bad_manifests() {
		$ok = array(
			'version' => '1.2.3',
			'package' => GRP_Updater::PACKAGE_PREFIX . 'v1.2.3/gridrankers-portal.zip',
		);
		return array(
			'not found'      => array( 404 ),
			'network error'  => array( new WP_Error( 'http_request_failed', 'down' ) ),
			'not json'       => array( '<html>' ),
			'no version'     => array( array( 'package' => $ok['package'] ) ),
			'bad version'    => array( array_merge( $ok, array( 'version' => '1.2' ) ) ),
			'other host'     => array( array_merge( $ok, array( 'package' => 'https://evil.example/gridrankers-portal.zip' ) ) ),
			'other repo'     => array( array_merge( $ok, array( 'package' => 'https://github.com/someone/else/releases/download/v1/x.zip' ) ) ),
			'path traversal' => array( array_merge( $ok, array( 'package' => GRP_Updater::PACKAGE_PREFIX . '../../evil/x.zip' ) ) ),
			'not a zip'      => array( array_merge( $ok, array( 'package' => GRP_Updater::PACKAGE_PREFIX . 'v1.2.3/install.php' ) ) ),
			'http not https' => array( array_merge( $ok, array( 'package' => 'http://github.com/creativewords89/Grid/releases/download/v1.2.3/gridrankers-portal.zip' ) ) ),
		);
	}

	public function test_auto_update_is_on_for_this_plugin_only() {
		$this->assertTrue( GRP_Updater::auto_update( null, (object) array( 'plugin' => GRP_Updater::basename() ) ) );
		$this->assertNull( GRP_Updater::auto_update( null, (object) array( 'plugin' => 'other/other.php' ) ) );
		$this->assertFalse( GRP_Updater::auto_update( false, (object) array( 'plugin' => 'other/other.php' ) ) );
		$this->assertTrue( apply_filters( 'auto_update_plugin', false, (object) array( 'plugin' => GRP_Updater::basename() ) ) );
	}

	public function test_view_details_popup() {
		$info = GRP_Updater::plugin_info( false, 'plugin_information', (object) array( 'slug' => 'gridrankers-portal' ) );

		$this->assertSame( '9.9.9', $info->version );
		$this->assertSame( GRP_Updater::PACKAGE_PREFIX . 'v9.9.9/gridrankers-portal.zip', $info->download_link );
		$this->assertStringContainsString( 'Fix &lt;b&gt;things&lt;/b&gt;', $info->sections['changelog'] );
		$this->assertFalse( GRP_Updater::plugin_info( false, 'plugin_information', (object) array( 'slug' => 'akismet' ) ) );
		$this->assertFalse( GRP_Updater::plugin_info( false, 'query_plugins', (object) array( 'slug' => 'gridrankers-portal' ) ) );
	}

	public function test_hourly_check_starts_an_update_only_when_newer() {
		$ran = 0;
		add_filter(
			'grp_run_auto_update',
			static function () use ( &$ran ) {
				++$ran;
				return false;
			}
		);

		$this->manifest_response = $this->release( GRP_VERSION );
		$this->assertFalse( GRP_Updater::check_now() );
		$this->assertSame( 0, $ran );

		$this->manifest_response = $this->release( '9.9.9' );
		set_site_transient( 'update_plugins', (object) array( 'stale' => true ) );
		$this->assertTrue( GRP_Updater::check_now() );
		$this->assertSame( 1, $ran );
		$this->assertObjectNotHasProperty( 'stale', get_site_transient( 'update_plugins' ) );
		// check_now always asks GitHub (no cache).
		$this->assertSame( 2, $this->manifest_requests() );
	}

	public function test_hourly_check_is_scheduled_and_removed_on_deactivation() {
		GRP_Updater::schedule();
		$this->assertNotFalse( wp_next_scheduled( GRP_Updater::HOOK ) );

		GRP_Install::deactivate();
		$this->assertFalse( wp_next_scheduled( GRP_Updater::HOOK ) );
		$this->assertFalse( wp_next_scheduled( GRP_Cron::HOOK ) );
	}

	public function test_each_check_records_its_outcome() {
		delete_option( GRP_Updater::STATUS );
		$this->assertNull( GRP_Updater::status() );

		GRP_Updater::manifest( true );
		$ok = GRP_Updater::status();
		$this->assertTrue( $ok['ok'] );
		$this->assertSame( '9.9.9', $ok['version'] );
		$this->assertSame( 'Reached GitHub.', $ok['message'] );
		$this->assertEqualsWithDelta( time(), $ok['at'], 5 );

		$this->manifest_response = new WP_Error( 'http_request_failed', 'Connection timed out' );
		GRP_Updater::manifest( true );
		$this->assertFalse( GRP_Updater::status()['ok'] );
		$this->assertSame( "Couldn't reach GitHub: Connection timed out", GRP_Updater::status()['message'] );

		$this->manifest_response = 404;
		GRP_Updater::manifest( true );
		$this->assertStringContainsString( 'HTTP 404', GRP_Updater::status()['message'] );

		$this->manifest_response = array( 'version' => 'x' );
		GRP_Updater::manifest( true );
		$this->assertStringContainsString( 'not valid', GRP_Updater::status()['message'] );
	}

	public function test_check_now_skips_the_cache_and_refreshes_wordpress() {
		GRP_Updater::manifest();
		set_site_transient( 'update_plugins', (object) array( 'stale' => true ) );

		$status = GRP_Updater::run_check();

		$this->assertSame( 2, $this->manifest_requests(), 'asked GitHub again' );
		$this->assertTrue( $status['ok'] );
		$this->assertObjectNotHasProperty( 'stale', get_site_transient( 'update_plugins' ) );
	}

	public function test_settings_page_shows_the_updates_box() {
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		if ( is_multisite() ) {
			grant_super_admin( get_current_user_id() );
		}
		GRP_Updater::manifest( true );

		ob_start();
		GRP_Admin_Settings::render_updates();
		$html = ob_get_clean();

		$this->assertStringContainsString( 'Installed version', $html );
		$this->assertStringContainsString( esc_html( GRP_VERSION ), $html );
		$this->assertStringContainsString( '9.9.9 — an update is available', $html );
		$this->assertStringContainsString( 'Reached GitHub.', $html );
		$this->assertStringContainsString( 'name="action" value="grp_update_check"', $html );
		$this->assertStringContainsString( 'Update now to 9.9.9', $html );
		$this->assertStringContainsString( 'action=upgrade-plugin', $html );

		// Up to date: no Update now button.
		$this->manifest_response = $this->release( GRP_VERSION );
		GRP_Updater::manifest( true );
		ob_start();
		GRP_Admin_Settings::render_updates();
		$html = ob_get_clean();
		$this->assertStringContainsString( 'you are up to date', $html );
		$this->assertStringNotContainsString( 'Update now', $html );
	}
}
