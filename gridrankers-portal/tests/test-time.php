<?php
/**
 * Tests for GRP_Time: work hours, the schedule, entry checks and overlaps (SPEC.md 6.15).
 *
 * @package GridRankers_Portal
 */

/**
 * Time tracker maths.
 */
class Test_GRP_Time extends WP_UnitTestCase {

	/**
	 * Durga Puja (event, Tue 6 Oct 2026) and the Eid holidays (seasonal, Mon 12 – Wed 14 Oct 2026).
	 *
	 * @var array[]
	 */
	private $days_off = array(
		array(
			'kind'      => 'event',
			'name'      => 'Durga Puja',
			'from_date' => '2026-10-06',
			'to_date'   => '2026-10-06',
		),
		array(
			'kind'      => 'seasonal',
			'name'      => 'Eid holidays',
			'from_date' => '2026-10-12',
			'to_date'   => '2026-10-14',
		),
	);

	/**
	 * A member with the team's weekly day off.
	 *
	 * @var array
	 */
	private $member = array(
		'id'         => 'm1',
		'weekly_off' => null,
		'work_hours' => null,
	);

	/**
	 * A leave row for m1.
	 *
	 * @param string $from   First date.
	 * @param string $to     Last date.
	 * @param string $status Status.
	 * @return array
	 */
	private function leave( $from, $to, $status ) {
		return array(
			'id'        => 'l-' . $from,
			'member_id' => 'm1',
			'type'      => 'sick',
			'reason'    => 'Fever',
			'from_date' => $from,
			'to_date'   => $to,
			'status'    => $status,
		);
	}

	/**
	 * One day of m1's schedule.
	 *
	 * @param string  $date   `Y-m-d`.
	 * @param array   $member Member row.
	 * @param array[] $leaves Leave rows.
	 * @param mixed   $hours  Team work hours.
	 * @return array
	 */
	private function day( $date, array $member = array(), array $leaves = array(), $hours = null ) {
		return GRP_Time::schedule_day( $date, $member + $this->member, array( 5 ), $this->days_off, $leaves, $hours );
	}

	/**
	 * A time entry.
	 *
	 * @param string      $id    Entry id.
	 * @param string      $start Started at.
	 * @param string|null $end   Ended at (null = running).
	 * @param string      $who   Member id.
	 * @return array
	 */
	private function entry( $id, $start, $end, $who = 'm1' ) {
		return array(
			'id'         => $id,
			'member_id'  => $who,
			'started_at' => $start,
			'ended_at'   => $end,
		);
	}

	public function test_work_hours_are_cleaned() {
		$this->assertSame(
			array(
				'start' => '09:00',
				'end'   => '17:30',
			),
			GRP_Time::work_hours( '{"start":"9:00","end":"17:30"}' )
		);
		$this->assertNull( GRP_Time::work_hours( null ) );
		$this->assertNull( GRP_Time::work_hours( array( 'start' => '17:00' ) ) );
		$this->assertNull(
			GRP_Time::work_hours(
				array(
					'start' => '17:00',
					'end'   => '09:00',
				)
			),
			'start must be before end'
		);
		$this->assertNull(
			GRP_Time::work_hours(
				array(
					'start' => '09:00',
					'end'   => '24:00',
				)
			)
		);
		$this->assertNull(
			GRP_Time::work_hours(
				array(
					'start' => '9am',
					'end'   => '5pm',
				)
			)
		);
	}

	public function test_own_work_hours_beat_the_teams_and_the_default() {
		$team = array(
			'start' => '08:00',
			'end'   => '16:00',
		);
		$own  = array(
			'start' => '10:00',
			'end'   => '18:00',
		);

		$this->assertSame( GRP_Time::DEFAULT_WORK_HOURS, GRP_Time::hours_for( $this->member, null ) );
		$this->assertSame( $team, GRP_Time::hours_for( $this->member, $team ) );
		$this->assertSame( $own, GRP_Time::hours_for( array( 'work_hours' => wp_json_encode( $own ) ) + $this->member, $team ) );
		$this->assertSame( $team, GRP_Time::hours_for( array( 'work_hours' => array( 'start' => 'x' ) ) + $this->member, $team ), 'broken own hours fall back' );

		$day = $this->day( '2026-10-07', array( 'work_hours' => $own ), array(), $team );
		$this->assertSame( '10:00', $day['start'] );
		$this->assertSame( '18:00', $day['end'] );
	}

