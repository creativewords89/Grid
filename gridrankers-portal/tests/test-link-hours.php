<?php
/**
 * Tests for hours sent from the tracker portal to the main portal (SPEC.md 6.22, step 106).
 *
 * @package GridRankers_Portal
 */

/**
 * POST /link/time-entries on the main portal, the tracker portal's push, and the main portal's
 * closed time routes.
 */
class Test_GRP_Link_Hours extends GRP_REST_TestCase {

	/**
	 * Answers of the faked main portal: id => answer, or a WP_Error.
	 *
	 * @var array|WP_Error
	 */
	private $answers = array();

	/**
	 * Entries the tracker portal sent.
	 *
	 * @var array[]
	 */
	private $sent = array();

	/**
	 * Called while the main portal "answers" (to change an entry mid-send).
	 *
	 * @var callable|null
	 */
	private $during = null;

	public function set_up() {
		parent::set_up();
		delete_option( GRP_Link::OPTION );
		delete_option( GRP_Link::KEY_OPTION );
		add_filter( 'pre_http_request', array( $this, 'fake_http' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'fake_http' ), 10 );
		remove_all_actions( 'shutdown' );
		parent::tear_down();
	}

	/**
	 * Fakes the main portal's POST /link/time-entries.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  URL.
	 * @return array|WP_Error
	 */
	public function fake_http( $pre, $args, $url ) {
		if ( is_wp_error( $this->answers ) ) {
			return $this->answers;
		}
		$entries    = json_decode( (string) $args['body'], true )['entries'];
		$this->sent = array_merge( $this->sent, $entries );
		if ( $this->during ) {
			call_user_func( $this->during );
			$this->during = null;
		}
		$results = array();
		foreach ( $entries as $e ) {
			$results[] = array( 'id' => $e['id'] ) + ( $this->answers[ $e['id'] ] ?? array( 'status' => 'saved' ) );
		}

		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( array( 'results' => $results ) ),
			'response' => array(
				'code'    => 200,
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * Yesterday at a time, UTC.
	 *
	 * @param string $time `H:i:s`.
	 * @return string
	 */
	private function yesterday( $time ) {
		return GRP_People::add_days( GRP_Cycles::today(), -1 ) . ' ' . $time;
	}

	/**
	 * An entry as the tracker portal sends it.
	 *
	 * @param string $id      Id.
	 * @param string $from    `H:i:s` yesterday.
	 * @param string $to      `H:i:s` yesterday, or '' while running.
	 * @param array  $changes More fields.
	 * @return array
	 */
	private function entry( $id, $from = '09:00:00', $to = '10:00:00', array $changes = array() ) {
		return array_merge(
			array(
				'id'           => $id,
				'member_id'    => $this->team['member']['id'],
				'project_id'   => null,
				'ref_kind'     => 'none',
				'ref_id'       => null,
				'period_key'   => null,
				'note'         => null,
				'started_at'   => $this->yesterday( $from ),
				'ended_at'     => '' === $to ? null : $this->yesterday( $to ),
				'idle_seconds' => 0,
				'source'       => 'desktop',
				'flags'        => null,
				'edited_by'    => null,
				'deleted_at'   => null,
			),
			$changes
		);
	}

	/**
	 * Sends entries to this main portal as the tracker portal does.
	 *
	 * @param array[] $entries Entries.
	 * @return array Answers by id.
	 */
	private function receive( array $entries ) {
		$out = array();
		foreach ( GRP_Link_Hours::receive( $entries ) as $answer ) {
			$out[ $answer['id'] ] = $answer;
		}

		return $out;
	}

	/**
	 * Tracked minutes in Max's report yesterday.
	 *
	 * @return int
	 */
	private function tracked_minutes() {
		$report = GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['member']['id'], GRP_People::add_days( GRP_Cycles::today(), -1 ) ) );
		$sum    = 0;
		foreach ( (array) ( $report['entries'] ?? array() ) as $line ) {
			if ( 'tracked' === ( $line['source'] ?? '' ) ) {
				$sum += (int) $line['minutes'];
			}
		}

		return $sum;
	}

	/**
	 * Makes this site a main portal linked to a tracker.
	 */
	private function as_main() {
		GRP_Link::set_main( 'https://tracker.gridrankers.com' );
		GRP_Link::make_key();
	}

	public function test_an_entry_reaches_the_daily_report_once_even_sent_twice() {
		$this->as_main();
		$entry = $this->entry( 'TRK00000000000000000001' );

		$this->assertSame( 'saved', $this->receive( array( $entry ) )['TRK00000000000000000001']['status'] );
		$this->assertSame( 60, $this->tracked_minutes() );
		$this->assertSame( 'exists', $this->receive( array( $entry ) )['TRK00000000000000000001']['status'] );
		$this->assertSame( 60, $this->tracked_minutes() );
		$this->assertCount( 1, GRP_Store::find( 'grp_time_entries', array( 'member_id' => $this->team['member']['id'] ) ) );
		$this->assertSame( 'desktop', GRP_Store::get( 'grp_time_entries', 'TRK00000000000000000001' )['source'] );
	}

