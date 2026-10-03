<?php
/**
 * Tests for /leave, /days-off, /settings/messages, /posts, /review/request, member
 * birthdays and leave privacy in /sync (SPEC.md 6.10, section 8).
 *
 * @package GridRankers_Portal
 */

/**
 * People features over REST, permissions enforced on the server.
 */
class Test_GRP_REST_People extends GRP_REST_TestCase {

	/**
	 * A Monday at least a week ahead.
	 *
	 * @var string
	 */
	private $monday;

	public function set_up() {
		parent::set_up();
		$this->monday = gmdate( 'Y-m-d', strtotime( 'monday next week', strtotime( GRP_Cycles::today() . ' UTC' ) + 7 * DAY_IN_SECONDS ) );
	}

	/**
	 * Date `$n` days after the test Monday.
	 *
	 * @param int $n Days.
	 * @return string
	 */
	private function day( $n ) {
		return GRP_People::add_days( $this->monday, $n );
	}

	/**
	 * Asks for leave and returns the response.
	 *
	 * @param string $who    Handle.
	 * @param int    $from   First day (offset from the test Monday).
	 * @param int    $to     Last day.
	 * @param array  $fields Extra fields.
	 * @return WP_REST_Response
	 */
	private function ask( $who, $from, $to, array $fields = array() ) {
		return $this->api_as(
			$who,
			'POST',
			'/leave',
			$fields + array(
				'type'   => 'day',
				'from'   => $this->day( $from ),
				'to'     => $this->day( $to ),
				'reason' => 'Family wedding',
			)
		);
	}

	public function test_member_requests_leave_and_a_leader_decides() {
		// Mon – Fri: the Friday is the team's weekly day off, so 4 days.
		$response = $this->ask( 'member', 0, 4 );
		$this->assertStatus( 201, $response );
		$leave = $response->get_data();
		$this->assertSame( 'pending', $leave['status'] );
		$this->assertSame( 4, $leave['days'] );

		$this->assertStatus( 403, $this->api_as( 'other', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'approve' ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'approve' ) ) );

		$approved = $this->api_as(
			'lead',
			'PATCH',
			"/leave/{$leave['id']}",
			array(
				'action'  => 'approve',
				'message' => 'Enjoy the wedding!',
			)
		);
		$this->assertStatus( 200, $approved );
		$this->assertSame( 'approved', $approved->get_data()['status'] );
		$this->assertSame( 'Enjoy the wedding!', $approved->get_data()['message'] );
		$this->assertSame( $this->team['lead']['id'], $approved->get_data()['decided_by'] );

