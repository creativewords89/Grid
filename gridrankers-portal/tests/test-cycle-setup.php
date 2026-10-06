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

	/**
	 * A meeting task of the project, given to Max.
	 *
	 * @param array  $project Project.
	 * @param string $status  todo|doing|done.
	 * @return array
	 */
	private function meeting_task( array $project, $status = 'done' ) {
		return GRP_Store::insert(
			'grp_meeting_tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Fix H1',
				'status'     => $status,
				'priority'   => 'normal',
				'target'     => 1,
				'assignees'  => array(
					array(
						'id' => $this->team['member']['id'],
						'n'  => 1,
					),
				),
				'deadline'   => array(
					'type' => 'date',
					'date' => GRP_Cycles::cycle_range( $project, -1, GRP_Cycles::today() )['end'],
				),
				'created_by' => $this->team['lead']['id'],
			)
		);
	}

	public function test_meeting_tasks_are_reviewed_too_and_feedback_reaches_their_people() {
		list( $project ) = $this->project_with_task();
		$task            = $this->meeting_task( $project );
		$path            = "/projects/{$project['id']}/cycle-review";
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', $path, array( 'task_id' => $task['id'], 'ok' => true ) ) ); // phpcs:ignore WordPress.Arrays.ArrayDeclarationSpacing.AssociativeArrayFound
		$this->assertStatus(
			200,
			$this->api_as(
				'lead',
				'POST',
				$path,
				array(
					'task_id' => $task['id'],
					'ok'      => false,
					'note'    => 'Keep the city in the heading.',
				)
			)
		);
		$key    = GRP_Cycles::cycle_range( $project, -1, GRP_Cycles::today() )['key'];
		$stored = GRP_Store::get( 'grp_projects', $project['id'] )['cycle_reviews'];
		$this->assertFalse( $stored[ $key ][ $task['id'] ]['ok'] );
		$posts = GRP_Store::find( 'grp_posts' );
		$this->assertSame( array( $this->team['member']['id'] ), $posts[0]['to_members'] );
		$this->assertSame( 'Feedback: Fix H1', $posts[0]['title'] );
	}

	public function test_an_open_meeting_task_can_be_carried_over() {
		list( $project, $monthly ) = $this->project_with_task();
		$open                      = $this->meeting_task( $project, 'doing' );
		$done                      = $this->meeting_task( $project, 'done' );
		$path                      = "/projects/{$project['id']}/cycle-review";
		$today                     = GRP_Cycles::today();
		$later                     = gmdate( 'Y-m-d', strtotime( $today . ' +5 days' ) );
		$past                      = gmdate( 'Y-m-d', strtotime( $today . ' -1 day' ) );

		foreach ( array( array( $done['id'], $later ), array( $monthly['id'], $later ), array( $open['id'], $past ), array( $open['id'], 'soon' ) ) as $case ) {
			$this->assertStatus(
				400,
				$this->api_as(
					'lead',
					'POST',
					$path,
					array(
						'task_id' => $case[0],
						'carry'   => $case[1],
					)
				),
				'Refused: ' . implode( ' ', $case )
			);
		}
		$this->assertStatus(
			200,
			$this->api_as(
				'lead',
				'POST',
				$path,
				array(
					'task_id' => $open['id'],
					'carry'   => $later,
				)
			)
		);
		$this->assertEquals(
			array(
				'type' => 'date',
				'date' => $later,
			),
			GRP_Store::get( 'grp_meeting_tasks', $open['id'] )['deadline']
		);
		$key    = GRP_Cycles::cycle_range( $project, -1, $today )['key'];
		$review = GRP_Store::get( 'grp_projects', $project['id'] )['cycle_reviews'][ $key ][ $open['id'] ];
		$this->assertTrue( $review['ok'] );
		$this->assertSame( $later, $review['carry'] );
		$this->assertCount( 0, GRP_Store::find( 'grp_posts' ) );
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
