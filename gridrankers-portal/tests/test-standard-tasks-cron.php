<?php
/**
 * Tests for GRP_Standard_Tasks and GRP_Cron (SPEC.md 6.8).
 *
 * @package GridRankers_Portal
 */

/**
 * Standard monthly tasks and grp_daily.
 */
class Test_GRP_Standard_Tasks_Cron extends GRP_REST_TestCase {

	/**
	 * Monthly tasks of a project, by title.
	 *
	 * @param string $project_id Project.
	 * @return array<string, array>
	 */
	private function tasks_of( $project_id ) {
		$out = array();
		foreach ( GRP_Store::find( 'grp_monthly_tasks', array( 'project_id' => $project_id ) ) as $t ) {
			$out[ $t['title'] ] = $t;
		}
		return $out;
	}

	public function test_new_projects_get_the_six_standard_tasks() {
		$project = $this->project( 'Acme', 1 );
		$tasks   = $this->tasks_of( $project['id'] );

		$this->assertEqualsCanonicalizing( array( 'GBP Posts', 'Social Posts', 'Pages', 'Blogs', 'Free Backlinks', 'Paid Backlinks' ), array_keys( $tasks ) );
		$this->assertSame( 'std_' . $project['id'] . '_free-backlinks', $tasks['Free Backlinks']['id'] );
		$this->assertSame( 11, $tasks['Free Backlinks']['target'] );
		$this->assertSame( array( 'Service Pages', 'Location Pages' ), wp_list_pluck( $tasks['Pages']['parts'], 'name' ) );
		$this->assertSame( 1, $tasks['GBP Posts']['target'] );
		$this->assertNull( $tasks['GBP Posts']['parts'] );
		foreach ( $tasks as $t ) {
			$this->assertSame( 1, $t['std'] );
			$this->assertSame( 'monthly', $t['due_mode'] );
			$this->assertSame( array(), $t['assignees'] );
		}
		$this->assertSame( GRP_Cycles::cycle_range( $project, 0, GRP_Cycles::today() )['key'], GRP_Store::get( 'grp_projects', $project['id'] )['std_cycle'] );
	}

