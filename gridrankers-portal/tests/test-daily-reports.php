<?php
/**
 * Tests for daily reports (SPEC.md 6.18): who writes and who reads them, saving and sending, the
 * missing report (design DR-D), the Team tab, Remind, and the export.
 *
 * @package GridRankers_Portal
 */

/**
 * Daily reports over REST; every rule enforced on the server.
 */
class Test_GRP_Daily_Reports extends GRP_REST_TestCase {

	/**
	 * A second Team Leader (Team Leaders read each other's reports).
	 *
	 * @var array
	 */
	private $lead2;

	public function set_up() {
		parent::set_up();
		// No weekly day off, so every day is a working day whatever today is.
		GRP_REST_People::set_setting( GRP_REST_People::WEEKLY_KEY, array( 'days' => array() ) );
		update_option( GRP_Daily_Reports::SINCE_OPTION, '2000-01-01', false );
		$this->lead2 = $this->add_member( 'Lia Lead', 'lead' );
		GRP_Auth::set_code( $this->lead2['id'], 'LEAD2CODE1' );
		$this->tokens['lead2'] = GRP_Auth::login( 'LEAD2CODE1', '127.0.0.1' )['token'];
		$this->team['lead2']   = $this->lead2;
		$this->backdate( array( 'lead', 'member', 'other', 'lead2' ), '-30 days' );
	}

