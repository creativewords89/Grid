<?php
/**
 * Tests for GRP_Import, GRP_Export, /import, /export and the admin import screen.
 *
 * @package GridRankers_Portal
 */

/**
 * Import / export (SPEC.md section 10).
 */
class Test_GRP_Import_Export extends GRP_REST_TestCase {

	/**
	 * The sample export in the old portal's format.
	 *
	 * @return array
	 */
	private function fixture() {
		return json_decode( file_get_contents( __DIR__ . '/fixtures/export-v1.json' ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	}

	/**
	 * Row count of a table.
	 *
	 * @param string $table Table.
	 * @return int
	 */
	private function rows( $table ) {
		return count( GRP_Store::find( $table ) );
	}

	public function test_import_counts() {
		$summary = GRP_Import::run( $this->fixture() );

		$expected = array(
			'team'        => array( 4, 0, 0 ),
			'clients'     => array( 3, 0, 0 ),
			'items'       => array( 5, 0, 0 ),
			'monthly'     => array( 5, 0, 0 ),
			'monthlyDone' => array( 4, 0, 0 ),
			'activity'    => array( 3, 0, 1 ),
			'edits'       => array( 3, 0, 0 ),
			'trash'       => array( 1, 0, 0 ),
			'dismissals'  => array( 2, 0, 0 ),
			'settings'    => array( 1, 0, 2 ),
			'visitors'    => array( 0, 0, 1 ),
		);
		foreach ( $expected as $collection => list( $inserted, $updated, $skipped ) ) {
			$this->assertSame(
				array(
					'inserted' => $inserted,
					'updated'  => $updated,
					'skipped'  => $skipped,
				),
				$summary['counts'][ $collection ],
				$collection
			);
		}
		$this->assertFalse( $summary['dry_run'] );
		$this->assertCount( 1, $summary['warnings'], 'unlinked Super Admin warning' );
		$this->assertStringContainsString( 'Grid Owner', $summary['warnings'][0] );

		// Test team (4) + imported team (4).
		$this->assertSame( 8, $this->rows( 'grp_members' ) );
		$this->assertSame( 3, $this->rows( 'grp_projects' ) );
		$this->assertSame( 5, $this->rows( 'grp_meeting_tasks' ) );
		$this->assertSame( 5, $this->rows( 'grp_monthly_tasks' ) );
		$this->assertSame( 4, $this->rows( 'grp_cycle_records' ) );
	}

	public function test_import_maps_projects() {
		GRP_Import::run( $this->fixture() );

		$acme = GRP_Store::get( 'grp_projects', 'c_acme' );
		$this->assertSame( 'active', $acme['state'] );
		$this->assertSame( 5, $acme['cycle_day'] );
		$this->assertSame( 1, $acme['cycle_set'] );
		$this->assertSame( '2026-09', $acme['std_cycle'] );
		$this->assertSame( '2025-01-02 00:00:00', $acme['created_at'], 'epoch ms' );

		$this->assertSame( 'inactive', GRP_Store::get( 'grp_projects', 'c_bright' )['state'], 'legacy active:false' );
		$this->assertSame( 0, GRP_Store::get( 'grp_projects', 'c_bright' )['cycle_set'] );

		$coast = GRP_Store::get( 'grp_projects', 'c_coast' );
		$this->assertSame( 'paused', $coast['state'] );
		$this->assertSame( 'merge', $coast['cycle_changes'][0]['mode'] );
		$this->assertCount( 2, $coast['cycle_log'] );
	}

	public function test_import_maps_meeting_tasks() {
		GRP_Import::run( $this->fixture() );

		$h1 = GRP_Store::get( 'grp_meeting_tasks', 'i_h1' );
		$this->assertSame( 'c_acme', $h1['project_id'] );
		$this->assertSame(
			array(
				array(
					'id' => 'tm_max',
					'n'  => 1,
				),
			),
			$h1['assignees'],
			'legacy whoId'
		);
		$this->assertSame( '2026-09-03', $h1['meeting_date'] );
		$this->assertSame( '2026-09-08 15:30:00', $h1['done_at'] );
		$this->assertSame(
			array(
				'date' => '2026-09-10',
				'type' => 'date',
			),
			$h1['deadline']
		);
		$this->assertSame( 'pending', $h1['review']['state'] );
		$this->assertSame( 'Updated H1 and meta', $h1['completion']['note'] );

		$cite = GRP_Store::get( 'grp_meeting_tasks', 'i_cite' );
		$this->assertSame( array( 'tm_max' => 2 ), $cite['progress'] );
		$this->assertSame( array( '2026-09-14', '2026-09-21' ), $cite['deadline']['weeks'] );

		$this->assertSame(
			array(
				'from' => '2026-10-12',
				'to'   => '2026-10-20',
				'type' => 'dates',
			),
			GRP_Store::get( 'grp_meeting_tasks', 'i_unas' )['deadline'],
			'legacy dueDates'
		);
		$this->assertSame( '2026-09', GRP_Store::get( 'grp_meeting_tasks', 'i_month' )['deadline']['month'], 'month from dueRef' );
		$this->assertSame( array( '2026-09-14' ), GRP_Store::get( 'grp_meeting_tasks', 'i_wkref' )['deadline']['weeks'], 'Monday of dueRef' );
	}

	public function test_import_maps_monthly_tasks_and_records() {
		GRP_Import::run( $this->fixture() );

		$std = GRP_Store::get( 'grp_monthly_tasks', 'std_c_acme_gbp-posts' );
		$this->assertSame( 1, $std['std'] );
		$this->assertSame( 4, $std['assignees'][0]['n'] );

		$pages = GRP_Store::get( 'grp_monthly_tasks', 'm_pages' );
		$this->assertSame(
			array(
				array(
					'id' => 'tm_max',
					'n'  => 2,
				),
			),
			$pages['parts'][0]['people'],
			'legacy part.who'
		);
		$this->assertSame( 'weekly', GRP_Store::get( 'grp_monthly_tasks', 'm_social' )['freq'] );
		$this->assertSame( 10, GRP_Store::get( 'grp_monthly_tasks', 'm_blogs' )['due_from_day'] );
		$this->assertSame( 'date', GRP_Store::get( 'grp_monthly_tasks', 'm_legacy' )['due_mode'], 'legacy dueDay without dueMode' );

		$weekly = GRP_Store::get( 'grp_cycle_records', 'm_social__2026-09-w2' );
		$this->assertSame( '2026-09-w2', $weekly['period_key'] );
		$this->assertSame( 2, $weekly['week'] );
		$this->assertSame( 'skipped', GRP_Store::get( 'grp_cycle_records', 'm_blogs__2026-08' )['status'] );
		$this->assertSame(
			array(
				'pt1'        => 2,
				'pt1|tm_max' => 2,
			),
			GRP_Store::get( 'grp_cycle_records', 'm_pages__2026-09' )['parts']
		);
	}

	public function test_import_maps_people_logs_and_settings() {
		GRP_Import::run( $this->fixture() );

		$max = GRP_Store::get( 'grp_members', 'tm_max' );
		$this->assertSame( 'https://drive.google.com/drive/folders/abc', $max['drive_url'] );
		$this->assertSame( 'q7w6', $max['code_salt'] );
		$this->assertArrayNotHasKey( 'accountId', $max );

		$a2 = GRP_Store::get( 'grp_activity', 'a2' );
		$this->assertSame( '2025-09-08 15:30:00', $a2['at'], 'epoch ms' );
		$this->assertSame( 'item:i_h1', $a2['ref_key'] );
		$this->assertSame( 90, GRP_Store::get( 'grp_activity', 'a3' )['minutes'] );
		$this->assertNull( GRP_Store::get( 'grp_activity', 'a3' )['project_id'] );

		$this->assertSame( 'priority', GRP_Store::get( 'grp_audit', 'e2' )['changes'][0]['field'] );
		$this->assertSame( 'grp_meeting_tasks', GRP_Store::get( 'grp_trash', 't1' )['type'] );
		$this->assertSame( 'c_acme', GRP_Store::get( 'grp_trash', 't1' )['data']['project_id'] );

		$this->assertCount( 2, GRP_Store::find( 'grp_dismissals', array( 'member_id' => 'tm_lee' ) ) );
		$settings = GRP_Store::find( 'grp_settings' );
		$this->assertSame( array( 'workweek' ), wp_list_pluck( $settings, 'setting_key' ) );
		$this->assertStringNotContainsString( 'do-not-import', wp_json_encode( $settings ) );
	}

	public function test_imported_legacy_codes_sign_in_and_are_rehashed() {
		GRP_Import::run( $this->fixture() );

		$result = GRP_Auth::login( 'MAXCODE1', '127.0.0.1' );
		$this->assertIsArray( $result );
		$this->assertSame( 'tm_max', $result['member']['id'] );
		$this->assertNull( GRP_Store::get( 'grp_members', 'tm_max' )['code_salt'] );

		// Re-importing keeps the upgraded hash (the code still works).
		GRP_Import::run( $this->fixture() );
		GRP_Auth::reset();
		$this->assertIsArray( GRP_Auth::login( 'MAXCODE1', '127.0.0.1' ) );
		$this->assertNull( GRP_Store::get( 'grp_members', 'tm_max' )['code_salt'] );

		// Old Super Admin codes don't work: Super Admins use WordPress login.
		$this->assertWPError( GRP_Auth::login( 'OWNER123', '127.0.0.1' ) );
	}

	public function test_import_is_idempotent() {
		GRP_Import::run( $this->fixture() );
		$before = array();
		foreach ( GRP_Install::TABLES as $table ) {
			$before[ $table ] = $this->rows( $table );
		}

		$again = GRP_Import::run( $this->fixture() );

		foreach ( GRP_Install::TABLES as $table ) {
			$this->assertSame( $before[ $table ], $this->rows( $table ), $table );
		}
		$this->assertSame( 0, array_sum( wp_list_pluck( $again['counts'], 'inserted' ) ) );
		$this->assertSame( 5, $again['counts']['items']['updated'] );
	}

	public function test_dry_run_changes_nothing() {
		$summary = GRP_Import::run( $this->fixture(), true );

		$this->assertTrue( $summary['dry_run'] );
		$this->assertSame( 5, $summary['counts']['items']['inserted'] );
		$this->assertSame( 0, $this->rows( 'grp_meeting_tasks' ) );
		$this->assertSame( 0, $this->rows( 'grp_projects' ) );
	}

	public function test_rejects_other_files() {
		$this->assertWPError( GRP_Import::run( array( 'hello' => 'world' ) ) );
		$this->assertWPError(
			GRP_Import::run(
				array(
					'format'  => 'gridrankers-portal-export',
					'version' => 2,
					'data'    => array(),
				)
			)
		);
		$this->assertWPError( GRP_Import::run( 'nope' ) );
	}

	public function test_project_name_clash_is_skipped_with_warning() {
		GRP_Store::insert( 'grp_projects', array( 'name' => 'Acme Plumbing' ) );

		$summary = GRP_Import::run( $this->fixture() );

		$this->assertSame( 1, $summary['counts']['clients']['skipped'] );
		$this->assertNotEmpty( preg_grep( '/Acme Plumbing/', $summary['warnings'] ) );

		// The skipped project's tasks are not imported without a project.
		$this->assertNull( GRP_Store::get( 'grp_projects', 'c_acme' ) );
		$this->assertSame( array(), GRP_Store::find( 'grp_meeting_tasks', array( 'project_id' => 'c_acme' ) ) );
		$this->assertSame( array(), GRP_Store::find( 'grp_monthly_tasks', array( 'project_id' => 'c_acme' ) ) );
		$this->assertSame( array(), GRP_Store::find( 'grp_cycle_records', array( 'project_id' => 'c_acme' ) ) );
		$this->assertSame( 2, $summary['counts']['items']['skipped'] );
	}

	public function test_export_round_trip() {
		GRP_Import::run( $this->fixture() );
		$first = GRP_Export::build();

		foreach ( GRP_Install::TABLES as $table ) {
			if ( 'grp_deletions' !== $table ) {
				global $wpdb;
				$wpdb->query( $wpdb->prepare( 'DELETE FROM %i', GRP_Install::table( $table ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			}
		}

		$summary = GRP_Import::run( json_decode( wp_json_encode( $first ), true ) );
		$this->assertSame( $summary['warnings'], preg_grep( '/Super Admin/', $summary['warnings'] ), 'only the unlinked Super Admin warning' );
		$second = GRP_Export::build();

		$strip = static function ( $export ) {
			$data = $export['data'];
			array_walk_recursive(
				$data,
				static function ( &$v, $k ) {
					if ( 'updatedAt' === $k ) {
						$v = null;
					}
				}
			);
			return $data;
		};
		$this->assertEquals( $strip( $first ), $strip( $second ) );
		$this->assertCount( 8, $second['data']['team'] );
		$this->assertCount( 5, $second['data']['items'] );
	}

	public function test_rest_export_and_import_super_admin_only() {
		$this->assertStatus( 403, $this->api_as( 'lead', 'GET', '/export' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/export' ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/import', $this->fixture() ) );

		$response = $this->api_as( 'admin', 'POST', '/import', $this->fixture() );
		$this->assertStatus( 200, $response );
		$this->assertSame( 5, $response->get_data()['counts']['items']['inserted'] );
		$this->assertCount( 1, GRP_Store::find( 'grp_audit', array( 'kind' => 'import' ) ) );

		$export = $this->api_as( 'admin', 'GET', '/export' );
		$this->assertStatus( 200, $export );
		$this->assertSame( 'gridrankers-portal-export', $export->get_data()['format'] );
		$this->assertStringContainsString( 'attachment', $export->get_headers()['Content-Disposition'] );

		$dry = $this->api_as(
			'admin',
			'POST',
			'/import',
			array(
				'format'  => 'x',
				'dry_run' => 1,
			)
		);
		$this->assertStatus( 400, $dry );
	}

	public function test_admin_import_file_and_screen() {
		wp_set_current_user( (int) $this->team['admin']['wp_user_id'] );
		$path = wp_tempnam( 'export.json' );
		file_put_contents( $path, wp_json_encode( $this->fixture() ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents

		$summary = GRP_Admin_Import_Export::import_file( $path, false );
		$this->assertSame( 3, $summary['counts']['clients']['inserted'] );

		file_put_contents( $path, '{not json' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		$this->assertWPError( GRP_Admin_Import_Export::import_file( $path, false ) );
		unlink( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink

		// The result table escapes what it prints.
		ob_start();
		GRP_Admin_Import_Export::render_result(
			array(
				'dry_run'  => true,
				'counts'   => array(
					'<script>' => array(
						'inserted' => 1,
						'updated'  => 0,
						'skipped'  => 0,
					),
				),
				'warnings' => array( '<b>x</b>' ),
			)
		);
		$html = ob_get_clean();
		$this->assertStringNotContainsString( '<script>', $html );
		$this->assertStringContainsString( '&lt;b&gt;x&lt;/b&gt;', $html );

		ob_start();
		GRP_Admin_Import_Export::render_import();
		$form = ob_get_clean();
		$this->assertStringContainsString( 'name="_wpnonce"', $form );
		$this->assertStringContainsString( 'grp_import_file', $form );
	}
}
