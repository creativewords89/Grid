<?php
/**
 * REST tests for /projects.
 *
 * @package GridRankers_Portal
 */

/**
 * Projects controller.
 */
class Test_GRP_REST_Projects extends GRP_REST_TestCase {

	public function test_signed_out_gets_401() {
		$this->assertStatus( 401, $this->api( 'GET', '/projects' ) );
		$this->assertStatus( 401, $this->api( 'POST', '/projects', array( 'name' => 'X' ) ) );
	}

	public function test_admin_and_lead_add_projects_everyone_lists_them() {
		foreach ( array( 'admin', 'lead' ) as $who ) {
			$response = $this->api_as( $who, 'POST', '/projects', array( 'name' => "Project $who" ) );
			$this->assertStatus( 201, $response );
			$this->assertSame( 'active', $response->get_data()['state'] );
			$this->assertSame( 0, $response->get_data()['cycle_set'] );
		}
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/projects', array( 'name' => 'Project member' ) ) );

		$list = $this->api_as( 'member', 'GET', '/projects' );
		$this->assertStatus( 200, $list );
		$this->assertCount( 2, $list->get_data() );
	}

	public function test_new_project_can_start_paused_with_a_cycle_day() {
		$response = $this->api_as(
			'lead',
			'POST',
			'/projects',
			array(
				'name'      => 'Later Co',
				'state'     => 'paused',
				'cycle_day' => 15,
			)
		);
		$this->assertStatus( 201, $response );
		$this->assertSame( 'paused', $response->get_data()['state'] );
		$this->assertSame( 15, $response->get_data()['cycle_day'] );
		$this->assertSame( 1, $response->get_data()['cycle_set'] );
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				'/projects',
				array(
					'name'  => 'Bad',
					'state' => 'archived',
				)
			)
		);
	}

	public function test_add_project_validates_and_audits() {
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/projects', array( 'name' => '   ' ) ) );

		$project = $this->project( 'Acme', 12 );
		$this->assertSame( 12, $project['cycle_day'] );
		$this->assertSame( 1, $project['cycle_set'] );
		$this->assertSame( 'initial', $project['cycle_log'][0]['by'] );

		$this->assertStatus( 409, $this->api_as( 'lead', 'POST', '/projects', array( 'name' => 'acme' ) ) );

		$audit = $this->audit_for( $project['id'] );
		$this->assertSame( 'project', $audit[0]['kind'] );
		$this->assertSame( 'client', $audit[0]['type'] );
		$this->assertSame( 'admin', $audit[0]['by_role'] );
	}

	public function test_output_is_not_html_executable_input_is_sanitised() {
		$response = $this->api_as( 'lead', 'POST', '/projects', array( 'name' => '<script>alert(1)</script>Bobs' ) );

		$this->assertStatus( 201, $response );
		$this->assertStringNotContainsString( '<script>', $response->get_data()['name'] );
	}

	public function test_move_project_state_admin_and_lead_only() {
		$project = $this->project();

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'paused' ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'archived' ) ) );

		$response = $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'paused' ) );
		$this->assertStatus( 200, $response );
		$this->assertSame( 'paused', $response->get_data()['state'] );

		$response = $this->api_as( 'admin', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'inactive' ) );
		$this->assertSame( 'inactive', $response->get_data()['state'] );

		$this->assertContains( 'moved to inactive projects', wp_list_pluck( $this->audit_for( $project['id'] ), 'detail' ) );
	}

	public function test_rename_admin_and_lead_only() {
		$project = $this->project();
		$this->project( 'Taken' );

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/projects/{$project['id']}", array( 'name' => 'New' ) ) );
		$this->assertStatus( 409, $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}", array( 'name' => 'Taken' ) ) );

		$response = $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}", array( 'name' => 'New name' ) );
		$this->assertSame( 'New name', $response->get_data()['name'] );
	}

	public function test_delete_project_super_admin_only_moves_tasks_to_trash() {
		$project = $this->project();
		$task    = $this->api_as(
			'member',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Fix H1',
			)
		)->get_data();

		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', "/projects/{$project['id']}" ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/projects/{$project['id']}" ) );
		$deleted = $this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" );
		$this->assertStatus( 200, $deleted );
		$returned = wp_list_pluck( $deleted->get_data()['trash'], 'doc_id' );
		$this->assertCount( 8, $returned, 'the task, the six standard monthly tasks and the project, returned for the app' );
		$this->assertSame( array( $task['id'], $project['id'] ), array( $returned[0], end( $returned ) ) );

		$this->assertNull( GRP_Store::get( 'grp_projects', $project['id'] ) );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', $task['id'] ) );
		$this->assertCount( 1, GRP_Store::find( 'grp_trash', array( 'doc_id' => $task['id'] ) ) );
		$this->assertCount( 1, GRP_Store::find( 'grp_trash', array( 'doc_id' => $project['id'] ) ) );
		$this->assertStatus( 404, $this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" ) );
	}

	public function test_restoring_a_project_brings_back_the_tasks_deleted_with_it() {
		$project = $this->project();
		$add     = function ( $title ) use ( $project ) {
			return $this->api_as(
				'lead',
				'POST',
				'/meeting-tasks',
				array(
					'project_id' => $project['id'],
					'title'      => $title,
				)
			)->get_data();
		};
		$earlier = $add( 'Deleted on its own' );
		$kept    = $add( 'Fix H1' );
		$this->assertStatus( 200, $this->api_as( 'lead', 'DELETE', "/meeting-tasks/{$earlier['id']}" ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" ) );

		$entries = wp_list_pluck( GRP_Store::find( 'grp_trash', array( 'project_id' => $project['id'] ) ), 'with_project', 'doc_id' );
		$this->assertSame( 0, $entries[ $earlier['id'] ] );
		$this->assertSame( 1, $entries[ $kept['id'] ] );

		$project_entry = GRP_Store::find( 'grp_trash', array( 'doc_id' => $project['id'] ) )[0];
		$this->assertStatus( 200, $this->api_as( 'lead', 'POST', "/trash/{$project_entry['id']}/restore" ) );

		$this->assertNotNull( GRP_Store::get( 'grp_projects', $project['id'] ) );
		$this->assertNotNull( GRP_Store::get( 'grp_meeting_tasks', $kept['id'] ), 'deleted with the project: back' );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', $earlier['id'] ), 'deleted before: still in the trash' );
		$this->assertCount( 1, GRP_Store::find( 'grp_trash', array( 'doc_id' => $earlier['id'] ) ) );
	}

	public function test_deleting_a_project_forever_empties_its_trash() {
		$project = $this->project();
		$task    = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Fix H1',
			)
		)->get_data();
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" ) );

		$project_entry = GRP_Store::find( 'grp_trash', array( 'doc_id' => $project['id'] ) )[0];
		$this->assertStatus( 200, $this->api_as( 'lead', 'DELETE', "/trash/{$project_entry['id']}" ) );
		$this->assertSame( array(), GRP_Store::find( 'grp_trash', array( 'project_id' => $project['id'] ) ) );
		$this->assertNull( GRP_Store::get( 'grp_meeting_tasks', $task['id'] ) );
	}

	public function test_first_cycle_choice_locks_and_is_open_to_members() {
		$response = $this->api_as( 'lead', 'POST', '/projects', array( 'name' => 'Unset' ) );
		$id       = $response->get_data()['id'];

		$this->assertStatus( 400, $this->api_as( 'member', 'POST', "/projects/$id/cycle", array( 'day' => 0 ) ) );

		$response = $this->api_as( 'member', 'POST', "/projects/$id/cycle", array( 'day' => 15 ) );
		$this->assertStatus( 200, $response );
		$this->assertSame( 15, $response->get_data()['cycle_day'] );
		$this->assertSame( 1, $response->get_data()['cycle_set'] );

		// Locked now.
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/projects/$id/cycle", array( 'day' => 3 ) ) );
	}

	public function test_change_locked_cycle_super_admin_with_reason_and_mode() {
		$project = $this->project( 'Locked', 1 );
		$url     = "/projects/{$project['id']}/cycle";
		$body    = array(
			'day'    => 20,
			'mode'   => 'merge',
			'from'   => '2026-03-10',
			'reason' => 'Align with billing',
		);

		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', $url, $body ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $url, $body ) );

		$no_reason = $this->api_as( 'admin', 'POST', $url, array( 'reason' => '' ) + $body );
		$this->assertStatus( 400, $no_reason );
		$this->assertSame( 'grp_reason_required', $no_reason->get_data()['code'] );

		$this->assertStatus( 400, $this->api_as( 'admin', 'POST', $url, array( 'mode' => 'skip' ) + $body ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'POST', $url, array( 'day' => 1 ) + $body ) );

		$response = $this->api_as( 'admin', 'POST', $url, $body );
		$this->assertStatus( 200, $response );
		$data = $response->get_data();
		$this->assertSame( 20, $data['cycle_day'] );
		$this->assertSame(
			array(
				'day'     => 20,
				'from'    => '2026-03-10',
				'mode'    => 'merge',
				'prevDay' => 1,
				'reason'  => 'Align with billing',
			),
			array_intersect_key( $data['cycle_changes'][0], array_flip( array( 'from', 'day', 'prevDay', 'mode', 'reason' ) ) )
		);
		$this->assertCount( 2, $data['cycle_log'] );

		// The stored change drives the cycle maths.
		$this->assertSame( '2026-03-10', GRP_Cycles::cycle_at( $data, '2026-04-01', '2026-10-01' )['start'] );

		$audit = $this->audit_for( $project['id'] );
		$this->assertSame( 'cycle', end( $audit )['kind'] );
	}

	public function test_unknown_project_404() {
		$this->assertStatus( 404, $this->api_as( 'admin', 'GET', '/projects/nope' ) );
		$this->assertStatus( 404, $this->api_as( 'admin', 'PATCH', '/projects/nope/state', array( 'state' => 'paused' ) ) );
	}
}