	public function test_paused_and_inactive_projects_get_no_monthly_tasks_until_active() {
		foreach ( array( 'paused', 'inactive' ) as $state ) {
			$response = $this->api_as(
				'admin',
				'POST',
				'/projects',
				array(
					'name'      => "Waiting $state",
					'cycle_day' => 1,
					'state'     => $state,
				)
			);
			$this->assertStatus( 201, $response );
			$project = $response->get_data();
			$this->assertSame( array(), $this->tasks_of( $project['id'] ), "A new $state project gets no standard tasks." );

			// grp_daily skips it, in this cycle and the next.
			GRP_Cron::run( GRP_Cycles::today() );
			GRP_Cron::run( GRP_Cycles::cycle_range( $project, 1, GRP_Cycles::today() )['start'] );
			$this->assertSame( array(), $this->tasks_of( $project['id'] ), "grp_daily skips a $state project." );

			// Moved to Active: topped up straight away.
			$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'active' ) ) );
			$this->assertCount( 6, $this->tasks_of( $project['id'] ) );
		}
	}

	public function test_moving_a_project_away_from_active_stops_the_top_up() {
		$project = $this->project( 'Acme', 1 );
		$blogs   = $this->tasks_of( $project['id'] )['Blogs'];
		$this->api_as( 'lead', 'DELETE', "/monthly-tasks/{$blogs['id']}" );
		$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', "/projects/{$project['id']}/state", array( 'state' => 'paused' ) ) );

		$next = GRP_Cycles::cycle_range( $project, 1, GRP_Cycles::today() )['start'];
		$this->assertSame( 0, GRP_Cron::run( $next )['standard_tasks'] );
		$this->assertArrayNotHasKey( 'Blogs', $this->tasks_of( $project['id'] ) );
	}

	public function test_deleted_standard_task_stays_gone_until_next_cycle() {
		$project = $this->project( 'Acme', 1 );
		$blogs   = $this->tasks_of( $project['id'] )['Blogs'];
		$this->api_as( 'lead', 'DELETE', "/monthly-tasks/{$blogs['id']}" );

		GRP_Cron::run( GRP_Cycles::today() );
		$this->assertArrayNotHasKey( 'Blogs', $this->tasks_of( $project['id'] ) );

		// Next cycle: topped up again.
		$next = GRP_Cycles::cycle_range( $project, 1, GRP_Cycles::today() )['start'];
		$sum  = GRP_Cron::run( $next );
		$this->assertSame( 1, $sum['standard_tasks'] );
		$this->assertArrayHasKey( 'Blogs', $this->tasks_of( $project['id'] ) );

		// Idempotent within the cycle.
		$this->assertSame( 0, GRP_Cron::run( $next )['standard_tasks'] );
	}

	public function test_existing_projects_are_topped_up_by_title() {
		$project = GRP_Store::insert(
			'grp_projects',
			array(
				'name'      => 'Imported',
				'cycle_day' => 5,
				'cycle_set' => 1,
			)
		);
		GRP_Store::insert(
			'grp_monthly_tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'gbp posts',
				'target'     => 4,
			)
		);

		$sum = GRP_Cron::run();

		$this->assertSame( 5, $sum['standard_tasks'] );
		$tasks = $this->tasks_of( $project['id'] );
		$this->assertCount( 6, $tasks );
		$this->assertSame( 4, $tasks['gbp posts']['target'], 'existing task kept' );
	}

	public function test_cron_purges_trash_sessions_and_old_tombstones() {
		global $wpdb;

		$old = GRP_Store::insert(
			'grp_trash',
			array(
				'type'       => 'grp_meeting_tasks',
				'doc_id'     => 'x',
				'data'       => array( 'id' => 'x' ),
				'deleted_at' => GRP_Ids::now( time() - 31 * DAY_IN_SECONDS ),
			)
		);
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			GRP_Install::table( 'grp_sessions' ),
			array(
				'id'         => 'expired1',
				'member_id'  => $this->team['other']['id'],
				'token_hash' => str_repeat( 'e', 64 ),
				'expires_at' => GRP_Ids::now( time() - 1 ),
				'created_at' => GRP_Ids::now(),
				'updated_at' => GRP_Ids::now(),
			)
		);
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			GRP_Install::table( 'grp_deletions' ),
			array(
				'id'         => 'tomb1',
				'table_name' => 'grp_activity',
				'doc_id'     => 'a1',
				'deleted_at' => GRP_Ids::now( time() - 61 * DAY_IN_SECONDS ),
				'created_at' => GRP_Ids::now(),
				'updated_at' => GRP_Ids::now(),
			)
		);

		$sum = GRP_Cron::run();

		$this->assertSame( 1, $sum['trash_purged'] );
		$this->assertNull( GRP_Store::get( 'grp_trash', $old['id'] ) );
		$this->assertGreaterThanOrEqual( 1, $sum['sessions'] );
		$this->assertNull( GRP_Store::get( 'grp_sessions', 'expired1' ) );
		$this->assertCount( 1, GRP_Store::find( 'grp_sessions', array( 'member_id' => $this->team['member']['id'] ) ), 'live sessions are kept' );
		$this->assertNull( GRP_Store::get( 'grp_deletions', 'tomb1' ) );
	}

	public function test_cron_is_scheduled_and_cleared() {
		GRP_Cron::unschedule();
		$this->assertFalse( wp_next_scheduled( GRP_Cron::HOOK ) );

		// GRP_Install::activate() calls this; activate() itself runs DDL, which would end the test transaction.
		GRP_Cron::schedule();
		$this->assertNotFalse( wp_next_scheduled( GRP_Cron::HOOK ) );
		$this->assertSame( 'hourly', wp_get_schedule( GRP_Cron::HOOK ) );

		GRP_Install::deactivate();
		$this->assertFalse( wp_next_scheduled( GRP_Cron::HOOK ) );
	}
}