	/**
	 * Moves people's join date back, so they owe reports for past days.
	 *
	 * @param string[] $handles People.
	 * @param string   $when    strtotime() offset.
	 */
	private function backdate( array $handles, $when ) {
		global $wpdb;
		foreach ( $handles as $handle ) {
			$wpdb->update( GRP_Install::table( 'grp_members' ), array( 'created_at' => gmdate( 'Y-m-d H:i:s', strtotime( $when ) ) ), array( 'id' => $this->team[ $handle ]['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		}
	}

	/**
	 * One entry.
	 *
	 * @param array $extra Fields to override.
	 * @return array
	 */
	private function entry( array $extra = array() ) {
		return $extra + array(
			'title'   => 'Site audit',
			'details' => 'Checked 14 pages.',
			'project' => 'office',
			'minutes' => 90,
		);
	}

	/**
	 * Saves a report as someone.
	 *
	 * @param string $who    Handle.
	 * @param string $day    `Y-m-d`.
	 * @param array  $params Body.
	 * @return WP_REST_Response
	 */
	private function put( $who, $day, array $params ) {
		return $this->api_as( $who, 'PUT', "/daily-reports/{$day}", $params );
	}

	private function today() {
		return GRP_Cycles::today();
	}

	private function yesterday() {
		return GRP_People::add_days( GRP_Cycles::today(), -1 );
	}

	public function test_permission_rows() {
		$admin  = $this->team['admin'];
		$lead   = $this->team['lead'];
		$member = $this->team['member'];
		$ctx    = static function ( $m ) {
			return array(
				'member_id' => $m['id'],
				'role'      => $m['role'],
			);
		};

		// Write: Team Leaders and Team Members, for themselves only; never the Super Admin.
		$this->assertTrue( GRP_Permissions::can( $member, GRP_Permissions::WRITE_DAILY_REPORT, array( 'member_id' => $member['id'] ) ) );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::WRITE_DAILY_REPORT, array( 'member_id' => $lead['id'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $lead, GRP_Permissions::WRITE_DAILY_REPORT, array( 'member_id' => $member['id'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $admin, GRP_Permissions::WRITE_DAILY_REPORT, array( 'member_id' => $admin['id'] ) ) );

		// Read: own; Super Admin anyone's; a Team Leader Team Members' and other Team Leaders'.
		$this->assertTrue( GRP_Permissions::can( $member, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $member ) ) );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $this->team['other'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $lead ) ) );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $member ) ) );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $this->lead2 ) ) );
		$this->assertFalse( GRP_Permissions::can( $lead, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $admin ) ) );
		$this->assertTrue( GRP_Permissions::can( $admin, GRP_Permissions::VIEW_DAILY_REPORT, $ctx( $lead ) ) );

		// Team tab and Remind: managers; not themselves.
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::VIEW_TEAM_REPORTS ) );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::VIEW_TEAM_REPORTS ) );
		$this->assertTrue( GRP_Permissions::can( $admin, GRP_Permissions::VIEW_TEAM_REPORTS ) );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::REMIND_DAILY_REPORT, $ctx( $this->lead2 ) ) );
		$this->assertFalse( GRP_Permissions::can( $lead, GRP_Permissions::REMIND_DAILY_REPORT, $ctx( $lead ) ) );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::REMIND_DAILY_REPORT, $ctx( $this->team['other'] ) ) );
	}

	public function test_writing_saving_and_sending() {
		$today = $this->today();

		// A draft saves with no entries; sending needs one.
		$draft = $this->put( 'member', $today, array( 'entries' => array() ) );
		$this->assertStatus( 200, $draft );
		$this->assertNull( $draft->get_data()['sent_at'] );
		$this->assertSame( 'grp_report_empty', $this->put( 'member', $today, array( 'send' => true ) )->get_data()['code'] );

		// Entries are checked: what, time, project, links, files.
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'title' => '' ) ) ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'minutes' => 0 ) ) ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'project' => 'nope' ) ) ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'links' => array( array( 'url' => 'javascript:alert(1)' ) ) ) ) ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'files' => array( 'missing' ) ) ) ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', $today, array( 'entries' => array( $this->entry( array( 'minutes' => 1000 ) ), $this->entry( array( 'minutes' => 1000 ) ) ) ) ) );

		$project = $this->project();
		$file    = GRP_Store::insert(
			'grp_files',
			array(
				'name'       => 'audit.pdf',
				'mime'       => 'application/pdf',
				'size'       => 100,
				'path'       => 'x/audit.pdf',
				'created_by' => $this->team['member']['id'],
			)
		);
		$sent    = $this->put(
			'member',
			$today,
			array(
				'entries'  => array(
					$this->entry(
						array(
							'project' => $project['id'],
							'files'   => array( $file['id'] ),
							'links'   => array( array( 'url' => 'https://docs.google.com/document/d/1' ) ),
						)
					),
					$this->entry(
						array(
							'title'   => 'Team meeting',
							'minutes' => 60,
						)
					),
				),
				'blocking' => 'Waiting for logins.',
				'tomorrow' => 'Publish the blog.',
				'send'     => true,
			)
		)->get_data();
		$this->assertNotEmpty( $sent['sent_at'] );
		$this->assertSame( 0, $sent['late'] );
		$this->assertSame( 150, $sent['minutes'] );
		$this->assertSame( 'audit.pdf', $sent['entries'][0]['files'][0]['name'] );
		$this->assertSame( 'docs.google.com', $sent['entries'][0]['links'][0]['name'] );

		// Today's report can still change until midnight, but not be emptied.
		$this->assertStatus( 200, $this->put( 'member', $today, array( 'entries' => array( $this->entry() ) ) ) );
		$this->assertSame( 'grp_report_empty', $this->put( 'member', $today, array( 'entries' => array() ) )->get_data()['code'] );

		// No future days, nothing too old; the Super Admin writes none.
		$this->assertStatus( 400, $this->put( 'member', GRP_People::add_days( $today, 1 ), array( 'entries' => array( $this->entry() ) ) ) );
		$this->assertStatus( 400, $this->put( 'member', GRP_People::add_days( $today, -30 ), array( 'entries' => array( $this->entry() ) ) ) );
		$this->assertStatus( 403, $this->put( 'admin', $today, array( 'entries' => array( $this->entry() ) ) ) );
	}

	public function test_missing_report_must_be_sent_and_is_late() {
		$me = $this->api_as( 'member', 'GET', '/daily-reports/me' )->get_data();
		$this->assertTrue( $me['writes'] );
		$this->assertSame( $this->yesterday(), $me['missing'] );

		// A draft doesn't count; sending it late does.
		$this->put( 'member', $this->yesterday(), array( 'entries' => array( $this->entry() ) ) );
		$this->assertSame( $this->yesterday(), $this->api_as( 'member', 'GET', '/daily-reports/me' )->get_data()['missing'] );
		$late = $this->put(
			'member',
			$this->yesterday(),
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		)->get_data();
		$this->assertSame( 1, $late['late'] );
		$this->assertNull( $this->api_as( 'member', 'GET', '/daily-reports/me' )->get_data()['missing'] );

		// Once a past day's report is sent it is locked.
		$this->assertSame( 'grp_report_locked', $this->put( 'member', $this->yesterday(), array( 'entries' => array( $this->entry() ) ) )->get_data()['code'] );

		// Nothing is owed for days before reports started, before someone joined, or by the Super Admin.
		update_option( GRP_Daily_Reports::SINCE_OPTION, $this->today(), false );
		$this->assertNull( $this->api_as( 'other', 'GET', '/daily-reports/me' )->get_data()['missing'] );
		update_option( GRP_Daily_Reports::SINCE_OPTION, '2000-01-01', false );
		$this->backdate( array( 'other' ), 'now' );
		$this->assertNull( $this->api_as( 'other', 'GET', '/daily-reports/me' )->get_data()['missing'] );
		$admin = $this->api_as( 'admin', 'GET', '/daily-reports/me' )->get_data();
		$this->assertFalse( $admin['writes'] );
		$this->assertNull( $admin['missing'] );
	}

	public function test_days_off_and_leave_owe_no_report() {
		$member  = GRP_Store::get( 'grp_members', $this->team['member']['id'] );
		$today   = $this->today();
		$weekday = (int) gmdate( 'w', strtotime( $this->yesterday() . ' UTC' ) );

		// Yesterday was their weekly day off: the day before is the one owed.
		$this->assertSame( GRP_People::add_days( $today, -2 ), GRP_Daily_Reports::missing( $member, $today, '2000-01-01', array(), array( $weekday ), array() ) );

		// A whole-team day off, then approved leave the day before.
		$off   = array(
			array(
				'kind'      => 'event',
				'from_date' => $this->yesterday(),
				'to_date'   => $this->yesterday(),
			),
		);
		$leave = array(
			array(
				'member_id' => $member['id'],
				'status'    => 'approved',
				'from_date' => GRP_People::add_days( $today, -2 ),
				'to_date'   => GRP_People::add_days( $today, -2 ),
			),
		);
		$this->assertSame( GRP_People::add_days( $today, -3 ), GRP_Daily_Reports::missing( $member, $today, '2000-01-01', $leave, array(), $off ) );
		$this->assertSame( 'leave', GRP_Daily_Reports::state( $member, GRP_People::add_days( $today, -2 ), $today, '2000-01-01', null, $leave, array(), $off ) );
		$this->assertSame( 'day_off', GRP_Daily_Reports::state( $member, $this->yesterday(), $today, '2000-01-01', null, $leave, array(), $off ) );

		// Pending leave doesn't count.
		$leave[0]['status'] = 'pending';
		$this->assertSame( GRP_People::add_days( $today, -2 ), GRP_Daily_Reports::missing( $member, $today, '2000-01-01', $leave, array(), $off ) );
	}

	public function test_who_reads_whose_reports() {
		$today = $this->today();
		$this->put(
			'member',
			$today,
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		);
		$this->put( 'other', $today, array( 'entries' => array( $this->entry( array( 'title' => 'Draft only' ) ) ) ) );
		$this->put(
			'lead2',
			$today,
			array(
				'entries' => array( $this->entry( array( 'title' => 'Planned the cycle' ) ) ),
				'send'    => true,
			)
		);

		// A Team Member reads only their own (drafts included).
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/daily-reports', array( 'member' => $this->team['other']['id'] ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/daily-reports', array( 'member' => $this->team['lead']['id'] ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/daily-reports/team' ) );
		$own = $this->api_as( 'other', 'GET', '/daily-reports' )->get_data();
		$this->assertSame( array( 'Draft only' ), wp_list_pluck( $own['reports'][0]['entries'], 'title' ) );

		// A Team Leader reads Team Members and other Team Leaders — never someone's draft.
		$this->assertStatus( 200, $this->api_as( 'lead', 'GET', '/daily-reports', array( 'member' => $this->lead2['id'] ) ) );
		$this->assertSame( array(), $this->api_as( 'lead', 'GET', '/daily-reports', array( 'member' => $this->team['other']['id'] ) )->get_data()['reports'] );
		$this->assertStatus( 403, $this->api_as( 'lead', 'GET', '/daily-reports', array( 'member' => $this->team['admin']['id'] ) ) );

		$team  = $this->api_as( 'lead', 'GET', '/daily-reports/team', array( 'day' => $today ) )->get_data();
		$state = array();
		foreach ( $team['people'] as $p ) {
			$state[ $p['member_id'] ] = $p['state'];
			if ( (string) $p['member_id'] === (string) $this->team['other']['id'] ) {
				$this->assertNull( $p['report'] );
			}
		}
		$this->assertSame( 'sent', $state[ $this->team['member']['id'] ] );
		$this->assertSame( 'not_sent', $state[ $this->team['other']['id'] ] );
		$this->assertSame( 'sent', $state[ $this->lead2['id'] ] );
		$this->assertArrayHasKey( $this->team['lead']['id'], $state );
		$this->assertArrayNotHasKey( $this->team['admin']['id'], $state );

		// The Super Admin sees everyone who writes reports.
		$this->assertCount( 4, $this->api_as( 'admin', 'GET', '/daily-reports/team', array( 'day' => $today ) )->get_data()['people'] );
	}

	public function test_remind_sends_a_private_notice() {
		$who = $this->team['other']['id'];
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/daily-reports/remind', array( 'member_id' => $who ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_id' => $this->team['lead']['id'] ) ) );

		$res = $this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_id' => $who ) );
		$this->assertStatus( 201, $res );
		$this->assertSame( 'notice', $res->get_data()['kind'] );
		$this->assertSame( array( (string) $who ), $res->get_data()['to_members'] );

		$this->put(
			'other',
			$this->today(),
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		);
		$this->assertStatus( 409, $this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_id' => $who ) ) );
	}

	public function test_team_tab_shows_missed_days_reminders_and_hours() {
		$today = $this->today();
		$this->put(
			'member',
			$this->yesterday(),
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		);
		$people = array_column( $this->api_as( 'admin', 'GET', '/daily-reports/team', array( 'day' => $today ) )->get_data()['people'], null, 'member_id' );
		$other  = $people[ $this->team['other']['id'] ];
		$this->assertSame( 'not_sent', $other['state'] );
		// Every working day for the last BACK_DAYS and today: no report.
		$this->assertSame( GRP_Daily_Reports::BACK_DAYS + 1, $other['missed'] );
		$this->assertNull( $other['reminded_at'] );
		$this->assertSame( 480, $other['day_minutes'] );
		// Max sent yesterday: only today is missing.
		$this->assertSame( 1, $people[ $this->team['member']['id'] ]['missed'] );

		$this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_id' => $this->team['other']['id'] ) );
		$people = array_column( $this->api_as( 'lead', 'GET', '/daily-reports/team', array( 'day' => $today ) )->get_data()['people'], null, 'member_id' );
		$this->assertNotNull( $people[ $this->team['other']['id'] ]['reminded_at'] );
	}

	public function test_remind_all_skips_who_sent_and_can_tell_the_team_leaders() {
		$today = $this->today();
		$this->put(
			'member',
			$today,
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		);
		$ids = array( $this->team['member']['id'], $this->team['other']['id'], $this->lead2['id'] );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/daily-reports/remind', array( 'member_ids' => array( $this->team['other']['id'] ) ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_ids' => array( $this->team['lead']['id'] ) ) ) );

		$res = $this->api_as(
			'admin',
			'POST',
			'/daily-reports/remind',
			array(
				'member_ids' => $ids,
				'tell_leads' => true,
			)
		);
		$this->assertStatus( 201, $res );
		$this->assertSame( array( $this->team['other']['id'], $this->lead2['id'] ), $res->get_data()['reminded'] );
		$this->assertSame( array( $this->team['member']['id'] ), $res->get_data()['skipped'] );

		// Sending a handwritten report also tells the Super Admin (SPEC.md 6.21); that notice is not a reminder.
		$posts = array_filter( GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ) ), static fn ( $p ) => ! str_starts_with( (string) $p['title'], '✍' ) );
		$this->assertCount( 3, $posts );
		$leads = array_values(
			array_filter(
				$posts,
				static function ( $p ) {
					return 'Daily reports not sent' === $p['title'];
				}
			)
		);
		// Lee is told; Lia was reminded herself.
		$this->assertCount( 1, $leads );
		$this->assertSame( array( $this->team['lead']['id'] ), $leads[0]['to_members'] );
		$this->assertStringContainsString( 'Olu Other', $leads[0]['body'] );
		$this->assertStringContainsString( 'Lia Lead', $leads[0]['body'] );

		// Without tell_leads only the people are reminded.
		$this->api_as( 'lead', 'POST', '/daily-reports/remind', array( 'member_ids' => array( $this->team['other']['id'] ) ) );
		$this->assertCount( 4, array_filter( GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ) ), static fn ( $p ) => ! str_starts_with( (string) $p['title'], '✍' ) ) );
	}

	public function test_reports_are_exported_and_imported() {
		$this->put(
			'member',
			$this->today(),
			array(
				'entries' => array( $this->entry( array( 'links' => array( array( 'url' => 'https://example.com/a' ) ) ) ) ),
				'send'    => true,
			)
		);
		$export = GRP_Export::build();
		$this->assertCount( 1, $export['data']['dailyReports'] );
		$doc = $export['data']['dailyReports'][0];
		$this->assertSame( 'Site audit', $doc['entries'][0]['title'] );

		$row = GRP_Import::daily_report( $doc );
		$this->assertSame( GRP_Daily_Reports::row_id( $this->team['member']['id'], $this->today() ), $row['id'] );
		$this->assertSame( 90, $row['entries'][0]['minutes'] );
		$this->assertSame( 'https://example.com/a', $row['entries'][0]['links'][0]['url'] );
		$this->assertNotNull( $row['sent_at'] );
	}

	/**
	 * A sent report from an earlier day, straight into the table.
	 *
	 * @param string $handle Person.
	 * @param string $day    Day.
	 * @return array
	 */
	private function sent( $handle, $day ) {
		return GRP_Store::insert(
			'grp_daily_reports',
			array(
				'id'        => GRP_Daily_Reports::row_id( $this->team[ $handle ]['id'], $day ),
				'member_id' => $this->team[ $handle ]['id'],
				'day'       => $day,
				'entries'   => array(
					array(
						'id'      => 'e1',
						'title'   => 'BMW content',
						'minutes' => 360,
					),
					array(
						'id'      => 'e2',
						'title'   => 'Images Sorting',
						'minutes' => 600,
					),
				),
				'sent_at'   => gmdate( 'Y-m-d H:i:s' ),
			)
		);
	}

	public function test_asking_to_change_a_past_report() {
		$day    = $this->yesterday();
		$ask    = fn ( $who, array $params, $d = null ) => $this->api_as( $who, 'POST', '/daily-reports/' . ( $d ?? $day ) . '/change', $params );
		$decide = fn ( $who, $id, $action, $message = '' ) => $this->api_as(
			$who,
			'PATCH',
			"/report-changes/{$id}",
			array(
				'action'  => $action,
				'message' => $message,
			)
		);
		$fix    = array(
			'entries' => array( 'e2' => 60 ),
			'reason'  => 'Typed 10h instead of 1h',
		);

		// Permission rows: ask for oneself (not the Super Admin); decide a Team Member's as a leader, anyone's as the Super Admin.
		$ctx = fn ( $m ) => array(
			'member_id' => $m['id'],
			'role'      => $m['role'],
		);
		$this->assertTrue( GRP_Permissions::can( $this->team['member'], GRP_Permissions::ASK_REPORT_CHANGE, array( 'member_id' => $this->team['member']['id'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['admin'], GRP_Permissions::ASK_REPORT_CHANGE, array( 'member_id' => $this->team['admin']['id'] ) ) );
		$this->assertTrue( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::DECIDE_REPORT_CHANGE, $ctx( $this->team['member'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::DECIDE_REPORT_CHANGE, $ctx( $this->lead2 ) ), 'a Team Leader’s change goes to the Super Admin' );
		$this->assertFalse( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::DECIDE_REPORT_CHANGE, $ctx( $this->team['lead'] ) ) );
		$this->assertTrue( GRP_Permissions::can( $this->team['admin'], GRP_Permissions::DECIDE_REPORT_CHANGE, $ctx( $this->team['lead'] ) ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['other'], GRP_Permissions::DECIDE_REPORT_CHANGE, $ctx( $this->team['member'] ) ) );

		// Nothing sent that day; today's report is edited instead.
		$this->assertStatus( 404, $ask( 'member', $fix ) );
		$this->sent( 'member', $day );
		$this->put(
			'member',
			$this->today(),
			array(
				'entries' => array( $this->entry() ),
				'send'    => true,
			)
		);
		$this->assertSame( 'grp_report_open', $ask( 'member', $fix, $this->today() )->get_data()['code'] );
		$this->assertSame( 'grp_report_locked', $this->put( 'member', $day, array( 'entries' => array( $this->entry() ) ) )->get_data()['code'], 'still locked' );

		// The request is checked: a reason, a real change, sensible times.
		$this->assertSame( 'grp_change_reason', $ask( 'member', array( 'entries' => array( 'e2' => 60 ) ) )->get_data()['code'] );
		$this->assertSame(
			'grp_change_none',
			$ask(
				'member',
				array(
					'entries' => array( 'e2' => 600 ),
					'reason'  => 'x',
				)
			)->get_data()['code']
		);
		$this->assertStatus(
			400,
			$ask(
				'member',
				array(
					'entries' => array( 'e2' => 0 ),
					'reason'  => 'x',
				)
			)
		);

		$asked = $ask( 'member', $fix );
		$this->assertStatus( 201, $asked );
		$change = $asked->get_data();
		$this->assertSame( 'pending', $change['status'] );
		$this->assertSame( 960, (int) $change['from_minutes'] );
		$this->assertSame( 420, (int) $change['to_minutes'] );
		$this->assertEquals(
			array(
				'id'    => 'e2',
				'title' => 'Images Sorting',
				'from'  => 600,
				'to'    => 60,
			),
			$change['entries'][0]
		);
		$this->assertSame( 'grp_change_waiting', $ask( 'member', $fix )->get_data()['code'], 'one waiting request per report' );

		// Who sees it: the person and the leaders; not other Team Members.
		$seen = fn ( $who ) => array_column( $this->api_as( $who, 'GET', '/sync' )->get_data()['changes']['report_changes'], 'id' );
		$this->assertContains( $change['id'], $seen( 'member' ) );
		$this->assertContains( $change['id'], $seen( 'lead' ) );
		$this->assertContains( $change['id'], $seen( 'admin' ) );
		$this->assertNotContains( $change['id'], $seen( 'other' ) );

		// Only a leader decides; approving puts the new time on the report.
		$this->assertStatus( 403, $decide( 'other', $change['id'], 'approve' ) );
		$this->assertStatus( 403, $decide( 'member', $change['id'], 'approve' ) );
		$ok = $decide( 'lead', $change['id'], 'approve', 'Fixed' );
		$this->assertStatus( 200, $ok );
		$this->assertSame( 'approved', $ok->get_data()['status'] );
		$this->assertSame( $this->team['lead']['id'], $ok->get_data()['decided_by'] );
		$report = GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['member']['id'], $day ) );
		$this->assertSame( 420, GRP_Daily_Reports::minutes( $report ) );
		$this->assertSame( 'grp_change_decided', $decide( 'lead', $change['id'], 'reject' )->get_data()['code'] );

		// A Team Leader's own change: only the Super Admin decides; they may cancel it while it waits.
		$this->sent( 'lead', $day );
		$mine = $ask( 'lead', $fix )->get_data();
		$this->assertStatus( 403, $decide( 'lead2', $mine['id'], 'approve' ) );
		$this->assertStatus( 403, $decide( 'admin', $mine['id'], 'cancel' ), 'only the person cancels' );
		$this->assertSame( 'cancelled', $decide( 'lead', $mine['id'], 'cancel' )->get_data()['status'] );
		$again = $ask( 'lead', $fix )->get_data();
		$this->assertSame( 'rejected', $decide( 'admin', $again['id'], 'reject', 'Looks right' )->get_data()['status'] );
		$this->assertSame( 960, GRP_Daily_Reports::minutes( GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['lead']['id'], $day ) ) ), 'rejected: as sent' );
	}

	public function test_a_change_recalculates_an_unpaid_payslip_and_a_paid_month_stays() {
		$day   = $this->yesterday();
		$month = substr( $day, 0, 7 );
		$this->sent( 'member', $day );
		$slip   = GRP_Store::insert(
			'grp_payslips',
			array(
				'id'        => GRP_Pay::slip_id( $this->team['member']['id'], $month ),
				'member_id' => $this->team['member']['id'],
				'month'     => $month,
				'salary'    => 30000,
				'extra'     => 480,
				'total'     => 99999,
			)
		);
		$fix    = array(
			'entries' => array( 'e2' => 60 ),
			'reason'  => 'Typed 10h instead of 1h',
		);
		$change = $this->api_as( 'member', 'POST', "/daily-reports/{$day}/change", $fix )->get_data();
		$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', "/report-changes/{$change['id']}", array( 'action' => 'approve' ) ) );
		$after = GRP_Store::get( 'grp_payslips', $slip['id'] );
		$this->assertSame( 0, (int) $after['extra'], '7h on an 8h day: no extra time' );
		$this->assertNotSame( 99999, (int) $after['total'] );

		// Once the salary is marked paid, the month's reports stay as they are.
		GRP_Store::update( 'grp_payslips', $slip['id'], array( 'paid_at' => gmdate( 'Y-m-d H:i:s' ) ) );
		$fix['entries'] = array( 'e2' => 120 );
		$this->assertSame( 'grp_month_paid', $this->api_as( 'member', 'POST', "/daily-reports/{$day}/change", $fix )->get_data()['code'] );
	}

	public function test_reports_are_not_synced() {
		$this->put( 'member', $this->today(), array( 'entries' => array( $this->entry() ) ) );
		$data = $this->api_as( 'lead', 'GET', '/sync' )->get_data();
		$this->assertArrayNotHasKey( 'daily_reports', $data );
	}
}
