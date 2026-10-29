<?php
/**
 * Tests for signing in on the tracker portal through the main portal (SPEC.md 6.22, step 105).
 *
 * @package GridRankers_Portal
 */

/**
 * Codes are checked by the main portal; the Super Admin is mapped to a copied profile.
 *
 * Both sites share this test database: the faked HTTP call runs the main portal's /link/* route
 * here, with the site switched to Main portal for that call.
 */
class Test_GRP_Link_Auth extends GRP_REST_TestCase {

	const KEY = 'abababababababababababababababababababababababababababababababab';

	/**
	 * Main portal unreachable.
	 *
	 * @var bool
	 */
	private $down = false;

	/**
	 * Calls made to the main portal.
	 *
	 * @var array[]
	 */
	private $calls = array();

	public function set_up() {
		parent::set_up();
		delete_option( GRP_Link::OPTION );
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', self::KEY );
		foreach ( array( '198.51.100.7', '198.51.100.8', 'tracker-portal' ) as $ip ) {
			delete_transient( 'grp_login_' . md5( $ip ) );
		}
		add_filter( 'pre_http_request', array( $this, 'main_portal' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'main_portal' ), 10 );
		delete_option( GRP_Link::OPTION );
		delete_option( GRP_Link::KEY_OPTION );
		parent::tear_down();
	}

