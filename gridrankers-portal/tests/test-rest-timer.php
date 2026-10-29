<?php
/**
 * Tests for the timer and time entries (SPEC.md 6.21, step 94): one timer per person, the batch
 * upload, every entry check, tracked time in the daily report, editing, the hourly auto-stop, the
 * tasks and work-start settings.
 *
 * @package GridRankers_Portal
 */

/**
 * /timer, /time-entries, tracked report entries.
 */
class Test_GRP_REST_Timer extends GRP_REST_TestCase {

	/**
	 * UTC datetime some minutes ago.
	 *
	 * @param int $minutes Minutes ago.
	 * @return string
	 */
	private function ago( $minutes ) {
		return GRP_Ids::now( time() - $minutes * MINUTE_IN_SECONDS );
	}

	/**
	 * A UTC datetime on a day, at a time.
	 *
	 * @param string $day  `Y-m-d`.
	 * @param string $time `H:i:s`.
	 * @return string
	 */
	private function on( $day, $time ) {
		return $day . ' ' . $time;
	}

	/**
	 * Yesterday (site time zone, UTC in the tests).
	 *
	 * @return string
	 */
	private function yesterday() {
		return GRP_People::add_days( GRP_Cycles::today(), -1 );
	}

	/**
	 * A meeting task assigned to the given people.
	 *
	 * @param string   $title   Title.
	 * @param string[] $handles People.
	 * @param string   $project Project id ('' = General task).
	 * @param string   $status  Status.
	 * @return array
	 */
	private function task( $title, array $handles = array( 'member' ), $project = '', $status = 'todo' ) {
		return GRP_Store::insert(
			'grp_meeting_tasks',
			array(
				'project_id' => $project,
				'title'      => $title,
				'status'     => $status,
				'target'     => 1,
				'assignees'  => array_map(
					fn ( $h ) => array(
						'id' => $this->team[ $h ]['id'],
						'n'  => 1,
					),
					$handles
				),
			)
		);
	}

	/**
	 * Sends a batch as someone.
	 *
	 * @param string  $handle  Person.
	 * @param array[] $entries Entries.
	 * @param array   $more    More body fields.
	 * @return array Results by id.
	 */
	private function batch( $handle, array $entries, array $more = array() ) {
		$response = $this->api_as( $handle, 'POST', '/time-entries/batch', array( 'entries' => $entries ) + $more );
		$this->assertStatus( 200, $response );

		return array_column( $response->get_data()['results'], null, 'id' );
	}