	public function test_a_running_entry_is_stopped_by_its_later_version() {
		$this->as_main();
		$this->receive( array( $this->entry( 'TRK00000000000000000002', '09:00:00', '' ) ) );
		$this->assertNull( GRP_Store::get( 'grp_time_entries', 'TRK00000000000000000002' )['ended_at'] );

		$answer = $this->receive( array( $this->entry( 'TRK00000000000000000002', '09:00:00', '09:30:00' ) ) );
		$this->assertSame( 'saved', $answer['TRK00000000000000000002']['status'] );
		$this->assertSame( 1800, GRP_Store::get( 'grp_time_entries', 'TRK00000000000000000002' )['seconds'] );
		$this->assertSame( 30, $this->tracked_minutes() );
	}

	public function test_an_edit_a_delete_and_a_restore_follow() {
		$this->as_main();
		$this->receive( array( $this->entry( 'TRK00000000000000000003' ) ) );

		$edited = $this->entry( 'TRK00000000000000000003', '09:00:00', '11:00:00', array( 'edited_by' => $this->team['lead']['id'] ) );
		$this->assertSame( 'saved', $this->receive( array( $edited ) )['TRK00000000000000000003']['status'] );
		$this->assertSame( 120, $this->tracked_minutes() );
		$this->assertSame( $this->team['lead']['id'], GRP_Store::get( 'grp_time_entries', 'TRK00000000000000000003' )['edited_by'] );

		$deleted = array_merge( $edited, array( 'deleted_at' => GRP_Ids::now() ) );
		$this->assertSame( 'saved', $this->receive( array( $deleted ) )['TRK00000000000000000003']['status'] );
		$this->assertSame( 0, $this->tracked_minutes() );
		$this->assertSame( 'exists', $this->receive( array( $deleted ) )['TRK00000000000000000003']['status'] );

		$this->assertSame( 'saved', $this->receive( array( $edited ) )['TRK00000000000000000003']['status'] );
		$this->assertSame( 120, $this->tracked_minutes() );
	}