	public function test_an_ordinary_day_is_a_working_day() {
		$this->assertSame(
			array(
				'date'    => '2026-10-07',
				'working' => true,
				'reason'  => null,
				'label'   => '',
				'start'   => '09:00',
				'end'     => '17:00',
			),
			$this->day( '2026-10-07' )
		);
	}

	public function test_team_weekly_day_off_is_not_a_working_day() {
		$day = $this->day( '2026-10-09' );

		$this->assertFalse( $day['working'] );
		$this->assertSame( 'weekly', $day['reason'] );
		$this->assertSame( 'Friday', $day['label'] );
	}

	public function test_own_weekly_day_off_replaces_the_teams() {
		$own = array( 'weekly_off' => array( 6 ) );

		$this->assertTrue( $this->day( '2026-10-09', $own )['working'], 'Friday is a working day for them' );
		$saturday = $this->day( '2026-10-10', $own );
		$this->assertFalse( $saturday['working'] );
		$this->assertSame( 'Saturday', $saturday['label'] );
	}

	public function test_event_and_seasonal_days_off_are_not_working_days() {
		$puja = $this->day( '2026-10-06' );
		$this->assertFalse( $puja['working'] );
		$this->assertSame( 'event', $puja['reason'] );
		$this->assertSame( 'Durga Puja', $puja['label'] );

		foreach ( array( '2026-10-12', '2026-10-13', '2026-10-14' ) as $date ) {
			$eid = $this->day( $date );
			$this->assertFalse( $eid['working'], $date );
			$this->assertSame( 'seasonal', $eid['reason'] );
			$this->assertSame( 'Eid holidays', $eid['label'] );
		}
		$this->assertTrue( $this->day( '2026-10-15' )['working'] );
	}

	public function test_approved_leave_is_not_a_working_day_and_stays_private() {
		$day = $this->day( '2026-10-07', array(), array( $this->leave( '2026-10-07', '2026-10-08', 'approved' ) ) );

		$this->assertFalse( $day['working'] );
		$this->assertSame( 'leave', $day['reason'] );
		$this->assertSame( 'Leave', $day['label'] );
		$this->assertStringNotContainsString( 'sick', wp_json_encode( $day ) );
		$this->assertStringNotContainsString( 'Fever', wp_json_encode( $day ) );
	}

	public function test_pending_rejected_or_cancelled_leave_is_a_working_day() {
		foreach ( array( 'pending', 'rejected', 'cancelled' ) as $status ) {
			$this->assertTrue( $this->day( '2026-10-07', array(), array( $this->leave( '2026-10-07', '2026-10-07', $status ) ) )['working'], $status );
		}
	}

	public function test_other_peoples_leave_does_not_count() {
		$leave              = $this->leave( '2026-10-07', '2026-10-07', 'approved' );
		$leave['member_id'] = 'm2';

		$this->assertTrue( $this->day( '2026-10-07', array(), array( $leave ) )['working'] );
	}

	public function test_a_day_off_is_named_before_leave() {
		$day = $this->day( '2026-10-06', array(), array( $this->leave( '2026-10-05', '2026-10-07', 'approved' ) ) );

		$this->assertSame( 'event', $day['reason'] );
	}

