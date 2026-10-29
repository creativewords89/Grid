<?php
/**
 * Tests for the sites and the link (SPEC.md 6.22, step 103): the Sites settings, the link key and
 * who may use /link/*.
 *
 * @package GridRankers_Portal
 */

/**
 * The main portal and the tracker portal.
 */
class Test_GRP_Link extends GRP_REST_TestCase {

	/**
	 * Faked answers of the main portal for the tracker portal's calls.
	 *
	 * @var array|WP_Error|null
	 */
	private $answer = null;

	/**
	 * The tracker portal's last call.
	 *
	 * @var array|null
	 */
	private $sent = null;

	public function set_up() {
		parent::set_up();
		delete_option( GRP_Link::OPTION );
		delete_option( GRP_Link::KEY_OPTION );
		$_SERVER['REMOTE_ADDR'] = '203.0.113.9';
		delete_transient( 'grp_login_' . md5( '203.0.113.9' ) );
		add_filter( 'pre_http_request', array( $this, 'fake_http' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'fake_http' ), 10 );
		delete_transient( 'grp_login_' . md5( '203.0.113.9' ) );
		unset( $_SERVER['REMOTE_ADDR'] );
		parent::tear_down();
	}

	/**
	 * Fakes the main portal.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  URL.
	 * @return array|WP_Error
	 */
	public function fake_http( $pre, $args, $url ) {
		$this->sent = array(
			'url'  => $url,
			'args' => $args,
		);
		if ( is_wp_error( $this->answer ) ) {
			return $this->answer;
		}

		return array(
			'headers'  => array(),
			'body'     => $this->answer['body'],
			'response' => array(
				'code'    => $this->answer['status'],
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * A call to /link/* as the tracker portal makes it: no cookie, no nonce.
	 *
	 * @param string      $path  Path under the namespace.
	 * @param string|null $token Bearer token.
	 * @return WP_REST_Response
	 */
	private function link_call( $path = '/link/ping', $token = null ) {
		$this->as_nobody();
		$request = new WP_REST_Request( 'GET', '/gr-portal/v1' . $path );
		if ( null !== $token ) {
			$request->set_header( 'Authorization', 'Bearer ' . $token );
		}

		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Makes this site a main portal with a key.
	 *
	 * @return string The key.
	 */
	private function main_with_key() {
		GRP_Link::set_main( 'https://tracker.gridrankers.com' );

		return GRP_Link::make_key();
	}

	public function test_a_site_is_on_its_own_by_default() {
		$this->assertSame( GRP_Link::ALONE, GRP_Link::part() );
		$this->assertFalse( GRP_Link::is_main() );
		$this->assertFalse( GRP_Link::is_tracker() );
	}

	public function test_the_key_is_shown_once_and_stored_hashed() {
		$result = GRP_Admin_Settings::apply_link(
			array(
				'do'          => 'save',
				'part'        => 'main',
				'tracker_url' => 'tracker.gridrankers.com/',
			)
		);
		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'https://tracker.gridrankers.com', GRP_Link::settings()['tracker_url'] );
		$this->assertFalse( GRP_Link::has_key() );

		$made = GRP_Admin_Settings::apply_link( array( 'do' => 'make_key' ) );
		$this->assertTrue( $made['ok'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $made['key'] );
		$stored = wp_json_encode( get_option( GRP_Link::OPTION ) );
		$this->assertStringNotContainsString( $made['key'], $stored );
		$this->assertSame( hash( 'sha256', $made['key'] ), GRP_Link::settings()['key_hash'] );
		$this->assertSame( '', (string) get_option( GRP_Link::KEY_OPTION, '' ) );
		$this->assertTrue( GRP_Link::key_ok( $made['key'] ) );
	}

	public function test_a_key_needs_a_main_portal() {
		$this->assertWPError( GRP_Link::make_key() );
		$result = GRP_Admin_Settings::apply_link( array( 'do' => 'make_key' ) );
		$this->assertFalse( $result['ok'] );
		$this->assertArrayNotHasKey( 'key', $result );
	}

	public function test_a_new_key_ends_the_old_one_and_unlink_ends_all() {
		$old = $this->main_with_key();
		$new = GRP_Link::make_key();
		$this->assertNotSame( $old, $new );
		$this->assertSame( 401, $this->link_call( '/link/ping', $old )->get_status() );
		$this->assertSame( 200, $this->link_call( '/link/ping', $new )->get_status() );

		GRP_Admin_Settings::apply_link( array( 'do' => 'unlink' ) );
		$this->assertFalse( GRP_Link::has_key() );
		$this->assertSame( 401, $this->link_call( '/link/ping', $new )->get_status() );
	}

	public function test_ping_answers_the_link_key() {
		$key = $this->main_with_key();
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'active' => 0 ) );

		$res = $this->link_call( '/link/ping', $key );
		$this->assertSame( 200, $res->get_status() );
		$data = $res->get_data();
		$this->assertSame( GRP_VERSION, $data['version'] );
		$this->assertSame( 3, $data['people'] );
		$this->assertSame( home_url(), $data['url'] );
	}

	public function test_link_routes_take_only_the_link_key() {
		$this->main_with_key();

		// No key.
		$res = $this->link_call();
		$this->assertSame( 401, $res->get_status() );
		$this->assertSame( 'grp_link_key', $res->get_data()['code'] );
		// A wrong key.
		$this->assertSame( 401, $this->link_call( '/link/ping', str_repeat( 'a', 64 ) )->get_status() );

		// A device token.
		$device = GRP_Auth::device_login( 'MEMBERCODE1', '127.0.0.1', 'Laptop', 'win32', '1.0.0' );
		$this->assertSame( 401, $this->link_call( '/link/ping', $device['token'] )->get_status() );

		// A browser session with its nonce.
		delete_transient( 'grp_login_' . md5( '203.0.113.9' ) );
		$this->act_as( 'member' );
		$this->assertSame( 401, $this->api( 'GET', '/link/ping' )->get_status() );
		// The Super Admin's WordPress login.
		$this->act_as( 'admin' );
		$this->assertSame( 401, $this->api( 'GET', '/link/ping' )->get_status() );
	}

	public function test_a_link_key_reaches_no_other_route() {
		$key = $this->main_with_key();
		foreach ( array( '/projects', '/auth/me', '/timer', '/time-entries', '/members', '/sync' ) as $path ) {
			$res = $this->link_call( $path, $key );
			$this->assertSame( 403, $res->get_status(), $path );
			$this->assertSame( 'grp_link_route', $res->get_data()['code'], $path );
		}
	}

	public function test_link_routes_are_off_unless_this_is_a_main_portal() {
		$key = $this->main_with_key();
		GRP_Link::set_alone();
		$res = $this->link_call( '/link/ping', $key );
		$this->assertSame( 404, $res->get_status() );
		$this->assertSame( 'grp_link_off', $res->get_data()['code'] );

		GRP_Link::set_tracker( 'https://bot.gridrankers.com', $key );
		$this->assertSame( 404, $this->link_call( '/link/ping', $key )->get_status() );
	}

	public function test_wrong_keys_lock_the_ip() {
		$key = $this->main_with_key();
		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertSame( 401, $this->link_call( '/link/ping', str_repeat( 'b', 64 ) )->get_status() );
		}
		$res = $this->link_call( '/link/ping', $key );
		$this->assertSame( 429, $res->get_status() );
		$this->assertSame( 'grp_link_locked', $res->get_data()['code'] );
		// Wrong link keys and wrong codes share the lockout.
		$this->assertWPError( GRP_Auth::login( 'MEMBERCODE1', '203.0.113.9' ) );
	}

	public function test_addresses_are_https_except_this_computer() {
		$this->assertSame( 'https://bot.gridrankers.com', GRP_Link::clean_url( 'bot.gridrankers.com' ) );
		$this->assertSame( 'https://bot.gridrankers.com', GRP_Link::clean_url( 'https://bot.gridrankers.com/' ) );
		$this->assertSame( 'http://localhost:8090', GRP_Link::clean_url( 'http://localhost:8090/' ) );
		$this->assertSame( 'http://127.0.0.1:8090', GRP_Link::clean_url( 'http://127.0.0.1:8090' ) );
		$this->assertWPError( GRP_Link::clean_url( 'http://bot.gridrankers.com' ) );
		$this->assertWPError( GRP_Link::clean_url( '' ) );
		$this->assertWPError( GRP_Link::clean_url( 'ftp://bot.gridrankers.com' ) );
		$this->assertWPError( GRP_Link::clean_url( 'https://bot.gridrankers.com/?x=1' ) );
		$this->assertWPError( GRP_Link::set_main( 'http://tracker.gridrankers.com' ) );
		$this->assertWPError( GRP_Link::set_tracker( 'http://bot.gridrankers.com', str_repeat( 'c', 64 ) ) );
	}

	public function test_the_tracker_portal_keeps_the_key_out_of_autoload() {
		$key = str_repeat( 'd', 64 );
		$this->assertWPError( GRP_Link::set_tracker( 'https://bot.gridrankers.com', 'not-a-key' ) );
		$this->assertTrue( is_array( GRP_Link::set_tracker( 'https://bot.gridrankers.com', strtoupper( $key ) ) ) );
		$this->assertTrue( GRP_Link::is_tracker() );
		$this->assertSame( $key, get_option( GRP_Link::KEY_OPTION ) );
		$this->assertStringNotContainsString( $key, wp_json_encode( get_option( GRP_Link::OPTION ) ) );

		global $wpdb;
		$autoload = $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", GRP_Link::KEY_OPTION ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$this->assertContains( $autoload, array( 'no', 'off' ) );

		// Saving again without a key keeps it.
		GRP_Link::set_tracker( 'https://bot.gridrankers.com/', '' );
		$this->assertSame( $key, get_option( GRP_Link::KEY_OPTION ) );
		// On its own again, the key is forgotten.
		GRP_Link::set_alone();
		$this->assertFalse( get_option( GRP_Link::KEY_OPTION ) );
	}

	public function test_test_connection_says_connected() {
		$key          = str_repeat( 'e', 64 );
		$this->answer = array(
			'status' => 200,
			'body'   => wp_json_encode(
				array(
					'site'    => 'GridRankers',
					'url'     => 'https://bot.gridrankers.com',
					'version' => GRP_VERSION,
					'people'  => 23,
				)
			),
		);
		$result       = GRP_Admin_Settings::apply_link(
			array(
				'do'       => 'save',
				'part'     => 'tracker',
				'main_url' => 'bot.gridrankers.com',
				'key'      => $key,
			)
		);
		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'Connected to bot.gridrankers.com · 23 people', $result['message'] );
		$this->assertSame( 'Bearer ' . $key, $this->sent['args']['headers']['Authorization'] );
		$this->assertSame( 'https://bot.gridrankers.com/?rest_route=%2Fgr-portal%2Fv1%2Flink%2Fping', $this->sent['url'] );
		$this->assertNull( GRP_Link::settings()['last_error'] );
	}

