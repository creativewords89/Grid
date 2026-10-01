<?php
/**
 * Tests for GRP_Auth and the /auth/* REST endpoints (SPEC.md section 4).
 *
 * @package GridRankers_Portal
 */

/**
 * Code login, legacy hashes, lockout, sessions, WP-admin mapping and logout.
 */
class Test_GRP_Auth extends WP_UnitTestCase {

	const IP = '203.0.113.7';

	public function set_up() {
		parent::set_up();

		GRP_Auth::reset();
		unset( $_COOKIE[ GRP_Auth::COOKIE ] );
		wp_set_current_user( 0 );

		// Fresh REST server so the plugin's routes are registered.
		global $wp_rest_server;
		$wp_rest_server = new WP_REST_Server(); // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		do_action( 'rest_api_init', $wp_rest_server );
	}

	public function tear_down() {
		global $wp_rest_server;
		$wp_rest_server = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited

		GRP_Auth::reset();
		unset( $_COOKIE[ GRP_Auth::COOKIE ] );

		parent::tear_down();
	}

	/**
	 * Inserts a team member.
	 *
	 * @param array $fields Column overrides.
	 * @return array The row.
	 */
	private function add_member( array $fields = array() ) {
		global $wpdb;

		$now = GRP_Ids::now();
		$row = array_merge(
			array(
				'id'         => GRP_Ids::ulid(),
				'name'       => 'Sam',
				'role'       => 'member',
				'active'     => 1,
				'created_at' => $now,
				'updated_at' => $now,
			),
			$fields
		);
		$wpdb->insert( GRP_Install::table( 'grp_members' ), $row ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		return $row;
	}

	/**
	 * Inserts a member and sets their code.
	 *
	 * @param string $code   Code.
	 * @param array  $fields Column overrides.
	 * @return array The row.
	 */
	private function member_with_code( $code, array $fields = array() ) {
		$member = $this->add_member( $fields );
		$this->assertTrue( GRP_Auth::set_code( $member['id'], $code ) );

		return $member;
	}

	/**
	 * Reads a member row.
	 *
	 * @param string $id Member id.
	 * @return array
	 */
	private function get_member( $id ) {
		global $wpdb;

		return $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM %i WHERE id = %s', GRP_Install::table( 'grp_members' ), $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Number of sessions for a member.
	 *
	 * @param string $member_id Member id.
	 * @return int
	 */
	private function session_count( $member_id ) {
		global $wpdb;

		return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM %i WHERE member_id = %s', GRP_Install::table( 'grp_sessions' ), $member_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Simulates the next request carrying a session cookie.
	 *
	 * @param string|null $token Raw token.
	 */
	private function next_request( $token ) {
		GRP_Auth::reset();
		if ( null === $token ) {
			unset( $_COOKIE[ GRP_Auth::COOKIE ] );
		} else {
			$_COOKIE[ GRP_Auth::COOKIE ] = $token;
		}
	}

	/**
	 * Dispatches a portal REST request with a valid nonce.
	 *
	 * @param string $method HTTP method.
	 * @param string $path   Path after the namespace.
	 * @param array  $params Body params.
	 * @param bool   $nonce  Whether to send a valid nonce.
	 * @return WP_REST_Response
	 */
	private function rest( $method, $path, array $params = array(), $nonce = true ) {
		$request = new WP_REST_Request( $method, '/gr-portal/v1' . $path );
		if ( $nonce ) {
			$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		}
		foreach ( $params as $key => $value ) {
			$request->set_param( $key, $value );
		}

		return rest_get_server()->dispatch( $request );
	}

	public function test_generate_code_uses_alphabet_and_length() {
		for ( $i = 0; $i < 50; $i++ ) {
			$this->assertMatchesRegularExpression( '/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/', GRP_Auth::generate_code() );
		}
	}

	public function test_set_code_stores_password_hash() {
		$member = $this->member_with_code( 'PLUMB3R5' );
		$row    = $this->get_member( $member['id'] );

		$this->assertNotSame( 'PLUMB3R5', $row['code_hash'] );
		$this->assertTrue( password_verify( 'PLUMB3R5', $row['code_hash'] ) );
		$this->assertNull( $row['code_salt'] );
		$this->assertNotEmpty( $row['code_set_at'] );
	}

	public function test_set_code_requires_six_characters() {
		$member = $this->add_member();

		$result = GRP_Auth::set_code( $member['id'], 'ABC12' );

		$this->assertWPError( $result );
		$this->assertSame( 'grp_code_too_short', $result->get_error_code() );
	}

	public function test_set_code_must_be_unique() {
		$this->member_with_code( 'SAMECODE' );
		$other = $this->add_member( array( 'name' => 'Alex' ) );

		$result = GRP_Auth::set_code( $other['id'], 'SAMECODE' );

		$this->assertWPError( $result );
		$this->assertSame( 'grp_code_taken', $result->get_error_code() );
	}

	public function test_set_code_unique_against_legacy_hashes() {
		$this->add_member(
			array(
				'code_salt' => 'abc',
				'code_hash' => hash( 'sha256', 'abc:LEGACY99' ),
			)
		);
		$other = $this->add_member( array( 'name' => 'Alex' ) );

		$this->assertWPError( GRP_Auth::set_code( $other['id'], 'LEGACY99' ) );
	}

	public function test_login_with_correct_code() {
		$member = $this->member_with_code( 'GOODCODE' );

		$result = GRP_Auth::login( '  GOODCODE ', self::IP, 'phpunit' );

		$this->assertIsArray( $result );
		$this->assertSame( $member['id'], $result['member']['id'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $result['token'] );
		$this->assertSame( 1, $this->session_count( $member['id'] ) );
	}

	public function test_session_stores_only_token_hash_with_30_day_expiry() {
		global $wpdb;

		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP, 'phpunit' )['token'];

		$session = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM %i WHERE member_id = %s', GRP_Install::table( 'grp_sessions' ), $member['id'] ), ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		$this->assertSame( hash( 'sha256', $token ), $session['token_hash'] );
		$this->assertStringNotContainsString( $token, implode( '|', $session ) );
		$this->assertEqualsWithDelta( time() + 30 * DAY_IN_SECONDS, strtotime( $session['expires_at'] . ' UTC' ), 5 );
		$this->assertSame( self::IP, $session['ip'] );
		$this->assertSame( 'phpunit', $session['user_agent'] );
	}

	public function test_codes_are_case_sensitive() {
		$this->member_with_code( 'GOODCODE' );

		$this->assertWPError( GRP_Auth::login( 'goodcode', self::IP ) );
	}

	public function test_wrong_code_gives_generic_error() {
		$this->member_with_code( 'GOODCODE' );

		$result = GRP_Auth::login( 'BADCODE1', self::IP );

		$this->assertWPError( $result );
		$this->assertSame( 'grp_invalid_code', $result->get_error_code() );
		$this->assertSame( "That code doesn't match anyone.", $result->get_error_message() );
		$this->assertSame( 401, $result->get_error_data()['status'] );
	}

	public function test_empty_code_fails() {
		$this->assertWPError( GRP_Auth::login( '   ', self::IP ) );
	}

	public function test_legacy_sha256_code_logs_in_and_is_rehashed() {
		$member = $this->add_member(
			array(
				'code_salt' => 'k9x2',
				'code_hash' => hash( 'sha256', 'k9x2:OLDCODE' ),
			)
		);

		$result = GRP_Auth::login( 'OLDCODE', self::IP );

		$this->assertIsArray( $result );
		$this->assertSame( $member['id'], $result['member']['id'] );

		$row = $this->get_member( $member['id'] );
		$this->assertNull( $row['code_salt'] );
		$this->assertTrue( password_verify( 'OLDCODE', $row['code_hash'] ) );

		// Still works after the rehash.
		GRP_Auth::reset();
		$this->assertIsArray( GRP_Auth::login( 'OLDCODE', self::IP ) );
	}

	public function test_legacy_hash_with_wrong_code_is_not_rehashed() {
		$hash   = hash( 'sha256', 'k9x2:OLDCODE' );
		$member = $this->add_member(
			array(
				'code_salt' => 'k9x2',
				'code_hash' => $hash,
			)
		);

		$this->assertWPError( GRP_Auth::login( 'NOTIT', self::IP ) );
		$this->assertSame( $hash, $this->get_member( $member['id'] )['code_hash'] );
	}

	public function test_inactive_member_cannot_sign_in() {
		$this->member_with_code( 'GOODCODE', array( 'active' => 0 ) );

		$this->assertWPError( GRP_Auth::login( 'GOODCODE', self::IP ) );
	}

	public function test_super_admin_cannot_sign_in_with_code() {
		$this->member_with_code( 'ADMINCODE', array( 'role' => 'admin' ) );

		$this->assertWPError( GRP_Auth::login( 'ADMINCODE', self::IP ) );
	}

	public function test_five_failures_lock_the_ip_for_15_minutes() {
		$this->member_with_code( 'GOODCODE' );

		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertSame( 'grp_invalid_code', GRP_Auth::login( 'WRONG' . $i, self::IP )->get_error_code() );
		}

		$this->assertTrue( GRP_Auth::is_locked( self::IP ) );

		$locked = GRP_Auth::login( 'GOODCODE', self::IP );
		$this->assertWPError( $locked );
		$this->assertSame( 'grp_locked', $locked->get_error_code() );
		$this->assertSame( 429, $locked->get_error_data()['status'] );

		$state = get_transient( 'grp_login_' . md5( self::IP ) );
		$this->assertEqualsWithDelta( time() + 15 * MINUTE_IN_SECONDS, $state['until'], 5 );

		// Other IPs are not affected.
		$this->assertIsArray( GRP_Auth::login( 'GOODCODE', '198.51.100.1' ) );
	}

	public function test_lock_expires() {
		$this->member_with_code( 'GOODCODE' );
		set_transient(
			'grp_login_' . md5( self::IP ),
			array(
				'count' => 5,
				'until' => time() - 1,
			),
			60
		);

		$this->assertFalse( GRP_Auth::is_locked( self::IP ) );
		$this->assertIsArray( GRP_Auth::login( 'GOODCODE', self::IP ) );
	}

	public function test_four_failures_then_success_resets_counter() {
		$this->member_with_code( 'GOODCODE' );

		for ( $i = 0; $i < 4; $i++ ) {
			GRP_Auth::login( 'WRONG' . $i, self::IP );
		}
		$this->assertIsArray( GRP_Auth::login( 'GOODCODE', self::IP ) );

		for ( $i = 0; $i < 4; $i++ ) {
			GRP_Auth::login( 'WRONG' . $i, self::IP );
		}
		$this->assertFalse( GRP_Auth::is_locked( self::IP ) );
	}

	public function test_current_member_from_session_cookie() {
		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];

		$this->next_request( $token );
		$this->assertSame( $member['id'], GRP_Auth::current_member()['id'] );

		$this->next_request( str_repeat( 'a', 64 ) );
		$this->assertNull( GRP_Auth::current_member() );

		$this->next_request( 'not-a-token' );
		$this->assertNull( GRP_Auth::current_member() );

		$this->next_request( null );
		$this->assertNull( GRP_Auth::current_member() );
	}

	public function test_expired_session_is_rejected() {
		global $wpdb;

		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];
		$wpdb->update( GRP_Install::table( 'grp_sessions' ), array( 'expires_at' => GRP_Ids::now( time() - 1 ) ), array( 'member_id' => $member['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		$this->next_request( $token );
		$this->assertNull( GRP_Auth::current_member() );
	}

	public function test_session_of_deactivated_member_is_rejected() {
		global $wpdb;

		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];
		$wpdb->update( GRP_Install::table( 'grp_members' ), array( 'active' => 0 ), array( 'id' => $member['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		$this->next_request( $token );
		$this->assertNull( GRP_Auth::current_member() );
	}

	public function test_logout_deletes_the_session() {
		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];

		$this->next_request( $token );
		GRP_Auth::logout();

		$this->assertSame( 0, $this->session_count( $member['id'] ) );
		$this->next_request( $token );
		$this->assertNull( GRP_Auth::current_member() );
	}

	public function test_set_code_revokes_all_sessions() {
		$member = $this->member_with_code( 'GOODCODE' );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];
		GRP_Auth::login( 'GOODCODE', '198.51.100.1' );
		$this->assertSame( 2, $this->session_count( $member['id'] ) );

		$this->assertTrue( GRP_Auth::set_code( $member['id'], 'NEWCODE9' ) );

		$this->assertSame( 0, $this->session_count( $member['id'] ) );
		$this->next_request( $token );
		$this->assertNull( GRP_Auth::current_member() );
		$this->assertWPError( GRP_Auth::login( 'GOODCODE', self::IP ) );
		$this->assertIsArray( GRP_Auth::login( 'NEWCODE9', self::IP ) );
	}

	public function test_wp_admin_is_mapped_to_linked_member() {
		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		$member   = $this->add_member(
			array(
				'role'       => 'admin',
				'wp_user_id' => $wp_admin,
			)
		);

		wp_set_current_user( $wp_admin );

		$this->assertSame( $member['id'], GRP_Auth::current_member()['id'] );
		$this->assertFalse( GRP_Auth::needs_setup() );
	}

	public function test_wp_admin_without_member_needs_setup() {
		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $wp_admin );

		$this->assertNull( GRP_Auth::current_member() );
		$this->assertTrue( GRP_Auth::needs_setup() );

		$member = GRP_Auth::setup_admin_member( 'Owner' );

		$this->assertSame( 'admin', $member['role'] );
		$this->assertSame( (string) $wp_admin, (string) $member['wp_user_id'] );
		$this->assertSame( $member['id'], GRP_Auth::current_member()['id'] );
		$this->assertFalse( GRP_Auth::needs_setup() );
		$this->assertWPError( GRP_Auth::setup_admin_member( 'Again' ) );
	}

	public function test_non_admin_wp_user_is_not_mapped_or_offered_setup() {
		$editor = self::factory()->user->create( array( 'role' => 'editor' ) );
		$this->add_member(
			array(
				'role'       => 'admin',
				'wp_user_id' => $editor,
			)
		);
		wp_set_current_user( $editor );

		$this->assertNull( GRP_Auth::current_member() );
		$this->assertFalse( GRP_Auth::needs_setup() );
		$this->assertWPError( GRP_Auth::setup_admin_member( 'Sneaky' ) );
	}

	public function test_admin_role_session_cookie_is_ignored() {
		global $wpdb;

		$member = $this->member_with_code( 'GOODCODE', array( 'role' => 'lead' ) );
		$token  = GRP_Auth::login( 'GOODCODE', self::IP )['token'];
		$wpdb->update( GRP_Install::table( 'grp_members' ), array( 'role' => 'admin' ), array( 'id' => $member['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		$this->next_request( $token );
		$this->assertNull( GRP_Auth::current_member() );
	}

	public function test_public_member_hides_secrets() {
		$member = $this->member_with_code( 'GOODCODE' );
		$public = GRP_Auth::public_member( $this->get_member( $member['id'] ) );

		$this->assertArrayNotHasKey( 'code_hash', $public );
		$this->assertArrayNotHasKey( 'code_salt', $public );
		$this->assertTrue( $public['has_code'] );
	}

	public function test_rest_login_me_logout() {
		$member = $this->member_with_code( 'GOODCODE' );

		$response = $this->rest( 'POST', '/auth/login', array( 'code' => 'GOODCODE' ) );
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( $member['id'], $response->get_data()['member']['id'] );
		$this->assertArrayNotHasKey( 'code_hash', $response->get_data()['member'] );

		$me = $this->rest( 'GET', '/auth/me' );
		$this->assertSame( $member['id'], $me->get_data()['member']['id'] );

		$this->assertSame( 200, $this->rest( 'POST', '/auth/logout' )->get_status() );
		$this->assertSame( 0, $this->session_count( $member['id'] ) );

		GRP_Auth::reset();
		$this->assertNull( $this->rest( 'GET', '/auth/me' )->get_data()['member'] );
	}

	public function test_rest_login_wrong_code() {
		$response = $this->rest( 'POST', '/auth/login', array( 'code' => 'NOPE1234' ) );

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( "That code doesn't match anyone.", $response->get_data()['message'] );
	}

	public function test_rest_requires_nonce() {
		$this->member_with_code( 'GOODCODE' );

		$response = $this->rest( 'POST', '/auth/login', array( 'code' => 'GOODCODE' ), false );

		$this->assertSame( 403, $response->get_status() );
		$this->assertSame( 'grp_bad_nonce', $response->get_data()['code'] );
	}

	public function test_rest_returns_401_outside_auth_when_signed_out() {
		register_rest_route(
			'gr-portal/v1',
			'/projects',
			array(
				'methods'             => 'GET',
				'callback'            => '__return_empty_array',
				'permission_callback' => '__return_true',
			)
		);

		$response = $this->rest( 'GET', '/projects' );
		$this->assertSame( 401, $response->get_status() );

		$this->member_with_code( 'GOODCODE' );
		GRP_Auth::login( 'GOODCODE', self::IP );
		$this->assertSame( 200, $this->rest( 'GET', '/projects' )->get_status() );
	}

	public function test_rest_setup_for_wp_admin() {
		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $wp_admin );

		$me = $this->rest( 'GET', '/auth/me' );
		$this->assertTrue( $me->get_data()['needsSetup'] );

		$response = $this->rest( 'POST', '/auth/setup', array( 'name' => 'Owner' ) );
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'admin', $response->get_data()['member']['role'] );

		$this->assertSame( 403, $this->rest( 'POST', '/auth/setup', array( 'name' => 'Again' ) )->get_status() );
	}

	public function test_rest_setup_denied_when_signed_out() {
		$this->assertContains( $this->rest( 'POST', '/auth/setup' )->get_status(), array( 401, 403 ) );
	}
}
