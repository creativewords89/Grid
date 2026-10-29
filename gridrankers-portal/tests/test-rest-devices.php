<?php
/**
 * Tests for the desktop tracker sign-in (SPEC.md 6.21, step 93): POST /auth/device, device tokens
 * limited to the tracker routes, revoking, and /devices.
 *
 * @package GridRankers_Portal
 */

/**
 * Desktop tracker devices.
 */
class Test_GRP_REST_Devices extends GRP_REST_TestCase {

	/**
	 * A request as the desktop app sends it: no cookie, no nonce, maybe a device token.
	 *
	 * @param string      $method HTTP method.
	 * @param string      $path   Path under the namespace.
	 * @param string|null $token  Device token (null = none).
	 * @param array       $params Body or query.
	 * @return WP_REST_Response
	 */
	private function desktop( $method, $path, $token = null, array $params = array() ) {
		$this->as_nobody();
		$request = new WP_REST_Request( $method, '/gr-portal/v1' . $path );
		if ( null !== $token ) {
			$request->set_header( 'Authorization', 'Bearer ' . $token );
		}
		if ( 'GET' === $method ) {
			$request->set_query_params( $params );
		} else {
			$request->set_header( 'Content-Type', 'application/json' );
			$request->set_body( wp_json_encode( $params ) );
		}

		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Signs the desktop app in.
	 *
	 * @param string $code Code.
	 * @param string $name Device name.
	 * @return WP_REST_Response
	 */
	private function sign_in( $code = 'MEMBERCODE1', $name = 'Max’s laptop' ) {
		return $this->desktop(
			'POST',
			'/auth/device',
			null,
			array(
				'code'        => $code,
				'device_name' => $name,
				'platform'    => 'win32',
				'app_version' => '1.0.0',
			)
		);
	}

	/**
	 * A signed-in device token.
	 *
	 * @param string $code Code.
	 * @return string
	 */
	private function token( $code = 'MEMBERCODE1' ) {
		$response = $this->sign_in( $code );
		$this->assertStatus( 200, $response );

		return $response->get_data()['token'];
	}

	/**
	 * Number of rows in a table.
	 *
	 * @param string $table Unprefixed table name.
	 * @return int
	 */
	private function count_rows( $table ) {
		global $wpdb;

		return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM %i', GRP_Install::table( $table ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	public function test_sign_in_with_the_code_gives_a_device_token_and_the_persons_day() {
		$sessions = $this->count_rows( 'grp_sessions' );

		$response = $this->sign_in();

		$this->assertStatus( 200, $response );
		$data = $response->get_data();
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $data['token'] );
		$this->assertSame( $this->team['member']['id'], $data['member']['id'] );
		$this->assertSame( 'member', $data['member']['role'] );
		$this->assertArrayNotHasKey( 'code_hash', $data['member'] );
		$this->assertSame( 'Max’s laptop', $data['device']['name'] );
		$this->assertSame( 'win32', $data['device']['platform'] );
		$this->assertArrayNotHasKey( 'token_hash', $data['device'] );
		$this->assertSame(
			array(
				'start'   => '09:00',
				'end'     => '17:00',
				'minutes' => 480,
			),
			$data['work_day']
		);
		$this->assertCount( 14, $data['schedule'] );
		$this->assertSame( GRP_Cycles::today(), $data['schedule'][0]['date'] );

		$device = GRP_Store::get( 'grp_devices', $data['device']['id'] );
		$this->assertSame( hash( 'sha256', $data['token'] ), $device['token_hash'], 'only the hash is stored' );
		$this->assertSame( $sessions, $this->count_rows( 'grp_sessions' ), 'no browser session' );
	}

	public function test_work_day_follows_pay_and_the_start_setting() {
		GRP_Store::update( 'grp_pay', $this->team['member']['id'], array( 'day_minutes' => 360 ) );
		GRP_REST_People::set_setting( GRP_Time::START_KEY, array( 'start' => '10:00' ) );

		$this->assertSame(
			array(
				'start'   => '10:00',
				'end'     => '16:00',
				'minutes' => 360,
			),
			$this->sign_in()->get_data()['work_day']
		);

		GRP_Store::update( 'grp_members', $this->team['member']['id'], array( 'work_start' => '08:30' ) );
		$this->assertSame( '08:30', $this->sign_in()->get_data()['work_day']['start'], 'own start beats the team’s' );
	}

