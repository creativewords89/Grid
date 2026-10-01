<?php
/**
 * REST tests for /meeting-tasks.
 *
 * @package GridRankers_Portal
 */

/**
 * Meeting tasks controller.
 */
class Test_GRP_REST_Meeting_Tasks extends GRP_REST_TestCase {

	/**
	 * Project used by the tests.
	 *
	 * @var array
	 */
	private $project;

	public function set_up() {
		parent::set_up();
		$this->project = $this->project();
	}

	/**
	 * Creates a task as someone.
	 *
	 * @param string $who    Member handle.
	 * @param array  $fields Fields.
	 * @return array
	 */
	private function task( $who = 'lead', array $fields = array() ) {
		$response = $this->api_as(
			$who,
			'POST',
			'/meeting-tasks',
			$fields + array(
				'project_id' => $this->project['id'],
				'title'      => 'Fix the H1',
			)
		);
		$this->assertStatus( 201, $response );

		return $response->get_data();
	}

	/**
	 * Assignees for the given handles.
	 *
	 * @param string ...$handles Member handles.
	 * @return array
	 */
	private function people( ...$handles ) {
		return array_map(
			function ( $h ) {
				return array( 'id' => $this->team[ $h ]['id'] );
			},
			$handles
		);
	}

	public function test_member_can_add_task_with_defaults() {
		$task = $this->task( 'member' );

		$this->assertSame( 'todo', $task['status'] );
		$this->assertSame( 'normal', $task['priority'] );
		$this->assertSame( 1, $task['target'] );
		$this->assertSame( array(), $task['assignees'] );
		$this->assertSame( $this->team['member']['id'], $task['created_by'] );
		$this->assertSame( 'add', $this->audit_for( $task['id'] )[0]['kind'] );
	}