		$this->assertSame( 409, $this->api_as( 'admin', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'reject' ) )->get_status(), 'already decided' );
		$this->assertStringNotContainsString( 'wedding', wp_json_encode( $this->audit_for( $leave['id'] ) ), 'the public log never carries the reason' );
	}

	public function test_team_leader_leave_is_approved_straight_away_and_the_super_admin_has_none() {
		$response = $this->ask( 'lead', 1, 1, array( 'type' => 'sick' ) );
		$this->assertStatus( 201, $response );
		$this->assertSame( 'approved', $response->get_data()['status'] );
		$this->assertSame( $this->team['lead']['id'], $response->get_data()['decided_by'] );

		$this->assertStatus( 403, $this->ask( 'admin', 1, 1 ) );
		$this->assertStatus( 403, $this->ask( 'member', 1, 1, array( 'member_id' => $this->team['other']['id'] ) ), 'only for yourself' );
	}

	public function test_leaders_and_the_super_admin_issue_a_day_off() {
		$issue = fn ( $who, $handle, $from, $to, array $more = array() ) => $this->api_as(
			$who,
			'POST',
			'/leave',
			$more + array(
				'member_id' => $this->team[ $handle ]['id'],
				'from'      => $this->day( $from ),
				'to'        => $this->day( $to ),
				'note'      => 'Thanks for the launch',
				'type'      => 'sick',
				'reason'    => 'ignored',
			)
		);

		// A Team Leader to a Team Member: approved day leave, decided by them, the note as the message.
		$response = $issue( 'lead', 'member', 0, 1 );
		$this->assertStatus( 201, $response );
		$leave = $response->get_data();
		$this->assertSame( 'approved', $leave['status'] );
		$this->assertSame( 'day', $leave['type'], 'an issued day off is day leave' );
		$this->assertSame( 2, (int) $leave['days'] );
		$this->assertSame( $this->team['lead']['id'], $leave['decided_by'] );
		$this->assertSame( $this->team['lead']['id'], $leave['created_by'] );
		$this->assertSame( 'Thanks for the launch', $leave['message'] );
		$this->assertSame( '', (string) $leave['reason'] );
		// It counts: Max took 2 days in that month (1 over the allowance).
		$month = substr( $this->day( 0 ), 0, 7 );
		if ( substr( $this->day( 1 ), 0, 7 ) === $month ) {
			$report = array_column( $this->api_as( 'admin', 'GET', '/leave/report', array( 'month' => $month ) )->get_data()['rows'], null, 'member_id' );
			$this->assertSame( 2, (int) $report[ $this->team['member']['id'] ]['taken'] );
		}
		$this->assertSame( 'grp_leave_overlap', $issue( 'admin', 'member', 1, 1 )->get_data()['code'] );

		// The Super Admin to a Team Leader; a Team Leader to another Team Leader.
		$this->assertStatus( 201, $issue( 'admin', 'lead', 2, 2 ) );
		$second = $this->add_member( 'Lia Lead', 'lead' );
		$this->assertStatus( 201, $issue( 'lead', 'lead', 3, 3, array( 'member_id' => $second['id'] ) ) );
		$this->assertStatus( 403, $issue( 'lead', 'admin', 3, 3 ), 'never to the Super Admin' );
		$this->assertStatus( 403, $issue( 'member', 'other', 3, 3 ), 'Team Members cannot issue' );
		$this->assertStatus( 400, $issue( 'admin', 'other', 4, 4 ), 'a Friday only' );

		// The leader who issued it may cancel it; the member may not.
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'cancel' ) ) );
		$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'cancel' ) ) );
	}

	public function test_leave_validation() {
		$this->assertStatus( 201, $this->ask( 'member', 0, 1 ) );
		$this->assertSame( 'grp_leave_overlap', $this->ask( 'member', 1, 2 )->get_data()['code'] );
		$this->assertSame( 'grp_leave_no_days', $this->ask( 'member', 4, 4 )->get_data()['code'], 'a Friday only' );
		$this->assertStatus( 400, $this->ask( 'member', 3, 2 ) );
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'POST',
				'/leave',
				array(
					'from' => GRP_People::add_days( GRP_Cycles::today(), -45 ),
					'to'   => GRP_People::add_days( GRP_Cycles::today(), -44 ),
				)
			),
			'more than 30 days ago'
		);
		$this->assertStatus( 201, $this->ask( 'other', 1, 2 ), 'other people may be off on the same days' );
	}

	public function test_cancelling_leave() {
		$pending = $this->ask( 'member', 0, 0 )->get_data();
		$this->assertStatus( 200, $this->api_as( 'member', 'PATCH', "/leave/{$pending['id']}", array( 'action' => 'cancel' ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/leave/{$pending['id']}", array( 'action' => 'cancel' ) ), 'already cancelled' );

		$approved = $this->ask( 'member', 1, 1 )->get_data();
		$this->api_as( 'lead', 'PATCH', "/leave/{$approved['id']}", array( 'action' => 'approve' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/leave/{$approved['id']}", array( 'action' => 'cancel' ) ), 'members cancel pending requests only' );
		$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', "/leave/{$approved['id']}", array( 'action' => 'cancel' ) ) );

		$lead_leave = $this->ask( 'lead', 2, 2 )->get_data();
		$this->assertStatus( 200, $this->api_as( 'admin', 'PATCH', "/leave/{$lead_leave['id']}", array( 'action' => 'cancel' ) ) );
	}

	public function test_team_members_only_see_their_own_leave_details() {
		$mine   = $this->ask( 'member', 0, 0 )->get_data();
		$theirs = $this->ask( 'other', 1, 1, array( 'type' => 'sick' ) )->get_data();
		$asked  = $this->ask( 'other', 2, 2 )->get_data();
		$this->api_as( 'lead', 'PATCH', "/leave/{$theirs['id']}", array( 'action' => 'approve' ) );

		$list = $this->api_as( 'member', 'GET', '/leave' )->get_data();
		$this->assertSame( array( $mine['id'] ), array_column( $list, 'id' ) );
		$this->assertCount( 3, $this->api_as( 'lead', 'GET', '/leave' )->get_data() );

		$sync  = $this->api_as( 'member', 'GET', '/sync' )->get_data();
		$leave = array_column( $sync['changes']['leave'], null, 'id' );
		$this->assertSame( 'Family wedding', $leave[ $mine['id'] ]['reason'] );
		$this->assertSame(
			array( 'from_date', 'id', 'member_id', 'status', 'to_date', 'updated_at' ),
			self::sorted_keys( $leave[ $theirs['id'] ] ),
			'no type, reason or message for other people'
		);
		$this->assertArrayNotHasKey( $asked['id'], $leave, 'other people’s pending requests are not shown' );
		$this->assertContains(
			array(
				'table' => 'leave',
				'id'    => $asked['id'],
			),
			$sync['deletions']
		);

		$lead = array_column( $this->api_as( 'lead', 'GET', '/sync' )->get_data()['changes']['leave'], null, 'id' );
		$this->assertSame( 'sick', $lead[ $theirs['id'] ]['type'] );
		$this->assertArrayHasKey( $asked['id'], $lead );
	}

	public function test_leave_report_is_for_the_super_admin() {
		$leave = $this->ask( 'member', 0, 2 )->get_data();
		$this->api_as( 'lead', 'PATCH', "/leave/{$leave['id']}", array( 'action' => 'approve' ) );
		$month = substr( $this->monday, 0, 7 );

		$this->assertStatus( 403, $this->api_as( 'lead', 'GET', '/leave/report', array( 'month' => $month ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/leave/report', array( 'month' => $month ) ) );

		$rows = array_column( $this->api_as( 'admin', 'GET', '/leave/report', array( 'month' => $month ) )->get_data()['rows'], null, 'member_id' );
		$this->assertArrayNotHasKey( $this->team['admin']['id'], $rows, 'the Super Admin has no leave' );
		$taken = GRP_People::taken_in_month( GRP_Store::get( 'grp_members', $this->team['member']['id'] ), $month, array( GRP_Store::get( 'grp_leave', $leave['id'] ) ), null, array() );
		$this->assertSame( GRP_People::settlement( $taken )['result'], $rows[ $this->team['member']['id'] ]['result'] );
		$this->assertSame( 'paid', $rows[ $this->team['other']['id'] ]['result'] );

		$year = $this->api_as( 'admin', 'GET', '/leave/report', array( 'year' => (int) substr( $this->monday, 0, 4 ) ) )->get_data();
		$this->assertSame( 3, array_column( $year['rows'], null, 'member_id' )[ $this->team['member']['id'] ]['day'] );
		$this->assertStatus( 400, $this->api_as( 'admin', 'GET', '/leave/report' ) );
	}

	public function test_days_off_and_weekly_days_are_set_by_the_super_admin() {
		$event = array(
			'kind' => 'event',
			'name' => 'Durga Puja',
			'from' => $this->day( 1 ),
		);
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/days-off', $event ) );
		$created = $this->api_as( 'admin', 'POST', '/days-off', $event );
		$this->assertStatus( 201, $created );
		$this->assertSame( $this->day( 1 ), $created->get_data()['to_date'] );

		// The Tuesday is now a day off: Mon – Wed counts 2 days.
		$this->assertSame( 2, $this->ask( 'member', 0, 2 )->get_data()['days'] );

		$this->assertStatus(
			400,
			$this->api_as(
				'admin',
				'POST',
				'/days-off',
				array(
					'kind' => 'seasonal',
					'name' => 'Eid',
					'from' => $this->day( 9 ),
					'to'   => $this->day( 8 ),
				)
			)
		);
		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', '/days-off/' . $created->get_data()['id'] ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', '/days-off/' . $created->get_data()['id'] ) );

		$this->assertStatus( 403, $this->api_as( 'lead', 'PUT', '/days-off/weekly', array( 'weekdays' => array( 5, 6 ) ) ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'PUT', '/days-off/weekly', array( 'weekdays' => array( 5, 6 ) ) ) );
		$this->assertSame( array( 5, 6 ), $this->api_as( 'member', 'GET', '/days-off' )->get_data()['weekly'] );

		$own = $this->api_as(
			'admin',
			'PUT',
			'/days-off/weekly',
			array(
				'weekdays' => array( 4 ),
				'member'   => $this->team['other']['id'],
			)
		);
		$this->assertStatus( 200, $own );
		$this->assertSame( array( 4 ), GRP_Store::get( 'grp_members', $this->team['other']['id'] )['weekly_off'] );
		// Rafi-style own Thursday off: Mon – Fri counts 4 (Friday is a working day for them).
		$this->assertSame( 4, $this->ask( 'other', 7, 11 )->get_data()['days'] );
	}

	public function test_automatic_messages() {
		$defaults = $this->api_as( 'member', 'GET', '/settings/messages' )->get_data();
		$this->assertStringContainsString( '{name}', $defaults['birthday'] );

		$this->assertStatus( 403, $this->api_as( 'lead', 'PUT', '/settings/messages', array( 'birthday' => 'Hi {name}' ) ) );
		$saved = $this->api_as(
			'admin',
			'PUT',
			'/settings/messages',
			array(
				'birthday' => 'Happy birthday {name}!',
				'day_off'  => '',
			)
		)->get_data();
		$this->assertSame( 'Happy birthday {name}!', $saved['birthday'] );
		$this->assertSame( $defaults['day_off'], $saved['day_off'], 'empty goes back to the default' );
	}

	public function test_announcements_and_shoutouts() {
		$announcement = array(
			'kind'       => 'announcement',
			'title'      => 'Office closed on Tuesday',
			'body'       => 'Enjoy the holiday!',
			'pinned'     => true,
			'show_until' => $this->day( 1 ),
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/posts', $announcement ) );
		$lead_post = $this->api_as( 'lead', 'POST', '/posts', $announcement );
		$this->assertStatus( 201, $lead_post );
		$this->assertSame( 1, $lead_post->get_data()['pinned'] );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/posts', array_merge( $announcement, array( 'body' => '' ) ) ) );

		$shout = array(
			'kind' => 'shoutout',
			'to'   => $this->team['member']['id'],
			'body' => 'Great work on the Acme H1 fixes',
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/posts', $shout ) );
		$this->assertStatus( 403, $this->api_as( 'admin', 'POST', '/posts', array_merge( $shout, array( 'to' => $this->team['lead']['id'] ) ) ), 'shout-outs are for Team Members' );
		$admin_shout = $this->api_as( 'admin', 'POST', '/posts', $shout );
		$this->assertStatus( 201, $admin_shout );

		$ids = array_column( $this->api_as( 'member', 'GET', '/posts' )->get_data(), 'id' );
		$this->assertSame( array( $admin_shout->get_data()['id'], $lead_post->get_data()['id'] ), $ids, 'newest first' );

		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', '/posts/' . $admin_shout->get_data()['id'] ), 'leaders remove their own posts only' );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', '/posts/' . $lead_post->get_data()['id'] ) );
		$this->assertSame( array( $admin_shout->get_data()['id'] ), array_column( $this->api_as( 'member', 'GET', '/posts' )->get_data(), 'id' ) );

		// Past their date or older than 30 days: no longer listed.
		global $wpdb;
		$wpdb->update( GRP_Install::table( 'grp_posts' ), array( 'created_at' => gmdate( 'Y-m-d H:i:s', time() - 31 * DAY_IN_SECONDS ) ), array( 'id' => $admin_shout->get_data()['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$this->assertSame( array(), $this->api_as( 'member', 'GET', '/posts' )->get_data() );
	}

	public function test_leaders_can_ask_anyone_to_review_their_own_work() {
		$project = $this->project();
		$task    = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Approve content plan',
			)
		)->get_data();
		$done    = $this->api_as( 'lead', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'done' ) )->get_data();
		$this->assertSame( 'accepted', $done['review']['state'], 'done straight away by default' );

		$ask = array(
			'kind'     => 'item',
			'id'       => $task['id'],
			'reviewer' => $this->team['member']['id'],
			'note'     => 'Please check the October topics',
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/review/request', $ask ) );
		$this->assertSame( 'grp_not_own_work', $this->api_as( 'admin', 'POST', '/review/request', $ask )->get_data()['code'] );
		$asked = $this->api_as( 'lead', 'POST', '/review/request', $ask );
		$this->assertStatus( 200, $asked );
		$this->assertSame( 'pending', $asked->get_data()['review']['state'] );
		$this->assertSame( $this->team['member']['id'], $asked->get_data()['review']['reviewer'] );

		$accept = array(
			'kind'   => 'item',
			'id'     => $task['id'],
			'action' => 'accept',
		);
		$this->assertStatus( 403, $this->api_as( 'other', 'POST', '/review', $accept ), 'not the reviewer' );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/review', $accept ), 'someone else was asked' );
		$this->assertStatus(
			403,
			$this->api_as(
				'member',
				'POST',
				'/review',
				array(
					'action' => 'reject',
					'note'   => 'no',
				) + $accept
			),
			'reviewers approve or send back'
		);
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/review', $accept ) );
		$this->assertSame( 'accepted', GRP_Store::get( 'grp_meeting_tasks', $task['id'] )['review']['state'] );

		// Members still can't review other work.
		$this->assertStatus(
			403,
			$this->api_as(
				'member',
				'POST',
				'/review',
				array_merge(
					$accept,
					array(
						'action' => 'revision',
						'note'   => 'x',
					)
				)
			)
		);
	}

	public function test_everyone_sets_their_own_birthday() {
		$this->assertStatus( 200, $this->api_as( 'member', 'PATCH', '/members/' . $this->team['member']['id'], array( 'birthday' => '10-14' ) ) );
		$this->assertSame( '10-14', GRP_Store::get( 'grp_members', $this->team['member']['id'] )['birthday'] );
		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', '/members/' . $this->team['member']['id'], array( 'birthday' => '02-30' ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'PATCH', '/members/' . $this->team['member']['id'], array( 'birthday' => '01-01' ) ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'PATCH', '/members/' . $this->team['member']['id'], array( 'birthday' => '' ) ) );
		$this->assertNull( GRP_Store::get( 'grp_members', $this->team['member']['id'] )['birthday'] );

		// Birthdays are visible to everyone (no contact details).
		$this->api_as( 'lead', 'PATCH', '/members/' . $this->team['lead']['id'], array( 'birthday' => '03-02' ) );
		$members = array_column( $this->api_as( 'member', 'GET', '/members' )->get_data(), null, 'id' );
		$this->assertSame( '03-02', $members[ $this->team['lead']['id'] ]['birthday'] );
	}

	public function test_notices_to_chosen_people_are_private() {
		$notice = array(
			'kind'       => 'notice',
			'to'         => array( $this->team['member']['id'] ),
			'title'      => 'Acme report',
			'body'       => 'Please send the Acme ranking report by 3 PM.',
			'show_until' => $this->day( 6 ),
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/posts', $notice ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/posts', array_merge( $notice, array( 'to' => array() ) ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/posts', array_merge( $notice, array( 'to' => array( 'nobody' ) ) ) ) );
		$sent = $this->api_as( 'lead', 'POST', '/posts', $notice );
		$this->assertStatus( 201, $sent );
		$id = $sent->get_data()['id'];
		$this->assertSame( array( $this->team['member']['id'] ), $sent->get_data()['to_members'] );

		$ids = fn ( $who, $path ) => array_column( 'sync' === $path ? $this->api_as( $who, 'GET', '/sync' )->get_data()['changes']['posts'] : $this->api_as( $who, 'GET', '/posts' )->get_data(), 'id' );
		foreach ( array( 'member', 'lead', 'admin' ) as $who ) {
			$this->assertContains( $id, $ids( $who, 'posts' ), "$who should see it" );
			$this->assertContains( $id, $ids( $who, 'sync' ), "$who should sync it" );
		}
		$this->assertNotContains( $id, $ids( 'other', 'posts' ), 'not for other people' );
		$this->assertNotContains( $id, $ids( 'other', 'sync' ), 'not even over /sync' );

		// A notice to everyone needs no title; shout-outs go to several Team Members at once.
		$all = $this->api_as(
			'admin',
			'POST',
			'/posts',
			array(
				'kind' => 'announcement',
				'body' => 'Office closes at 4 PM on Thursday.',
			)
		);
		$this->assertStatus( 201, $all );
		$this->assertContains( $all->get_data()['id'], $ids( 'other', 'posts' ) );
		$shout = array(
			'kind' => 'shoutout',
			'to'   => array( $this->team['member']['id'], $this->team['other']['id'] ),
			'body' => 'Great teamwork on Acme!',
		);
		$this->assertStatus( 201, $this->api_as( 'lead', 'POST', '/posts', $shout ) );
		$this->assertStatus( 403, $this->api_as( 'admin', 'POST', '/posts', array_merge( $shout, array( 'to' => array( $this->team['member']['id'], $this->team['lead']['id'] ) ) ) ), 'shout-outs are for Team Members' );
	}

	public function test_incomplete_profile_locks_task_work_with_a_clear_message() {
		$project = $this->project();
		$task    = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Fix the H1',
			)
		)->get_data();
		GRP_Store::update(
			'grp_members',
			$this->team['member']['id'],
			array(
				'location' => null,
				'phone'    => '',
			)
		);
		GRP_Store::update( 'grp_members', $this->team['admin']['id'], array( 'location' => null ) );

		$res = $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'doing' ) );
		$this->assertStatus( 403, $res );
		$this->assertSame( 'grp_profile_incomplete', $res->get_data()['code'] );
		$this->assertStringContainsString( 'Location, Phone number', $res->get_data()['message'] );
		$this->assertStatus( 201, $this->ask( 'member', 0, 0 ), 'leave still works' );
		$this->assertStatus( 200, $this->api_as( 'admin', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'doing' ) ), 'the Super Admin is only reminded' );

		$this->assertStatus(
			200,
			$this->api_as(
				'member',
				'PATCH',
				'/members/' . $this->team['member']['id'],
				array(
					'location' => 'Rangpur',
					'phone'    => '+8801711111111',
				)
			)
		);
		$done = array(
			'status' => 'done',
			'note'   => 'Fixed the H1',
		);
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", $done ) );
	}

	public function test_birth_year_is_private_and_validated() {
		$me = '/members/' . $this->team['member']['id'];
		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', $me, array( 'birth_year' => '1850' ) ) );
		$this->assertStatus( 403, $this->api_as( 'other', 'PATCH', $me, array( 'birth_year' => '1995' ) ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'PATCH', $me, array( 'birth_year' => '1996' ) ) );

		$seen = fn ( $who ) => array_column( $this->api_as( $who, 'GET', '/members' )->get_data(), null, 'id' )[ $this->team['member']['id'] ];
		$this->assertSame( 1996, $seen( 'member' )['birth_year'] );
		$this->assertSame( 1996, $seen( 'lead' )['birth_year'] );
		$this->assertArrayNotHasKey( 'birth_year', $seen( 'other' ), 'the year is for managers and the person' );
		$this->assertSame( '01-15', $seen( 'other' )['birthday'], 'day and month are for everyone' );
		$this->assertSame( 'Rangpur', $seen( 'other' )['location'] );
	}

	public function test_weather_for_the_persons_city() {
		$asked = array();
		$fake  = static function ( $pre, $args, $url ) use ( &$asked ) {
			$asked[] = $url;
			$body    = str_contains( $url, 'geocoding-api' )
				? array(
					'results' => array(
						array(
							'name'      => 'Rangpur',
							'latitude'  => 25.74,
							'longitude' => 89.27,
						),
					),
				)
				: array(
					'current' => array(
						'temperature_2m' => 30.6,
						'weather_code'   => 1,
					),
					'daily'   => array(
						'temperature_2m_max' => array( 31.2 ),
						'temperature_2m_min' => array( 24.4 ),
					),
				);
			return array(
				'response' => array( 'code' => 200 ),
				'body'     => wp_json_encode( $body ),
				'headers'  => array(),
				'cookies'  => array(),
			);
		};
		add_filter( 'pre_http_request', $fake, 10, 3 );

		$res = $this->api_as( 'member', 'GET', '/weather' )->get_data();
		$this->assertSame(
			array(
				'available' => true,
				'city'      => 'Rangpur',
				'temp'      => 31,
				'max'       => 31,
				'min'       => 24,
				'code'      => 1,
				'text'      => 'Mostly sunny',
				'icon'      => 'sun',
			),
			$res
		);
		$this->assertCount( 2, $asked );
		$this->assertStringContainsString( 'name=Rangpur', $asked[0] );
		$this->assertStringNotContainsString( 'Max', implode( ' ', $asked ), 'nothing about the person is sent' );

		$this->api_as( 'other', 'GET', '/weather' );
		$this->assertCount( 2, $asked, 'cached per city' );

		GRP_Store::update( 'grp_members', $this->team['lead']['id'], array( 'location' => '' ) );
		$this->assertSame(
			array(
				'available' => false,
				'city'      => '',
			),
			$this->api_as( 'lead', 'GET', '/weather' )->get_data()
		);
		remove_filter( 'pre_http_request', $fake, 10 );
	}

	/**
	 * Keys of an array, sorted.
	 *
	 * @param array $row Row.
	 * @return string[]
	 */
	private static function sorted_keys( array $row ) {
		$keys = array_keys( $row );
		sort( $keys );

		return $keys;
	}
}
