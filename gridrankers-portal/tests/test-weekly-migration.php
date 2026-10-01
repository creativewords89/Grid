<?php
/**
 * Tests for the schema 3 migration: weekly records move to cycle weeks (SPEC.md 6.2).
 *
 * @package GridRankers_Portal
 */

/**
 * GRP_Install::migrate_weekly_records().
 */
class Test_GRP_Weekly_Migration extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		// The test install already ran it once on an empty database.
		delete_option( 'grp_weekly_migrated' );
	}

	/**
	 * Inserts a project with a weekly task.
	 *
	 * @param int $cycle_day Cycle day.
	 * @return array `[project, task]`.
	 */
	private function weekly_task( $cycle_day ) {
		$project = GRP_Store::insert(
			'grp_projects',
			array(
				'name'      => 'P' . $cycle_day . wp_rand(),
				'cycle_day' => $cycle_day,
				'cycle_set' => 1,
			)
		);
		$task    = GRP_Store::insert(
			'grp_monthly_tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Weekly post',
				'freq'       => 'weekly',
				'due_mode'   => 'weekly',
			)
		);

		return array( $project, $task );
	}

	/**
	 * Inserts a record under an old calendar-week key, with an activity credit.
	 *
	 * @param array  $task Task.
	 * @param string $key  `YYYY-MM-wN`.
	 * @return array
	 */
	private function old_record( array $task, $key ) {
		$id = GRP_Cycles::record_id( $task['id'], $key );
		GRP_Activity::credit( 'tm_x', $task['project_id'], $task['title'], '1/1', 1, 'monthly', 'rec:' . $id );

		return GRP_Store::insert(
			'grp_cycle_records',
			array(
				'id'         => $id,
				'task_id'    => $task['id'],
				'project_id' => $task['project_id'],
				'period_key' => $key,
				'week'       => (int) substr( $key, -1 ),
				'count'      => 1,
				'status'     => 'done',
			)
		);
	}

	public function test_records_move_to_the_cycle_week_with_their_credits() {
		list( $project, $task ) = $this->weekly_task( 15 );
		// Calendar W3 of Oct 2026 starts Oct 15: W1 of the cycle Oct 15 – Nov 14.
		$this->old_record( $task, '2026-10-w3' );
		// Calendar W1 of Nov starts Nov 1: W3 of that cycle (Oct 29 – Nov 4).
		$this->old_record( $task, '2026-11-w1' );

		$this->assertSame( 2, GRP_Install::migrate_weekly_records() );

		$keys = wp_list_pluck( GRP_Store::find( 'grp_cycle_records', array( 'task_id' => $task['id'] ) ), 'period_key' );
		sort( $keys );
		$this->assertSame( array( '2026-10-w1', '2026-10-w3' ), $keys );

		$moved = GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $task['id'], '2026-10-w3' ) );
		$this->assertSame( 3, $moved['week'] );
		$this->assertSame( 1, $moved['count'] );
		$this->assertCount( 1, GRP_Store::find( 'grp_activity', array( 'ref_key' => 'rec:' . $moved['id'] ) ) );
		$this->assertSame( array(), GRP_Store::find( 'grp_activity', array( 'ref_key' => 'rec:' . GRP_Cycles::record_id( $task['id'], '2026-11-w1' ) ) ) );

		$this->assertSame( 0, GRP_Install::migrate_weekly_records(), 'running again changes nothing' );
	}

	public function test_day_one_projects_and_clashes_are_left_alone() {
		list( , $day_one ) = $this->weekly_task( 1 );
		$this->old_record( $day_one, '2026-10-w2' );

		// Day 1 → day 15 from Oct 1 with a transition period Oct 1–14 (two weeks).
		list( $project, $mid ) = $this->weekly_task( 15 );
		GRP_Store::update(
			'grp_projects',
			$project['id'],
			array(
				'cycle_changes' => array(
					array(
						'from'    => '2026-10-01',
						'day'     => 15,
						'prevDay' => 1,
						'mode'    => 'due',
					),
				),
			)
		);
		// Calendar W2 (Oct 8) is W2 of the transition, whose record already exists.
		$this->old_record( $mid, '2026-10-w2' );
		GRP_Store::insert(
			'grp_cycle_records',
			array(
				'id'         => GRP_Cycles::record_id( $mid['id'], 'T2026-10-01-w2' ),
				'task_id'    => $mid['id'],
				'project_id' => $mid['project_id'],
				'period_key' => 'T2026-10-01-w2',
				'week'       => 2,
				'count'      => 1,
				'status'     => 'done',
			)
		);

		$this->assertSame( 0, GRP_Install::migrate_weekly_records() );
		$this->assertNotNull( GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $day_one['id'], '2026-10-w2' ) ), 'day 1: same weeks' );
		$this->assertNotNull( GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $mid['id'], '2026-10-w2' ) ), 'clash: kept under the old key' );
	}

	public function test_transition_weeks_get_transition_keys() {
		list( $project, $task ) = $this->weekly_task( 15 );
		GRP_Store::update(
			'grp_projects',
			$project['id'],
			array(
				'cycle_changes' => array(
					array(
						'from'    => '2026-10-01',
						'day'     => 15,
						'prevDay' => 1,
						'mode'    => 'due',
					),
				),
			)
		);
		$this->old_record( $task, '2026-10-w1' );

		$this->assertSame( 1, GRP_Install::migrate_weekly_records() );
		$this->assertNotNull( GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $task['id'], 'T2026-10-01-w1' ) ) );
	}

	public function test_schema_three_adds_the_migration_and_trash_flag() {
		global $wpdb;
		$this->assertSame( 3, GRP_Install::DB_VERSION );
		$columns = $wpdb->get_col( $wpdb->prepare( 'SHOW COLUMNS FROM %i', GRP_Install::table( 'grp_trash' ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$this->assertContains( 'with_project', $columns );
	}
}
