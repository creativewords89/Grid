<?php
/**
 * Tests for GRP_Store and GRP_Activity.
 *
 * @package GridRankers_Portal
 */

/**
 * Data layer tests.
 */
class Test_GRP_Store extends WP_UnitTestCase {

	public function test_insert_get_update_decode() {
		$row = GRP_Store::insert(
			'grp_projects',
			array(
				'name'          => 'Acme',
				'cycle_day'     => 5,
				'cycle_changes' => array( array( 'from' => '2026-01-01' ) ),
			)
		);

		$this->assertSame( 26, strlen( $row['id'] ) );
		$this->assertSame( 5, $row['cycle_day'] );
		$this->assertSame( array( array( 'from' => '2026-01-01' ) ), $row['cycle_changes'] );
		$this->assertNull( $row['cycle_log'] );
		$this->assertNotEmpty( $row['created_at'] );

		$updated = GRP_Store::update( 'grp_projects', $row['id'], array( 'state' => 'paused' ) );
		$this->assertSame( 'paused', $updated['state'] );
		$this->assertSame( 'Acme', $updated['name'] );
	}

	public function test_find_conditions_and_order() {
		foreach ( array(
			'b' => 3,
			'a' => 1,
			'c' => 2,
		) as $name => $day ) {
			GRP_Store::insert(
				'grp_projects',
				array(
					'name'      => $name,
					'cycle_day' => $day,
				)
			);
		}

		$names = wp_list_pluck( GRP_Store::find( 'grp_projects', array( 'cycle_day >=' => 2 ), array( 'order_by' => 'cycle_day' ) ), 'name' );
		$this->assertSame( array( 'c', 'b' ), $names );

		$this->assertCount( 2, GRP_Store::find( 'grp_projects', array( 'name' => array( 'a', 'c' ) ) ) );
		$this->assertCount( 0, GRP_Store::find( 'grp_projects', array( 'name' => array() ) ) );
		$this->assertCount( 3, GRP_Store::find( 'grp_projects', array( 'std_cycle' => null ) ) );
		$this->assertCount(
			1,
			GRP_Store::find(
				'grp_projects',
				array(),
				array(
					'order_by' => 'name',
					'limit'    => 1,
					'offset'   => 2,
				)
			)
		);
	}

	public function test_find_is_injection_safe() {
		GRP_Store::insert( 'grp_projects', array( 'name' => 'Safe' ) );

		$this->assertCount( 0, GRP_Store::find( 'grp_projects', array( 'name' => "x' OR '1'='1" ) ) );
		$this->assertCount( 1, GRP_Store::find( 'grp_projects' ) );
	}

	public function test_delete_records_tombstone() {
		$row = GRP_Store::insert( 'grp_projects', array( 'name' => 'Gone' ) );

		$this->assertTrue( GRP_Store::delete( 'grp_projects', $row['id'] ) );
		$this->assertNull( GRP_Store::get( 'grp_projects', $row['id'] ) );
		$this->assertCount(
			1,
			GRP_Store::find(
				'grp_deletions',
				array(
					'table_name' => 'grp_projects',
					'doc_id'     => $row['id'],
				)
			)
		);
		$this->assertFalse( GRP_Store::delete( 'grp_projects', $row['id'] ) );
	}

	public function test_transaction_rolls_back_on_wp_error_and_exception() {
		$result = GRP_Store::transaction(
			static function () {
				GRP_Store::insert( 'grp_projects', array( 'name' => 'Rolled back' ) );
				return new WP_Error( 'nope', 'nope' );
			}
		);
		$this->assertWPError( $result );
		$this->assertCount( 0, GRP_Store::find( 'grp_projects', array( 'name' => 'Rolled back' ) ) );

		try {
			GRP_Store::transaction(
				static function () {
					GRP_Store::insert( 'grp_projects', array( 'name' => 'Thrown' ) );
					throw new RuntimeException( 'boom' );
				}
			);
			$this->fail( 'Expected exception' );
		} catch ( RuntimeException $e ) {
			$this->assertSame( 'boom', $e->getMessage() );
		}
		$this->assertCount( 0, GRP_Store::find( 'grp_projects', array( 'name' => 'Thrown' ) ) );

		$ok = GRP_Store::transaction(
			static function () {
				return GRP_Store::insert( 'grp_projects', array( 'name' => 'Kept' ) );
			}
		);
		$this->assertSame( 'Kept', $ok['name'] );
		$this->assertCount( 1, GRP_Store::find( 'grp_projects', array( 'name' => 'Kept' ) ) );
	}

	public function test_credit_and_uncredit_newest_first() {
		GRP_Activity::credit( 'm1', 'p1', 'Blogs', '1/3', 1, 'board', 'itemq:t1:m1' );
		GRP_Activity::credit( 'm1', 'p1', 'Blogs', '2/3', 1, 'board', 'itemq:t1:m1' );
		GRP_Activity::credit( 'm1', 'p1', 'Blogs', '3/3', 1, 'board', 'itemq:t1:m1' );

		GRP_Activity::uncredit( 'itemq:t1:m1', 1 );
		$left = GRP_Store::find( 'grp_activity', array( 'ref_key' => 'itemq:t1:m1' ) );
		$this->assertCount( 2, $left );
		$this->assertNotContains( '3/3', wp_list_pluck( $left, 'detail' ) );

		GRP_Activity::uncredit( 'itemq:t1:m1' );
		$this->assertCount( 0, GRP_Store::find( 'grp_activity', array( 'ref_key' => 'itemq:t1:m1' ) ) );
	}

	public function test_audit_row() {
		$actor = array(
			'id'     => 'm-lead',
			'role'   => 'lead',
			'active' => 1,
		);

		$row = GRP_Activity::audit(
			'edit',
			'items',
			array(
				'id'         => 't1',
				'project_id' => 'p1',
				'title'      => 'Fix H1',
			),
			$actor,
			'',
			array(
				array(
					'field' => 'title',
					'label' => 'title',
					'from'  => 'a',
					'to'    => 'b',
				),
			)
		);

		$this->assertSame( 'p1', $row['project_id'] );
		$this->assertSame( 'lead', $row['by_role'] );
		$this->assertSame( 'title', $row['changes'][0]['field'] );

		$project = GRP_Activity::audit(
			'project',
			'client',
			array(
				'id'   => 'p9',
				'name' => 'Acme',
			),
			$actor,
			'project added'
		);
		$this->assertSame( 'p9', $project['project_id'] );
		$this->assertSame( 'Acme', $project['title'] );
	}
}
