<?php
/**
 * Tests for task steps (SPEC.md 6.16, designs DEP-A..C): Write → Edit → Proofread on meeting tasks
 * and monthly tasks, who ticks which step, the order, completion, review and export.
 *
 * @package GridRankers_Portal
 */

/**
 * Steps over REST, permissions enforced on the server.
 */
class Test_GRP_Steps extends GRP_REST_TestCase {

	/**
	 * Project.
	 *
	 * @var array
	 */
	private $acme;

	/**
	 * Current cycle key of the project.
	 *
	 * @var string
	 */
	private $period;

	public function set_up() {
		parent::set_up();
		$this->acme   = $this->project( 'Acme', 1 );
		$this->period = GRP_Cycles::cycle_range( $this->acme, 0, GRP_Cycles::today() )['key'];
	}

	/**
	 * Write (member) → Edit (other) → Proofread (lead).
	 *
	 * @return array
	 */
	private function chain() {
		return array(
			array(
				'id'     => 'write',
				'name'   => 'Write',
				'member' => $this->team['member']['id'],
			),
			array(
				'id'     => 'edit',
				'name'   => 'Edit',
				'member' => $this->team['other']['id'],
			),
			array(
				'id'     => 'proof',
				'name'   => 'Proofread',
				'member' => $this->team['lead']['id'],
			),
		);
	}

	/**
	 * A meeting task with the chain.
	 *
	 * @param int $target Quantity.
	 * @return array
	 */
	private function item( $target = 2 ) {
		$res = $this->api_as(
			'member',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->acme['id'],
				'title'      => 'Blog posts',
				'target'     => $target,
				'steps'      => $this->chain(),
			)
		);
		$this->assertStatus( 201, $res );

