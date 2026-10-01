<?php
/**
 * REST tests for /records and /review.
 *
 * @package GridRankers_Portal
 */

/**
 * Recurring progress, completion and the review flow.
 */
class Test_GRP_REST_Records_Review extends GRP_REST_TestCase {

	/**
	 * Project used by the tests.
	 *
	 * @var array
	 */
	private $project;

	/**
	 * Current cycle key of the project.
	 *
	 * @var string
	 */
	private $period;

	public function set_up() {
		parent::set_up();
		$this->project = $this->project( 'Acme', 1 );
		$this->period  = GRP_Cycles::cycle_range( $this->project, 0, GRP_Cycles::today() )['key'];
	}

	/**
	 * Creates a monthly task as the lead.
	 *
	 * @param array $fields Fields.
	 * @return array
	 */
	private function monthly( array $fields = array() ) {
		$response = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			$fields + array(
				'project_id' => $this->project['id'],
				'title'      => 'GBP Posts',
			)
		);
		$this->assertStatus( 201, $response );

		return $response->get_data();
	}

	/**
	 * Ticks a record.
	 *
	 * @param string $who    Member handle.
	 * @param array  $task   Task.
	 * @param int    $delta  +1 / -1.
	 * @param array  $extra  Extra params.
	 * @return WP_REST_Response
	 */
	private function tick( $who, array $task, $delta = 1, array $extra = array() ) {
		return $this->api_as(
			$who,
			'POST',
			'/records/tick',
			$extra + array(
				'taskId'    => $task['id'],
				'periodKey' => $this->period,
				'delta'     => $delta,
			)
		);
	}

	public function test_period_key_validation() {
		$task   = $this->monthly();
		$weekly = $this->monthly( array( 'due_mode' => 'weekly' ) );

		$this->assertStatus( 400, $this->tick( 'member', $task, 1, array( 'periodKey' => '2099-01' ) ) );
		$this->assertStatus( 400, $this->tick( 'member', $task, 1, array( 'periodKey' => 'nope' ) ) );
		$this->assertStatus( 400, $this->tick( 'member', $weekly, 1, array( 'periodKey' => $this->period ) ) );
		$this->assertStatus( 200, $this->tick( 'member', $weekly, 1, array( 'periodKey' => substr( GRP_Cycles::today(), 0, 7 ) . '-w1' ) ) );
		$this->assertStatus( 404, $this->tick( 'member', array( 'id' => 'ghost' ) ) );
	}

	public function test_member_ticks_unassigned_task_to_done_pending_review() {
		$task = $this->monthly( array( 'target' => 2 ) );

		$first = $this->tick( 'member', $task );
		$this->assertStatus( 200, $first );
		$rec = $first->get_data()['record'];
		$this->assertSame( $task['id'] . '__' . $this->period, $rec['id'] );
		$this->assertSame( 1, $rec['count'] );
		$this->assertSame( 'doing', $rec['status'] );

		$done = $this->tick( 'member', $task )->get_data()['record'];
		$this->assertSame( 'done', $done['status'] );
		$this->assertSame( 'pending', $done['review']['state'] );
		$this->assertNotEmpty( $done['done_at'] );

		$credits = $this->credits( $this->team['member']['id'] );
		$this->assertSame( 2, array_sum( wp_list_pluck( $credits, 'qty' ) ) );
		$this->assertSame( array( 'monthly' ), array_unique( wp_list_pluck( $credits, 'source' ) ) );

		// Completed → locked for ticks.
		$this->assertStatus( 403, $this->tick( 'member', $task, -1 ) );
		$this->assertStatus( 403, $this->tick( 'lead', $task, -1 ) );
	}

	public function test_member_cannot_tick_someone_elses_task() {
		$task = $this->monthly(
			array(
				'target'    => 2,
				'assignees' => array( array( 'id' => $this->team['other']['id'] ) ),
			)
		);

		$this->assertStatus( 403, $this->tick( 'member', $task ) );
		$this->assertStatus( 200, $this->tick( 'other', $task ) );
		$this->assertStatus( 200, $this->tick( 'lead', $task, 1, array( 'periodKey' => $this->period ) ) );
	}

	public function test_count_down_to_zero_is_for_managers() {
		$task = $this->monthly( array( 'target' => 3 ) );
		$this->tick( 'member', $task );

		$this->assertStatus( 403, $this->tick( 'member', $task, -1 ) );
		$response = $this->tick( 'lead', $task, -1 );
		$this->assertStatus( 200, $response );
		$this->assertSame( 0, $response->get_data()['record']['count'] );
		$this->assertCount( 0, $this->credits( $this->team['member']['id'] ) );
	}

	public function test_shared_task_shares() {
		$task = $this->monthly(
			array(
				'target'    => 3,
				'team'      => false,
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
		$this->assertSame( 0, $task['team'] );
		$me = $this->team['member']['id'];

		$this->assertStatus( 403, $this->tick( 'member', $task, 1, array( 'memberId' => $this->team['other']['id'] ) ) );

		$rec = $this->tick( 'member', $task, 1, array( 'memberId' => $me ) )->get_data()['record'];
		$this->assertSame( array( $me => 1 ), $rec['by_person'] );
		$this->assertSame( 1, $rec['count'] );

		$this->tick( 'member', $task, 1, array( 'memberId' => $me ) );
		$capped = $this->tick( 'member', $task, 1, array( 'memberId' => $me ) )->get_data()['record'];
		$this->assertSame( 2, $capped['by_person'][ $me ], 'share caps at 2' );
	}

	public function test_breakdown_rows() {
		$task  = $this->monthly(
			array(
				'parts' => array(
					array(
						'name'   => 'Service Pages',
						'n'      => 1,
						'people' => array( array( 'id' => $this->team['member']['id'] ) ),
					),
					array(
						'name' => 'Location Pages',
						'n'    => 2,
					),
				),
			)
		);
		$parts = wp_list_pluck( $task['parts'], 'id' );

		// The single-person row is theirs alone.
		$this->assertStatus( 403, $this->tick( 'other', $task, 1, array( 'partId' => $parts[0] ) ) );

		$rec = $this->tick( 'member', $task, 1, array( 'partId' => $parts[0] ) )->get_data()['record'];
		$this->assertSame( 1, $rec['parts'][ $parts[0] ] );
		$this->assertSame( 1, $rec['count'] );

		// Row caps at its quantity.
		$same = $this->tick( 'member', $task, 1, array( 'partId' => $parts[0] ) )->get_data()['record'];
		$this->assertSame( 1, $same['parts'][ $parts[0] ] );

		$this->tick( 'lead', $task, 1, array( 'partId' => $parts[1] ) );
		$done = $this->tick( 'lead', $task, 1, array( 'partId' => $parts[1] ) )->get_data()['record'];
		$this->assertSame( 3, $done['count'] );
		$this->assertSame( 'done', $done['status'] );

		$this->assertStatus( 400, $this->tick( 'lead', $task, 1, array( 'partId' => 'nope' ) ) );
	}

	public function test_status_moves_and_completion_note() {
		$task = $this->monthly( array( 'target' => 2 ) );
		$url  = '/records/status';
		$body = array(
			'taskId'    => $task['id'],
			'periodKey' => $this->period,
		);

		$doing = $this->api_as( 'member', 'POST', $url, $body + array( 'status' => 'doing' ) );
		$this->assertStatus( 200, $doing );
		$this->assertSame( 'doing', $doing->get_data()['record']['status'] );
		$this->assertSame( 0, $doing->get_data()['record']['count'] );

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $url, $body + array( 'status' => 'todo' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', $url, $body + array( 'status' => 'done' ) ) );

		$done = $this->api_as(
			'member',
			'POST',
			$url,
			$body + array(
				'status' => 'done',
				'note'   => 'Posted both',
			)
		)->get_data()['record'];
		$this->assertSame( 2, $done['count'] );
		$this->assertSame( 'Posted both', $done['completion']['note'] );
		$this->assertSame( 'pending', $done['review']['state'] );

		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', $url, $body + array( 'status' => 'todo' ) ) );
	}

	public function test_lead_resets_period_and_skip_is_managers_only() {
		$task = $this->monthly();
		$body = array(
			'taskId'    => $task['id'],
			'periodKey' => $this->period,
		);

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/records/status', $body + array( 'status' => 'skipped' ) ) );

		$skipped = $this->api_as( 'lead', 'POST', '/records/status', $body + array( 'status' => 'skipped' ) );
		$this->assertSame( 'skipped', $skipped->get_data()['record']['status'] );

		$this->api_as( 'lead', 'POST', '/records/status', $body + array( 'status' => 'doing' ) );
		$reset = $this->api_as( 'lead', 'POST', '/records/status', $body + array( 'status' => 'todo' ) );
		$this->assertStatus( 200, $reset );
		$this->assertNull( $reset->get_data()['record'] );
		$this->assertNull( GRP_Store::get( 'grp_cycle_records', $task['id'] . '__' . $this->period ) );
	}

	public function test_review_permissions_and_validation() {
		$task = $this->monthly();
		$rec  = $this->tick( 'member', $task )->get_data()['record'];
		$body = array(
			'kind' => 'record',
			'id'   => $rec['id'],
		);

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/review', $body + array( 'action' => 'accept' ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/review', $body + array( 'action' => 'approve' ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/review', $body + array( 'action' => 'reject' ) ) );
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				'/review',
				array(
					'kind'   => 'thing',
					'id'     => 'x',
					'action' => 'accept',
				)
			)
		);
		$this->assertStatus(
			404,
			$this->api_as(
				'lead',
				'POST',
				'/review',
				array(
					'kind'   => 'item',
					'id'     => 'x',
					'action' => 'accept',
				)
			)
		);

		$accepted = $this->api_as( 'lead', 'POST', '/review', $body + array( 'action' => 'accept' ) );
		$this->assertStatus( 200, $accepted );
		$this->assertSame( 'accepted', $accepted->get_data()['review']['state'] );

		// Already accepted: accept again conflicts; reopening is allowed.
		$this->assertStatus( 409, $this->api_as( 'lead', 'POST', '/review', $body + array( 'action' => 'accept' ) ) );
	}

	public function test_record_revise_then_reject() {
		$task = $this->monthly( array( 'target' => 2 ) );
		$this->tick( 'member', $task );
		$rec  = $this->tick( 'member', $task )->get_data()['record'];
		$body = array(
			'kind' => 'record',
			'id'   => $rec['id'],
		);
		$me   = $this->team['member']['id'];

		$revised = $this->api_as(
			'lead',
			'POST',
			'/review',
			$body + array(
				'action' => 'revision',
				'note'   => 'Add photos',
			)
		)->get_data();
		$this->assertSame( 'revision', $revised['review']['state'] );
		$this->assertSame( 'Add photos', $revised['review']['note'] );
		$this->assertSame( 1, $revised['count'] );
		$this->assertSame( 'doing', $revised['status'] );
		$this->assertSame( 1, array_sum( wp_list_pluck( $this->credits( $me ), 'qty' ) ), 'one unit of credit removed' );

		// Member re-completes → pending again → admin rejects.
		$again = $this->tick( 'member', $task )->get_data()['record'];
		$this->assertSame( 'pending', $again['review']['state'] );

		$rejected = $this->api_as(
			'admin',
			'POST',
			'/review',
			$body + array(
				'action' => 'reject',
				'note'   => 'Wrong client',
			)
		)->get_data();
		$this->assertSame( 'rejected', $rejected['review']['state'] );
		$this->assertSame( 0, $rejected['count'] );
		$this->assertSame( 'todo', $rejected['status'] );
		$this->assertCount( 0, $this->credits( $me ), 'all credit removed' );

		$audit = GRP_Store::find( 'grp_audit', array( 'kind' => 'review' ) );
		$this->assertCount( 2, $audit );
	}

	public function test_meeting_task_review_flow() {
		$task = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Fix H1',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$me   = $this->team['member']['id'];
		$done = array(
			'status' => 'done',
			'note'   => 'Fixed it',
		);
		$body = array(
			'kind' => 'item',
			'id'   => $task['id'],
		);

		$this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", $done );
		$this->assertCount( 1, $this->credits( $me ) );

		$revised = $this->api_as(
			'lead',
			'POST',
			'/review',
			$body + array(
				'action' => 'revision',
				'note'   => 'Also the H2',
			)
		)->get_data();
		$this->assertSame( 'doing', $revised['status'] );
		$this->assertNull( $revised['done_at'] );
		$this->assertSame( 'revision', $revised['review']['state'] );
		$this->assertCount( 0, $this->credits( $me ) );

		$this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/status", $done );
		$accepted = $this->api_as( 'admin', 'POST', '/review', $body + array( 'action' => 'accept' ) )->get_data();
		$this->assertSame( 'done', $accepted['status'] );
		$this->assertSame( 'accepted', $accepted['review']['state'] );
		$this->assertCount( 1, $this->credits( $me ) );

		// Reviewers can reopen accepted work.
		$rejected = $this->api_as(
			'admin',
			'POST',
			'/review',
			$body + array(
				'action' => 'reject',
				'note'   => 'Client changed their mind',
			)
		)->get_data();
		$this->assertSame( 'todo', $rejected['status'] );
		$this->assertCount( 0, $this->credits( $me ) );
		$this->assertStatus(
			409,
			$this->api_as(
				'admin',
				'POST',
				'/review',
				$body + array(
					'action' => 'reject',
					'note'   => 'again',
				)
			)
		);
	}

	public function test_quantity_item_revision_removes_submitters_unit() {
		$task = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Citations',
				'target'     => 2,
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$me   = $this->team['member']['id'];
		$tick = array(
			'memberId' => $me,
			'delta'    => 1,
		);

		$this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/progress", $tick );
		$this->api_as( 'member', 'POST', "/meeting-tasks/{$task['id']}/progress", $tick );

		$revised = $this->api_as(
			'lead',
			'POST',
			'/review',
			array(
				'kind'   => 'item',
				'id'     => $task['id'],
				'action' => 'revision',
				'note'   => 'One is a duplicate',
			)
		)->get_data();

		$this->assertSame( 1, $revised['progress'][ $me ] );
		$this->assertSame( 'doing', $revised['status'] );
		$this->assertCount( 1, $this->credits( $me ) );
	}
}
