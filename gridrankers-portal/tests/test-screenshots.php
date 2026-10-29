<?php
/**
 * Tests for screenshots on the server (SPEC.md 6.23, step 108).
 *
 * @package GridRankers_Portal
 */

/**
 * The setting, uploads from the desktop app, who sees them, delete and removal.
 */
class Test_GRP_Screenshots extends GRP_REST_TestCase {

	/**
	 * Temporary files.
	 *
	 * @var string[]
	 */
	private $temp = array();

	/**
	 * Max's time entry.
	 *
	 * @var array
	 */
	private $entry;

	public function set_up() {
		parent::set_up();
		delete_option( GRP_Link::OPTION );
		GRP_Link::set_tracker( 'https://bot.gridrankers.com', str_repeat( 'a', 64 ) );
		GRP_REST_People::set_setting( GRP_Screenshots::KEY, array( 'every' => 10 ) );
		add_filter(
			'grp_files_move',
			static function ( $moved, $tmp, $dest ) {
				return copy( $tmp, $dest );
			},
			10,
			3
		);
		$this->entry = GRP_Store::insert(
			'grp_time_entries',
			array(
				'id'         => 'ENTRY0000000000000000001',
				'member_id'  => $this->team['member']['id'],
				'day'        => GRP_Cycles::today(),
				'started_at' => GRP_Ids::now( time() - 3600 ),
				'ended_at'   => null,
				'source'     => 'desktop',
			)
		);
	}

