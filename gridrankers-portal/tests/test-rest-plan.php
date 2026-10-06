<?php
/**
 * Tests for a project's Details tab and keyword checklist (SPEC.md 6.12): PUT /projects/{id}/details,
 * PUT /projects/{id}/keyword-columns, POST /projects/{id}/keywords, PATCH and DELETE /keywords/{id}.
 *
 * @package GridRankers_Portal
 */

/**
 * Details and keywords over REST, permissions enforced on the server.
 */
class Test_GRP_REST_Plan extends GRP_REST_TestCase {

	/**
	 * Details with one section and two links.
	 *
	 * @return array
	 */
	private function details() {
		return array(
			'sections' => array(
				array(
					'title' => 'About',
					'text'  => 'Family plumbing company in Dhaka.',
					'links' => array(
						array(
							'title' => 'Keyword research',
							'url'   => 'https://docs.google.com/spreadsheets/d/abc/edit',
						),
						array(
							'title' => '',
							'url'   => 'https://drive.google.com/drive/folders/xyz',
						),
					),
				),
			),
		);
	}

	public function test_everyone_edits_the_details_and_reads_them() {
		$project = $this->project();
		$path    = "/projects/{$project['id']}/details";

		$this->assertStatus( 200, $this->api_as( 'member', 'PUT', $path, $this->details() ), 'Team Members maintain the Details tab too' );
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'location' => null ) );
		$this->assertSame( 'grp_profile_incomplete', $this->api_as( 'other', 'PUT', $path, $this->details() )->get_data()['code'] );
		$response = $this->api_as( 'lead', 'PUT', $path, $this->details() );
		$this->assertStatus( 200, $response );
		$section = $response->get_data()['details']['sections'][0];
		$this->assertSame( 'About', $section['title'] );
		$this->assertSame( array( 'sheet', 'drive' ), wp_list_pluck( $section['links'], 'kind' ), 'the kind comes from the address' );
		$this->assertSame( 'drive.google.com', $section['links'][1]['title'], 'a link without a name is named after its host' );
		$this->assertNotEmpty( $section['id'] );

		// Everyone gets them through /sync.
		$sync     = $this->api_as( 'member', 'GET', '/sync' )->get_data();
		$projects = array_column( $sync['changes']['projects'], null, 'id' );
		$this->assertSame( 'Family plumbing company in Dhaka.', $projects[ $project['id'] ]['details']['sections'][0]['text'] );

		// Only http(s) links; every section needs a title.
		$bad                                   = $this->details();
		$bad['sections'][0]['links'][0]['url'] = 'javascript:alert(1)';
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', $path, $bad ) );
		$bad                         = $this->details();
		$bad['sections'][0]['title'] = '';
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', $path, $bad ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'PUT', $path, array( 'sections' => array() ) ) );
	}

	public function test_link_kinds() {
		$this->assertSame( 'sheet', GRP_REST_Plan::link_kind( 'https://docs.google.com/spreadsheets/d/1/edit#gid=0' ) );
		$this->assertSame( 'doc', GRP_REST_Plan::link_kind( 'https://docs.google.com/document/d/1/edit' ) );
		$this->assertSame( 'drive', GRP_REST_Plan::link_kind( 'https://drive.google.com/drive/folders/1' ) );
		$this->assertSame( 'other', GRP_REST_Plan::link_kind( 'https://search.google.com/search-console' ) );
	}

	public function test_leaders_add_keywords_and_set_deadlines() {
		$project = $this->project();
		$path    = "/projects/{$project['id']}/keywords";
		$add     = array( 'keywords' => array( 'emergency plumber', ' Emergency Plumber ', '', 'drain cleaning' ) );

		$response = $this->api_as( 'member', 'POST', $path, $add + array( 'deadline' => '2026-10-31' ) );
		$this->assertStatus( 201, $response );
		$rows = $response->get_data();
		$this->assertSame( array( 'emergency plumber', 'drain cleaning' ), wp_list_pluck( $rows, 'keyword' ), 'blank lines and repeats are skipped' );
		$this->assertSame( '2026-10-31', $rows[0]['deadline'] );
		$this->assertSame( array( 1, 2 ), array_map( 'intval', wp_list_pluck( $rows, 'position' ) ) );
		$this->assertSame( 'grp_keywords_none', $this->api_as( 'admin', 'POST', $path, array( 'keywords' => array( 'DRAIN cleaning' ) ) )->get_data()['code'] );

		$id = $rows[0]['id'];
		// Deadline, rename and order: everyone (Team Members included).
		$this->assertSame( '2026-11-30', $this->api_as( 'member', 'PATCH', "/keywords/{$id}", array( 'deadline' => '2026-11-30' ) )->get_data()['deadline'] );
		$this->assertSame( 'drain', $this->api_as( 'member', 'PATCH', "/keywords/{$id}", array( 'keyword' => 'drain' ) )->get_data()['keyword'] );
		$this->assertSame( 'emergency plumber', $this->api_as( 'member', 'PATCH', "/keywords/{$id}", array( 'keyword' => 'emergency plumber' ) )->get_data()['keyword'] );
		$this->assertSame( '2026-11-30', $this->api_as( 'admin', 'PATCH', "/keywords/{$id}", array( 'deadline' => '2026-11-30' ) )->get_data()['deadline'] );
		$this->assertNull( $this->api_as( 'lead', 'PATCH', "/keywords/{$id}", array( 'deadline' => '' ) )->get_data()['deadline'], 'no deadline' );
		$this->assertSame( 'grp_keyword_taken', $this->api_as( 'lead', 'PATCH', "/keywords/{$id}", array( 'keyword' => 'Drain Cleaning' ) )->get_data()['code'] );
		$this->assertSame( 7, (int) $this->api_as( 'lead', 'PATCH', "/keywords/{$id}", array( 'position' => 7 ) )->get_data()['position'] );

		// Removing: everyone; /sync reports the deletion.
		$this->assertStatus( 200, $this->api_as( 'member', 'DELETE', "/keywords/{$id}" ) );
		$this->assertNull( GRP_Store::get( 'grp_keywords', $id ) );
	}

	public function test_everyone_ticks_and_writes_notes() {
		$project = $this->project();
		$row     = $this->api_as( 'lead', 'POST', "/projects/{$project['id']}/keywords", array( 'keywords' => array( 'emergency plumber' ) ) )->get_data()[0];
		$path    = "/keywords/{$row['id']}";

		$ticked = $this->api_as(
			'member',
			'PATCH',
			$path,
			array(
				'check' => array(
					'column' => 'c2',
					'on'     => true,
				),
			)
		);
		$this->assertStatus( 200, $ticked );
		$checks = $ticked->get_data()['checks'];
		$this->assertSame( $this->team['member']['id'], $checks['c2']['by'], 'who ticked it' );
		$this->assertNotEmpty( $checks['c2']['at'] );
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'PATCH',
				$path,
				array(
					'check' => array(
						'column' => 'nope',
						'on'     => true,
					),
				)
			)
		);

		$this->assertSame( 'Need 3 backlinks', $this->api_as( 'other', 'PATCH', $path, array( 'note' => 'Need 3 backlinks' ) )->get_data()['note'] );
		// Everyone unticks (SPEC.md 6.12); an older "ask to untick" request is still answered by anyone.
		$untick = array(
			'check' => array(
				'column' => 'c2',
				'on'     => false,
			),
		);
		$this->assertArrayHasKey( 'c2', (array) GRP_Store::get( 'grp_keywords', $row['id'] )['checks'] );
		$ask   = array(
			'ask_untick' => array(
				'column' => 'c2',
				'note'   => 'Ticked by mistake',
			),
		);
		$asked = $this->api_as( 'other', 'PATCH', $path, $ask )->get_data()['checks']['c2'];
		$this->assertSame( $this->team['member']['id'], $asked['by'], 'still ticked by the first person' );
		$this->assertSame( $this->team['other']['id'], $asked['ask']['by'] );
		$this->assertSame( 'Ticked by mistake', $asked['ask']['note'] );
		$this->assertSame( 'grp_not_ticked', $this->api_as( 'member', 'PATCH', $path, array( 'ask_untick' => array( 'column' => 'c3' ) ) )->get_data()['code'] );
		// Ticking a ticked box changes nothing.
		$again = $this->api_as(
			'other',
			'PATCH',
			$path,
			array(
				'check' => array(
					'column' => 'c2',
					'on'     => true,
				),
			)
		)->get_data()['checks']['c2'];
		$this->assertSame( $this->team['member']['id'], $again['by'] );
		// Keep it ticked (the request is answered), or untick it.
		$kept = $this->api_as( 'member', 'PATCH', $path, array( 'keep' => array( 'column' => 'c2' ) ) )->get_data()['checks']['c2'];
		$this->assertArrayNotHasKey( 'ask', $kept );
		$cleared = $this->api_as( 'other', 'PATCH', $path, $untick )->get_data();
		$this->assertArrayNotHasKey( 'c2', (array) $cleared['checks'] );

		// A Team Member with an incomplete profile can't tick (section 3, Profile lock).
		GRP_Store::update( 'grp_members', $this->team['member']['id'], array( 'location' => null ) );
		$this->assertSame(
			'grp_profile_incomplete',
			$this->api_as(
				'member',
				'PATCH',
				$path,
				array(
					'check' => array(
						'column' => 'c1',
						'on'     => true,
					),
				)
			)->get_data()['code']
		);
	}

	public function test_columns_are_per_project() {
		$project = $this->project();
		$path    = "/projects/{$project['id']}/keyword-columns";
		$columns = array(
			array(
				'id'   => 'c1',
				'name' => 'On-page',
			),
			array( 'name' => 'GBP post' ),
		);

		$saved = $this->api_as( 'member', 'PUT', $path, array( 'columns' => $columns ) )->get_data()['kw_columns'];
		$this->assertSame( array( 'On-page', 'GBP post' ), wp_list_pluck( $saved, 'name' ) );
		$this->assertSame( 'c1', $saved[0]['id'], 'existing ids are kept so ticks stay' );
		$this->assertNotEmpty( $saved[1]['id'] );
		$this->assertStatus( 400, $this->api_as( 'lead', 'PUT', $path, array( 'columns' => array() ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'PUT', $path, array( 'columns' => array( array( 'name' => '' ) ) ) ) );

		// Ticks are checked against the project's own columns now.
		$row = $this->api_as( 'lead', 'POST', "/projects/{$project['id']}/keywords", array( 'keywords' => array( 'kw' ) ) )->get_data()[0];
		$this->assertStatus(
			400,
			$this->api_as(
				'member',
				'PATCH',
				"/keywords/{$row['id']}",
				array(
					'check' => array(
						'column' => 'c2',
						'on'     => true,
					),
				)
			)
		);
		$this->assertStatus(
			200,
			$this->api_as(
				'member',
				'PATCH',
				"/keywords/{$row['id']}",
				array(
					'check' => array(
						'column' => $saved[1]['id'],
						'on'     => true,
					),
				)
			)
		);
	}

	public function test_keywords_go_with_their_project_and_round_trip_the_export() {
		$project = $this->project();
		$this->api_as( 'admin', 'PUT', "/projects/{$project['id']}/details", $this->details() );
		$row = $this->api_as( 'lead', 'POST', "/projects/{$project['id']}/keywords", array( 'keywords' => array( 'kw one' ) ) )->get_data()[0];
		$this->api_as( 'member', 'PATCH', "/keywords/{$row['id']}", array( 'note' => 'hello' ) );

		$export = GRP_Export::build();
		$this->assertSame( 'kw one', $export['data']['keywords'][0]['keyword'] );
		$this->assertSame( 'hello', $export['data']['keywords'][0]['note'] );
		$this->assertSame( 'About', $export['data']['clients'][0]['details']['sections'][0]['title'] );

		GRP_Store::delete( 'grp_keywords', $row['id'] );
		GRP_Store::update( 'grp_projects', $project['id'], array( 'details' => null ) );
		GRP_Import::run( $export );
		$this->assertSame( 'hello', GRP_Store::get( 'grp_keywords', $row['id'] )['note'] );
		$this->assertSame( 'About', GRP_Store::get( 'grp_projects', $project['id'] )['details']['sections'][0]['title'] );

		// Deleted forever from the trash: the checklist goes too.
		$this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" );
		$this->assertNotNull( GRP_Store::get( 'grp_keywords', $row['id'] ), 'kept while the project can be restored' );
		$entry = GRP_Store::find( 'grp_trash', array( 'doc_id' => $project['id'] ) )[0];
		$this->api_as( 'admin', 'DELETE', "/trash/{$entry['id']}" );
		$this->assertNull( GRP_Store::get( 'grp_keywords', $row['id'] ) );
	}
}
