<?php
/**
 * Submission files, editing and comments (SPEC.md 6.6, designs SF-A / SF-B).
 *
 * @package GridRankers_Portal
 */

/**
 * POST /files, GET /files/{id}, records' submission and POST/DELETE /comments.
 */
class Test_GRP_Files_Comments extends GRP_REST_TestCase {

	/**
	 * Project.
	 *
	 * @var array
	 */
	private $project;

	/**
	 * Temporary files to remove.
	 *
	 * @var string[]
	 */
	private $temp = array();

	public function set_up() {
		parent::set_up();
		$this->project = $this->project();
		// Uploads in tests are not real HTTP uploads, so copy instead of move_uploaded_file().
		add_filter(
			'grp_files_move',
			static function ( $moved, $tmp, $dest ) {
				return copy( $tmp, $dest );
			},
			10,
			3
		);
	}

	public function tear_down() {
		remove_all_filters( 'grp_files_move' );
		foreach ( $this->temp as $path ) {
			if ( $path && file_exists( $path ) ) {
				unlink( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink
			}
		}
		parent::tear_down();
	}

	/**
	 * Uploads a file as a member.
	 *
	 * @param string $handle  Member handle.
	 * @param string $name    File name.
	 * @param string $content Bytes.
	 * @param int    $size    Reported size (defaults to the real one).
	 * @return WP_REST_Response
	 */
	private function upload( $handle, $name, $content, $size = null ) {
		$this->act_as( $handle );
		$tmp          = wp_tempnam( $name );
		$this->temp[] = $tmp;
		file_put_contents( $tmp, $content ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents

		$request = new WP_REST_Request( 'POST', '/gr-portal/v1/files' );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		$request->set_file_params(
			array(
				'file' => array(
					'name'     => $name,
					'tmp_name' => $tmp,
					'size'     => $size ?? strlen( $content ),
					'error'    => 0,
				),
			)
		);

		return rest_get_server()->dispatch( $request );
	}

	/**
	 * A tiny real PDF.
	 *
	 * @return string
	 */
	private function pdf() {
		return "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
	}

	/**
	 * Meeting task done by the member (assigned to them).
	 *
	 * @param array $extra Extra completion fields.
	 * @return array
	 */
	private function done_task( array $extra = array() ) {
		$task = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Add citations',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$done = $this->api_as(
			'member',
			'POST',
			"/meeting-tasks/{$task['id']}/status",
			$extra + array(
				'status' => 'done',
				'note'   => 'Added 10 citations',
			)
		);
		$this->assertStatus( 200, $done );

		return $done->get_data();
	}

	public function test_upload_attach_and_download() {
		$up = $this->upload( 'member', 'report.pdf', $this->pdf() );
		$this->assertStatus( 201, $up );
		$file = $up->get_data();
		$this->assertSame( 'report.pdf', $file['name'] );
		$this->assertSame( 'application/pdf', $file['mime'] );
		$this->assertSame( array( 'id', 'mime', 'name', 'size' ), array_keys( $file ) );

		$row  = GRP_Store::get( 'grp_files', $file['id'] );
		$path = GRP_Files::path( $row );
		$this->assertNotNull( $path );
		$this->temp[] = $path;
		$this->assertStringNotContainsString( 'report', basename( $path ), 'stored under a random name' );
		$this->assertFileExists( dirname( $path, 3 ) . '/.htaccess', 'the folder refuses direct requests' );

		$task = $this->done_task( array( 'files' => array( $file['id'] ) ) );
		$this->assertSame( array( $file ), $task['completion']['files'] );

		$this->assertStatus( 200, $this->api_as( 'other', 'GET', "/files/{$file['id']}" ), 'any team member can open it' );
		$this->as_nobody();
		$this->assertStatus( 401, $this->api( 'GET', "/files/{$file['id']}" ) );
		$this->assertStatus( 404, $this->api_as( 'member', 'GET', '/files/ghost' ) );
	}

	public function test_upload_checks_type_size_and_profile() {
		$this->assertSame( 'grp_file', $this->upload( 'member', 'run.php', '<?php echo 1;' )->get_data()['code'] );
		$this->assertSame( 'grp_file', $this->upload( 'member', 'fake.pdf', '<?php echo 1;' )->get_data()['code'], 'content must match the type' );
		$this->assertStatus( 400, $this->upload( 'member', 'big.pdf', $this->pdf(), GRP_Files::MAX_BYTES + 1 ) );
		$this->assertStatus( 400, $this->upload( 'member', 'empty.txt', '' ) );
		$this->assertStatus( 201, $this->upload( 'member', 'notes.txt', 'plain notes' ) );

		GRP_Store::update( 'grp_members', $this->team['member']['id'], array( 'phone' => '' ) );
		$this->assertSame( 'grp_profile_incomplete', $this->upload( 'member', 'notes.txt', 'plain notes' )->get_data()['code'] );
	}

	public function test_submission_limits() {
		$links = array_map(
			static function ( $i ) {
				return "https://example.com/$i";
			},
			range( 1, 11 )
		);
		$task  = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Too many links',
			)
		)->get_data();
		$url   = "/meeting-tasks/{$task['id']}/status";
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				$url,
				array(
					'status' => 'done',
					'note'   => 'Done',
					'links'  => $links,
				)
			)
		);
		$this->assertStatus(
			400,
			$this->api_as(
				'lead',
				'POST',
				$url,
				array(
					'status' => 'done',
					'note'   => 'Done',
					'links'  => array( 'ftp://example.com' ),
				)
			)
		);
	}

	public function test_comments() {
		$task = $this->done_task();
		$body = array(
			'kind' => 'item',
			'id'   => $task['id'],
			'body' => 'Two sites still waiting for confirmation',
		);

		$mine = $this->api_as( 'member', 'POST', '/comments', $body );
		$this->assertStatus( 201, $mine );
		$this->assertSame( 'item', $mine->get_data()['ref_kind'] );
		$this->assertSame( $this->project['id'], $mine->get_data()['project_id'] );
		$this->assertStatus( 201, $this->api_as( 'lead', 'POST', '/comments', array( 'body' => 'Add the Yelp screenshot' ) + $body ) );
		$this->assertStatus( 403, $this->api_as( 'other', 'POST', '/comments', $body ), 'not on the task' );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/comments', array( 'body' => '' ) + $body ) );

		$file         = $this->upload( 'member', 'yelp.png', base64_decode( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' ) )->get_data(); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		$this->temp[] = GRP_Files::path( GRP_Store::get( 'grp_files', $file['id'] ) );
		$only_file    = $this->api_as(
			'member',
			'POST',
			'/comments',
			array(
				'body'  => '',
				'files' => array( $file['id'] ),
			) + $body
		);
		$this->assertStatus( 201, $only_file );
		$this->assertSame( array( $file ), $only_file->get_data()['files'] );

		// Everyone gets comments with the sync.
		$synced = $this->api_as( 'other', 'GET', '/sync' )->get_data()['changes']['comments'];
		$this->assertCount( 3, $synced );

		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', '/comments/' . $mine->get_data()['id'] ), 'only the author (or the Super Admin)' );
		$gone = $this->api_as( 'member', 'DELETE', '/comments/' . $mine->get_data()['id'] );
		$this->assertStatus( 200, $gone );
		$this->assertSame( '', $gone->get_data()['body'] );
		$this->assertNotEmpty( $gone->get_data()['deleted_at'] );
		$this->assertStatus( 404, $this->api_as( 'member', 'DELETE', '/comments/' . $mine->get_data()['id'] ) );
		$this->assertStatus( 404, $this->api_as( 'member', 'POST', '/comments', array( 'id' => 'ghost' ) + $body ) );
	}

	public function test_reviewer_asked_for_can_comment() {
		$task = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'Content plan',
			)
		)->get_data();
		$this->api_as(
			'lead',
			'POST',
			"/meeting-tasks/{$task['id']}/status",
			array(
				'status'   => 'done',
				'note'     => 'Plan ready',
				'reviewer' => $this->team['other']['id'],
			)
		);
		$body = array(
			'kind' => 'item',
			'id'   => $task['id'],
			'body' => 'Looks good',
		);
		$this->assertStatus( 201, $this->api_as( 'other', 'POST', '/comments', $body ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/comments', $body ) );
	}

	public function test_record_submission_and_comments() {
		$task   = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $this->project['id'],
				'title'      => 'GBP post',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$period = GRP_Cycles::cycle_range( $this->project, 0, GRP_Cycles::today() )['key'];
		$at     = array(
			'taskId'    => $task['id'],
			'periodKey' => $period,
		);

		$this->assertSame( 'grp_no_submission', $this->api_as( 'member', 'PATCH', '/records/submission', $at + array( 'note' => 'Early' ) )->get_data()['code'] );
		$rec = $this->api_as(
			'member',
			'POST',
			'/records/status',
			$at + array(
				'status'  => 'done',
				'note'    => 'Posted the offer',
				'comment' => 'Used the October photo',
			)
		)->get_data()['record'];
		$this->assertSame( 'Used the October photo', $rec['completion']['comment'] );

		$edited = $this->api_as( 'member', 'PATCH', '/records/submission', $at + array( 'note' => 'Posted the offer and a photo' ) );
		$this->assertStatus( 200, $edited );
		$this->assertSame( 'Posted the offer and a photo', $edited->get_data()['record']['completion']['note'] );
		$this->assertStatus( 403, $this->api_as( 'other', 'PATCH', '/records/submission', $at + array( 'note' => 'Not mine' ) ) );

		$this->assertStatus(
			201,
			$this->api_as(
				'member',
				'POST',
				'/comments',
				array(
					'kind' => 'record',
					'id'   => $rec['id'],
					'body' => 'Photo is in the Drive',
				)
			)
		);
	}
}
