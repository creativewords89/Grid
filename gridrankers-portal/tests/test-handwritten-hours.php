<?php
/**
 * Tests for the handwritten-hours notice (SPEC.md 6.21, step 95): the Super Admin is told when a
 * report is sent with handwritten time and when handwritten minutes go up after it was sent.
 *
 * @package GridRankers_Portal
 */

/**
 * Handwritten hours.
 */
class Test_GRP_Handwritten_Hours extends GRP_REST_TestCase {

	public function set_up() {
		parent::set_up();
		update_option( GRP_Time::SINCE_OPTION, GRP_People::add_days( GRP_Cycles::today(), -10 ) );
	}

	/**
	 * Yesterday.
	 *
	 * @return string
	 */
	private function yesterday() {
		return GRP_People::add_days( GRP_Cycles::today(), -1 );
	}

	/**
	 * Notices about handwritten hours, oldest first.
	 *
	 * @return array[]
	 */
	private function notices() {
		return array_values(
			array_filter(
				GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ), array( 'order_by' => 'created_at' ) ),
				static fn ( $post ) => str_starts_with( (string) $post['title'], '✍' )
			)
		);
	}

	/**
	 * Tracks an hour for someone on a day.
	 *
	 * @param string $handle Person.
	 * @param string $day    `Y-m-d`.
	 */
	private function track_hour( $handle, $day ) {
		$response = $this->api_as(
			$handle,
			'POST',
			'/time-entries/batch',
			array(
				'entries' => array(
					array(
						'id'         => 'HOUR' . strtoupper( $handle ) . str_replace( '-', '', $day ) . '0000',
						'started_at' => $day . ' 09:00:00',
						'ended_at'   => $day . ' 10:00:00',
					),
				),
			)
		);
		$this->assertSame( 'saved', $response->get_data()['results'][0]['status'] );
	}

	/**
	 * Saves someone's report: the entries already on it plus handwritten work.
	 *
	 * @param string  $handle Person.
	 * @param string  $day    `Y-m-d`.
	 * @param array[] $hand   Handwritten entries `{id?, title, minutes}`.
	 * @param bool    $send   Send it.
	 * @return WP_REST_Response
	 */
	private function save( $handle, $day, array $hand, $send = true ) {
		$report  = GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team[ $handle ]['id'], $day ) );
		$entries = array_values( array_filter( (array) ( $report['entries'] ?? array() ), array( 'GRP_Time', 'is_tracked' ) ) );
		foreach ( $hand as $entry ) {
			$entries[] = $entry + array( 'project' => 'other' );
		}

		return $this->api_as(
			$handle,
			'PUT',
			'/daily-reports/' . $day,
			array(
				'entries' => $entries,
				'send'    => $send,
			)
		);
	}

	public function test_a_report_with_only_tracked_time_tells_nobody() {
		$day = $this->yesterday();
		$this->track_hour( 'member', $day );

		$this->assertStatus( 200, $this->save( 'member', $day, array() ) );

		$this->assertSame( array(), $this->notices() );
	}

	public function test_sending_handwritten_hours_tells_the_super_admin_only() {
		$day = $this->yesterday();
		$this->track_hour( 'member', $day );

		$this->assertStatus(
			200,
			$this->save(
				'member',
				$day,
				array(
					array(
						'id'      => 'call',
						'title'   => 'Client call',
						'minutes' => 120,
					),
				)
			)
		);

		$notices = $this->notices();
		$this->assertCount( 1, $notices );
		$this->assertSame( '✍ Max Member wrote 2h by hand · ' . gmdate( 'M j', strtotime( $day . ' UTC' ) ), $notices[0]['title'] );
		$this->assertStringContainsString( 'Client call · 2h', $notices[0]['body'] );
		$this->assertStringContainsString( 'Tracked 1h · by hand 2h · total 3h', $notices[0]['body'] );
		$this->assertSame( array( $this->team['admin']['id'] ), $notices[0]['to_members'] );
		$this->assertSame( $this->team['admin']['id'], $notices[0]['created_by'], 'private: the person never receives it' );
	}

	public function test_a_draft_tells_nobody_until_it_is_sent() {
		$day  = $this->yesterday();
		$hand = array(
			array(
				'id'      => 'call',
				'title'   => 'Client call',
				'minutes' => 30,
			),
		);

		$this->save( 'member', $day, $hand, false );
		$this->assertSame( array(), $this->notices() );

		$this->save( 'member', $day, $hand );
		$this->assertCount( 1, $this->notices() );
	}

	public function test_more_handwritten_time_after_sending_tells_again_less_does_not() {
		$day = GRP_Cycles::today();
		$this->save(
			'member',
			$day,
			array(
				array(
					'id'      => 'call',
					'title'   => 'Client call',
					'minutes' => 60,
				),
			)
		);

		$this->save(
			'member',
			$day,
			array(
				array(
					'id'      => 'call',
					'title'   => 'Client call',
					'minutes' => 60,
				),
			)
		);
		$this->assertCount( 1, $this->notices(), 'saved again unchanged' );

		$this->save(
			'member',
			$day,
			array(
				array(
					'id'      => 'call',
					'title'   => 'Client call',
					'minutes' => 90,
				),
				array(
					'id'      => 'research',
					'title'   => 'Research',
					'minutes' => 45,
				),
			)
		);
		$notices = $this->notices();
		$this->assertCount( 2, $notices );
		$this->assertStringContainsString( 'wrote 1h 15m by hand', $notices[1]['title'] );
		$this->assertStringContainsString( 'Client call · 1h 30m (+30m)', $notices[1]['body'] );
		$this->assertStringContainsString( 'Research · 45m', $notices[1]['body'] );

		$this->save(
			'member',
			$day,
			array(
				array(
					'id'      => 'call',
					'title'   => 'Client call',
					'minutes' => 30,
				),
			)
		);
		$this->assertCount( 2, $this->notices(), 'less handwritten time tells nobody' );
	}

	public function test_team_leaders_reports_count_too() {
		$this->save(
			'lead',
			$this->yesterday(),
			array(
				array(
					'title'   => 'Planning',
					'minutes' => 60,
				),
			)
		);

		$this->assertStringContainsString( 'Lee Lead wrote 1h by hand', $this->notices()[0]['title'] );
	}

	public function test_reports_from_before_the_tracker_started_tell_nobody() {
		update_option( GRP_Time::SINCE_OPTION, GRP_Cycles::today() );

		$this->save(
			'member',
			$this->yesterday(),
			array(
				array(
					'title'   => 'Client call',
					'minutes' => 60,
				),
			)
		);

		$this->assertSame( array(), $this->notices() );
	}

	public function test_the_person_does_not_receive_the_notice() {
		$this->save(
			'member',
			$this->yesterday(),
			array(
				array(
					'title'   => 'Client call',
					'minutes' => 60,
				),
			)
		);

		$member = wp_json_encode( $this->api_as( 'member', 'GET', '/posts' )->get_data() );
		$admin  = wp_json_encode( $this->api_as( 'admin', 'GET', '/posts' )->get_data() );
		$this->assertStringNotContainsString( 'by hand', $member );
		$this->assertStringContainsString( 'by hand', $admin );
	}
}
