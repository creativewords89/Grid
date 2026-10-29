<?php
/**
 * Tests for time entries in /sync, the export / import and the trash (SPEC.md 6.21, step 96).
 *
 * @package GridRankers_Portal
 */

/**
 * Time entries as data.
 */
class Test_GRP_Time_Data extends GRP_REST_TestCase {

	/**
	 * Yesterday.
	 *
	 * @return string
	 */
	private function yesterday() {
		return GRP_People::add_days( GRP_Cycles::today(), -1 );
	}

	/**
	 * Uploads one stopped entry for someone yesterday.
	 *
	 * @param string $handle Person.
	 * @param string $id     Entry id.
	 * @param string $from   Start time `H:i:s`.
	 * @param string $to     End time `H:i:s`.
	 * @return array The entry.
	 */
	private function entry( $handle, $id, $from = '09:00:00', $to = '10:00:00' ) {
		$day      = $this->yesterday();
		$response = $this->api_as(
			$handle,
			'POST',
			'/time-entries/batch',
			array(
				'entries' => array(
					array(
						'id'         => $id,
						'started_at' => "$day $from",
						'ended_at'   => "$day $to",
					),
				),
			)
		);
		$this->assertSame( 'saved', $response->get_data()['results'][0]['status'], wp_json_encode( $response->get_data() ) );

		return $response->get_data()['results'][0]['entry'];
	}

	/**
	 * Time entry ids someone receives from a full /sync.
	 *
	 * @param string $handle Person.
	 * @return string[]
	 */
	private function synced( $handle ) {
		$ids = wp_list_pluck( $this->api_as( $handle, 'GET', '/sync' )->get_data()['changes']['time_entries'], 'id' );
		sort( $ids );

		return $ids;
	}

	public function test_sync_sends_a_team_member_only_their_own_time() {
		$this->entry( 'member', 'SYNCMEMBER00000000000001' );
		$this->entry( 'other', 'SYNCOTHER000000000000001' );
		$this->entry( 'lead', 'SYNCLEAD0000000000000001' );

		$this->assertSame( array( 'SYNCMEMBER00000000000001' ), $this->synced( 'member' ) );
		$this->assertSame( array( 'SYNCOTHER000000000000001' ), $this->synced( 'other' ) );
		$this->assertCount( 3, $this->synced( 'lead' ) );
		$this->assertCount( 3, $this->synced( 'admin' ) );
	}

	public function test_sync_never_sends_devices() {
		GRP_Auth::device_login( 'MEMBERCODE1', '127.0.0.1', 'Laptop' );

		$json = wp_json_encode( $this->api_as( 'admin', 'GET', '/sync' )->get_data() );

		$this->assertStringNotContainsString( 'token_hash', $json );
		$this->assertStringNotContainsString( 'Laptop', $json );
	}

	public function test_export_and_import_keep_time_and_tracked_report_lines() {
		$this->entry( 'member', 'EXPORT000000000000000001' );
		$this->api_as(
			'member',
			'PUT',
			'/daily-reports/' . $this->yesterday(),
			array(
				'entries' => array_merge(
					array_values( GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['member']['id'], $this->yesterday() ) )['entries'] ),
					array(
						array(
							'title'   => 'Client call',
							'minutes' => 30,
							'project' => 'other',
						),
					)
				),
			)
		);
		GRP_Auth::device_login( 'MEMBERCODE1', '127.0.0.1', 'Laptop' );

		$export = GRP_Export::build();
		$this->assertCount( 1, $export['data']['timeEntries'] );
		$this->assertSame( 'EXPORT000000000000000001', $export['data']['timeEntries'][0]['id'] );
		$this->assertArrayNotHasKey( 'devices', $export['data'] );
		$this->assertStringNotContainsString( 'Laptop', wp_json_encode( $export ) );

		global $wpdb;
		foreach ( array( 'grp_time_entries', 'grp_daily_reports' ) as $table ) {
			$wpdb->query( $wpdb->prepare( 'DELETE FROM %i', GRP_Install::table( $table ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		}
		$summary = GRP_Import::run( json_decode( wp_json_encode( $export ), true ) );
		$this->assertNotWPError( $summary );

		$entry = GRP_Store::get( 'grp_time_entries', 'EXPORT000000000000000001' );
		$this->assertSame( 3600, $entry['seconds'] );
		$this->assertSame( $this->yesterday(), $entry['day'] );
		$report = GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $this->team['member']['id'], $this->yesterday() ) );
		$this->assertSame(
			array(
				'tracked' => 60,
				'hand'    => 30,
				'total'   => 90,
			),
			GRP_Time::split( $report ),
			'tracked time is still tracked after an import'
		);
	}

	public function test_a_deleted_entry_can_be_restored() {
		$entry = $this->entry( 'member', 'TRASH0000000000000000001' );
		$this->assertStatus( 200, $this->api_as( 'lead', 'DELETE', '/time-entries/' . $entry['id'] ) );
		$report_id = GRP_Daily_Reports::row_id( $this->team['member']['id'], $this->yesterday() );
		$this->assertSame( 0, GRP_Daily_Reports::minutes( GRP_Store::get( 'grp_daily_reports', $report_id ) ) );

		$this->assertStatus( 403, $this->api_as( 'other', 'POST', '/time-entries/' . $entry['id'] . '/restore' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/time-entries/' . $entry['id'] . '/restore' ), 'own: the same day only' );

		$restored = $this->api_as( 'lead', 'POST', '/time-entries/' . $entry['id'] . '/restore' );
		$this->assertStatus( 200, $restored );
		$this->assertNull( $restored->get_data()['deleted_at'] );
		$this->assertSame( 60, GRP_Daily_Reports::minutes( GRP_Store::get( 'grp_daily_reports', $report_id ) ), 'its time is back' );
		$this->assertStatus( 409, $this->api_as( 'lead', 'POST', '/time-entries/' . $entry['id'] . '/restore' ), 'already restored' );
	}

	public function test_restoring_into_time_taken_since_is_refused() {
		$entry = $this->entry( 'member', 'TRASH0000000000000000002' );
		$this->api_as( 'lead', 'DELETE', '/time-entries/' . $entry['id'] );
		$this->entry( 'member', 'TRASH0000000000000000003', '09:30:00', '10:30:00' );

		$response = $this->api_as( 'lead', 'POST', '/time-entries/' . $entry['id'] . '/restore' );

		$this->assertStatus( 409, $response );
		$this->assertSame( 'grp_time_overlap', $response->get_data()['code'] );
	}

	public function test_deleted_entries_are_removed_after_30_days() {
		$old  = $this->entry( 'member', 'PURGE0000000000000000001' );
		$new  = $this->entry( 'member', 'PURGE0000000000000000002', '11:00:00', '12:00:00' );
		$kept = $this->entry( 'member', 'PURGE0000000000000000003', '13:00:00', '14:00:00' );
		GRP_Store::update( 'grp_time_entries', $old['id'], array( 'deleted_at' => GRP_Ids::now( time() - 31 * DAY_IN_SECONDS ) ) );
		GRP_Store::update( 'grp_time_entries', $new['id'], array( 'deleted_at' => GRP_Ids::now( time() - 29 * DAY_IN_SECONDS ) ) );

		$summary = GRP_Cron::run();

		$this->assertSame( 1, $summary['time_purged'] );
		$this->assertNull( GRP_Store::get( 'grp_time_entries', $old['id'] ) );
		$this->assertNotNull( GRP_Store::get( 'grp_time_entries', $new['id'] ) );
		$this->assertNotNull( GRP_Store::get( 'grp_time_entries', $kept['id'] ) );
	}
}
