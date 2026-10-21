<?php
/**
 * Tests for GRP_People: days off, leave day counting, the yearly allowance and its monthly
 * settlement, festival holidays, Who's out today and the year-end report (SPEC.md 6.10).
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

	public function test_yearly_allowance_by_employment() {
		foreach ( array( 'full_time', 'part_time' ) as $type ) {
			$this->assertSame( 10, GRP_People::allowance( array( 'employment' => $type ), 'day' ) );
			$this->assertSame( 14, GRP_People::allowance( array( 'employment' => $type ), 'sick' ) );
		}
		foreach ( array( 'intern', 'contractual' ) as $type ) {
			$this->assertFalse( GRP_People::has_leave( array( 'employment' => $type ) ) );
			$this->assertSame( 0, GRP_People::allowance( array( 'employment' => $type ), 'day' ) );
			$this->assertSame( 0, GRP_People::allowance( array( 'employment' => $type ), 'sick' ) );
		}
	}

	public function test_balance_counts_the_calendar_year_only() {
		$member  = array(
			'id'         => 'm1',
			'weekly_off' => null,
			'employment' => 'full_time',
		);
		$leaves  = array(
			// Mon 28 – Thu 31 Dec 2026 and Fri 1 – Mon 4 Jan 2027: 4 days in 2026, 3 in 2027 (Friday 1 Jan is off).
			$this->leave( 'm1', '2026-12-28', '2027-01-04' ),
			$this->leave( 'm1', '2026-10-05', '2026-10-07', 'approved', 'sick' ),
			$this->leave( 'm1', '2026-11-02', '2026-11-03', 'pending' ),
		);
		$balance = GRP_People::balance( $member, 2026, $leaves, null, $this->days_off );
		$this->assertSame(
			array(
				'allowance' => 10,
				'taken'     => 4,
				'left'      => 6,
				'over'      => 0,
			),
			$balance['day']
		);
		// Durga Puja (Tue 6 Oct) is a day off, not sick leave.
		$this->assertSame( 2, $balance['sick']['taken'] );
		$this->assertSame( 12, $balance['sick']['left'] );
		$this->assertSame( 3, GRP_People::balance( $member, 2027, $leaves, null, $this->days_off )['day']['taken'] );
	}

	public function test_settlement_deducts_days_past_the_allowance_in_date_order() {
		$member = array(
			'id'         => 'm1',
			'weekly_off' => array(),
			'employment' => 'full_time',
		);
		$leaves = array(
			$this->leave( 'm1', '2026-01-01', '2026-01-08' ),
			// The 9th and 10th casual days fall in February, the 11th to 13th in March.
			$this->leave( 'm1', '2026-02-27', '2026-03-03' ),
		);
		$this->assertSame(
			array(
				'taken'    => 8,
				'result'   => 'even',
				'paid'     => 0,
				'deducted' => 0,
			),
			GRP_People::settlement( $member, '2026-01', $leaves, null, array() )
		);
		$this->assertSame( 0, GRP_People::settlement( $member, '2026-02', $leaves, null, array() )['deducted'] );
		$this->assertSame(
			array(
				'taken'    => 3,
				'result'   => 'deducted',
				'paid'     => 0,
				'deducted' => 3,
			),
			GRP_People::settlement( $member, '2026-03', $leaves, null, array() )
		);
	}

	public function test_december_pays_out_unused_leave_of_both_types() {
		$member = array(
			'id'         => 'm1',
			'weekly_off' => null,
			'employment' => 'full_time',
		);
		$leaves = array(
			$this->leave( 'm1', '2026-03-02', '2026-03-04' ),
			$this->leave( 'm1', '2026-12-01', '2026-12-01', 'approved', 'sick' ),
		);
		// 10 − 3 casual + 14 − 1 sick.
		$this->assertSame(
			array(
				'taken'    => 1,
				'result'   => 'paid',
				'paid'     => 20,
				'deducted' => 0,
			),
			GRP_People::settlement( $member, '2026-12', $leaves, null, array() )
		);
		$this->assertSame( 0, GRP_People::settlement( $member, '2026-11', $leaves, null, array() )['paid'] );
	}

	public function test_interns_and_contractual_employees_have_every_leave_day_deducted() {
		foreach ( array( 'intern', 'contractual' ) as $type ) {
			$member = array(
				'id'         => 'm1',
				'weekly_off' => null,
				'employment' => $type,
			);
			$leaves = array( $this->leave( 'm1', '2026-12-01', '2026-12-02', 'approved', 'sick' ) );
			$this->assertSame(
				array(
					'taken'    => 2,
					'result'   => 'deducted',
					'paid'     => 0,
					'deducted' => 2,
				),
				GRP_People::settlement( $member, '2026-12', $leaves, null, array() ),
				$type
			);
		}
	}

	public function test_festival_days_skip_the_weekly_day_off_and_count_a_date_once() {
		$days_off = array(
			array(
				'from_date' => '2026-10-20',
				'to_date'   => '2026-10-24',
			),
			array(
				'from_date' => '2026-10-21',
				'to_date'   => '2026-10-21',
			),
			array(
				'from_date' => '2025-12-31',
				'to_date'   => '2026-01-01',
			),
		);
		// Tue 20 – Sat 24 Oct without Friday 23rd, and Thu 1 Jan.
		$this->assertSame( 5, GRP_People::festival_days( 2026, $days_off, null ) );
		$this->assertSame( 1, GRP_People::festival_days( 2025, $days_off, null ) );
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
					'member_id'  => 'max',
					'employment' => 'full_time',
					'day'        => 3,
					'sick'       => 2,
					'total'      => 5,
					'day_left'   => 7,
					'sick_left'  => 12,
					'over'       => 0,
					'days_off'   => 57,
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
