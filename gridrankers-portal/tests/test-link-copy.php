<?php
/**
 * Tests for profiles copied from the main portal (SPEC.md 6.22, step 104): GET /link/people, the
 * tracker portal's copy, and its read-only profiles.
 *
 * @package GridRankers_Portal
 */

/**
 * The tracker portal's copy of the main portal.
 */
class Test_GRP_Link_Copy extends GRP_REST_TestCase {

	/**
	 * The main portal's answer for the faked call.
	 *
	 * @var array|WP_Error|null
	 */
	private $main = null;

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
		add_filter( 'pre_http_request', array( $this, 'fake_http' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'fake_http' ), 10 );
		wp_clear_scheduled_hook( GRP_Link_Copy::HOOK );
		parent::tear_down();
	}

	/**
	 * Fakes the main portal's GET /link/people.
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
		if ( is_wp_error( $this->main ) ) {
			return $this->main;
		}

		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $this->main ),
			'response' => array(
				'code'    => 200,
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * The main portal's data: a project, an open and a done meeting task, a monthly task, approved
	 * and pending leave, a day off, the team settings; then GET /link/people as the tracker gets it.
	 *
	 * @return array
	 */
	private function main_payload() {
		$project = GRP_Store::insert(
			'grp_projects',
			array(
				'name'      => 'Acme Plumbing',
				'cycle_day' => 1,
				'details'   => array( 'sections' => array( array( 'title' => 'Secret client notes' ) ) ),
			)
		);
		GRP_Store::insert(
			'grp_meeting_tasks',
			array(
				'id'         => 'mt-open',
				'project_id' => $project['id'],
				'title'      => 'Fix H1 tags',
				'notes'      => 'Client password is hunter2',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		);
		GRP_Store::insert(
			'grp_meeting_tasks',
			array(
				'id'         => 'mt-done',
				'project_id' => $project['id'],
				'title'      => 'Old task',
				'status'     => 'done',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		);
		GRP_Store::insert(
			'grp_monthly_tasks',
			array(
				'id'         => 'mo-blogs',
				'project_id' => $project['id'],
				'title'      => 'Cycle blogs',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		);
		GRP_Store::insert(
			'grp_leave',
			array(
				'id'        => 'lv-ok',
				'member_id' => $this->team['member']['id'],
				'type'      => 'sick',
				'from_date' => '2026-11-02',
				'to_date'   => '2026-11-03',
				'days'      => 2,
				'reason'    => 'Dentist',
				'status'    => 'approved',
				'message'   => 'Get well',
			)
		);
		GRP_Store::insert(
			'grp_leave',
			array(
				'id'        => 'lv-wait',
				'member_id' => $this->team['other']['id'],
				'from_date' => '2026-11-05',
				'to_date'   => '2026-11-05',
				'days'      => 1,
				'status'    => 'pending',
			)
		);
		GRP_Store::insert(
			'grp_days_off',
			array(
				'id'        => 'do-1',
				'name'      => 'Victory Day',
				'from_date' => '2026-12-16',
				'to_date'   => '2026-12-16',
			)
		);
		GRP_Store::insert(
			'grp_settings',
			array(
				'setting_key' => GRP_Time::START_KEY,
				'value'       => array( 'start' => '10:00' ),
			)
		);
		GRP_Store::update(
			'grp_members',
			$this->team['member']['id'],
			array(
				'address' => '12 Secret Road',
				'notes'   => 'Private note',
			)
		);

		GRP_Link::set_main( 'https://tracker.gridrankers.com' );
		$key     = GRP_Link::make_key();
		$request = new WP_REST_Request( 'GET', '/gr-portal/v1/link/people' );
		$request->set_header( 'Authorization', 'Bearer ' . $key );
		$this->as_nobody();
		$res = rest_get_server()->dispatch( $request );
		$this->assertStatus( 200, $res );

		// As it arrives over HTTP.
		return json_decode( wp_json_encode( $res->get_data() ), true );
	}

	/**
	 * Empties the tables the copy fills, as on a new tracker portal, and makes this site one.
	 */
	private function become_tracker() {
		global $wpdb;
		foreach ( array_keys( GRP_Link_Copy::COLUMNS ) as $table ) {
			$wpdb->query( 'DELETE FROM ' . GRP_Install::table( $table ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
		}
		$wpdb->query( 'DELETE FROM ' . GRP_Install::table( 'grp_settings' ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
	}

	public function test_the_main_portal_never_sends_secrets() {
		$data = $this->main_payload();
		$json = wp_json_encode( $data );
		foreach ( array( 'code_hash', 'code_salt', 'salary', 'account_number', 'account_name', 'bank_name', 'Dutch-Bangla', 'Dentist', 'Get well', 'sick', '12 Secret Road', 'Private note', 'hunter2', 'Secret client notes', 'wp_user_id' ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $json, $secret );
		}

		$this->assertCount( 4, $data['members'] );
		// Pay: only who has set it up, and their working hours.
		$this->assertEqualsCanonicalizing( array( $this->team['lead']['id'], $this->team['member']['id'], $this->team['other']['id'] ), wp_list_pluck( $data['pay'], 'member_id' ) );
		$this->assertSame( 480, $data['pay'][0]['day_minutes'] );
		// Leave: approved only, as "Leave".
		$this->assertSame( array( 'lv-ok' ), wp_list_pluck( $data['leave'], 'id' ) );
		$this->assertSame( 'day', $data['leave'][0]['type'] );
		$this->assertSame( array( 'start' => '10:00' ), $data['settings'][ GRP_Time::START_KEY ] );
		$this->assertArrayHasKey( 'timezone_string', $data['timezone'] );
	}

	public function test_the_tracker_copies_with_the_same_ids_and_nothing_else() {
		$data = $this->main_payload();
		$this->become_tracker();

		$summary = GRP_Link_Copy::apply( $data );
		$this->assertSame( 4, $summary['members']['added'] );
		$this->assertSame( 1, $summary['leave']['added'] );

		$max = GRP_Store::get( 'grp_members', $this->team['member']['id'] );
		$this->assertSame( 'Max Member', $max['name'] );
		$this->assertSame( 'Rangpur', $max['location'] );
		$this->assertEmpty( $max['code_hash'] );
		$this->assertEmpty( $max['address'] );
		$this->assertNull( $max['wp_user_id'] );

		$pay = GRP_Store::get( 'grp_pay', $this->team['member']['id'] );
		$this->assertSame( 480, $pay['day_minutes'] );
		$this->assertSame( 0, $pay['salary'] );
		$this->assertEmpty( $pay['account_number'] );
		$this->assertNull( GRP_Store::get( 'grp_pay', $this->team['admin']['id'] ) );

		$this->assertNull( GRP_Store::get( 'grp_leave', 'lv-wait' ) );
		$this->assertEmpty( GRP_Store::get( 'grp_leave', 'lv-ok' )['reason'] );
		$this->assertSame( 'Fix H1 tags', GRP_Store::get( 'grp_meeting_tasks', 'mt-open' )['title'] );
		$this->assertEmpty( GRP_Store::get( 'grp_meeting_tasks', 'mt-open' )['notes'] );
		$this->assertSame( array( 'start' => '10:00' ), GRP_Store::find( 'grp_settings', array( 'setting_key' => GRP_Time::START_KEY ) )[0]['value'] );

		// The tracker works from the copy: Max's tasks and working day.
		$tasks = GRP_Time_Entries::tasks_for( $max );
		$this->assertEqualsCanonicalizing( array( 'Fix H1 tags', 'Cycle blogs' ), wp_list_pluck( $tasks['tasks'], 'title' ) );
		$this->assertFalse( GRP_Pay::needs_setup( $max ) );
		$this->assertSame( '10:00', GRP_REST_Auth::device_payload( $max, 1 )['work_day']['start'] );
	}

	public function test_a_copy_that_changes_nothing_writes_nothing() {
		$data = $this->main_payload();
		$this->become_tracker();
		GRP_Link_Copy::apply( $data );
		$before = GRP_Store::get( 'grp_members', $this->team['member']['id'] )['updated_at'];

		$again = GRP_Link_Copy::apply( $data );
		foreach ( array( 'members', 'pay', 'leave', 'projects', 'meeting_tasks', 'monthly_tasks', 'days_off' ) as $key ) {
			$this->assertSame(
				array(
					'added'   => 0,
					'changed' => 0,
					'removed' => 0,
				),
				$again[ $key ],
				$key
			);
		}
		$this->assertSame( 0, $again['settings'] );
		$this->assertSame( $before, GRP_Store::get( 'grp_members', $this->team['member']['id'] )['updated_at'] );
	}

	public function test_changes_on_the_main_portal_follow() {
		$data = $this->main_payload();
		$this->become_tracker();
		GRP_Link_Copy::apply( $data );

		foreach ( $data['members'] as &$m ) {
			if ( $m['id'] === $this->team['member']['id'] ) {
				$m['name']       = 'Max Renamed';
				$m['work_start'] = '08:30';
			}
		}
		unset( $m );
		$data['leave']         = array();
		$data['meeting_tasks'] = array_values( array_filter( $data['meeting_tasks'], static fn ( $t ) => 'mt-done' !== $t['id'] ) );
		$summary               = GRP_Link_Copy::apply( $data );

		$this->assertSame( 1, $summary['members']['changed'] );
		$this->assertSame( 'Max Renamed', GRP_Store::get( 'grp_members', $this->team['member']['id'] )['name'] );
		$this->assertSame( '08:30', GRP_Store::get( 'grp_members', $this->team['member']['id'] )['work_start'] );
		$this->assertNull( GRP_Store::get( 'grp_leave', 'lv-ok' ), 'leave cancelled on the main portal' );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', 'mt-done' ), 'a task deleted on the main portal' );
	}

	public function test_removed_inactive_or_a_new_code_signs_out_on_the_tracker() {
		$data = $this->main_payload();
		$this->become_tracker();
		GRP_Link_Copy::apply( $data );
		foreach ( array( 'lead', 'member', 'other' ) as $handle ) {
			GRP_Store::insert(
				'grp_devices',
				array(
					'member_id'  => $this->team[ $handle ]['id'],
					'token_hash' => hash( 'sha256', $handle ),
					'expires_at' => GRP_Ids::now( time() + DAY_IN_SECONDS ),
				)
			);
		}

		$members = array();
		foreach ( $data['members'] as $m ) {
			if ( $m['id'] === $this->team['other']['id'] ) {
				continue; // Gone from the main portal.
			}
			if ( $m['id'] === $this->team['lead']['id'] ) {
				$m['active'] = 0;
			}
			if ( $m['id'] === $this->team['member']['id'] ) {
				$m['code_set_at'] = '2030-01-01 00:00:00';
			}
			$members[] = $m;
		}
		$data['members'] = $members;
		$summary         = GRP_Link_Copy::apply( $data );

		$this->assertSame( 3, $summary['signed_out'] );
		$this->assertSame( 0, GRP_Store::get( 'grp_members', $this->team['other']['id'] )['active'], 'kept, with their time, but inactive' );
		$this->assertSame( 0, GRP_Store::get( 'grp_members', $this->team['lead']['id'] )['active'] );
		foreach ( array( 'lead', 'member', 'other' ) as $handle ) {
			$this->assertSame( array(), GRP_Auth::devices( $this->team[ $handle ]['id'] ), $handle );
		}
	}

	public function test_every_profile_change_is_refused_on_the_tracker() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$me    = $this->team['member']['id'];
		$calls = array(
			array( 'admin', 'POST', '/members', array( 'name' => 'New Person' ) ),
			array( 'admin', 'PATCH', '/members/' . $me, array( 'name' => 'Renamed' ) ),
			array( 'admin', 'POST', '/members/' . $me . '/code', array( 'code' => 'NEWCODE99' ) ),
			array( 'admin', 'POST', '/projects', array( 'name' => 'Beta' ) ),
			array( 'admin', 'POST', '/days-off', array( 'name' => 'Holiday' ) ),
			array( 'member', 'POST', '/leave', array( 'from_date' => '2026-11-10' ) ),
			array( 'member', 'PUT', '/pay/me', self::FULL_PAY ),
			array( 'member', 'POST', '/meeting-tasks', array( 'title' => 'x' ) ),
			array( 'member', 'POST', '/records/tick', array() ),
			array( 'admin', 'POST', '/import', array() ),
		);
		foreach ( $calls as $call ) {
			list( $who, $method, $path, $params ) = $call;
			$res                                  = $this->api_as( $who, $method, $path, $params );
			$this->assertSame( 403, $res->get_status(), "$method $path" );
			$this->assertSame( 'grp_main_portal', $res->get_data()['code'], "$method $path" );
			$this->assertSame( 'Change this on bot.gridrankers.com.', $res->get_data()['message'] );
		}

		// Reading, and the tracker's own time, still work.
		$this->assertStatus( 200, $this->api_as( 'member', 'GET', '/sync' ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/start', array() ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/stop', array() ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/notifications/dismiss', array( 'key' => 'k' ) ) );

		// On its own, nothing is refused for being on the main portal.
		GRP_Link::set_alone();
		$this->assertNotSame( 'grp_main_portal', $this->api_as( 'admin', 'POST', '/projects', array( 'name' => 'Beta' ) )->get_data()['code'] ?? '' );
	}

	public function test_run_calls_the_main_portal_with_the_key() {
		$this->main = $this->main_payload();
		$this->become_tracker();

		$summary = GRP_Link_Copy::run();
		$this->assertIsArray( $summary );
		$this->assertSame( 4, $summary['members']['added'] );
		$this->assertSame( 'Bearer ' . str_repeat( 'a', 64 ), $this->sent['args']['headers']['Authorization'] );
		$this->assertStringContainsString( rawurlencode( '/gr-portal/v1/link/people' ), $this->sent['url'] );
		$this->assertNotEmpty( GRP_Link::settings()['last_copy_at'] );
		$this->assertNull( GRP_Link::settings()['last_error'] );

		// Main portal not reachable: the copy stays as it was, the reason is kept.
		$this->main = new WP_Error( 'http_request_failed', 'timeout' );
		$this->assertWPError( GRP_Link_Copy::run() );
		$this->assertStringContainsString( 'Can’t reach bot.gridrankers.com', GRP_Link::settings()['last_error'] );
		$this->assertCount( 4, GRP_Store::find( 'grp_members' ) );
	}

	public function test_an_empty_answer_changes_nothing() {
		$this->become_tracker();
		GRP_Store::insert(
			'grp_members',
			array(
				'id'     => 'kept',
				'name'   => 'Kept Person',
				'active' => 1,
			)
		);
		foreach ( array( array(), array( 'members' => array() ), array( 'site' => 'GridRankers' ) ) as $answer ) {
			$this->main = $answer;
			$this->assertWPError( GRP_Link_Copy::run() );
		}
		$this->assertSame( 1, GRP_Store::get( 'grp_members', 'kept' )['active'] );
		$this->assertStringContainsString( 'sent no profiles', GRP_Link::settings()['last_error'] );
	}

	public function test_sync_now_copies() {
		$this->main = $this->main_payload();
		$this->become_tracker();
		$result = GRP_Admin_Settings::apply_link( array( 'do' => 'sync' ) );
		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'Profiles copied: 4 new, 0 changed, 0 removed.', $result['message'] );
	}

	public function test_only_a_tracker_portal_runs_the_copy_every_5_minutes() {
		GRP_Link_Copy::schedule();
		$this->assertFalse( wp_next_scheduled( GRP_Link_Copy::HOOK ) );

		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		GRP_Link_Copy::schedule();
		$this->assertNotFalse( wp_next_scheduled( GRP_Link_Copy::HOOK ) );
		$this->assertSame( GRP_Link_Copy::SCHEDULE, wp_get_schedule( GRP_Link_Copy::HOOK ) );
		$this->assertSame( 300, wp_get_schedules()[ GRP_Link_Copy::SCHEDULE ]['interval'] );

		GRP_Link::set_alone();
		GRP_Link_Copy::schedule();
		$this->assertFalse( wp_next_scheduled( GRP_Link_Copy::HOOK ) );
		$this->assertWPError( GRP_Link_Copy::run() );
	}

	public function test_the_hourly_job_adds_no_tasks_on_the_tracker() {
		$this->project();
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$before = count( GRP_Store::find( 'grp_monthly_tasks' ) );
		$this->assertSame( 0, GRP_Cron::run()['standard_tasks'] );
		$this->assertCount( $before, GRP_Store::find( 'grp_monthly_tasks' ) );
	}
}