	public function test_refusals_keep_their_reason() {
		$this->as_main();
		$this->receive( array( $this->entry( 'TRK00000000000000000004' ) ) );

		$overlap = $this->receive( array( $this->entry( 'TRK00000000000000000005', '09:30:00', '10:30:00' ) ) )['TRK00000000000000000005'];
		$this->assertSame( 'refused', $overlap['status'] );
		$this->assertSame( 'grp_time_overlap', $overlap['code'] );

		$nobody = $this->receive( array( $this->entry( 'TRK00000000000000000006', '12:00:00', '13:00:00', array( 'member_id' => 'not-here' ) ) ) )['TRK00000000000000000006'];
		$this->assertSame( 'grp_time_member', $nobody['code'] );

		// The day's report is sent: the time can't change any more.
		$day = GRP_People::add_days( GRP_Cycles::today(), -1 );
		GRP_Store::update( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['member']['id'], $day ), array( 'sent_at' => $day . ' 18:00:00' ) );
		$late = $this->receive( array( $this->entry( 'TRK00000000000000000007', '14:00:00', '15:00:00' ) ) )['TRK00000000000000000007'];
		$this->assertSame( 'grp_report_locked', $late['code'] );
		$this->assertSame( 60, $this->tracked_minutes() );
	}

	public function test_link_time_entries_needs_the_link_key() {
		$this->as_main();
		$this->as_nobody();
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/link/time-entries' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( wp_json_encode( array( 'entries' => array( $this->entry( 'TRK00000000000000000008' ) ) ) ) );
		$this->assertSame( 401, rest_get_server()->dispatch( $request )->get_status() );
		$this->assertNull( GRP_Store::get( 'grp_time_entries', 'TRK00000000000000000008' ) );

		$key = GRP_Link::make_key();
		$request->set_header( 'Authorization', 'Bearer ' . $key );
		$res = rest_get_server()->dispatch( $request );
		$this->assertStatus( 200, $res );
		$this->assertSame( 'saved', $res->get_data()['results'][0]['status'] );
	}

	public function test_a_linked_main_portal_takes_time_only_through_the_link() {
		$this->as_main();
		foreach ( array( array( 'POST', '/timer/start' ), array( 'POST', '/timer/stop' ), array( 'POST', '/time-entries/batch' ), array( 'PATCH', '/time-entries/x' ), array( 'DELETE', '/time-entries/x' ) ) as $call ) {
			$res = $this->api_as( 'member', $call[0], $call[1] );
			$this->assertSame( 403, $res->get_status(), implode( ' ', $call ) );
			$this->assertSame( 'grp_tracker_portal', $res->get_data()['code'] );
			$this->assertSame( 'Time is tracked on tracker.gridrankers.com. Sign in there.', $res->get_data()['message'] );
		}
		$this->assertStatus( 200, $this->api_as( 'member', 'GET', '/timer' ) );

		$this->as_nobody();
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/auth/device' );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( wp_json_encode( array( 'code' => 'MEMBERCODE1' ) ) );
		$this->assertSame( 'grp_tracker_portal', rest_get_server()->dispatch( $request )->get_data()['code'] );

		// Unlinked, the main portal's own timer works again.
		GRP_Link::unlink();
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/start' ) );
	}

	public function test_the_tracker_pushes_what_is_pending_and_keeps_the_answers() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$ok            = GRP_Store::insert( 'grp_time_entries', array_merge( $this->entry( 'TRK00000000000000000011' ), array( 'day' => GRP_People::add_days( GRP_Cycles::today(), -1 ) ) ) );
		$bad           = GRP_Store::insert( 'grp_time_entries', array_merge( $this->entry( 'TRK00000000000000000012', '11:00:00', '12:00:00' ), array( 'day' => GRP_People::add_days( GRP_Cycles::today(), -1 ) ) ) );
		$this->answers = array(
			$bad['id'] => array(
				'status'  => 'refused',
				'code'    => 'grp_report_locked',
				'message' => 'That day’s report is sent. Ask to change it instead.',
			),
		);

		$count = GRP_Link_Hours::push();
		$this->assertSame(
			array(
				'sent'    => 2,
				'saved'   => 1,
				'refused' => 1,
			),
			$count
		);
		$this->assertSame( array( $ok['id'], $bad['id'] ), wp_list_pluck( $this->sent, 'id' ) );
		$this->assertSame( $this->team['member']['id'], $this->sent[0]['member_id'] );
		$this->assertArrayNotHasKey( 'main_error', $this->sent[0] );
		$this->assertNull( GRP_Store::get( 'grp_time_entries', $ok['id'] )['main_error'] );
		$this->assertNotNull( GRP_Store::get( 'grp_time_entries', $ok['id'] )['main_synced_at'] );
		$this->assertSame( 'That day’s report is sent. Ask to change it instead.', GRP_Store::get( 'grp_time_entries', $bad['id'] )['main_error'] );

		// Nothing pending: nothing sent.
		$this->sent = array();
		$this->assertSame( 0, GRP_Link_Hours::push()['sent'] );
		$this->assertSame( array(), $this->sent );

		// A correction goes again.
		$this->tick();
		GRP_Store::update( 'grp_time_entries', $ok['id'], array( 'note' => 'Fixed' ) );
		GRP_Link_Hours::push();
		$this->assertSame( array( $ok['id'] ), wp_list_pluck( $this->sent, 'id' ) );
	}

	public function test_an_entry_changed_while_it_was_sent_goes_again() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$row          = GRP_Store::insert( 'grp_time_entries', array_merge( $this->entry( 'TRK00000000000000000013' ), array( 'day' => GRP_People::add_days( GRP_Cycles::today(), -1 ) ) ) );
		$this->during = static function () use ( $row ) {
			GRP_Store::update( 'grp_time_entries', $row['id'], array( 'note' => 'changed meanwhile' ) );
		};
		GRP_Link_Hours::push();
		$this->assertSame( 'changed meanwhile', $this->sent[1]['note'] ?? null, 'sent again with the change' );
		$this->assertNotNull( GRP_Store::get( 'grp_time_entries', $row['id'] )['main_synced_at'] );
	}

	public function test_main_portal_down_keeps_entries_pending() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$row           = GRP_Store::insert( 'grp_time_entries', array_merge( $this->entry( 'TRK00000000000000000014' ), array( 'day' => GRP_People::add_days( GRP_Cycles::today(), -1 ) ) ) );
		$this->answers = new WP_Error( 'http_request_failed', 'timeout' );
		$this->assertWPError( GRP_Link_Hours::push() );
		$this->assertNull( GRP_Store::get( 'grp_time_entries', $row['id'] )['main_synced_at'] );
		$this->assertCount( 1, GRP_Link_Hours::pending() );
	}

	public function test_a_time_change_on_the_tracker_is_sent_when_the_request_ends() {
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/start' ) );
		$this->assertNotFalse( has_action( 'shutdown', array( 'GRP_Link_Hours', 'push_on_shutdown' ) ) );
		GRP_Link_Hours::push();
		$this->assertCount( 1, $this->sent );
		$this->assertNull( $this->sent[0]['ended_at'] );
	}

	public function test_only_a_tracker_portal_pushes() {
		$this->assertWPError( GRP_Link_Hours::push() );
		$this->assertStatus( 200, $this->api_as( 'member', 'POST', '/timer/start' ) );
		$this->assertFalse( has_action( 'shutdown', array( 'GRP_Link_Hours', 'push_on_shutdown' ) ) );
	}

	/**
	 * Waits for the next second, so `updated_at` moves.
	 */
	private function tick() {
		$start = time();
		while ( time() === $start ) {
			usleep( 50000 );
		}
	}
}
