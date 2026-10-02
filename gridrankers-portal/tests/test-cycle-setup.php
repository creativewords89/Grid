<?php
/**
 * Tests for the new cycle setup (SPEC.md 6.11): reviewing last cycle's monthly tasks.
 *
 * @package GridRankers_Portal
 */

/**
 * POST /projects/{id}/cycle-review, schema 7.
 */
class Test_GRP_Cycle_Setup extends GRP_REST_TestCase {

	/**
	 * A project and one of its standard monthly tasks, given to Max.
	 *
	 * @return array{0: array, 1: array}
	 */
	private function project_with_task() {
		$project = $this->project( 'Acme', 1 );
		$task    = GRP_Store::find( 'grp_monthly_tasks', array( 'project_id' => $project['id'] ) )[0];
		$task    = GRP_Store::update(
			'grp_monthly_tasks',
			$task['id'],
			array(
				'assignees' => array(
					array(
						'id' => $this->team['member']['id'],
						'n'  => 1,
					),
				),
			)
		);
		return array( $project, $task );
	}

	public function test_only_managers_review_a_cycle() {
		list( $project, $task ) = $this->project_with_task();
		$path                   = "/projects/{$project['id']}/cycle-review";
		$body                   = array(
			'task_id' => $task['id'],
			'ok'      => true,
		);

		$this->assertTrue( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::REVIEW_CYCLE ) );
		$this->assertTrue( GRP_Permissions::can( $this->team['admin'], GRP_Permissions::REVIEW_CYCLE ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['member'], GRP_Permissions::REVIEW_CYCLE ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $path, $body ) );
		$this->assertStatus( 200, $this->api_as( 'lead', 'POST', $path, $body ) );
	}

	public function test_looks_good_is_stored_under_last_cycle() {
		list( $project, $task ) = $this->project_with_task();
		$response               = $this->api_as(
			'lead',
			'POST',
			"/projects/{$project['id']}/cycle-review",
			array(
				'task_id' => $task['id'],
				'ok'      => true,
			)
		);
		$this->assertStatus( 200, $response );

		$key    = GRP_Cycles::cycle_range( $project, -1, GRP_Cycles::today() )['key'];
		$stored = GRP_Store::get( 'grp_projects', $project['id'] )['cycle_reviews'];
		$this->assertTrue( $stored[ $key ][ $task['id'] ]['ok'] );
		$this->assertSame( $this->team['lead']['id'], $stored[ $key ][ $task['id'] ]['by'] );
		$this->assertCount( 0, GRP_Store::find( 'grp_posts' ), 'No notice for "Looks good".' );
	}

	public function test_feedback_needs_a_note_and_reaches_only_the_people_responsible() {
		list( $project, $task ) = $this->project_with_task();
		$path                   = "/projects/{$project['id']}/cycle-review";

		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				$path,
				array(
					'task_id' => $task['id'],
					'ok'      => false,
				)
			)
		);
		$this->assertStatus(
			200,
			$this->api_as(
				'lead',
				'POST',
				$path,
				array(
					'task_id' => $task['id'],
					'ok'      => false,
					'note'    => 'Only 1 of 4 went out. Plan the rest early this cycle.',
				)
			)
		);

		$posts = GRP_Store::find( 'grp_posts' );
		$this->assertCount( 1, $posts );
		$this->assertSame( 'notice', $posts[0]['kind'] );
		$this->assertSame( array( $this->team['member']['id'] ), $posts[0]['to_members'] );
		$this->assertSame( 'Feedback: ' . $task['title'], $posts[0]['title'] );

		// Private: Max gets it, Olu does not.
		$titles = static function ( $response ) {
			return wp_list_pluck( $response->get_data(), 'title' );
		};
		$this->assertContains( 'Feedback: ' . $task['title'], $titles( $this->api_as( 'member', 'GET', '/posts' ) ) );
		$this->assertNotContains( 'Feedback: ' . $task['title'], $titles( $this->api_as( 'other', 'GET', '/posts' ) ) );
	}

	public function test_a_task_from_another_project_is_refused() {
		list( $project, $task ) = $this->project_with_task();
		$other                  = $this->project( 'Bright', 1 );
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				"/projects/{$other['id']}/cycle-review",
				array(
					'task_id' => $task['id'],
					'ok'      => true,
				)
			)
		);
		$this->assertStatus(
			404,
			$this->api_as(
				'lead',
				'POST',
				'/projects/nope/cycle-review',
				array(
					'task_id' => $task['id'],
					'ok'      => true,
				)
			)
		);
	}

	public function test_install_starts_the_rule_today() {
		GRP_Install::start_cycle_setup();
		GRP_Install::start_cycle_setup();
		$rows = GRP_Store::find( 'grp_settings', array( 'setting_key' => GRP_Cycle_Setup::SINCE_KEY ) );
		$this->assertCount( 1, $rows );
		$this->assertSame( array( 'date' => GRP_Cycles::today() ), $rows[0]['value'] );
	}
}