	public function test_schedule_shows_own_leave_without_its_type_or_reason_and_nobody_elses() {
		$today = GRP_Cycles::today();
		foreach ( array( 'member', 'other' ) as $handle ) {
			GRP_Store::insert(
				'grp_leave',
				array(
					'member_id'  => $this->team[ $handle ]['id'],
					'type'       => 'sick',
					'from_date'  => GRP_People::add_days( $today, 1 ),
					'to_date'    => GRP_People::add_days( $today, 1 ),
					'days'       => 1,
					'reason'     => 'Dentist appointment',
					'status'     => 'member' === $handle ? 'approved' : 'pending',
					'created_by' => $this->team[ $handle ]['id'],
				)
			);
		}
		GRP_Store::insert(
			'grp_leave',
			array(
				'member_id'  => $this->team['other']['id'],
				'type'       => 'day',
				'from_date'  => GRP_People::add_days( $today, 2 ),
				'to_date'    => GRP_People::add_days( $today, 2 ),
				'days'       => 1,
				'reason'     => 'Wedding',
				'status'     => 'approved',
				'created_by' => $this->team['other']['id'],
			)
		);

		$data     = $this->sign_in()->get_data();
		$tomorrow = $data['schedule'][1];
		$json     = wp_json_encode( $data );

		if ( 'weekly' !== $tomorrow['reason'] ) {
			$this->assertSame( 'leave', $tomorrow['reason'] );
			$this->assertSame( 'Leave', $tomorrow['label'] );
		}
		$this->assertStringNotContainsString( 'Dentist', $json );
		$this->assertStringNotContainsString( 'sick', $json );
		$this->assertStringNotContainsString( 'Wedding', $json );
		$this->assertStringNotContainsString( $this->team['other']['id'], $json, 'nothing about anyone else' );
		if ( 'weekly' !== $data['schedule'][2]['reason'] ) {
			$this->assertTrue( $data['schedule'][2]['working'], 'someone else’s leave is not my day off' );
		}
	}

	public function test_wrong_code_gives_nothing_and_counts_towards_the_lockout() {
		$response = $this->sign_in( 'NOPE1234' );

		$this->assertStatus( 401, $response );
		$this->assertSame( 'grp_invalid_code', $response->get_data()['code'] );
		$this->assertArrayNotHasKey( 'token', (array) $response->get_data() );
		$this->assertSame( 0, $this->count_rows( 'grp_devices' ) );

		for ( $i = 0; $i < 4; $i++ ) {
			$this->sign_in( 'NOPE1234' );
		}
		$locked = $this->sign_in();
		$this->assertStatus( 429, $locked, 'the right code is refused while locked' );
		$this->assertSame( 0, $this->count_rows( 'grp_devices' ) );
	}