	public function test_create_validation() {
		$this->act_as( 'member' );
		$base = array(
			'project_id' => $this->project['id'],
			'title'      => 'x',
		);

		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'project_id' => 'nope' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'title' => ' ' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'url' => 'javascript:alert(1)' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'priority' => 'meh' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'meeting_date' => '2026-02-30' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'assignees' => array( array( 'id' => 'ghost' ) ) ) + $base ) );
		$this->assertStatus(
			400,
			$this->api(
				'POST',
				'/meeting-tasks',
				array(
					'deadline' => array(
						'type'  => 'weekly',
						'weeks' => array( '2026-10-06' ),
					),
				) + $base
			)
		);
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'deadline' => array( 'type' => 'date' ) ) + $base ) );
	}

	public function test_deadlines_are_normalised() {
		$weekly = $this->task(
			'lead',
			array(
				'deadline' => array(
					'type'  => 'weekly',
					'weeks' => array( '2026-10-12', '2026-10-05', '2026-10-05' ),
				),
			)
		);
		$this->assertSame( array( '2026-10-05', '2026-10-12' ), $weekly['deadline']['weeks'] );

		$dates = $this->task(
			'lead',
			array(
				'deadline' => array(
					'type' => 'dates',
					'from' => '2026-10-20',
					'to'   => '2026-10-12',
				),
			)
		);
		$this->assertSame( '2026-10-12', $dates['deadline']['from'] );
		$this->assertSame( '2026-10-20', $dates['deadline']['to'] );

		$monthly = $this->task( 'lead', array( 'deadline' => array( 'type' => 'monthly' ) ) );
		$this->assertSame( substr( GRP_Cycles::today(), 0, 7 ), $monthly['deadline']['month'] );
	}

	public function test_shares_split_evenly_and_one_person_gets_all() {
		$split = $this->task(
			'lead',
			array(
				'target'    => 5,
				'assignees' => $this->people( 'member', 'other' ),
			)
		);
		$this->assertSame( array( 3, 2 ), wp_list_pluck( $split['assignees'], 'n' ) );

		$kept = $this->task(
			'lead',
			array(
				'target'    => 5,
				'assignees' => array(
					array(
						'id' => $this->team['member']['id'],
						'n'  => 1,
					),
					array(
						'id' => $this->team['other']['id'],
						'n'  => 4,
					),
				),
			)
		);
		$this->assertSame( array( 1, 4 ), wp_list_pluck( $kept['assignees'], 'n' ) );

		$one = $this->task(
			'lead',
			array(
				'target'    => 4,
				'assignees' => $this->people( 'member' ),
			)
		);
		$this->assertSame( 4, $one['assignees'][0]['n'] );
	}

	public function test_only_managers_edit_and_changes_are_audited() {
		$task = $this->task( 'member' );

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/meeting-tasks/{$task['id']}", array( 'title' => 'Mine now' ) ) );

		$response = $this->api_as(
			'lead',
			'PATCH',
			"/meeting-tasks/{$task['id']}",
			array(
				'title'        => 'Fix the H1 on /plumbers',
				'meeting_date' => '2026-09-30',
				'assignees'    => $this->people( 'member' ),
			)
		);
		$this->assertStatus( 200, $response );
		$this->assertSame( 'Fix the H1 on /plumbers', $response->get_data()['title'] );
		$this->assertSame( 'normal', $response->get_data()['priority'], 'fields not sent are kept' );

		$edit    = wp_list_filter( $this->audit_for( $task['id'] ), array( 'kind' => 'edit' ) );
		$changes = reset( $edit )['changes'];
		$this->assertSame( array( 'title', 'meeting_date', 'assignees' ), wp_list_pluck( $changes, 'field' ) );
		$this->assertSame( 'Unassigned', $changes[2]['from'] );
		$this->assertSame( 'Max Member', $changes[2]['to'] );
	}

	public function test_unchanged_json_fields_are_not_logged_whatever_the_stored_key_order() {
		global $wpdb;
		$task = $this->task( 'lead', array( 'assignees' => $this->people( 'member' ) ) );

		// MySQL's JSON type stores object keys in its own order.
		$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			GRP_Install::table( 'grp_meeting_tasks' ),
			array( 'assignees' => '[{"n": 1, "id": "' . $task['assignees'][0]['id'] . '"}]' ),
			array( 'id' => $task['id'] )
		);

		$response = $this->api_as(
			'lead',
			'PATCH',
			"/meeting-tasks/{$task['id']}",
			array(
				'title'     => 'Renamed',
				'assignees' => $this->people( 'member' ),
			)
		);
		$this->assertStatus( 200, $response );

		$edit = wp_list_filter( $this->audit_for( $task['id'] ), array( 'kind' => 'edit' ) );
		$this->assertSame( array( 'title' ), wp_list_pluck( reset( $edit )['changes'], 'field' ) );
	}

	public function test_edit_cannot_reopen_done_task() {
		$task = $this->task( 'lead', array( 'status' => 'done' ) );

		$response = $this->api_as( 'lead', 'PATCH', "/meeting-tasks/{$task['id']}", array( 'status' => 'doing' ) );
		$this->assertStatus( 409, $response );
	}

	public function test_delete_is_soft_and_managers_only() {
		$task = $this->task( 'member' );

		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/meeting-tasks/{$task['id']}" ) );

		$response = $this->api_as( 'lead', 'DELETE', "/meeting-tasks/{$task['id']}" );
		$this->assertStatus( 200, $response );
		$trash = GRP_Store::get( 'grp_trash', $response->get_data()['trash_id'] );
		$this->assertSame( $trash, $response->get_data()['trash'] );
		$this->assertSame( 'grp_meeting_tasks', $trash['type'] );
		$this->assertSame( 'Fix the H1', $trash['data']['title'] );
		$this->assertSame( $this->project['id'], $trash['project_id'] );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', $task['id'] ) );
	}

	public function test_member_status_on_own_unassigned_and_others_tasks() {
		$own        = $this->task( 'lead', array( 'assignees' => $this->people( 'member' ) ) );
		$unassigned = $this->task( 'lead' );
		$others     = $this->task( 'lead', array( 'assignees' => $this->people( 'other' ) ) );

		$this->assertStatus( 200, $this->api_as( 'member', 'POST', "/meeting-tasks/{$own['id']}/status", array( 'status' => 'doing' ) ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', "/meeting-tasks/{$unassigned['id']}/status", array( 'status' => 'doing' ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/meeting-tasks/{$others['id']}/status", array( 'status' => 'doing' ) ) );
		$this->assertStatus( 200, $this->api_as( 'lead', 'POST', "/meeting-tasks/{$others['id']}/status", array( 'status' => 'doing' ) ) );
	}

	public function test_member_cannot_move_in_progress_back() {
		$task = $this->task( 'lead', array( 'assignees' => $this->people( 'member' ) ) );
		$this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'doing' ) );

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'todo' ) ) );
		$response = $this->api_as( 'lead', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'todo' ) );
		$this->assertStatus( 200, $response );
		$this->assertSame( 'todo', $response->get_data()['status'] );
	}

	public function test_member_completion_needs_note_and_waits_for_review() {
		$task = $this->task( 'lead', array( 'assignees' => $this->people( 'member' ) ) );
		$url  = "/meeting-tasks/{$task['id']}/status";

		$missing = $this->api_as( 'member', 'POST', $url, array( 'status' => 'done' ) );
		$this->assertStatus( 400, $missing );
		$this->assertSame( 'grp_completion_required', $missing->get_data()['code'] );

		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'POST',
				$url,
				array(
					'status' => 'done',
					'note'   => 'Updated the H1',
					'link'   => 'ftp://example.com',
				)
			)
		);

		$response = $this->api_as(
			'member',
			'POST',
			$url,
			array(
				'status' => 'done',
				'note'   => 'Updated the H1',
				'link'   => 'https://example.com/plumbers',
			)
		);
		$this->assertStatus( 200, $response );
		$data = $response->get_data();
		$this->assertSame( 'done', $data['status'] );
		$this->assertNotEmpty( $data['done_at'] );
		$this->assertSame( 'pending', $data['review']['state'] );
		$this->assertSame( $this->team['member']['id'], $data['review']['submittedBy'] );
		$this->assertSame( 'Updated the H1', $data['completion']['note'] );
		$this->assertSame( 'https://example.com/plumbers', $data['completion']['link'] );

		// Credited to the member; done is locked for everyone outside review.
		$this->assertSame( array( 'item:' . $task['id'] ), wp_list_pluck( $this->credits( $this->team['member']['id'] ), 'ref_key' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $url, array( 'status' => 'doing' ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', $url, array( 'status' => 'doing' ) ) );
		$audit = $this->audit_for( $task['id'] );
		$this->assertSame( 'done', end( $audit )['kind'] );
	}

	public function test_manager_completion_is_auto_accepted_without_note() {
		$task = $this->task( 'lead' );

		$response = $this->api_as( 'lead', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'done' ) );

		$this->assertStatus( 200, $response );
		$this->assertSame( 'accepted', $response->get_data()['review']['state'] );
		$this->assertSame( 1, $response->get_data()['review']['auto'] );
	}

	public function test_progress_on_shares() {
		$task = $this->task(
			'lead',
			array(
				'target'    => 3,
				'assignees' => array(
					array(
						'id' => $this->team['member']['id'],
						'n'  => 2,
					),
					array(
						'id' => $this->team['other']['id'],
						'n'  => 1,
					),
				),
			)
		);
		$url  = "/meeting-tasks/{$task['id']}/progress";
		$me   = $this->team['member']['id'];
		$them = $this->team['other']['id'];

		// Members tick only their own share.
		$this->assertStatus(
			403,
			$this->api_as(
				'member',
				'POST',
				$url,
				array(
					'memberId' => $them,
					'delta'    => 1,
				)
			)
		);

		$first = $this->api_as(
			'member',
			'POST',
			$url,
			array(
				'memberId' => $me,
				'delta'    => 1,
			)
		)->get_data();
		$this->assertSame( 'doing', $first['status'] );
		$this->assertSame( 1, $first['progress'][ $me ] );

		// Share caps at 2.
		$this->api_as(
			'member',
			'POST',
			$url,
			array(
				'memberId' => $me,
				'delta'    => 1,
			)
		);
		$capped = $this->api_as(
			'member',
			'POST',
			$url,
			array(
				'memberId' => $me,
				'delta'    => 1,
			)
		)->get_data();
		$this->assertSame( 2, $capped['progress'][ $me ] );
		$this->assertCount( 2, $this->credits( $me ) );

		// Lead ticks the other share → total = target → done, credited to the share owner.
		$done = $this->api_as(
			'lead',
			'POST',
			$url,
			array(
				'memberId' => $them,
				'delta'    => 1,
			)
		)->get_data();
		$this->assertSame( 'done', $done['status'] );
		$this->assertSame( 'accepted', $done['review']['state'] );
		$this->assertCount( 1, $this->credits( $them ) );

		// Completed: no more ticking down outside review.
		$this->assertStatus(
			403,
			$this->api_as(
				'lead',
				'POST',
				$url,
				array(
					'memberId' => $them,
					'delta'    => -1,
				)
			)
		);
	}

	public function test_member_cannot_count_down_to_zero_but_lead_can() {
		$task = $this->task(
			'lead',
			array(
				'target'    => 2,
				'assignees' => $this->people( 'member' ),
			)
		);
		$url  = "/meeting-tasks/{$task['id']}/progress";
		$me   = $this->team['member']['id'];
		$tick = array(
			'memberId' => $me,
			'delta'    => 1,
		);
		$back = array(
			'memberId' => $me,
			'delta'    => -1,
		);

		$this->api_as( 'member', 'POST', $url, $tick );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $url, $back ) );

		$response = $this->api_as( 'lead', 'POST', $url, $back );
		$this->assertStatus( 200, $response );
		$this->assertSame( 'todo', $response->get_data()['status'] );
		$this->assertCount( 0, $this->credits( $me ), 'undo removes the credit' );
	}

	public function test_progress_validation() {
		$assigned   = $this->task( 'lead', array( 'assignees' => $this->people( 'member' ) ) );
		$unassigned = $this->task( 'lead' );

		$this->assertStatus( 400, $this->api_as( 'member', 'POST', "/meeting-tasks/{$assigned['id']}/progress", array( 'delta' => 1 ) ) );
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'POST',
				"/meeting-tasks/{$assigned['id']}/progress",
				array(
					'memberId' => $this->team['member']['id'],
					'delta'    => 5,
				)
			)
		);

		// Unassigned: tick without memberId, credited to whoever ticks.
		$response = $this->api_as( 'other', 'POST', "/meeting-tasks/{$unassigned['id']}/progress", array( 'delta' => 1 ) );
		$this->assertStatus( 200, $response );
		$this->assertSame( 'done', $response->get_data()['status'] );
		$this->assertSame( 'pending', $response->get_data()['review']['state'] );
		$this->assertCount( 1, $this->credits( $this->team['other']['id'] ) );
	}

	public function test_member_cannot_create_started_task_for_someone_else() {
		$response = $this->api_as(
			'member',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Theirs',
				'status'     => 'doing',
				'assignees'  => $this->people( 'other' ),
			)
		);
		$this->assertStatus( 403, $response );

		$own = $this->task(
			'member',
			array(
				'status'    => 'doing',
				'assignees' => $this->people( 'member' ),
			)
		);
		$this->assertSame( 'doing', $own['status'] );
	}

	public function test_links_are_checked_by_syntax_not_dns() {
		$task = $this->task( 'lead', array( 'url' => 'https://client-site.invalid/plumbers?x=1' ) );
		$this->assertSame( 'https://client-site.invalid/plumbers?x=1', $task['url'] );

		$this->act_as( 'lead' );
		$base = array(
			'project_id' => $this->project['id'],
			'title'      => 'x',
		);
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'url' => 'https://' ) + $base ) );
		$this->assertStatus( 400, $this->api( 'POST', '/meeting-tasks', array( 'url' => 'https://a b.com' ) + $base ) );
	}
}
