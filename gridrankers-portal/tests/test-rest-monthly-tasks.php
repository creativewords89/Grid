<?php
/**
 * REST tests for /monthly-tasks.
 *
 * @package GridRankers_Portal
 */

/**
 * Monthly tasks controller.
 */
class Test_GRP_REST_Monthly_Tasks extends GRP_REST_TestCase {

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
	 * Creates a monthly task.
	 *
	 * @param string $who    Member handle.
	 * @param array  $fields Fields.
	 * @return WP_REST_Response
	 */
	private function create( $who, array $fields = array() ) {
		return $this->api_as(
			$who,
			'POST',
			'/monthly-tasks',
			$fields + array(
				'project_id' => $this->project['id'],
				'title'      => 'Blogs',
			)
		);
	}

	public function test_biweekly_mode_makes_a_biweekly_task() {
		$response = $this->create( 'lead', array( 'due_mode' => 'biweekly' ) );
		$this->assertStatus( 201, $response );
		$this->assertSame( 'biweekly', $response->get_data()['freq'] );
		$this->assertSame( 'biweekly', $response->get_data()['due_mode'] );

		$back = $this->api_as( 'lead', 'PATCH', '/monthly-tasks/' . $response->get_data()['id'], array( 'due_mode' => 'monthly' ) );
		$this->assertSame( 'monthly', $back->get_data()['freq'] );
	}

	public function test_member_adds_monthly_task_with_defaults() {
		$response = $this->create( 'member' );

		$this->assertStatus( 201, $response );
		$task = $response->get_data();
		$this->assertSame( 'monthly', $task['freq'] );
		$this->assertSame( 'monthly', $task['due_mode'] );
		$this->assertSame( 1, $task['target'] );
		$this->assertNull( $task['parts'] );
		$this->assertSame( 0, $task['std'] );
	}

	public function test_due_modes() {
		$weekly = $this->create( 'lead', array( 'due_mode' => 'weekly' ) )->get_data();
		$this->assertSame( 'weekly', $weekly['freq'] );

		$date = $this->create(
			'lead',
			array(
				'due_mode' => 'date',
				'due_day'  => 10,
			)
		)->get_data();
		$this->assertSame( 10, $date['due_day'] );

		$dates = $this->create(
			'lead',
			array(
				'due_mode'     => 'dates',
				'due_from_day' => 20,
				'due_day'      => 12,
			)
		)->get_data();
		$this->assertSame( 12, $dates['due_from_day'] );
		$this->assertSame( 20, $dates['due_day'] );

		$this->assertStatus( 400, $this->create( 'lead', array( 'due_mode' => 'date' ) ) );
		$this->assertStatus( 400, $this->create( 'lead', array( 'due_mode' => 'yearly' ) ) );
	}

	public function test_responsible_people_share_whole_task() {
		$task = $this->create(
			'lead',
			array(
				'target'    => 4,
				'assignees' => array( array( 'id' => $this->team['member']['id'] ), array( 'id' => $this->team['other']['id'] ) ),
			)
		)->get_data();

		$this->assertSame( 1, $task['team'] );
		$this->assertSame( array( 4, 4 ), wp_list_pluck( $task['assignees'], 'n' ) );
	}

	public function test_breakdown_sets_quantity_and_derives_responsible() {
		$task = $this->create(
			'lead',
			array(
				'target' => 50,
				'parts'  => array(
					array(
						'name'   => 'Service Pages',
						'n'      => 3,
						'people' => array( array( 'id' => $this->team['member']['id'] ) ),
					),
					array(
						'name'   => 'Location Pages',
						'n'      => 4,
						'people' => array(
							array(
								'id' => $this->team['member']['id'],
								'n'  => 1,
							),
							array(
								'id' => $this->team['other']['id'],
								'n'  => 3,
							),
						),
					),
					array( 'name' => '  ' ),
				),
			)
		)->get_data();

		$this->assertSame( 7, $task['target'], 'quantity = sum of rows' );
		$this->assertCount( 2, $task['parts'] );
		$this->assertSame( 0, $task['team'] );
		$this->assertSame(
			array(
				array(
					'id' => $this->team['member']['id'],
					'n'  => 4,
				),
				array(
					'id' => $this->team['other']['id'],
					'n'  => 3,
				),
			),
			$task['assignees']
		);
		$this->assertSame( 3, $task['parts'][0]['people'][0]['n'] );
		$this->assertNotEmpty( $task['parts'][0]['id'] );
	}

	public function test_breakdown_without_people_keeps_team() {
		$task = $this->create(
			'lead',
			array(
				'parts'     => array(
					array(
						'name' => 'Citations',
						'n'    => 5,
					),
				),
				'assignees' => array( array( 'id' => $this->team['other']['id'] ) ),
			)
		)->get_data();

		$this->assertSame( 5, $task['target'] );
		$this->assertSame( 1, $task['team'] );
		$this->assertSame( 5, $task['assignees'][0]['n'] );
	}

	public function test_edit_and_delete_managers_only() {
		$task = $this->create( 'member' )->get_data();

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/monthly-tasks/{$task['id']}", array( 'title' => 'Mine' ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/monthly-tasks/{$task['id']}" ) );

		$updated = $this->api_as(
			'lead',
			'PATCH',
			"/monthly-tasks/{$task['id']}",
			array(
				'title'  => 'Blog posts',
				'target' => 2,
			)
		);
		$this->assertStatus( 200, $updated );
		$this->assertSame( 'Blog posts', $updated->get_data()['title'] );
		$this->assertSame( 2, $updated->get_data()['target'] );
		$this->assertSame( 'monthly', $updated->get_data()['due_mode'], 'unsent fields kept' );

		$edit = wp_list_filter( $this->audit_for( $task['id'] ), array( 'kind' => 'edit' ) );
		$this->assertSame( array( 'title', 'target' ), wp_list_pluck( reset( $edit )['changes'], 'field' ) );

		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/monthly-tasks/{$task['id']}" ) );
		$this->assertCount( 1, GRP_Store::find( 'grp_trash', array( 'doc_id' => $task['id'] ) ) );
	}
}
