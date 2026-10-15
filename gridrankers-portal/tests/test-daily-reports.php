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

		$posts = GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ) );
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
		$this->assertCount( 4, GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ) ) );
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

	public function test_reports_are_not_synced() {
		$this->put( 'member', $this->today(), array( 'entries' => array( $this->entry() ) ) );
		$data = $this->api_as( 'lead', 'GET', '/sync' )->get_data();
		$this->assertArrayNotHasKey( 'daily_reports', $data );
	}
}