		return $res->get_data();
	}

	/**
	 * Ticks a meeting task's step.
	 *
	 * @param string $who   Handle.
	 * @param array  $task  Task.
	 * @param string $step  Step id.
	 * @param int    $delta +1 / -1.
	 * @return WP_REST_Response
	 */
	private function step( $who, array $task, $step, $delta = 1 ) {
		return $this->api_as(
			$who,
			'POST',
			"/meeting-tasks/{$task['id']}/step",
			array(
				'step'  => $step,
				'delta' => $delta,
				'note'  => 'All checked',
			)
		);
	}

	public function test_steps_are_validated_and_their_people_share_the_task() {
		$task = $this->item();
		$this->assertSame( array( 'write', 'edit', 'proof' ), wp_list_pluck( $task['steps'], 'id' ) );
		$this->assertSame( 1, $task['team'] );
		$this->assertSame( array( $this->team['member']['id'], $this->team['other']['id'], $this->team['lead']['id'] ), wp_list_pluck( $task['assignees'], 'id' ) );
		$this->assertSame( array( 2, 2, 2 ), wp_list_pluck( $task['assignees'], 'n' ) );

		$base = array(
			'project_id' => $this->acme['id'],
			'title'      => 'x',
		);
		$one  = array( $this->chain()[0] );
		$five = array_merge( $this->chain(), $this->chain() );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/meeting-tasks', $base + array( 'steps' => $one ) ), 'at least 2' );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/meeting-tasks', $base + array( 'steps' => array_slice( $five, 0, 5 ) ) ), 'at most 4' );
		$nameless            = $this->chain();
		$nameless[1]['name'] = ' ';
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/meeting-tasks', $base + array( 'steps' => $nameless ) ) );
		$nobody              = $this->chain();
		$nobody[2]['member'] = 'ghost';
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/meeting-tasks', $base + array( 'steps' => $nobody ) ) );
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				'/meeting-tasks',
				$base + array(
					'steps'  => $this->chain(),
					'status' => 'doing',
				)
			),
			'starts at the first step'
		);

		// Back to one step on Edit (leaders): the people picker takes over again.
		$plain = $this->api_as(
			'lead',
			'PATCH',
			"/meeting-tasks/{$task['id']}",
			array(
				'steps'     => array(),
				'assignees' => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$this->assertNull( $plain['steps'] );
		$this->assertSame( array( $this->team['member']['id'] ), wp_list_pluck( $plain['assignees'], 'id' ) );
	}

	public function test_each_step_waits_for_the_one_before_and_belongs_to_its_person() {
		$task = $this->item();

		// Edit can't start before anything is written.
		$res = $this->step( 'other', $task, 'edit' );
		$this->assertStatus( 409, $res );
		$this->assertSame( 'grp_step_waiting', $res->get_data()['code'] );
		// Someone else's step, and counting back, are refused for Team Members.
		$this->assertStatus( 403, $this->step( 'other', $task, 'write' ) );
		$this->assertStatus( 400, $this->step( 'member', $task, 'nope' ) );

		$after = $this->step( 'member', $task, 'write' )->get_data();
		$this->assertSame( 'doing', $after['status'] );
		$this->assertSame( 1, $after['step_done']['write']['n'] );
		$this->assertSame( $this->team['member']['id'], $after['step_done']['write']['by'] );
		$this->assertStatus( 403, $this->step( 'member', $task, 'write', -1 ) );

		$this->assertStatus( 200, $this->step( 'other', $task, 'edit' ) );
		$this->assertStatus( 409, $this->step( 'other', $task, 'edit' ), 'only 1 written so far' );
		$this->assertStatus( 200, $this->step( 'member', $task, 'write' ) );
		$this->assertStatus( 409, $this->step( 'member', $task, 'write' ), 'write is finished' );

		// A leader counts back (write 2 → 1), but not below what the next step already used (edit 1).
		$this->assertStatus( 200, $this->step( 'lead', $task, 'write', -1 ) );
		$this->assertStatus( 409, $this->step( 'lead', $task, 'write', -1 ) );
		$this->assertStatus( 200, $this->step( 'member', $task, 'write' ) );

		// Each unit is credited to the step's person, whoever ticks.
		$this->assertCount( 2, $this->credits( $this->team['member']['id'] ) );
		$this->assertCount( 1, $this->credits( $this->team['other']['id'] ) );
		$this->assertSame( array(), $this->credits( $this->team['lead']['id'] ) );

		// The old ways to move it are closed.
		$this->assertSame( 'grp_has_steps', $this->api_as( 'lead', 'POST', "/meeting-tasks/{$task['id']}/status", array( 'status' => 'done' ) )->get_data()['code'] );
		$this->assertSame(
			'grp_has_steps',
			$this->api_as(
				'lead',
				'POST',
				"/meeting-tasks/{$task['id']}/progress",
				array(
					'memberId' => $this->team['member']['id'],
					'delta'    => 1,
				)
			)->get_data()['code']
		);

		// Profile lock.
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'location' => null ) );
		$this->assertSame( 'grp_profile_incomplete', $this->step( 'other', $task, 'edit', 1 )->get_data()['code'] );
	}

	public function test_the_last_step_completes_the_task_and_review_sends_it_back() {
		$task = $this->item( 1 );
		$this->step( 'member', $task, 'write' );
		$this->step( 'other', $task, 'edit' );

		$res = $this->api_as(
			'lead',
			'POST',
			"/meeting-tasks/{$task['id']}/step",
			array(
				'step'  => 'proof',
				'delta' => 1,
			)
		);
		$this->assertSame( 'grp_completion_required', $res->get_data()['code'], 'the last unit asks for the submission' );
		$done = $this->step( 'lead', $task, 'proof' )->get_data();
		$this->assertSame( 'done', $done['status'] );
		$this->assertSame( 'All checked', $done['completion']['note'] );
		$this->assertStatus( 403, $this->step( 'lead', $task, 'proof', -1 ), 'completed work changes through review' );

		// Revise: the last step gives back its unit.
		$this->api_as(
			'admin',
			'POST',
			'/review',
			array(
				'kind'   => 'item',
				'id'     => $task['id'],
				'action' => 'revision',
				'note'   => 'Fix the intro',
			)
		);
		$back = GRP_Store::get( 'grp_meeting_tasks', $task['id'] );
		$this->assertSame( 'doing', $back['status'] );
		$this->assertSame( array( 1, 1, 0 ), array( $back['step_done']['write']['n'], $back['step_done']['edit']['n'], $back['step_done']['proof']['n'] ) );
		$this->assertSame( array(), $this->credits( $this->team['lead']['id'] ) );

		// Reject clears every step and its credit.
		$this->step( 'lead', $task, 'proof' );
		$this->api_as(
			'admin',
			'POST',
			'/review',
			array(
				'kind'   => 'item',
				'id'     => $task['id'],
				'action' => 'reject',
				'note'   => 'Wrong topic',
			)
		);
		$gone = GRP_Store::get( 'grp_meeting_tasks', $task['id'] );
		$this->assertSame( 'todo', $gone['status'] );
		$this->assertSame( array(), (array) $gone['step_done'] );
		$this->assertSame( array(), $this->credits( $this->team['member']['id'] ) );
	}

	public function test_monthly_tasks_take_steps_per_cycle() {
		$res = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $this->acme['id'],
				'title'      => 'Blog posts',
				'target'     => 2,
				'steps'      => array_slice( $this->chain(), 0, 2 ),
			)
		);
		$this->assertStatus( 201, $res );
		$task = $res->get_data();
		$this->assertNull( $task['parts'] );
		$this->assertSame( array( $this->team['member']['id'], $this->team['other']['id'] ), wp_list_pluck( $task['assignees'], 'id' ) );

		// Steps and a breakdown don't mix.
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'PATCH',
				"/monthly-tasks/{$task['id']}",
				array(
					'parts' => array(
						array(
							'name' => 'Blogs',
							'n'    => 2,
						),
					),
				)
			)
		);

		$step = function ( $who, $id, $delta = 1 ) use ( $task ) {
			return $this->api_as(
				$who,
				'POST',
				'/records/step',
				array(
					'taskId'    => $task['id'],
					'periodKey' => $this->period,
					'step'      => $id,
					'delta'     => $delta,
					'note'      => 'Done both',
				)
			);
		};
		$this->assertStatus( 409, $step( 'other', 'edit' ) );
		$this->assertStatus( 403, $step( 'other', 'write' ) );
		$rec = $step( 'member', 'write' )->get_data()['record'];
		$this->assertSame( array( 'doing', 0 ), array( $rec['status'], $rec['count'] ) );
		$this->assertSame(
			'grp_has_steps',
			$this->api_as(
				'member',
				'POST',
				'/records/tick',
				array(
					'taskId'    => $task['id'],
					'periodKey' => $this->period,
					'delta'     => 1,
				)
			)->get_data()['code']
		);

		$step( 'member', 'write' );
		$step( 'other', 'edit' );
		$rec = $step( 'other', 'edit' )->get_data()['record'];
		$this->assertSame( array( 'done', 2, 'pending' ), array( $rec['status'], $rec['count'], $rec['review']['state'] ) );
		$this->assertSame( 'Done both', $rec['completion']['note'] );

		// Revise takes one unit back from the last step.
		$this->api_as(
			'lead',
			'POST',
			'/review',
			array(
				'kind'   => 'record',
				'id'     => $rec['id'],
				'action' => 'revision',
				'note'   => 'One more pass',
			)
		);
		$back = GRP_Store::get( 'grp_cycle_records', $rec['id'] );
		$this->assertSame( array( 'doing', 1, 1 ), array( $back['status'], $back['count'], $back['step_done']['edit']['n'] ) );

		// Skipping the period takes back the steps' credit.
		$this->api_as(
			'lead',
			'POST',
			'/records/status',
			array(
				'taskId'    => $task['id'],
				'periodKey' => $this->period,
				'status'    => 'skipped',
			)
		);
		$this->assertNull( GRP_Store::get( 'grp_cycle_records', $rec['id'] )['step_done'] );
		$this->assertSame( array(), $this->credits( $this->team['member']['id'] ) );
	}

	public function test_permission_rows() {
		$task = array(
			'status'    => 'doing',
			'assignees' => array( array( 'id' => $this->team['member']['id'] ) ),
		);
		$mine = array( 'member' => $this->team['member']['id'] );
		$can  = function ( $who, $step, $delta, $t = null ) use ( $task ) {
			return GRP_Permissions::can(
				$this->team[ $who ],
				GRP_Permissions::TICK_STEP,
				array(
					'task'  => $t ? $t : $task,
					'step'  => $step,
					'delta' => $delta,
				)
			);
		};
		$this->assertTrue( $can( 'member', $mine, 1 ) );
		$this->assertFalse( $can( 'member', $mine, -1 ) );
		$this->assertFalse( $can( 'member', array( 'member' => $this->team['other']['id'] ), 1 ) );
		$this->assertTrue( $can( 'lead', $mine, 1 ) );
		$this->assertTrue( $can( 'admin', $mine, -1 ) );
		$this->assertFalse( $can( 'admin', $mine, 1, array( 'status' => 'done' ) + $task ) );
	}

	public function test_steps_survive_export_and_import() {
		$task = $this->item();
		$this->step( 'member', $task, 'write' );

		$export = GRP_Export::build();
		$item   = wp_list_filter( $export['data']['items'], array( 'id' => $task['id'] ) );
		$item   = reset( $item );
		$this->assertSame( 'Proofread', $item['steps'][2]['name'] );

		GRP_Store::update(
			'grp_meeting_tasks',
			$task['id'],
			array(
				'steps'     => null,
				'step_done' => null,
			)
		);
		GRP_Import::run( $export );
		$back = GRP_Store::get( 'grp_meeting_tasks', $task['id'] );
		$this->assertSame( array( 'write', 'edit', 'proof' ), wp_list_pluck( $back['steps'], 'id' ) );
		$this->assertSame( 1, $back['step_done']['write']['n'] );
		$this->assertSame( 1, $back['team'] );
	}
}
