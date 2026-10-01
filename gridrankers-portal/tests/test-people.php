<?php
/**
 * Tests for GRP_People: days off, leave day counting, monthly settlement, Who's out today
 * and the year-end report (SPEC.md 6.10).
 *
 * @package GridRankers_Portal
 */

/**
 * Leave and days-off maths.
 */
class Test_GRP_People extends WP_UnitTestCase {

	/**
	 * Durga Puja (event, Tue 6 Oct 2026) and Eid (seasonal, Mon 30 Mar – Thu 2 Apr 2026).
	 *
	 * @var array[]
	 */
	private $days_off = array(
		array(
			'kind'      => 'event',
			'from_date' => '2026-10-06',
			'to_date'   => '2026-10-06',
		),
		array(
			'kind'      => 'seasonal',
			'from_date' => '2026-03-30',
			'to_date'   => '2026-04-02',
		),
	);

	/**
	 * A leave row.
	 *
	 * @param string $member_id Person.
	 * @param string $from      First date.
	 * @param string $to        Last date.
	 * @param string $status    Status.
	 * @param string $type      day or sick.
	 * @return array
	 */
	private function leave( $member_id, $from, $to, $status = 'approved', $type = 'day' ) {
		return array(
			'id'        => 'l_' . md5( $member_id . $from . $to . $status ),
			'member_id' => $member_id,
			'from_date' => $from,
			'to_date'   => $to,
			'status'    => $status,
			'type'      => $type,
		);
	}

	public function test_weekly_day_off_defaults_to_friday_and_people_can_have_their_own() {
		$this->assertSame( array( 5 ), GRP_People::weekly_off( array( 'weekly_off' => null ), null ) );
		$this->assertSame( array( 5, 6 ), GRP_People::weekly_off( array( 'weekly_off' => null ), '[6,5]' ) );
		$this->assertSame( array( 4 ), GRP_People::weekly_off( array( 'weekly_off' => array( 4 ) ), array( 5 ) ) );
		$this->assertSame( array(), GRP_People::weekly_off( array( 'weekly_off' => array() ), array( 5 ) ), 'an empty own list means no weekly day off' );
		$this->assertSame( array( 0, 6 ), GRP_People::weekdays( array( 6, '0', 9, 'x', 6 ) ) );
	}

	public function test_day_off_kinds() {
		$member = array( 'weekly_off' => null );
		$this->assertSame( 'weekly', GRP_People::day_off_kind( '2026-10-02', $member, null, $this->days_off ) ); // Friday.
		$this->assertSame( 'event', GRP_People::day_off_kind( '2026-10-06', $member, null, $this->days_off ) );
		$this->assertSame( 'seasonal', GRP_People::day_off_kind( '2026-04-01', $member, null, $this->days_off ) );
		$this->assertNull( GRP_People::day_off_kind( '2026-10-01', $member, null, $this->days_off ) );
		$this->assertNull( GRP_People::day_off_kind( '2026-10-02', array( 'weekly_off' => array( 4 ) ), null, $this->days_off ), 'own weekly day off replaces the team one' );
	}

	public function test_leave_days_skip_days_off_and_split_by_month() {
		$member = array( 'weekly_off' => null );
		// Mon 19 – Wed 21 Oct: 3 working days.
		$this->assertSame( array( '2026-10' => 3 ), GRP_People::leave_days( '2026-10-19', '2026-10-21', $member, null, $this->days_off ) );
		// Thu 1 – Wed 7 Oct: Fri 2 (weekly) and Tue 6 (Durga Puja) are not counted.
		$this->assertSame( array( '2026-10' => 5 ), GRP_People::leave_days( '2026-10-01', '2026-10-07', $member, null, $this->days_off ) );
		// Wed 28 Oct – Tue 3 Nov: Fri 30 Oct off.
		$this->assertSame(
			array(
				'2026-10' => 3,
				'2026-11' => 3,
			),
			GRP_People::leave_days( '2026-10-28', '2026-11-03', $member, null, $this->days_off )
		);
		$this->assertSame( array(), GRP_People::leave_days( '2026-10-02', '2026-10-02', $member, null, $this->days_off ) );
	}

	public function test_taken_in_month_counts_only_approved_leave_in_that_month() {
		$member = array(
			'id'         => 'm1',
			'weekly_off' => null,
		);
		$leaves = array(
			$this->leave( 'm1', '2026-10-28', '2026-11-03' ),
			$this->leave( 'm1', '2026-10-12', '2026-10-12', 'pending' ),
			$this->leave( 'm1', '2026-10-13', '2026-10-13', 'rejected' ),
			$this->leave( 'm2', '2026-10-14', '2026-10-14' ),
			$this->leave( 'm1', '2026-10-15', '2026-10-15', 'approved', 'sick' ),
		);
		$this->assertSame( 4, GRP_People::taken_in_month( $member, '2026-10', $leaves, null, array() ) );
		$this->assertSame( 3, GRP_People::taken_in_month( $member, '2026-11', $leaves, null, array() ) );
		$this->assertSame( 0, GRP_People::taken_in_month( $member, '2026-12', $leaves, null, array() ) );
	}