	/**
	 * The main portal: runs its /link/* route in this WordPress, as a main portal.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  URL.
	 * @return array|WP_Error
	 */
	public function main_portal( $pre, $args, $url ) {
		parse_str( (string) wp_parse_url( $url, PHP_URL_QUERY ), $query );
		$this->calls[] = array(
			'route' => $query['rest_route'] ?? '',
			'body'  => json_decode( (string) ( $args['body'] ?? '' ), true ),
		);
		if ( $this->down ) {
			return new WP_Error( 'http_request_failed', 'timeout' );
		}

		$tracker = get_option( GRP_Link::OPTION );
		update_option(
			GRP_Link::OPTION,
			array(
				'part'     => GRP_Link::MAIN,
				'key_hash' => hash( 'sha256', self::KEY ),
			)
		);
		$request = new WP_REST_Request( $args['method'], $query['rest_route'] );
		$request->set_header( 'Authorization', $args['headers']['Authorization'] );
		if ( isset( $args['body'] ) ) {
			$request->set_header( 'Content-Type', 'application/json' );
			$request->set_body( $args['body'] );
		}
		$response = rest_get_server()->dispatch( $request );
		update_option( GRP_Link::OPTION, $tracker );

		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $response->get_data() ),
			'response' => array(
				'code'    => $response->get_status(),
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * Routes called on the main portal.
	 *
	 * @return string[]
	 */
	private function routes() {
		return wp_list_pluck( $this->calls, 'route' );
	}

	public function test_the_main_portals_code_signs_in_on_the_tracker() {
		$result = GRP_Auth::login( 'MEMBERCODE1', '198.51.100.7' );
		$this->assertIsArray( $result );
		$this->assertSame( $this->team['member']['id'], $result['member']['id'] );
		$this->assertSame( array( '/gr-portal/v1/link/verify' ), $this->routes() );
		$this->assertSame(
			array(
				'code' => 'MEMBERCODE1',
				'ip'   => '198.51.100.7',
			),
			$this->calls[0]['body']
		);
	}

	public function test_the_desktop_app_signs_in_on_the_tracker() {
		$this->as_nobody();
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/auth/device' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				array(
					'code'        => 'LEADCODE1',
					'device_name' => 'Lee’s laptop',
					'platform'    => 'darwin',
				)
			)
		);
		$res = rest_get_server()->dispatch( $request );
		$this->assertStatus( 200, $res );
		$this->assertSame( $this->team['lead']['id'], $res->get_data()['member']['id'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $res->get_data()['token'] );
	}

	public function test_a_wrong_code_gets_the_generic_error() {
		$result = GRP_Auth::login( 'NOPE1234', '198.51.100.7' );
		$this->assertWPError( $result );
		$this->assertSame( 'grp_invalid_code', $result->get_error_code() );
		$this->assertSame( "That code doesn't match anyone.", $result->get_error_message() );
	}

	public function test_wrong_codes_lock_the_persons_ip_on_the_main_portal() {
		for ( $i = 0; $i < 5; $i++ ) {
			GRP_Auth::login( 'NOPE1234', '198.51.100.7' );
		}
		$locked = GRP_Auth::login( 'MEMBERCODE1', '198.51.100.7' );
		$this->assertWPError( $locked );
		$this->assertSame( 'grp_locked', $locked->get_error_code() );

		// Only that person's IP: someone else signs in through the same tracker portal.
		$this->assertIsArray( GRP_Auth::login( 'OTHERCODE1', '198.51.100.8' ) );
		$this->assertFalse( GRP_Auth::is_locked( 'tracker-portal' ) );
	}

	public function test_the_main_portal_locks_out_on_its_own() {
		// Main portal side: the IP sent, not the caller's.
		update_option(
			GRP_Link::OPTION,
			array(
				'part'     => GRP_Link::MAIN,
				'key_hash' => hash( 'sha256', self::KEY ),
			)
		);
		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertWPError( GRP_Auth::check_code( 'NOPE1234', '198.51.100.7' ) );
		}
		$this->assertTrue( GRP_Auth::is_locked( '198.51.100.7' ) );
		$this->assertSame( 'grp_locked', GRP_Auth::check_code( 'MEMBERCODE1', '198.51.100.7' )->get_error_code() );
	}

	public function test_main_portal_not_reachable() {
		$this->down = true;
		$result     = GRP_Auth::login( 'MEMBERCODE1', '198.51.100.7' );
		$this->assertWPError( $result );
		$this->assertSame( 'grp_main_unreachable', $result->get_error_code() );
		$this->assertSame( 'Can’t reach bot.gridrankers.com to check your code. Try again in a minute.', $result->get_error_message() );
		$this->assertSame( 503, $result->get_error_data()['status'] );
		// Not a wrong code: no attempt counted.
		$this->assertFalse( get_transient( 'grp_login_' . md5( '198.51.100.7' ) ) );
	}

	public function test_no_code_is_checked_on_the_tracker_portal() {
		// The main portal says whose code it is; a code only this site knows signs nobody in.
		GRP_Store::insert(
			'grp_members',
			array(
				'id'        => 'local-only',
				'name'      => 'Local Only',
				'role'      => 'member',
				'active'    => 1,
				'code_hash' => password_hash( 'LOCALCODE9', PASSWORD_DEFAULT ),
			)
		);
		$this->down = true;
		$this->assertSame( 'grp_main_unreachable', GRP_Auth::login( 'LOCALCODE9', '198.51.100.7' )->get_error_code() );
	}

	public function test_inactive_or_super_admin_profiles_never_sign_in_with_a_code() {
		// The main portal knows the code, but the copy here is inactive.
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'active' => 0 ) );
		$this->assertSame( 'grp_invalid_code', GRP_Auth::login( 'OTHERCODE1', '198.51.100.7' )->get_error_code() );
	}

	public function test_the_super_admin_is_mapped_by_email() {
		$wp_user = self::factory()->user->create(
			array(
				'role'       => 'administrator',
				'user_email' => 'Ada@GridRankers.com',
			)
		);
		$copied  = $this->add_member( 'Ada Copied', 'admin' );
		GRP_Store::update( 'grp_members', $copied['id'], array( 'email' => 'ada@gridrankers.com' ) );

		$this->as_nobody();
		wp_set_current_user( $wp_user );
		$this->assertFalse( GRP_Auth::needs_setup() );
		$me = GRP_Auth::current_member();
		$this->assertSame( $copied['id'], $me['id'] );
		$this->assertSame( $wp_user, (int) GRP_Store::get( 'grp_members', $copied['id'] )['wp_user_id'] );
	}

	public function test_set_up_picks_a_copied_super_admin_and_never_makes_one() {
		$copied  = $this->add_member( 'Bea Boss', 'admin' );
		$wp_user = self::factory()->user->create(
			array(
				'role'       => 'administrator',
				'user_email' => 'someone-else@example.com',
			)
		);
		$this->as_nobody();
		wp_set_current_user( $wp_user );

		$me = $this->api( 'GET', '/auth/me' )->get_data();
		$this->assertTrue( $me['needsSetup'] );
		$this->assertSame( 'https://bot.gridrankers.com', $me['mainPortal'] );
		$this->assertSame( array( 'Bea Boss' ), wp_list_pluck( $me['setupChoices'], 'name' ) );

		$count = count( GRP_Store::find( 'grp_members' ) );
		$res   = $this->api( 'POST', '/auth/setup', array( 'name' => 'New Admin' ) );
		$this->assertSame( 400, $res->get_status() );
		$this->assertSame( 'grp_main_portal', $res->get_data()['code'] );
		$this->assertCount( $count, GRP_Store::find( 'grp_members' ) );

		// A profile that isn't a copied Super Admin can't be picked.
		$this->assertSame( 400, $this->api( 'POST', '/auth/setup', array( 'member_id' => $this->team['member']['id'] ) )->get_status() );

		$res = $this->api( 'POST', '/auth/setup', array( 'member_id' => $copied['id'] ) );
		$this->assertStatus( 200, $res );
		$this->assertSame( $copied['id'], $res->get_data()['member']['id'] );
		$this->assertSame( 'admin', $res->get_data()['member']['role'] );
		$this->assertCount( $count, GRP_Store::find( 'grp_members' ) );
	}

	public function test_on_its_own_set_up_still_makes_the_super_admin() {
		GRP_Link::set_alone();
		$wp_user = self::factory()->user->create( array( 'role' => 'administrator' ) );
		$this->as_nobody();
		wp_set_current_user( $wp_user );
		$me = $this->api( 'GET', '/auth/me' )->get_data();
		$this->assertArrayNotHasKey( 'setupChoices', $me );
		$this->assertStatus( 200, $this->api( 'POST', '/auth/setup', array( 'name' => 'New Admin' ) ) );
	}

	public function test_verify_needs_the_link_key() {
		$this->as_nobody();
		update_option(
			GRP_Link::OPTION,
			array(
				'part'     => GRP_Link::MAIN,
				'key_hash' => hash( 'sha256', self::KEY ),
			)
		);
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/link/verify' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( wp_json_encode( array( 'code' => 'MEMBERCODE1' ) ) );
		$this->assertSame( 401, rest_get_server()->dispatch( $request )->get_status() );
	}
}
