<?php
/**
 * Tests for GRP_Time: the working day, the schedule, entry checks, overlaps, tracked report
 * entries and handwritten time (SPEC.md 6.21).
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
	 * A member with the team's weekly day off and start.
	 *
	 * @var array
	 */
	private $member = array(
		'id'         => 'm1',
		'weekly_off' => null,
		'work_start' => null,
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
	 * One day of m1's schedule (09:00, 8 hours).
	 *
	 * @param string  $date   `Y-m-d`.
	 * @param array   $member Member row.
	 * @param array[] $leaves Leave rows.
	 * @return array
	 */
	private function day( $date, array $member = array(), array $leaves = array() ) {
		$member += $this->member;

		return GRP_Time::schedule_day( $date, $member, array( 5 ), $this->days_off, $leaves, GRP_Time::work_day( $member, null, null ) );
	}

	/**
	 * A stopped time entry of m1.
	 *
	 * @param string      $id      Entry id.
	 * @param string      $start   Started at.
	 * @param string|null $end     Ended at (null = running).
	 * @param array       $fields  More fields (ref_kind, ref_id, project_id, member_id, deleted_at).
	 * @return array
	 */
	private function time( $id, $start, $end, array $fields = array() ) {
		return $fields + array(
			'id'         => $id,
			'member_id'  => 'm1',
			'started_at' => $start,
			'ended_at'   => $end,
			'ref_kind'   => 'none',
			'ref_id'     => null,
			'project_id' => null,
		);
	}

	/**
	 * A handwritten report entry.
	 *
	 * @param string $id      Entry id.
	 * @param string $title   Title.
	 * @param int    $minutes Minutes.
	 * @return array
	 */
	private function hand( $id, $title, $minutes ) {
		return array(
			'id'      => $id,
			'title'   => $title,
			'details' => '',
			'project' => 'other',
			'minutes' => $minutes,
			'files'   => array(),
			'links'   => array(),
		);
	}

	public function test_start_time_is_cleaned() {
		$this->assertSame( '09:00', GRP_Time::start_time( '9:00' ) );
		$this->assertSame( '17:30', GRP_Time::start_time( ' 17:30 ' ) );
		$this->assertNull( GRP_Time::start_time( '24:00' ) );
		$this->assertNull( GRP_Time::start_time( '9am' ) );
		$this->assertNull( GRP_Time::start_time( null ) );
	}

	public function test_working_day_starts_at_own_else_team_else_nine_and_lasts_pays_hours() {
		$this->assertSame(
			array(
				'start'   => '09:00',
				'end'     => '17:00',
				'minutes' => 480,
			),
			GRP_Time::work_day( $this->member, null, null ),
			'8 hours until pay is set'
		);
		$this->assertSame( '08:00', GRP_Time::work_day( $this->member, '8:00', null )['start'] );

		$own = GRP_Time::work_day( array( 'work_start' => '10:00' ) + $this->member, '08:00', array( 'day_minutes' => 300 ) );
		$this->assertSame( '10:00', $own['start'] );
		$this->assertSame( '15:00', $own['end'] );
		$this->assertSame( 300, $own['minutes'] );

		$this->assertSame( '08:00', GRP_Time::work_day( array( 'work_start' => 'soon' ) + $this->member, '08:00', null )['start'], 'a broken own start falls back' );
		$this->assertSame( '23:59', GRP_Time::work_day( array( 'work_start' => '20:00' ) + $this->member, null, array( 'day_minutes' => 480 ) )['end'], 'never past midnight' );
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
		$this->assertSame( 'event', $this->day( '2026-10-06', array(), array( $this->leave( '2026-10-05', '2026-10-07', 'approved' ) ) )['reason'] );
	}

	public function test_schedule_lists_each_date() {
		$day      = GRP_Time::work_day( $this->member, null, null );
		$schedule = GRP_Time::schedule( '2026-10-05', 14, $this->member, array( 5 ), $this->days_off, array(), $day );

		$this->assertCount( 14, $schedule );
		$this->assertSame( '2026-10-05', $schedule[0]['date'] );
		$this->assertSame( '2026-10-18', $schedule[13]['date'] );
		$this->assertSame(
			array( '2026-10-06', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16' ),
			array_values( wp_list_pluck( wp_list_filter( $schedule, array( 'working' => false ) ), 'date' ) )
		);
		$this->assertCount( 62, GRP_Time::schedule( '2026-10-05', 500, $this->member, array( 5 ), array(), array(), $day ), 'at most 62 days' );
		$this->assertCount( 1, GRP_Time::schedule( '2026-10-05', 0, $this->member, array( 5 ), array(), array(), $day ) );
	}

	public function test_day_of_uses_the_site_time_zone() {
		$dhaka = new DateTimeZone( 'Asia/Dhaka' );

		$this->assertSame( '2026-10-30', GRP_Time::day_of( '2026-10-29 18:30:00', $dhaka ), '00:30 in Dhaka' );
		$this->assertSame( '2026-10-29', GRP_Time::day_of( '2026-10-29 17:59:59', $dhaka ) );
	}

	public function test_invalid_times() {
		$now = '2026-10-07 12:00:00';

		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 09:00:00', '2026-10-07 11:00:00', $now ) );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 09:00:00', null, $now ), 'running' );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 00:00:00', '2026-10-07 12:00:00', $now ), 'exactly 12 hours' );
		$this->assertNull( GRP_Time::invalid_times( '2026-10-07 11:00:00', '2026-10-07 12:02:00', $now ), 'two minutes of clock difference' );
		$this->assertSame( 5400, GRP_Time::seconds( '2026-10-07 09:00:00', '2026-10-07 10:30:00' ) );

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
			$this->time( 'a', '2026-10-07 09:00:00', '2026-10-07 10:00:00' ),
			$this->time( 'b', '2026-10-07 10:30:00', '2026-10-07 11:00:00' ),
			$this->time( 'other-person', '2026-10-07 09:00:00', '2026-10-07 12:00:00', array( 'member_id' => 'm2' ) ),
			$this->time( 'deleted', '2026-10-07 10:00:00', '2026-10-07 10:30:00', array( 'deleted_at' => '2026-10-07 11:30:00' ) ),
		);

		$this->assertSame( array(), GRP_Time::overlapping( $this->time( 'n', '2026-10-07 10:00:00', '2026-10-07 10:30:00' ), $entries, $now ), 'touching ends, other people and deleted entries' );
		$this->assertSame( array( 'a' ), GRP_Time::overlapping( $this->time( 'n', '2026-10-07 09:59:59', '2026-10-07 10:15:00' ), $entries, $now ) );
		$this->assertSame( array( 'a', 'b' ), GRP_Time::overlapping( $this->time( 'n', '2026-10-07 08:00:00', '2026-10-07 12:00:00' ), $entries, $now ) );
		$this->assertSame( array(), GRP_Time::overlapping( $this->time( 'a', '2026-10-07 09:00:00', '2026-10-07 10:15:00' ), $entries, $now ), 'an entry never overlaps itself' );
	}

	public function test_a_running_entry_lasts_until_now() {
		$now     = '2026-10-07 12:00:00';
		$running = array( $this->time( 'r', '2026-10-07 11:00:00', null ) );

		$this->assertSame( array( 'r' ), GRP_Time::overlapping( $this->time( 'n', '2026-10-07 11:30:00', '2026-10-07 11:45:00' ), $running, $now ) );
		$this->assertSame( array(), GRP_Time::overlapping( $this->time( 'n', '2026-10-07 10:00:00', '2026-10-07 11:00:00' ), $running, $now ) );
	}

	public function test_owner_may_edit_the_same_day_only() {
		$this->assertTrue( GRP_Time::owner_may_edit( '2026-10-29', '2026-10-29' ) );
		$this->assertFalse( GRP_Time::owner_may_edit( '2026-10-28', '2026-10-29' ) );
		$this->assertFalse( GRP_Time::owner_may_edit( '', '2026-10-29' ) );
	}

	public function test_tracked_entries_sum_time_per_task() {
		$times  = array(
			$this->time(
				't1',
				'2026-10-29 03:00:00',
				'2026-10-29 04:30:00',
				array(
					'ref_kind'   => 'item',
					'ref_id'     => 'task-1',
					'project_id' => 'p1',
				)
			),
			$this->time(
				't2',
				'2026-10-29 05:00:00',
				'2026-10-29 05:30:00',
				array(
					'ref_kind'   => 'item',
					'ref_id'     => 'task-1',
					'project_id' => 'p1',
				)
			),
			$this->time(
				't3',
				'2026-10-29 06:00:00',
				'2026-10-29 06:45:00',
				array(
					'ref_kind'   => 'record',
					'ref_id'     => 'monthly-1',
					'project_id' => 'p2',
				)
			),
			$this->time( 't4', '2026-10-29 07:00:00', '2026-10-29 07:20:00' ),
			$this->time(
				'running',
				'2026-10-29 08:00:00',
				null,
				array(
					'ref_kind' => 'item',
					'ref_id'   => 'task-1',
				)
			),
			$this->time(
				'deleted',
				'2026-10-29 09:00:00',
				'2026-10-29 10:00:00',
				array(
					'ref_kind'   => 'item',
					'ref_id'     => 'task-1',
					'deleted_at' => '2026-10-29 10:05:00',
				)
			),
		);
		$titles = array(
			'item:task-1'      => 'Fix H1 tags',
			'record:monthly-1' => 'Citations',
		);

		$entries = GRP_Time::with_tracked( array( $this->hand( 'h1', 'Client call', 60 ) ), $times, $titles );

		$this->assertCount( 4, $entries );
		$this->assertSame( $this->hand( 'h1', 'Client call', 60 ), $entries[0], 'handwritten entries are kept as they are' );
		$this->assertSame( 'Fix H1 tags', $entries[1]['title'] );
		$this->assertSame( 120, $entries[1]['minutes'], '1h 30m + 30m; running and deleted time left out' );
		$this->assertSame( array( 't1', 't2' ), $entries[1]['time_ids'] );
		$this->assertSame( 'tracked', $entries[1]['source'] );
		$this->assertSame( 'p1', $entries[1]['project'] );
		$this->assertSame( 'Citations', $entries[2]['title'] );
		$this->assertSame( 45, $entries[2]['minutes'] );
		$this->assertSame( GRP_Time::NO_TASK_TITLE, $entries[3]['title'] );
		$this->assertSame( 'office', $entries[3]['project'] );
		$this->assertSame( 20, $entries[3]['minutes'] );
	}

	public function test_tracked_entries_keep_what_the_person_added_and_go_when_their_time_does() {
		$times = array(
			$this->time(
				't1',
				'2026-10-29 03:00:00',
				'2026-10-29 04:00:00',
				array(
					'ref_kind'   => 'item',
					'ref_id'     => 'task-1',
					'project_id' => 'p1',
				)
			),
		);
		$first = GRP_Time::with_tracked( array(), $times, array( 'item:task-1' => 'Fix H1 tags' ) );

		$first[0]['details'] = 'Home and contact pages';
		$first[0]['links']   = array(
			array(
				'url'  => 'https://example.com',
				'name' => 'Site',
			),
		);
		$first[0]['minutes'] = 600; // Typed over: the time entries win.
		$times[]             = $this->time(
			't2',
			'2026-10-29 05:00:00',
			'2026-10-29 05:15:00',
			array(
				'ref_kind'   => 'item',
				'ref_id'     => 'task-1',
				'project_id' => 'p1',
			)
		);

		$again = GRP_Time::with_tracked( $first, $times, array( 'item:task-1' => 'Fix H1 tags' ) );
		$this->assertCount( 1, $again );
		$this->assertSame( $first[0]['id'], $again[0]['id'] );
		$this->assertSame( 'Home and contact pages', $again[0]['details'] );
		$this->assertSame( 'https://example.com', $again[0]['links'][0]['url'] );
		$this->assertSame( 75, $again[0]['minutes'] );

		$this->assertSame( array(), GRP_Time::with_tracked( $again, array(), array() ), 'no time left: the tracked entry goes' );
	}

	public function test_split_tracked_and_handwritten_minutes() {
		$report = array(
			'entries' => array_merge(
				array( $this->hand( 'h1', 'Client call', 120 ), $this->hand( 'h2', 'Research', 30 ) ),
				GRP_Time::with_tracked( array(), array( $this->time( 't1', '2026-10-29 03:00:00', '2026-10-29 08:30:00' ) ), array() )
			),
		);

		$this->assertSame(
			array(
				'tracked' => 330,
				'hand'    => 150,
				'total'   => 480,
			),
			GRP_Time::split( $report )
		);
		$this->assertSame( GRP_Daily_Reports::minutes( $report ), GRP_Time::split( $report )['total'], 'pay counts the same total: tracked once, handwritten once' );
	}

	public function test_handwritten_time_added() {
		$tracked = GRP_Time::with_tracked( array(), array( $this->time( 't1', '2026-10-29 03:00:00', '2026-10-29 08:30:00' ) ), array() );
		$sent    = array_merge( $tracked, array( $this->hand( 'h1', 'Client call', 120 ) ) );

		$first = GRP_Time::hand_added( array(), $sent );
		$this->assertSame( 120, $first['minutes'], 'on sending: all handwritten time' );
		$this->assertSame( 'Client call', $first['entries'][0]['title'] );

		$this->assertSame( 0, GRP_Time::hand_added( array(), $tracked )['minutes'], 'tracked time never counts as handwritten' );
		$this->assertSame( 0, GRP_Time::hand_added( $sent, $sent )['minutes'], 'nothing new' );

		$later    = $sent;
		$later[1] = $this->hand( 'h1', 'Client call', 150 );
		$later[]  = $this->hand( 'h2', 'Research', 45 );
		$added    = GRP_Time::hand_added( $sent, $later );
		$this->assertSame( 75, $added['minutes'], '30m longer + 45m new' );
		$this->assertSame( array( 30, 45 ), wp_list_pluck( $added['entries'], 'added' ) );

		$shorter    = $sent;
		$shorter[1] = $this->hand( 'h1', 'Client call', 60 );
		$this->assertSame( 0, GRP_Time::hand_added( $sent, $shorter )['minutes'], 'less handwritten time is no notice' );
	}
}