	public function test_test_connection_says_why_not() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'f', 64 ) );
		$cases = array(
			'Can’t reach bot.gridrankers.com'      => new WP_Error( 'http_request_failed', 'cURL error 6' ),
			'isn’t a GridRankers portal'           => array(
				'status' => 200,
				'body'   => '<!doctype html><html></html>',
			),
			'The link key is wrong'                => array(
				'status' => 401,
				'body'   => '{"code":"grp_link_key","message":"The link key is wrong."}',
			),
			'isn’t set to Main portal'             => array(
				'status' => 404,
				'body'   => '{"code":"grp_link_off","message":"This site isn’t a main portal."}',
			),
			'Update its GridRankers Portal plugin' => array(
				'status' => 404,
				'body'   => '{"code":"rest_no_route","message":"No route was found"}',
			),
			'Too many wrong link keys'             => array(
				'status' => 429,
				'body'   => '{"code":"grp_link_locked","message":"Too many wrong link keys. Try again in 15 minutes."}',
			),
		);
		foreach ( $cases as $says => $answer ) {
			$this->answer = $answer;
			$result       = GRP_Admin_Settings::apply_link( array( 'do' => 'test' ) );
			$this->assertFalse( $result['ok'], $says );
			$this->assertStringContainsString( $says, $result['message'] );
			$this->assertStringContainsString( $says, GRP_Link::settings()['last_error'] );
		}
	}

	public function test_on_its_own_the_tracker_portal_calls_nobody() {
		$this->assertWPError( GRP_Link::call( 'GET', 'ping' ) );
		$this->assertNull( $this->sent );
	}

	public function test_schema_25_adds_the_main_portal_columns() {
		global $wpdb;
		$columns = $wpdb->get_col( 'SHOW COLUMNS FROM ' . GRP_Install::table( 'grp_time_entries' ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
		$this->assertContains( 'main_synced_at', $columns );
		$this->assertContains( 'main_error', $columns );
		$this->assertGreaterThanOrEqual( 25, GRP_Install::DB_VERSION );
	}
}