	public function test_schedule_lists_each_date() {
		$schedule = GRP_Time::schedule( '2026-10-05', 14, $this->member, array( 5 ), $this->days_off, array(), null );

		$this->assertCount( 14, $schedule );
		$this->assertSame( '2026-10-05', $schedule[0]['date'] );
		$this->assertSame( '2026-10-18', $schedule[13]['date'] );
		$this->assertSame(
			array( '2026-10-06', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16' ),
			array_values( wp_list_pluck( wp_list_filter( $schedule, array( 'working' => false ) ), 'date' ) )
		);
		$this->assertCount( 62, GRP_Time::schedule( '2026-10-05', 500, $this->member, array( 5 ), array(), array(), null ), 'at most 62 days' );
		$this->assertCount( 1, GRP_Time::schedule( '2026-10-05', 0, $this->member, array( 5 ), array(), array(), null ) );
	}

	public function test_seconds() {
		$this->assertSame( 5400, GRP_Time::seconds( '2026-10-07 09:00:00', '2026-10-07 10:30:00' ) );
		$this->assertSame( 0, GRP_Time::seconds( '2026-10-07 10:30:00', '2026-10-07 09:00:00' ) );
	}

	public function test_invalid_times() {
		$now = '2026-10-07 12:00:00';

		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 09:00:00', '2026-10-07 11:00:00', $now ) );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 09:00:00', null, $now ), 'running' );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 00:00:00', '2026-10-07 12:00:00', $now ), 'exactly 12 hours' );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 11:00:00', '2026-10-07 12:02:00', $now ), 'two minutes of clock difference' );

		$this->assertSame( 'grp_time_invalid', GRP_Time::invalid_times( '2026-10-07', null, $now ) );
		$this->assertSame( 'grp_time_invalid', GRP_Time::invalid_times( '2026-02-30 09:00:00', null, $now ) );
		$this->assertSame( 'grp_time_invalid', GRP_Time::invalid_times( '2026-10-07 09:00:00', 'soon', $now ) );
		$this->assertSame( 'grp_time_order', GRP_Time::invalid_times( '2026-10-07 10:00:00', '2026-10-07 10:00:00', $now ) );
		$this->assertSame( 'grp_time_order', GRP_Time::invalid_times( '2026-10-07 10:00:00', '2026-10-07 09:00:00', $now ) );
		$this->assertSame( 'grp_time_too_long', GRP_Time::invalid_times( '2026-10-06 23:59:59', '2026-10-07 12:00:00', $now ) );
		$this->assertSame( 'grp_time_future', GRP_Time::invalid_times( '2026-10-07 11:00:00', '2026-10-07 12:02:01', $now ) );
		$this->assertSame( 'grp_time_future', GRP_Time::invalid_times( '2026-10-07 13:00:00', null, $now ) );
	}

	public function test_overlapping_entries() {
		$now     = '2026-10-07 12:00:00';
		$entries = array(
			$this->entry( 'a', '2026-10-07 09:00:00', '2026-10-07 10:00:00' ),
			$this->entry( 'b', '2026-10-07 10:30:00', '2026-10-07 11:00:00' ),
			$this->entry( 'other-person', '2026-10-07 09:00:00', '2026-10-07 12:00:00', 'm2' ),
			array( 'deleted_at' => '2026-10-07 11:30:00' ) + $this->entry( 'deleted', '2026-10-07 10:00:00', '2026-10-07 10:30:00' ),
		);

		$this->assertSame( array(), GRP_Time::overlapping( $this->entry( 'n', '2026-10-07 10:00:00', '2026-10-07 10:30:00' ), $entries, $now ), 'touching ends, other people and deleted entries' );
		$this->assertSame( array( 'a' ), GRP_Time::overlapping( $this->entry( 'n', '2026-10-07 09:59:59', '2026-10-07 10:15:00' ), $entries, $now ) );
		$this->assertSame( array( 'a', 'b' ), GRP_Time::overlapping( $this->entry( 'n', '2026-10-07 08:00:00', '2026-10-07 12:00:00' ), $entries, $now ) );
		$this->assertSame( array(), GRP_Time::overlapping( $this->entry( 'a', '2026-10-07 09:00:00', '2026-10-07 10:15:00' ), $entries, $now ), 'an entry never overlaps itself' );
	}

	public function test_a_running_entry_lasts_until_now() {
		$now     = '2026-10-07 12:00:00';
		$running = array( $this->entry( 'r', '2026-10-07 11:00:00', null ) );

		$this->assertSame( array( 'r' ), GRP_Time::overlapping( $this->entry( 'n', '2026-10-07 11:30:00', '2026-10-07 11:45:00' ), $running, $now ) );
		$this->assertSame( array(), GRP_Time::overlapping( $this->entry( 'n', '2026-10-07 10:00:00', '2026-10-07 11:00:00' ), $running, $now ) );
		$this->assertSame(
			array( 'b' ),
			GRP_Time::overlapping(
				$this->entry( 'n', '2026-10-07 11:50:00', null ),
				array( $this->entry( 'b', '2026-10-07 11:30:00', '2026-10-07 11:55:00' ) ),
				$now
			),
			'a new running entry is checked up to now'
		);
	}

	public function test_owner_may_edit_for_seven_days() {
		$now = '2026-10-07 12:00:00';

		$this->assertTrue( GRP_Time::owner_may_edit( '2026-10-07 09:00:00', $now ) );
		$this->assertTrue( GRP_Time::owner_may_edit( '2026-09-30 12:00:00', $now ) );
		$this->assertFalse( GRP_Time::owner_may_edit( '2026-09-30 11:59:59', $now ) );
		$this->assertFalse( GRP_Time::owner_may_edit( '', $now ) );
	}
}
