<?php
/**
 * Tests for hand-ins on task steps (SPEC.md 6.16, design SH-2B): each step's checklist of what to
 * hand in, files and links handed in, and a step that can't be Completed without its required items.
 *
 * @package GridRankers_Portal
 */

/**
 * Hand-ins over REST, permissions enforced on the server.
 */
class Test_GRP_Step_Handins extends GRP_REST_TestCase {

	/**
	 * Project.
	 *
	 * @var array
	 */
	private $acme;

	public function set_up() {
		parent::set_up();
		$this->acme = $this->project( 'Acme', 1 );
	}

	/**
	 * Write (member, with a checklist) → Edit (other).
	 *
	 * @return array
	 */
	private function chain() {
		return array(
			array(
				'id'     => 'write',
				'name'   => 'Write',
				'member' => $this->team['member']['id'],
				'handin' => array(
					array(
						'id'       => 'draft',
						'label'    => 'Article draft',
						'kind'     => 'file',
						'required' => true,
					),
					array(
						'id'       => 'doc',
						'label'    => 'Google Doc link',
						'kind'     => 'link',
						'required' => true,
					),
					array(
						'id'    => 'cover',
						'label' => 'Cover image ideas',
						'kind'  => 'image',
					),
				),
			),
			array(
				'id'     => 'edit',
				'name'   => 'Edit',
				'member' => $this->team['other']['id'],
			),
		);
	}