	public function tear_down() {
		remove_all_filters( 'grp_files_move' );
		foreach ( GRP_Store::find( GRP_Screenshots::TABLE ) as $row ) {
			GRP_Screenshots::delete( $row );
		}
		foreach ( $this->temp as $path ) {
			if ( file_exists( $path ) ) {
				unlink( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
			}
		}
		delete_option( GRP_Link::OPTION );
		delete_option( GRP_Link::KEY_OPTION );
		parent::tear_down();
	}

	/**
	 * A real JPEG (or other bytes).
	 *
	 * @param string|null $bytes Content, or null for a picture.
	 * @return string Path.
	 */
	private function picture( $bytes = null ) {
		$tmp          = wp_tempnam( 'shot.jpg' );
		$this->temp[] = $tmp;
		if ( null === $bytes ) {
			$img = imagecreatetruecolor( 64, 40 );
			imagejpeg( $img, $tmp );
			imagedestroy( $img );
		} else {
			file_put_contents( $tmp, $bytes ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		}

		return $tmp;
	}

	/**
	 * Uploads a screenshot as someone.
	 *
	 * @param string      $handle   Who.
	 * @param string      $id       Screenshot id.
	 * @param string|null $taken_at When (default: now).
	 * @param string|null $file     Path (default: a picture).
	 * @param string|null $entry    Entry id.
	 * @return WP_REST_Response
	 */
	private function upload( $handle, $id = 'SHOT00000000000000000001', $taken_at = null, $file = null, $entry = null ) {
		$this->act_as( $handle );
		$file    = $file ?? $this->picture();
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/time-entries/' . ( $entry ?? $this->entry['id'] ) . '/screenshots' );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		$request->set_body_params(
			array(
				'id'       => $id,
				'taken_at' => $taken_at ?? GRP_Ids::now(),
			)
		);
		$request->set_file_params(
			array(
				'file' => array(
					'name'     => 'shot.jpg',
					'tmp_name' => $file,
					'size'     => filesize( $file ),
					'error'    => 0,
				),
			)
		);

		return rest_get_server()->dispatch( $request );
	}

	public function test_the_setting_is_the_super_admins_on_a_tracker_portal() {
		$this->assertSame( 10, GRP_Screenshots::every() );
		$this->assertStatus( 403, $this->api_as( 'lead', 'PUT', '/settings/screenshots', array( 'every' => 5 ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', '/settings/screenshots', array( 'every' => 7 ) ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'PUT', '/settings/screenshots', array( 'every' => 0 ) ) );
		$this->assertSame( 0, GRP_Screenshots::every() );

		// The desktop app gets it with its schedule.
		$this->api_as( 'admin', 'PUT', '/settings/screenshots', array( 'every' => 15 ) );
		$this->assertSame( 15, GRP_REST_Auth::device_payload( $this->team['member'], 1 )['screenshots'] );
		$this->assertSame( 15, $this->api_as( 'member', 'GET', '/timer/schedule' )->get_data()['screenshots'] );

		// Anywhere but a tracker portal there are none.
		GRP_Link::set_alone();
		$this->assertSame( 0, GRP_Screenshots::every() );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', '/settings/screenshots', array( 'every' => 10 ) ) );
	}

	public function test_the_desktop_app_uploads_once() {
		$res = $this->upload( 'member' );
		$this->assertStatus( 201, $res );
		$this->assertSame( 'saved', $res->get_data()['status'] );
		$this->assertSame( 64, $res->get_data()['screenshot']['width'] );
		$this->assertArrayNotHasKey( 'path', $res->get_data()['screenshot'] );

		$again = $this->upload( 'member' );
		$this->assertStatus( 200, $again );
		$this->assertSame( 'exists', $again->get_data()['status'] );
		$this->assertCount( 1, GRP_Store::find( GRP_Screenshots::TABLE ) );

		$row  = GRP_Store::get( GRP_Screenshots::TABLE, 'SHOT00000000000000000001' );
		$path = GRP_Screenshots::path( $row );
		$this->assertFileExists( $path );
		$this->assertStringContainsString( '/grp-private/shots/', $path );
	}

	public function test_uploads_are_checked() {
		// Not a picture.
		$this->assertStatus( 400, $this->upload( 'member', 'SHOT00000000000000000002', null, $this->picture( 'not an image' ) ) );
		// Too big.
		$this->assertStatus( 413, $this->upload( 'member', 'SHOT00000000000000000003', null, $this->picture( str_repeat( 'x', GRP_Screenshots::MAX_BYTES + 1 ) ) ) );
		// Not while the timer ran.
		$this->assertStatus( 400, $this->upload( 'member', 'SHOT00000000000000000004', GRP_Ids::now( time() - 7200 ) ) );
		// Someone else's timer.
		$this->assertStatus( 403, $this->upload( 'other', 'SHOT00000000000000000005' ) );
		// A bad id.
		$this->assertStatus( 400, $this->upload( 'member', 'x' ) );
		// Screenshots off.
		GRP_REST_People::set_setting( GRP_Screenshots::KEY, array( 'every' => 0 ) );
		$off = $this->upload( 'member', 'SHOT00000000000000000006' );
		$this->assertSame( 'grp_screenshots_off', $off->get_data()['code'] );
		$this->assertCount( 0, GRP_Store::find( GRP_Screenshots::TABLE ) );
	}

	public function test_who_sees_them() {
		$this->upload( 'member' );
		$day = GRP_Cycles::today();
		foreach ( array(
			'member' => 200,
			'lead'   => 200,
			'admin'  => 200,
			'other'  => 403,
		) as $who => $status ) {
			$res = $this->api_as(
				$who,
				'GET',
				'/screenshots',
				array(
					'member' => $this->team['member']['id'],
					'day'    => $day,
				)
			);
			$this->assertStatus( $status, $res );
			if ( 200 === $status ) {
				$this->assertSame( array( 'SHOT00000000000000000001' ), wp_list_pluck( $res->get_data()['screenshots'], 'id' ) );
			}
			$this->assertStatus( $status, $this->api_as( $who, 'GET', '/screenshots/SHOT00000000000000000001' ) );
		}

		// A Team Leader doesn't see another Team Leader's.
		$lead_entry = GRP_Store::insert(
			'grp_time_entries',
			array(
				'id'         => 'ENTRY0000000000000000002',
				'member_id'  => $this->team['lead']['id'],
				'day'        => $day,
				'started_at' => GRP_Ids::now( time() - 600 ),
			)
		);
		$this->assertStatus( 201, $this->upload( 'lead', 'SHOT00000000000000000007', null, null, $lead_entry['id'] ) );
		$this->assertTrue(
			GRP_Permissions::can(
				$this->team['lead'],
				GRP_Permissions::VIEW_SCREENSHOTS,
				array(
					'member_id' => $this->team['lead']['id'],
					'role'      => 'lead',
				)
			)
		);
		$this->assertFalse(
			GRP_Permissions::can(
				$this->team['lead'],
				GRP_Permissions::VIEW_SCREENSHOTS,
				array(
					'member_id' => 'other-lead',
					'role'      => 'lead',
				)
			)
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/screenshots/SHOT00000000000000000007' ) );
	}

	public function test_only_the_super_admin_deletes_one() {
		$this->upload( 'member' );
		$path = GRP_Screenshots::path( GRP_Store::get( GRP_Screenshots::TABLE, 'SHOT00000000000000000001' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', '/screenshots/SHOT00000000000000000001' ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', '/screenshots/SHOT00000000000000000001' ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', '/screenshots/SHOT00000000000000000001' ) );
		$this->assertNull( GRP_Store::get( GRP_Screenshots::TABLE, 'SHOT00000000000000000001' ) );
		$this->assertFileDoesNotExist( $path );
	}

	public function test_deleting_the_time_entry_deletes_its_screenshots() {
		$this->upload( 'member' );
		GRP_Time_Entries::stop( $this->entry, GRP_Ids::now() );
		GRP_Time_Entries::delete( GRP_Store::get( 'grp_time_entries', $this->entry['id'] ), $this->team['member']['id'] );
		$this->assertCount( 0, GRP_Store::find( GRP_Screenshots::TABLE ) );
	}

	public function test_kept_30_days() {
		$this->upload( 'member' );
		$this->assertSame( 0, GRP_Screenshots::purge( GRP_Ids::now( time() + 29 * DAY_IN_SECONDS ) ) );
		$this->assertSame( 1, GRP_Screenshots::purge( GRP_Ids::now( time() + 31 * DAY_IN_SECONDS ) ) );
		$this->assertCount( 0, GRP_Store::find( GRP_Screenshots::TABLE ) );
	}

	public function test_the_desktop_app_uploads_with_its_device_token() {
		add_filter( 'pre_http_request', array( $this, 'main_says_max' ), 10, 3 );
		$device = GRP_Auth::device_login( 'MEMBERCODE1', '127.0.0.1', 'Laptop', 'win32', '1.0.0' );
		remove_filter( 'pre_http_request', array( $this, 'main_says_max' ), 10 );
		$this->assertIsArray( $device );

		$this->as_nobody();
		$file    = $this->picture();
		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/time-entries/' . $this->entry['id'] . '/screenshots' );
		$request->set_header( 'Authorization', 'Bearer ' . $device['token'] );
		$request->set_body_params(
			array(
				'id'       => 'SHOT00000000000000000009',
				'taken_at' => GRP_Ids::now(),
			)
		);
		$request->set_file_params(
			array(
				'file' => array(
					'name'     => 'shot.jpg',
					'tmp_name' => $file,
					'size'     => filesize( $file ),
					'error'    => 0,
				),
			)
		);
		$this->assertStatus( 201, rest_get_server()->dispatch( $request ) );

		// A device token can't list or open them: that is the portal's.
		$list = new WP_REST_Request( 'GET', '/gr-portal/v1/screenshots' );
		$list->set_header( 'Authorization', 'Bearer ' . $device['token'] );
		$this->assertSame( 403, rest_get_server()->dispatch( $list )->get_status() );
	}

	/**
	 * The tracker portal asks the main portal whose code it is: answered here for the device test.
	 *
	 * @param mixed  $pre  Short-circuit.
	 * @param array  $args Args.
	 * @param string $url  URL.
	 * @return array
	 */
	public function main_says_max( $pre, $args, $url ) {
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( array( 'member_id' => $this->team['member']['id'] ) ),
			'response' => array(
				'code'    => 200,
				'message' => '',
			),
			'cookies'  => array(),
		);
	}
}