	/**
	 * A person's report for a day.
	 *
	 * @param string $handle Person.
	 * @param string $day    `Y-m-d`.
	 * @return array|null
	 */
	private function report( $handle, $day ) {
		return GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team[ $handle ]['id'], $day ) );
	}

	public function test_start_stop_and_one_timer_per_person() {
		$task = $this->task( 'Fix H1 tags' );
		// Both starts from one moment, so a slow second between them doesn't change the 20 minutes.
		$now = time();

		$first = $this->api_as(
			'member',
			'POST',
			'/timer/start',
			array(
				'ref_kind'   => 'item',
				'ref_id'     => $task['id'],
				'started_at' => GRP_Ids::now( $now - 30 * MINUTE_IN_SECONDS ),
			)
		);
		$this->assertStatus( 200, $first );
		$timer = $first->get_data()['timer'];
		$this->assertNull( $timer['ended_at'] );
		$this->assertSame( 'web', $timer['source'] );
		$this->assertSame( $timer['id'], $this->api_as( 'member', 'GET', '/timer' )->get_data()['timer']['id'] );

		$switch = $this->api_as( 'member', 'POST', '/timer/start', array( 'started_at' => GRP_Ids::now( $now - 10 * MINUTE_IN_SECONDS ) ) );
		$this->assertStatus( 200, $switch );
		$stopped = $switch->get_data()['stopped'];
		$this->assertSame( $timer['id'], $stopped['id'], 'starting a timer stops the running one' );
		$this->assertSame( $switch->get_data()['timer']['started_at'], $stopped['ended_at'] );
		$this->assertSame( 1200, $stopped['seconds'] );

		$stop = $this->api_as( 'member', 'POST', '/timer/stop' );
		$this->assertStatus( 200, $stop );
		$this->assertNotNull( $stop->get_data()['entry']['ended_at'] );
		$this->assertNull( $this->api_as( 'member', 'GET', '/timer' )->get_data()['timer'] );

		$none = $this->api_as( 'member', 'POST', '/timer/stop' );
		$this->assertStatus( 409, $none );
		$this->assertSame( 'grp_time_not_running', $none->get_data()['code'] );
	}

	public function test_who_may_track() {
		$this->assertStatus( 403, $this->api_as( 'admin', 'POST', '/timer/start' ), 'the Super Admin tracks no time' );
		$this->assertStatus( 403, $this->api_as( 'admin', 'GET', '/timer/tasks' ) );

		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'phone' => '' ) );
		$locked = $this->api_as( 'other', 'POST', '/timer/start' );
		$this->assertStatus( 403, $locked );
		$this->assertSame( 'grp_profile_incomplete', $locked->get_data()['code'] );
		// The desktop app's upload says what is missing, and the schedule tells it beforehand.
		$refused = GRP_Time_Entries::save( GRP_Store::get( 'grp_members', $this->team['other']['id'] ), array( 'started_at' => $this->ago( 30 ) ) );
		$this->assertSame( 'grp_profile_incomplete', $refused['code'] );
		$this->assertSame( 'Finish your profile on the portal first (your page → Settings). Missing: Phone number.', $refused['message'] );
		$this->assertSame( array( 'Phone number' ), GRP_REST_Auth::device_payload( GRP_Store::get( 'grp_members', $this->team['other']['id'] ), 1 )['profile_missing'] );
		$this->assertSame( array(), GRP_REST_Auth::device_payload( $this->team['member'], 1 )['profile_missing'] );

		GRP_Store::delete( 'grp_pay', $this->team['lead']['id'] );
		$this->assertSame( 'grp_pay_needed', $this->api_as( 'lead', 'POST', '/timer/start' )->get_data()['code'] );
	}

	public function test_batch_answers_each_entry_and_never_saves_one_twice() {
		$day     = $this->yesterday();
		$entries = array(
			array(
				'id'         => 'ENTRY0000000000000000001',
				'started_at' => $this->on( $day, '09:00:00' ),
				'ended_at'   => $this->on( $day, '10:00:00' ),
			),
			array(
				'id'         => 'ENTRY0000000000000000002',
				'started_at' => $this->on( $day, '09:30:00' ),
				'ended_at'   => $this->on( $day, '11:00:00' ),
			),
			array(
				'id'         => 'ENTRY0000000000000000003',
				'started_at' => $this->on( $day, '11:00:00' ),
				'ended_at'   => $this->on( $day, '11:45:00' ),
			),
		);

		$results = $this->batch( 'member', $entries );

		$this->assertSame( 'saved', $results['ENTRY0000000000000000001']['status'] );
		$this->assertSame( 'refused', $results['ENTRY0000000000000000002']['status'] );
		$this->assertSame( 'grp_time_overlap', $results['ENTRY0000000000000000002']['code'] );
		$this->assertSame( 'saved', $results['ENTRY0000000000000000003']['status'], 'one refusal never blocks the others' );

		$again = $this->batch( 'member', $entries );
		$this->assertSame( 'exists', $again['ENTRY0000000000000000001']['status'], 'resent: already there' );
		$this->assertSame( 'exists', $again['ENTRY0000000000000000003']['status'] );
		$this->assertCount( 2, GRP_Store::find( 'grp_time_entries', array( 'member_id' => $this->team['member']['id'] ) ) );
		$this->assertSame( 105, GRP_Daily_Reports::minutes( $this->report( 'member', $day ) ), 'paid once: 1h + 45m' );
	}

	public function test_a_running_entry_sent_offline_is_stopped_by_its_later_upload() {
		$id      = 'OFFLINE00000000000000001';
		$started = $this->ago( 50 );

		$first = $this->batch(
			'member',
			array(
				array(
					'id'         => $id,
					'started_at' => $started,
				),
			)
		);
		$this->assertSame( 'saved', $first[ $id ]['status'] );
		$this->assertNull( $first[ $id ]['entry']['ended_at'] );

		$second = $this->batch(
			'member',
			array(
				array(
					'id'         => $id,
					'started_at' => $started,
					'ended_at'   => $this->ago( 20 ),
				),
			)
		);
		$this->assertSame( 'saved', $second[ $id ]['status'] );
		$this->assertSame( 1800, $second[ $id ]['entry']['seconds'] );
	}

	public function test_entry_checks() {
		$day   = $this->yesterday();
		$cases = array(
			'grp_time_future'   => array( $this->ago( -10 ), null ),
			'grp_time_order'    => array( $this->on( $day, '10:00:00' ), $this->on( $day, '09:00:00' ) ),
			'grp_time_too_long' => array( $this->on( $day, '00:00:00' ), $this->on( $day, '12:00:01' ) ),
			'grp_time_invalid'  => array( 'yesterday', null ),
			'grp_time_too_old'  => array( $this->on( GRP_People::add_days( $day, -30 ), '09:00:00' ), $this->on( GRP_People::add_days( $day, -30 ), '10:00:00' ) ),
		);
		$i     = 0;
		foreach ( $cases as $code => $times ) {
			$id      = 'CHECK00000000000000000' . ( ++$i );
			$results = $this->batch(
				'member',
				array(
					array(
						'id'         => $id,
						'started_at' => $times[0],
						'ended_at'   => $times[1],
					),
				)
			);
			$this->assertSame( $code, $results[ $id ]['code'] ?? null, $code );
		}

		$results = $this->batch(
			'member',
			array(
				array(
					'id'         => 'TASKGONE0000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
					'ref_kind'   => 'item',
					'ref_id'     => 'no-such-task',
				),
			)
		);
		$this->assertSame( 'grp_time_task', $results['TASKGONE0000000000000001']['code'] );
	}

	public function test_an_id_belongs_to_one_person() {
		$entry = array(
			'id'         => 'SHARED000000000000000001',
			'started_at' => $this->on( $this->yesterday(), '09:00:00' ),
			'ended_at'   => $this->on( $this->yesterday(), '10:00:00' ),
		);
		$this->batch( 'member', array( $entry ) );

		$this->assertSame( 'grp_time_id_taken', $this->batch( 'other', array( $entry ) )['SHARED000000000000000001']['code'] );
	}

	public function test_a_sent_report_or_a_paid_month_locks_the_day() {
		$day = $this->yesterday();
		GRP_Store::insert(
			'grp_daily_reports',
			array(
				'id'        => GRP_Daily_Reports::row_id( $this->team['member']['id'], $day ),
				'member_id' => $this->team['member']['id'],
				'day'       => $day,
				'entries'   => array(
					array(
						'id'      => 'h1',
						'title'   => 'Client call',
						'minutes' => 60,
					),
				),
				'sent_at'   => $this->on( $day, '18:00:00' ),
			)
		);

		$results = $this->batch(
			'member',
			array(
				array(
					'id'         => 'LOCKED000000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
				),
			)
		);
		$this->assertSame( 'grp_report_locked', $results['LOCKED000000000000000001']['code'] );
		$this->assertSame( 60, GRP_Daily_Reports::minutes( $this->report( 'member', $day ) ), 'the sent report is unchanged' );

		GRP_Store::insert(
			'grp_payslips',
			array(
				'id'        => GRP_Pay::slip_id( $this->team['other']['id'], substr( $day, 0, 7 ) ),
				'member_id' => $this->team['other']['id'],
				'month'     => substr( $day, 0, 7 ),
				'paid_at'   => GRP_Ids::now(),
			)
		);
		$results = $this->batch(
			'other',
			array(
				array(
					'id'         => 'PAIDMONTH000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
				),
			)
		);
		$this->assertSame( 'grp_report_locked', $results['PAIDMONTH000000000000001']['code'] );
	}

	public function test_tracked_time_goes_into_the_report_beside_handwritten_work() {
		$day  = $this->yesterday();
		$task = $this->task( 'Fix H1 tags' );
		$this->api_as(
			'member',
			'PUT',
			'/daily-reports/' . $day,
			array(
				'entries' => array(
					array(
						'title'   => 'Client call',
						'minutes' => 30,
						'project' => 'other',
					),
				),
			)
		);

		$this->batch(
			'member',
			array(
				array(
					'id'         => 'TRACK0000000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:30:00' ),
					'ref_kind'   => 'item',
					'ref_id'     => $task['id'],
				),
				array(
					'id'         => 'TRACK0000000000000000002',
					'started_at' => $this->on( $day, '11:00:00' ),
					'ended_at'   => $this->on( $day, '11:30:00' ),
					'ref_kind'   => 'item',
					'ref_id'     => $task['id'],
				),
				array(
					'id'         => 'TRACK0000000000000000003',
					'started_at' => $this->on( $day, '12:00:00' ),
					'ended_at'   => $this->on( $day, '12:20:00' ),
				),
			)
		);

		$report  = $this->report( 'member', $day );
		$entries = array_values( $report['entries'] );
		$this->assertCount( 3, $entries );
		$this->assertSame( 'Client call', $entries[0]['title'] );
		$this->assertFalse( GRP_Time::is_tracked( $entries[0] ) );
		$this->assertSame( 'Fix H1 tags', $entries[1]['title'] );
		$this->assertSame( 120, $entries[1]['minutes'] );
		$this->assertSame( GRP_Time::NO_TASK_TITLE, $entries[2]['title'] );
		$this->assertSame(
			array(
				'tracked' => 140,
				'hand'    => 30,
				'total'   => 170,
			),
			GRP_Time::split( $report )
		);
		$this->assertSame( 170, GRP_Daily_Reports::minutes( $report ), 'pay counts both, once' );
		$this->assertNull( $report['sent_at'], 'still a draft: the person sends it' );
	}

	public function test_saving_the_report_keeps_tracked_minutes() {
		$day = $this->yesterday();
		$this->batch(
			'member',
			array(
				array(
					'id'         => 'KEEP00000000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
				),
			)
		);
		$tracked = array_values( $this->report( 'member', $day )['entries'] )[0];

		$response = $this->api_as(
			'member',
			'PUT',
			'/daily-reports/' . $day,
			array(
				'entries' => array(
					array(
						'id'      => $tracked['id'],
						'title'   => 'Typed over',
						'details' => 'Keyword research',
						'minutes' => 600,
						'project' => 'office',
					),
					array(
						'title'   => 'Meeting',
						'minutes' => 45,
						'project' => 'other',
					),
				),
			)
		);
		$this->assertStatus( 200, $response );

		$entries = array_values( $this->report( 'member', $day )['entries'] );
		$this->assertSame( 60, $entries[0]['minutes'], 'the timer’s minutes, not the typed ones' );
		$this->assertSame( GRP_Time::NO_TASK_TITLE, $entries[0]['title'] );
		$this->assertSame( 'Keyword research', $entries[0]['details'], 'details are the person’s' );
		$this->assertTrue( GRP_Time::is_tracked( $entries[0] ) );
		$this->assertFalse( GRP_Time::is_tracked( $entries[1] ) );

		$this->api_as(
			'member',
			'PUT',
			'/daily-reports/' . $day,
			array(
				'entries' => array(
					array(
						'title'   => 'Meeting',
						'minutes' => 45,
						'project' => 'other',
					),
				),
			)
		);
		$this->assertSame( 105, GRP_Daily_Reports::minutes( $this->report( 'member', $day ) ), 'a tracked entry left out comes back while its time is there' );
	}

	public function test_editing_and_deleting_time() {
		$day     = $this->yesterday();
		$results = $this->batch(
			'member',
			array(
				array(
					'id'         => 'EDIT00000000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
				),
			)
		);
		$id      = $results['EDIT00000000000000000001']['entry']['id'];

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', '/time-entries/' . $id, array( 'ended_at' => $this->on( $day, '11:00:00' ) ) ), 'own: the same day only' );
		$this->assertStatus( 403, $this->api_as( 'other', 'PATCH', '/time-entries/' . $id, array( 'ended_at' => $this->on( $day, '11:00:00' ) ) ) );

		$edited = $this->api_as( 'lead', 'PATCH', '/time-entries/' . $id, array( 'ended_at' => $this->on( $day, '09:30:00' ) ) );
		$this->assertStatus( 200, $edited );
		$this->assertSame( 1800, $edited->get_data()['seconds'] );
		$this->assertSame( $this->team['lead']['id'], $edited->get_data()['edited_by'] );
		$this->assertSame( 30, GRP_Daily_Reports::minutes( $this->report( 'member', $day ) ) );

		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', '/time-entries/' . $id ) );
		$this->assertSame( array(), array_values( $this->report( 'member', $day )['entries'] ), 'its time leaves the report' );
		$this->assertSame(
			'exists',
			$this->batch(
				'member',
				array(
					array(
						'id'         => 'EDIT00000000000000000001',
						'started_at' => $this->on( $day, '09:00:00' ),
						'ended_at'   => $this->on( $day, '10:00:00' ),
					),
				)
			)['EDIT00000000000000000001']['status'],
			'a deleted entry is not uploaded again'
		);
	}

	public function test_own_entries_can_change_the_same_day() {
		$started = $this->ago( 40 );
		if ( GRP_Time::day_of( $started ) !== GRP_Cycles::today() ) {
			$this->markTestSkipped( 'Just after midnight.' );
		}
		$results = $this->batch(
			'member',
			array(
				array(
					'id'         => 'TODAY0000000000000000001',
					'started_at' => $started,
					'ended_at'   => $this->ago( 10 ),
				),
			)
		);

		$response = $this->api_as( 'member', 'PATCH', '/time-entries/TODAY0000000000000000001', array( 'ended_at' => $this->ago( 20 ) ) );

		$this->assertStatus( 200, $response );
		$this->assertSame( 1200, $response->get_data()['seconds'] );
		$this->assertSame( 'saved', $results['TODAY0000000000000000001']['status'] );

		$moved = $this->api_as(
			'member',
			'PATCH',
			'/time-entries/TODAY0000000000000000001',
			array(
				'started_at' => $this->on( $this->yesterday(), '09:00:00' ),
				'ended_at'   => $this->on( $this->yesterday(), '10:00:00' ),
			)
		);
		$this->assertStatus( 403, $moved, 'not onto an earlier day' );
	}

	public function test_desktop_uploads_are_marked_and_flagged() {
		$token   = GRP_Auth::device_login( 'MEMBERCODE1', '127.0.0.1', 'Laptop' )['token'];
		$day     = GRP_People::add_days( GRP_Cycles::today(), -3 );
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/time-entries/batch' );
		$request->set_header( 'Authorization', 'Bearer ' . $token );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				array(
					'clock_offset' => 300,
					'entries'      => array(
						array(
							'id'         => 'DESKTOP00000000000000001',
							'started_at' => $this->on( $day, '09:00:00' ),
							'ended_at'   => $this->on( $day, '10:00:00' ),
						),
					),
				)
			)
		);
		$this->as_nobody();

		$response = rest_get_server()->dispatch( $request );

		$this->assertStatus( 200, $response );
		$entry = $response->get_data()['results'][0]['entry'];
		$this->assertSame( 'desktop', $entry['source'] );
		$this->assertNotEmpty( $entry['device_id'] );
		$this->assertTrue( $entry['flags']['late_sync'] );
		$this->assertSame( 300, $entry['flags']['clock_skew'] );
	}

	public function test_time_on_a_day_off_is_kept_and_flagged() {
		$day = GRP_Cycles::today();
		for ( $i = 1; $i <= 7; $i++ ) {
			$day = GRP_People::add_days( GRP_Cycles::today(), -$i );
			if ( 5 === (int) gmdate( 'w', strtotime( $day . ' UTC' ) ) ) {
				break;
			}
		}

		$results = $this->batch(
			'member',
			array(
				array(
					'id'         => 'FRIDAY000000000000000001',
					'started_at' => $this->on( $day, '09:00:00' ),
					'ended_at'   => $this->on( $day, '10:00:00' ),
				),
			)
		);

		$this->assertSame( 'saved', $results['FRIDAY000000000000000001']['status'] );
		$this->assertTrue( $results['FRIDAY000000000000000001']['entry']['flags']['day_off'] );
	}

	public function test_forgotten_timers_stop_at_their_twelfth_hour() {
		$this->api_as( 'member', 'POST', '/timer/start', array( 'started_at' => $this->ago( 13 * 60 ) ) );
		$this->api_as( 'other', 'POST', '/timer/start', array( 'started_at' => $this->ago( 60 ) ) );

		$summary = GRP_Cron::run();

		$this->assertSame( 1, $summary['timers_stopped'] );
		$entry = GRP_Store::find( 'grp_time_entries', array( 'member_id' => $this->team['member']['id'] ) )[0];
		$this->assertSame( GRP_Time::MAX_ENTRY_SECONDS, $entry['seconds'] );
		$this->assertTrue( $entry['flags']['auto_stopped'] );
		$this->assertNotNull( GRP_Time_Entries::running( $this->team['other']['id'] ), 'an hour is not forgotten' );
	}

	public function test_who_sees_whose_time() {
		$this->batch(
			'member',
			array(
				array(
					'id'         => 'SEE000000000000000000001',
					'started_at' => $this->on( $this->yesterday(), '09:00:00' ),
					'ended_at'   => $this->on( $this->yesterday(), '10:00:00' ),
				),
			)
		);
		$query = array(
			'member' => $this->team['member']['id'],
			'from'   => $this->yesterday(),
		);

		$this->assertCount( 1, $this->api_as( 'member', 'GET', '/time-entries', array( 'from' => $this->yesterday() ) )->get_data() );
		$this->assertStatus( 403, $this->api_as( 'other', 'GET', '/time-entries', $query ) );
		$this->assertCount( 1, $this->api_as( 'lead', 'GET', '/time-entries', $query )->get_data() );
		$this->assertCount( 1, $this->api_as( 'admin', 'GET', '/time-entries', $query )->get_data() );
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'GET',
				'/time-entries',
				array(
					'from' => '2026-01-01',
					'to'   => '2026-06-01',
				)
			)
		);
	}

	public function test_tasks_to_track() {
		$project = $this->project();
		$mine    = $this->task( 'Fix H1 tags', array( 'member' ), $project['id'] );
		$general = $this->task( 'Update the handbook' );
		$this->task( 'Done already', array( 'member' ), $project['id'], 'done' );
		$this->task( 'Not mine', array( 'other' ), $project['id'] );
		$monthly = GRP_Store::insert(
			'grp_monthly_tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Citations',
				'freq'       => 'monthly',
				'target'     => 5,
				'assignees'  => array(
					array(
						'id' => $this->team['member']['id'],
						'n'  => 5,
					),
				),
			)
		);

		$response = $this->api_as( 'member', 'GET', '/timer/tasks' );

		$this->assertStatus( 200, $response );
		$tasks = array_column( $response->get_data()['tasks'], null, 'id' );
		$this->assertSame( array( $mine['id'], $general['id'], $monthly['id'] ), array_keys( $tasks ) );
		$this->assertSame( 'Acme Plumbing', $tasks[ $mine['id'] ]['project_name'] );
		$this->assertSame( '', $tasks[ $general['id'] ]['project_id'] );
		$this->assertSame( 'record', $tasks[ $monthly['id'] ]['kind'] );
		$this->assertNotEmpty( $tasks[ $monthly['id'] ]['period_key'] );
		$this->assertContains( 'Acme Plumbing', wp_list_pluck( $response->get_data()['projects'], 'name' ) );
	}

	public function test_sign_in_answer_carries_tasks_and_the_running_timer() {
		$this->task( 'Fix H1 tags' );
		$this->api_as( 'member', 'POST', '/timer/start', array( 'started_at' => $this->ago( 5 ) ) );
		$this->as_nobody();

		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/auth/device' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( wp_json_encode( array( 'code' => 'MEMBERCODE1' ) ) );
		$data = rest_get_server()->dispatch( $request )->get_data();

		$this->assertSame( 'Fix H1 tags', $data['tasks']['tasks'][0]['title'] );
		$this->assertNull( $data['timer']['ended_at'] );
	}

	public function test_start_of_the_working_day() {
		$this->assertStatus( 403, $this->api_as( 'lead', 'PUT', '/settings/work-start', array( 'start' => '08:00' ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', '/settings/work-start', array( 'start' => '8am' ) ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'PUT', '/settings/work-start', array( 'start' => '8:00' ) ) );
		$this->assertSame( '08:00', $this->api_as( 'member', 'GET', '/timer/schedule' )->get_data()['work_day']['start'] );

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', '/members/' . $this->team['member']['id'], array( 'work_start' => '10:00' ) ), 'not their own' );
		$this->assertStatus( 200, $this->api_as( 'lead', 'PATCH', '/members/' . $this->team['member']['id'], array( 'work_start' => '10:00' ) ) );
		$this->assertSame( '10:00', $this->api_as( 'member', 'GET', '/timer/schedule' )->get_data()['work_day']['start'] );
		$this->assertStatus( 403, $this->api_as( 'lead', 'PATCH', '/members/' . $this->team['lead']['id'], array( 'work_start' => '10:00' ) ) );

		$this->assertStatus( 200, $this->api_as( 'admin', 'PATCH', '/members/' . $this->team['member']['id'], array( 'work_start' => '' ) ) );
		$this->assertSame( '08:00', $this->api_as( 'member', 'GET', '/timer/schedule' )->get_data()['work_day']['start'], 'cleared: the team’s again' );
	}

	public function test_stopping_in_the_same_second_works() {
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/start' ) );

		$stop = $this->api_as( 'member', 'POST', '/timer/stop' );

		$this->assertStatus( 200, $stop );
		$this->assertGreaterThanOrEqual( 1, $stop->get_data()['entry']['seconds'] );
	}
}