	/**
	 * A meeting task with the chain.
	 *
	 * @return array
	 */
	private function item() {
		$res = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->acme['id'],
				'title'      => 'BMW content',
				'steps'      => $this->chain(),
			)
		);
		$this->assertStatus( 201, $res );

		return $res->get_data();
	}

	/**
	 * A stored file.
	 *
	 * @param string $name File name.
	 * @param string $mime Type.
	 * @return array
	 */
	private function file( $name = 'draft.docx', $mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ) {
		return GRP_Store::insert(
			'grp_files',
			array(
				'name'       => $name,
				'mime'       => $mime,
				'size'       => 2048,
				'path'       => 'x/' . $name,
				'created_by' => $this->team['member']['id'],
			)
		);
	}

	/**
	 * POST a step request on a meeting task.
	 *
	 * @param string $who  Handle.
	 * @param array  $task Task.
	 * @param array  $body Body.
	 * @return WP_REST_Response
	 */
	private function step( $who, array $task, array $body ) {
		return $this->api_as( $who, 'POST', "/meeting-tasks/{$task['id']}/step", $body );
	}

	public function test_the_checklist_is_saved_with_the_step_and_validated() {
		$task = $this->item();
		// Stored JSON sorts keys, so compare without order.
		$this->assertEquals(
			array(
				array(
					'id'       => 'draft',
					'label'    => 'Article draft',
					'kind'     => 'file',
					'required' => true,
				),
				array(
					'id'       => 'doc',
					'label'    => 'Google Doc link',
					'kind'     => 'link',
					'required' => true,
				),
				array(
					'id'       => 'cover',
					'label'    => 'Cover image ideas',
					'kind'     => 'image',
					'required' => false,
				),
			),
			$task['steps'][0]['handin']
		);
		$this->assertArrayNotHasKey( 'handin', $task['steps'][1] );

		$bad = function ( array $items ) {
			$steps              = $this->chain();
			$steps[0]['handin'] = $items;
			return $this->api_as(
				'lead',
				'POST',
				'/meeting-tasks',
				array(
					'project_id' => $this->acme['id'],
					'title'      => 'x',
					'steps'      => $steps,
				)
			);
		};
		$this->assertStatus( 400, $bad( array( array( 'label' => '' ) ) ) );
		$this->assertStatus(
			400,
			$bad(
				array(
					array(
						'label' => 'Video',
						'kind'  => 'video',
					),
				)
			)
		);
		$this->assertStatus( 400, $bad( array_fill( 0, 11, array( 'label' => 'File' ) ) ) );
		$this->assertStatus( 201, $bad( array_fill( 0, 10, array( 'label' => 'File' ) ) ) );
	}

	public function test_a_step_is_completed_only_with_its_required_items() {
		$task  = $this->item();
		$draft = $this->file();

		$res = $this->step(
			'member',
			$task,
			array(
				'step'   => 'write',
				'status' => 'done',
			)
		);
		$this->assertStatus( 409, $res );
		$this->assertSame( 'grp_handin_needed', $res->get_data()['code'] );
		$this->assertSame( array( 'draft', 'doc' ), $res->get_data()['data']['missing'] );

		// One required item in: still refused, nothing saved.
		$res = $this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'status'  => 'done',
				'handins' => array( 'draft' => array( 'files' => array( $draft['id'] ) ) ),
			)
		);
		$this->assertStatus( 409, $res );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', $task['id'] )['handins'] );

		$res = $this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'status'  => 'done',
				'handins' => array(
					'draft' => array( 'files' => array( $draft['id'] ) ),
					'doc'   => array( 'links' => array( array( 'url' => 'https://docs.google.com/document/d/1' ) ) ),
				),
			)
		);
		$this->assertStatus( 200, $res );
		$row = $res->get_data();
		$this->assertSame( 'done', GRP_Steps::state( $row['step_done'], 'write', 1 ) );
		$this->assertSame( 'draft.docx', $row['handins']['write']['draft']['files'][0]['name'] );
		$this->assertSame( array( 'https://docs.google.com/document/d/1', 'docs.google.com' ), array( $row['handins']['write']['doc']['links'][0]['url'], $row['handins']['write']['doc']['links'][0]['name'] ) );
		$this->assertSame( $this->team['member']['id'], $row['handins']['write']['doc']['by'] );
		$this->assertArrayNotHasKey( 'cover', $row['handins']['write'] );

		// A completed step can't lose a required item.
		$res = $this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'handins' => array( 'doc' => array( 'links' => array() ) ),
			)
		);
		$this->assertStatus( 409, $res );
	}

	public function test_handing_in_alone_keeps_the_step_where_it_is() {
		$task  = $this->item();
		$image = $this->file( 'hero.png', 'image/png' );
		$res   = $this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'handins' => array( 'cover' => array( 'files' => array( $image['id'] ) ) ),
			)
		);
		$this->assertStatus( 200, $res );
		$row = $res->get_data();
		$this->assertSame( 'todo', GRP_Steps::state( $row['step_done'], 'write', 1 ) );
		$this->assertSame( 'hero.png', $row['handins']['write']['cover']['files'][0]['name'] );

		// Sent empty clears it.
		$row = $this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'handins' => array( 'cover' => array() ),
			)
		)->get_data();
		$this->assertNull( $row['handins'] );
	}

	public function test_hand_ins_are_checked() {
		$task  = $this->item();
		$draft = $this->file();
		$send  = function ( $who, array $handins, $step = 'write' ) use ( $task ) {
			return $this->step(
				$who,
				$task,
				array(
					'step'    => $step,
					'handins' => $handins,
				)
			);
		};
		// An image item takes images only.
		$this->assertStatus( 400, $send( 'member', array( 'cover' => array( 'files' => array( $draft['id'] ) ) ) ) );
		// Not on the checklist.
		$this->assertStatus( 400, $send( 'member', array( 'video' => array( 'files' => array( $draft['id'] ) ) ) ) );
		// A missing file, a link that isn't http(s).
		$this->assertStatus( 400, $send( 'member', array( 'draft' => array( 'files' => array( 'nope' ) ) ) ) );
		$this->assertStatus( 400, $send( 'member', array( 'doc' => array( 'links' => array( array( 'url' => 'javascript:alert(1)' ) ) ) ) ) );
		// Someone else's step: refused; a Team Leader may hand in for them.
		$this->assertStatus( 403, $send( 'other', array( 'draft' => array( 'files' => array( $draft['id'] ) ) ) ) );
		$this->assertStatus( 200, $send( 'lead', array( 'draft' => array( 'files' => array( $draft['id'] ) ) ) ) );
	}

	public function test_permission_rows() {
		$task = array(
			'status'    => 'doing',
			'assignees' => array( array( 'id' => $this->team['member']['id'] ) ),
		);
		$mine = array( 'member' => $this->team['member']['id'] );
		$can  = function ( $who, $step, $t = null ) use ( $task ) {
			return GRP_Permissions::can(
				$this->team[ $who ],
				GRP_Permissions::HAND_IN_STEP,
				array(
					'task' => $t ? $t : $task,
					'step' => $step,
				)
			);
		};
		$this->assertTrue( $can( 'member', $mine ) );
		$this->assertFalse( $can( 'member', array( 'member' => $this->team['other']['id'] ) ) );
		$this->assertTrue( $can( 'lead', $mine ) );
		$this->assertTrue( $can( 'admin', $mine ) );
		$this->assertFalse( $can( 'admin', $mine, array( 'status' => 'done' ) + $task ) );
	}

	public function test_monthly_steps_hand_in_per_period() {
		$res = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $this->acme['id'],
				'title'      => 'Monthly blog',
				'steps'      => $this->chain(),
			)
		);
		$this->assertStatus( 201, $res );
		$task   = $res->get_data();
		$period = GRP_Cycles::cycle_range( $this->acme, 0, GRP_Cycles::today() )['key'];
		$draft  = $this->file();
		$send   = function ( array $body ) use ( $task, $period ) {
			return $this->api_as(
				'member',
				'POST',
				'/records/step',
				array(
					'taskId'    => $task['id'],
					'periodKey' => $period,
					'step'      => 'write',
				) + $body
			);
		};
		$this->assertSame( 'grp_handin_needed', $send( array( 'status' => 'done' ) )->get_data()['code'] );
		$rec = $send(
			array(
				'status'  => 'done',
				'handins' => array(
					'draft' => array( 'files' => array( $draft['id'] ) ),
					'doc'   => array( 'links' => array( 'https://figma.com/file/abc' ) ),
				),
			)
		)->get_data()['record'];
		$this->assertSame( 'figma.com', $rec['handins']['write']['doc']['links'][0]['name'] );
		$this->assertSame( 'done', GRP_Steps::state( $rec['step_done'], 'write', 1 ) );
	}

	public function test_hand_ins_survive_export_and_import() {
		$task  = $this->item();
		$draft = $this->file();
		$this->step(
			'member',
			$task,
			array(
				'step'    => 'write',
				'handins' => array( 'draft' => array( 'files' => array( $draft['id'] ) ) ),
			)
		);
		$export = GRP_Export::build();
		GRP_Store::update(
			'grp_meeting_tasks',
			$task['id'],
			array(
				'steps'   => null,
				'handins' => null,
			)
		);
		GRP_Import::run( $export );
		$back = GRP_Store::get( 'grp_meeting_tasks', $task['id'] );
		$this->assertSame( 'Article draft', $back['steps'][0]['handin'][0]['label'] );
		$this->assertSame( 'draft.docx', $back['handins']['write']['draft']['files'][0]['name'] );
	}
}