	public function test_removed_people_cannot_sign_in() {
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'active' => 0 ) );

		$this->assertStatus( 401, $this->sign_in( 'OTHERCODE1' ) );
	}

	public function test_pay_must_be_set_up_on_the_portal_first() {
		GRP_Store::delete( 'grp_pay', $this->team['member']['id'] );

		$response = $this->sign_in();

		$this->assertStatus( 403, $response );
		$this->assertSame( 'grp_pay_needed', $response->get_data()['code'] );
		$this->assertSame( 0, $this->count_rows( 'grp_devices' ) );
	}

	public function test_the_token_works_on_tracker_routes_without_a_nonce() {
		$token = $this->token();

		$me = $this->desktop( 'GET', '/auth/me', $token );

		$this->assertStatus( 200, $me );
		$this->assertSame( $this->team['member']['id'], $me->get_data()['member']['id'] );
		$this->assertSame( 'Max’s laptop', $me->get_data()['device']['name'] );
	}

	public function test_the_token_cannot_reach_anything_else() {
		$token = $this->token();

		foreach ( array(
			array( 'GET', '/projects' ),
			array( 'GET', '/sync' ),
			array( 'GET', '/daily-reports/me' ),
			array( 'GET', '/devices' ),
			array( 'POST', '/auth/logout' ),
			array( 'POST', '/projects' ),
		) as $call ) {
			$response = $this->desktop( $call[0], $call[1], $token );
			$this->assertStatus( 403, $response );
			$this->assertSame( 'grp_device_route', $response->get_data()['code'], $call[1] );
		}
	}

	public function test_bad_expired_or_revoked_tokens_get_401() {
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', 'not-a-token' ) );
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', str_repeat( 'a', 64 ) ) );

		$token  = $this->token();
		$device = GRP_Store::find( 'grp_devices', array( 'member_id' => $this->team['member']['id'] ) )[0];
		GRP_Store::update( 'grp_devices', $device['id'], array( 'expires_at' => GRP_Ids::now( time() - 1 ) ) );
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', $token ), 'expired' );

		$token = $this->token();
		$this->assertStatus( 200, $this->desktop( 'DELETE', '/auth/device', $token ) );
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', $token ), 'signed out' );
		$this->assertStatus( 401, $this->desktop( 'DELETE', '/auth/device' ), 'signing out needs a token' );
	}

	public function test_signing_in_again_works_with_an_old_token_still_sent() {
		$old = $this->token();
		$this->desktop( 'DELETE', '/auth/device', $old );

		$response = $this->desktop(
			'POST',
			'/auth/device',
			$old,
			array( 'code' => 'MEMBERCODE1' )
		);

		$this->assertStatus( 200, $response );
		$this->assertNotSame( $old, $response->get_data()['token'] );
	}

	public function test_set_code_and_removing_someone_end_their_devices() {
		$token = $this->token();
		GRP_Auth::set_code( $this->team['member']['id'], 'NEWCODE99' );
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', $token ), 'Set code' );

		$token = $this->token( 'OTHERCODE1' );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', '/members/' . $this->team['other']['id'] ) );
		$this->assertStatus( 401, $this->desktop( 'GET', '/auth/me', $token ), 'Remove member' );
	}

	public function test_using_the_token_renews_it_every_few_minutes() {
		$token  = $this->token();
		$device = GRP_Store::find( 'grp_devices', array( 'member_id' => $this->team['member']['id'] ) )[0];
		$old    = GRP_Ids::now( time() - DAY_IN_SECONDS );
		GRP_Store::update(
			'grp_devices',
			$device['id'],
			array(
				'last_seen_at' => $old,
				'expires_at'   => GRP_Ids::now( time() + HOUR_IN_SECONDS ),
			)
		);

		$this->desktop( 'GET', '/auth/me', $token );

		$renewed = GRP_Store::get( 'grp_devices', $device['id'] );
		$this->assertGreaterThan( $old, $renewed['last_seen_at'] );
		$this->assertGreaterThan( GRP_Ids::now( time() + 29 * DAY_IN_SECONDS ), $renewed['expires_at'] );
	}

	public function test_web_requests_still_need_the_nonce_and_a_session() {
		$this->as_nobody();
		$request = new WP_REST_Request( 'GET', '/gr-portal/v1/projects' );
		$this->assertStatus( 403, rest_get_server()->dispatch( $request ), 'no nonce' );

		$response = $this->desktop( 'GET', '/timer' );
		$this->assertStatus( 403, $response, 'a tracker route without a token is a web request' );
		$this->assertSame( 'grp_bad_nonce', $response->get_data()['code'] );
	}

	public function test_list_own_devices() {
		$this->token();
		$this->sign_in( 'MEMBERCODE1', 'Office PC' );

		$response = $this->api_as( 'member', 'GET', '/devices' );

		$this->assertStatus( 200, $response );
		$this->assertSame( array( 'Office PC', 'Max’s laptop' ), wp_list_pluck( $response->get_data(), 'name' ) );
		$this->assertArrayNotHasKey( 'token_hash', $response->get_data()[0] );
	}

	public function test_who_sees_and_revokes_whose_devices() {
		$this->token();
		$this->token( 'LEADCODE1' );
		$member_device = GRP_Store::find( 'grp_devices', array( 'member_id' => $this->team['member']['id'] ) )[0];
		$lead_device   = GRP_Store::find( 'grp_devices', array( 'member_id' => $this->team['lead']['id'] ) )[0];

		$this->assertStatus( 403, $this->api_as( 'other', 'GET', '/devices', array( 'member' => $this->team['member']['id'] ) ) );
		$this->assertStatus( 403, $this->api_as( 'other', 'DELETE', '/devices/' . $member_device['id'] ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', '/devices/' . $lead_device['id'] ), 'a Team Member never revokes a leader’s' );
		$this->assertStatus( 200, $this->api_as( 'lead', 'GET', '/devices', array( 'member' => $this->team['member']['id'] ) ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'GET', '/devices', array( 'member' => $this->team['lead']['id'] ) ) );

		$this->assertStatus( 200, $this->api_as( 'lead', 'DELETE', '/devices/' . $member_device['id'] ) );
		$this->assertNotEmpty( GRP_Store::get( 'grp_devices', $member_device['id'] )['revoked_at'] );
		$this->assertSame( array(), $this->api_as( 'member', 'GET', '/devices' )->get_data(), 'revoked devices are not listed' );

		$this->assertStatus( 200, $this->api_as( 'lead', 'DELETE', '/devices/' . $lead_device['id'] ), 'own' );
		$this->assertStatus( 404, $this->api_as( 'admin', 'DELETE', '/devices/nope' ) );
	}
}