	public function test_monthly_settlement() {
		$this->assertSame(
			array(
				'taken'    => 0,
				'result'   => 'paid',
				'paid'     => 1,
				'deducted' => 0,
			),
			GRP_People::settlement( 0 )
		);
		$this->assertSame(
			array(
				'taken'    => 1,
				'result'   => 'even',
				'paid'     => 0,
				'deducted' => 0,
			),
			GRP_People::settlement( 1 )
		);
		$this->assertSame(
			array(
				'taken'    => 3,
				'result'   => 'deducted',
				'paid'     => 0,
				'deducted' => 2,
			),
			GRP_People::settlement( 3 )
		);
		$this->assertSame( 1, GRP_People::days_left( 0 ) );
		$this->assertSame( 0, GRP_People::days_left( 3 ) );
	}

	public function test_overlaps_ignore_rejected_cancelled_and_other_people() {
		$leaves = array(
			$this->leave( 'm1', '2026-10-19', '2026-10-21', 'pending' ),
			$this->leave( 'm1', '2026-10-26', '2026-10-26', 'cancelled' ),
			$this->leave( 'm2', '2026-10-27', '2026-10-27' ),
		);
		$this->assertTrue( GRP_People::overlaps( 'm1', '2026-10-21', '2026-10-22', $leaves ) );
		$this->assertFalse( GRP_People::overlaps( 'm1', '2026-10-21', '2026-10-22', $leaves, $leaves[0]['id'] ), 'the leave being edited does not count' );
		$this->assertFalse( GRP_People::overlaps( 'm1', '2026-10-26', '2026-10-27', $leaves ) );
		$this->assertFalse( GRP_People::overlaps( 'm1', '2026-10-22', '2026-10-25', $leaves ) );
	}

	public function test_whos_out_today() {
		$members = array(
			array(
				'id'         => 'max',
				'weekly_off' => null,
			),
			array(
				'id'         => 'rafi',
				'weekly_off' => array( 4 ),
			),
			array(
				'id'         => 'sara',
				'weekly_off' => null,
			),
			array(
				'id'         => 'nia',
				'weekly_off' => null,
			),
		);
		$leaves  = array(
			$this->leave( 'sara', '2026-09-30', '2026-10-04' ),
			$this->leave( 'nia', '2026-10-01', '2026-10-01', 'pending' ),
		);
		// Thu 1 Oct: Rafi's own day off (back Fri), Sara on leave until Sun 4 (back Mon 5); Nia's leave is pending.
		$this->assertSame(
			array(
				array(
					'member_id' => 'rafi',
					'why'       => 'day_off',
					'back'      => '2026-10-02',
				),
				array(
					'member_id' => 'sara',
					'why'       => 'leave',
					'back'      => '2026-10-05',
				),
			),
			GRP_People::whos_out( '2026-10-01', $members, $leaves, null, $this->days_off, 'max' )
		);
		// Mon 5 Oct: everyone is in.
		$this->assertSame( array(), GRP_People::whos_out( '2026-10-05', $members, $leaves, null, $this->days_off ) );
		// Tue 6 Oct: the whole team is off; back Wed 7 (Rafi included).
		$out = GRP_People::whos_out( '2026-10-06', $members, $leaves, null, $this->days_off );
		$this->assertCount( 4, $out );
		$this->assertSame( array( '2026-10-07' ), array_values( array_unique( array_column( $out, 'back' ) ) ) );
	}

	public function test_year_report_counts_leave_types_and_days_off() {
		$members = array(
			array(
				'id'         => 'max',
				'weekly_off' => null,
			),
		);
		$leaves  = array(
			$this->leave( 'max', '2026-10-19', '2026-10-21' ),
			$this->leave( 'max', '2026-12-30', '2027-01-04', 'approved', 'sick' ),
			$this->leave( 'max', '2026-11-02', '2026-11-02', 'rejected' ),
		);
		$report  = GRP_People::year_report( 2026, $members, $leaves, null, $this->days_off );
		// 52 Fridays in 2026, plus Durga Puja (a Tuesday) and Eid Mon 30 Mar – Thu 2 Apr (4 days, no Friday).
		$this->assertSame(
			array(
				array(
					'member_id' => 'max',
					'day'       => 3,
					'sick'      => 2,
					'total'     => 5,
					'days_off'  => 57,
				),
			),
			$report
		);
	}

	public function test_dates() {
		$this->assertTrue( GRP_People::is_date( '2026-02-28' ) );
		$this->assertFalse( GRP_People::is_date( '2026-02-30' ) );
		$this->assertFalse( GRP_People::is_date( '2026-2-3' ) );
		$this->assertSame( '2026-03-01', GRP_People::add_days( '2026-02-28', 1 ) );
		$this->assertSame( '2025-12-31', GRP_People::add_days( '2026-01-01', -1 ) );
	}
}
