<?php
/**
 * Tests for requests to undo In progress (SPEC.md 6.6): POST /meeting-tasks/{id}/undo and
 * /undo/decide, POST /records/undo and /records/undo/decide, and the answer notice.
 *
 * @package GridRankers_Portal
 */

/**
 * A Team Member asks; a Team Leader or the Super Admin decides.
 */
class Test_GRP_Undo extends GRP_REST_TestCase {

	/**
	 * A meeting task for Max, In progress.
	 *
	 * @param array $fields Extra fields.
	 * @return array
	 */
	private function started( array $fields = array() ) {
		$project = $this->project( 'Acme', 1 );
		$task    = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			$fields + array(
				'project_id' => $project['id'],
				'title'      => 'Fix H1',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$this->assertSame( 'doing', $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'doing' ) )->get_data()['status'] );

		return $task;
	}

	/**
	 * Notices sent to someone.
	 *
	 * @param string $handle Team handle.
	 * @return array[]
	 */
	private function notices_to( $handle ) {
		return GRP_Store::find(
			'grp_posts',
			array(
				'kind'      => 'notice',
				'to_member' => $this->team[ $handle ]['id'],
			)
		);
	}

	public function test_permission_rows() {
		$doing  = array(
			'status'    => 'doing',
			'target'    => 1,
			'assignees' => array( array( 'id' => $this->team['member']['id'] ) ),
		);
		$member = GRP_Store::get( 'grp_members', $this->team['member']['id'] );
		$lead   = GRP_Store::get( 'grp_members', $this->team['lead']['id'] );
		$other  = GRP_Store::get( 'grp_members', $this->team['other']['id'] );
		$this->assertTrue( GRP_Permissions::can( $member, GRP_Permissions::REQUEST_UNDO, array( 'task' => $doing ) ) );
		$this->assertFalse( GRP_Permissions::can( $other, GRP_Permissions::REQUEST_UNDO, array( 'task' => $doing ) ), 'someone else’s task' );
		$this->assertFalse( GRP_Permissions::can( $lead, GRP_Permissions::REQUEST_UNDO, array( 'task' => $doing ) ), 'leaders move it back themselves' );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::REQUEST_UNDO, array( 'task' => array( 'status' => 'todo' ) + $doing ) ) );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::REQUEST_UNDO, array( 'task' => array( 'target' => 3 ) + $doing ) ), 'quantity tasks count down instead' );
		$this->assertTrue( GRP_Permissions::can( $lead, GRP_Permissions::DECIDE_UNDO ) );
		$this->assertFalse( GRP_Permissions::can( $member, GRP_Permissions::DECIDE_UNDO ) );
	}

	public function test_member_asks_and_a_leader_undoes() {
		$task = $this->started();
		$path = "/meeting-tasks/{$task['id']}/undo";

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'todo' ) ), 'still no moving back' );
		$this->assertSame( 'grp_undo_reason', $this->api_as( 'member', 'POST', $path, array( 'reason' => 'oops' ) )->get_data()['code'], 'a reason is required' );
		$this->assertStatus( 403, $this->api_as( 'other', 'POST', $path, array( 'reason' => 'Not my task but anyway' ) ) );
		$asked = $this->api_as( 'member', 'POST', $path, array( 'reason' => 'Clicked the wrong card, not started yet' ) );
		$this->assertStatus( 200, $asked );
		$undo = $asked->get_data()['undo_request'];
		$this->assertSame( $this->team['member']['id'], $undo['by'] );
		$this->assertSame( 'Clicked the wrong card, not started yet', $undo['reason'] );
		$this->assertSame( 'grp_undo_pending', $this->api_as( 'member', 'POST', $path, array( 'reason' => 'Asking twice for the same' ) )->get_data()['code'] );

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "$path/decide", array( 'action' => 'undo' ) ) );
		$done = $this->api_as(
			'lead',
			'POST',
			"$path/decide",
			array(
				'action' => 'undo',
				'note'   => 'Fine',
			)
		)->get_data();
		$this->assertSame( 'todo', $done['status'] );
		$this->assertNull( $done['undo_request'] );
		$notice = $this->notices_to( 'member' );
		$this->assertCount( 1, $notice );
		$this->assertSame( 'Undo approved', $notice[0]['title'] );
		$this->assertStringContainsString( 'back to Not started', $notice[0]['body'] );
		$this->assertSame( 'grp_undo_none', $this->api_as( 'lead', 'POST', "$path/decide", array( 'action' => 'undo' ) )->get_data()['code'] );
	}

	public function test_keep_in_progress_and_moving_on_answers_the_request() {
		$task = $this->started();
		$path = "/meeting-tasks/{$task['id']}/undo";
		$this->api_as( 'member', 'POST', $path, array( 'reason' => 'Clicked the wrong card, not started yet' ) );
		$kept = $this->api_as(
			'admin',
			'POST',
			"$path/decide",
			array(
				'action' => 'keep',
				'note'   => 'The draft is already in Docs',
			)
		)->get_data();
		$this->assertSame( 'doing', $kept['status'] );
		$this->assertNull( $kept['undo_request'] );
		$this->assertSame( 'Undo not approved', $this->notices_to( 'member' )[0]['title'] );
		$this->assertStringContainsString( 'The draft is already in Docs', $this->notices_to( 'member' )[0]['body'] );

		// A new request is dropped when the task moves on (completed).
		$this->api_as( 'member', 'POST', $path, array( 'reason' => 'Clicked the wrong card again' ) );
		$completed = $this->api_as(
			'member',
			'POST',
			"/meeting-tasks/{$task['id']}/status",
			array(
				'status' => 'done',
				'note'   => 'Fixed the H1',
			)
		)->get_data();
		$this->assertNull( $completed['undo_request'] );
	}

	public function test_quantity_tasks_cannot_ask() {
		$project = $this->project( 'Acme', 1 );
		$task    = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Citations',
				'target'     => 3,
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$this->api_as(
			'member',
			'POST',
			"/meeting-tasks/{$task['id']}/progress",
			array(
				'memberId' => $this->team['member']['id'],
				'delta'    => 1,
			)
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/undo", array( 'reason' => 'Ticked one by mistake today' ) ) );
	}

	public function test_monthly_record_undo() {
		$project = $this->project( 'Acme', 1 );
		$period  = GRP_Cycles::cycle_range( $project, 0, GRP_Cycles::today() )['key'];
		$task    = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'GBP post',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$at      = array(
			'taskId'    => $task['id'],
			'periodKey' => $period,
		);
		$this->assertSame( 'doing', $this->api_as( 'member', 'POST', '/records/status', $at + array( 'status' => 'doing' ) )->get_data()['record']['status'] );
		$this->assertSame( 'grp_undo_reason', $this->api_as( 'member', 'POST', '/records/undo', $at + array( 'reason' => '' ) )->get_data()['code'] );
		$asked = $this->api_as( 'member', 'POST', '/records/undo', $at + array( 'reason' => 'Wrong month, not started yet' ) )->get_data()['record'];
		$this->assertSame( 'Wrong month, not started yet', $asked['undo_request']['reason'] );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/records/undo/decide', $at + array( 'action' => 'undo' ) ) );
		$out = $this->api_as( 'lead', 'POST', '/records/undo/decide', $at + array( 'action' => 'undo' ) )->get_data();
		$this->assertNull( $out['record'], 'back to Not started: the period is empty again' );
		$this->assertSame( 'Undo approved', $this->notices_to( 'member' )[0]['title'] );
	}

	public function test_last_unit_needs_the_completion_note_from_members() {
		$project = $this->project( 'Acme', 1 );
		$period  = GRP_Cycles::cycle_range( $project, 0, GRP_Cycles::today() )['key'];
		$task    = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Posts',
				'target'     => 2,
			)
		)->get_data();
		$tick    = array(
			'taskId'    => $task['id'],
			'periodKey' => $period,
			'delta'     => 1,
		);
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/records/tick', $tick ), 'not the last one: no note' );
		$this->assertSame( 'grp_completion_required', $this->api_as( 'member', 'POST', '/records/tick', $tick )->get_data()['code'] );
		$done = $this->api_as( 'member', 'POST', '/records/tick', $tick + array( 'note' => 'Two posts published' ) )->get_data()['record'];
		$this->assertSame( 'done', $done['status'] );
		$this->assertSame( 'Two posts published', $done['completion']['note'] );
	}
}
