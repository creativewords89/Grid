<?php
/**
 * Tests for files added with a task (SPEC.md 6.17): meeting tasks and monthly tasks.
 *
 * @package GridRankers_Portal
 */

/**
 * Attachments on tasks over REST.
 */
class Test_GRP_Task_Files extends GRP_REST_TestCase {

	/**
	 * A stored file row.
	 *
	 * @param string $name File name.
	 * @return array
	 */
	private function file( $name = 'brief.pdf' ) {
		return GRP_Store::insert(
			'grp_files',
			array(
				'name'       => $name,
				'mime'       => 'application/pdf',
				'size'       => 2048,
				'path'       => 'x/' . $name,
				'created_by' => $this->team['member']['id'],
			)
		);
	}

	public function test_files_are_added_with_a_meeting_task() {
		$project = $this->project();
		$brief   = $this->file();
		$res     = $this->api_as(
			'member',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'New About page',
				'files'      => array( $brief['id'] ),
			)
		);
		$this->assertStatus( 201, $res );
		$task = $res->get_data();
		$this->assertSame(
			array(
				array(
					'id'   => $brief['id'],
					'mime' => 'application/pdf',
					'name' => 'brief.pdf',
					'size' => 2048,
				),
			),
			$task['files']
		);

		// A file that isn't uploaded is refused; a leader removes or adds files on Edit.
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'POST',
				'/meeting-tasks',
				array(
					'project_id' => $project['id'],
					'title'      => 'x',
					'files'      => array( 'missing' ),
				)
			)
		);
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/meeting-tasks/{$task['id']}", array( 'files' => array() ) ) );
		$more = $this->file( 'photos.pdf' );
		$edit = $this->api_as( 'lead', 'PATCH', "/meeting-tasks/{$task['id']}", array( 'files' => array( $more['id'] ) ) )->get_data();
		$this->assertSame( array( 'photos.pdf' ), wp_list_pluck( $edit['files'], 'name' ) );
		$this->assertSame( array( 'photos.pdf' ), wp_list_pluck( GRP_Export::meeting_task( $edit )['files'], 'name' ) );

		// Profile lock: no task, no upload.
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'location' => null ) );
		$this->assertSame(
			'grp_profile_incomplete',
			$this->api_as(
				'other',
				'POST',
				'/meeting-tasks',
				array(
					'project_id' => $project['id'],
					'title'      => 'y',
					'files'      => array( $brief['id'] ),
				)
			)->get_data()['code']
		);
	}

	public function test_files_are_added_with_a_monthly_task() {
		$project = $this->project();
		$sheet   = $this->file( 'keywords.pdf' );
		$res     = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Blog posts',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
				'files'      => array( $sheet['id'] ),
			)
		);
		$this->assertStatus( 201, $res );
		$this->assertSame( array( 'keywords.pdf' ), wp_list_pluck( $res->get_data()['files'], 'name' ) );
		$this->assertSame( array( 'keywords.pdf' ), wp_list_pluck( GRP_Export::monthly_task( $res->get_data() )['files'], 'name' ) );
	}
}
