<?php
/**
 * Tests for GRP_Ids.
 *
 * @package GridRankers_Portal
 */

/**
 * ULIDs.
 */
class Test_GRP_Ids extends WP_UnitTestCase {

	public function test_ulids_are_26_crockford_chars_and_monotonic() {
		$ids = array();
		for ( $i = 0; $i < 2000; $i++ ) {
			$ids[] = GRP_Ids::ulid();
		}

		foreach ( $ids as $id ) {
			$this->assertMatchesRegularExpression( '/^[0-9A-HJKMNP-TV-Z]{26}$/', $id );
		}
		$sorted = $ids;
		sort( $sorted, SORT_STRING );
		$this->assertSame( $ids, $sorted, 'ids sort in creation order' );
		$this->assertCount( 2000, array_unique( $ids ) );
	}
}
