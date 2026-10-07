<?php
/**
 * Tests for client requests (SPEC.md 6.15, designs DP-B and DP-G): asking, statuses, the thread,
 * what the client sent, deleting, /sync and the purge with the project.
 *
 * @package GridRankers_Portal
 */

/**
 * Client requests over REST, permissions enforced on the server.
 */
class Test_GRP_Client_Requests extends GRP_REST_TestCase {

	/**
	 * Adds a request as someone.
	 *
	 * @param string $handle  Who.
	 * @param array  $project Project.
	 * @param array  $params  Extra params.
	 * @return WP_REST_Response
	 */
	private function ask( $handle, array $project, array $params = array() ) {
		return $this->api_as( $handle, 'POST', "/projects/{$project['id']}/client-requests", $params + array( 'title' => 'New GBP images' ) );
	}

	/**
	 * The thread of a request, oldest first.
	 *
	 * @param string $id Request id.
	 * @return array[]
	 */
	private function thread( $id ) {
		return GRP_Store::find( 'grp_request_messages', array( 'request_id' => $id ), array( 'order_by' => 'created_at' ) );
	}

	/**
	 * A stored file row to attach.
	 *
	 * @return array
	 */
	private function file() {
		return GRP_Store::insert(
			'grp_files',
			array(
				'name'       => 'storefront.jpg',
				'mime'       => 'image/jpeg',
				'size'       => 1200,
				'path'       => 'x/storefront.jpg',
				'created_by' => $this->team['lead']['id'],
			)
		);
	}

	public function test_everyone_asks_and_the_profile_lock_applies() {
		$project = $this->project();

		foreach ( array( 'admin', 'lead', 'member' ) as $who ) {
			$this->assertStatus( 201, $this->ask( $who, $project ) );
			$this->assertTrue( GRP_Permissions::can( $this->team[ $who ], GRP_Permissions::CLIENT_REQUEST ) );
		}
		$row = $this->ask(
			'member',
			$project,
			array(
				'kind'    => 'images',
				'details' => 'Storefront and team',
			)
		)->get_data();
		$this->assertSame( 'needed', $row['status'] );
		$this->assertSame( 'images', $row['kind'] );
		$this->assertSame( $this->team['member']['id'], $row['created_by'] );
		$this->assertSame( array(), $this->thread( $row['id'] ), 'no status line for a new Needed request' );

		$this->assertStatus( 400, $this->ask( 'member', $project, array( 'title' => '  ' ) ) );
		$this->assertSame( 'other', $this->ask( 'member', $project, array( 'kind' => 'bogus' ) )->get_data()['kind'] );
		$this->assertStatus( 404, $this->api_as( 'member', 'POST', '/projects/nope/client-requests', array( 'title' => 'x' ) ) );

		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'location' => null ) );
		$this->assertSame( 'grp_profile_incomplete', $this->ask( 'other', $project )->get_data()['code'] );
		$this->assertSame( 'grp_profile_incomplete', $this->api_as( 'other', 'PATCH', "/client-requests/{$row['id']}", array( 'status' => 'done' ) )->get_data()['code'] );
		$this->assertSame( 'grp_profile_incomplete', $this->api_as( 'other', 'POST', "/client-requests/{$row['id']}/messages", array( 'body' => 'hi' ) )->get_data()['code'] );
		$this->assertSame( 'needed', GRP_Store::get( 'grp_client_requests', $row['id'] )['status'], 'refused calls changed nothing' );

		$this->as_nobody();
		$this->assertStatus( 401, $this->api( 'POST', "/projects/{$project['id']}/client-requests", array( 'title' => 'x' ) ) );
	}

	public function test_status_changes_are_lines_in_the_thread() {
		$project = $this->project();
		$row     = $this->ask(
			'lead',
			$project,
			array(
				'status' => 'asked',
				'via'    => 'email',
			)
		)->get_data();
		$this->assertSame( 'asked', $row['status'] );
		$this->assertSame( 'email', $row['asked_via'] );
		$this->assertSame( $this->team['lead']['id'], $row['asked_by'] );
		$this->assertNotEmpty( $row['asked_at'] );
		$thread = $this->thread( $row['id'] );
		$this->assertCount( 1, $thread );
		$this->assertSame( array( 'asked', 'email' ), array( $thread[0]['event'], $thread[0]['via'] ) );

		// A Team Member marks it done; the same status again adds nothing.
		$done = $this->api_as( 'member', 'PATCH', "/client-requests/{$row['id']}", array( 'status' => 'done' ) )->get_data();
		$this->assertSame( 'done', $done['status'] );
		$this->assertSame( $this->team['member']['id'], $done['done_by'] );
		$this->api_as( 'member', 'PATCH', "/client-requests/{$row['id']}", array( 'status' => 'done' ) );
		$this->assertCount( 2, $this->thread( $row['id'] ) );

		// Back to Needed clears done; title and type change without a line.
		$back = $this->api_as(
			'member',
			'PATCH',
			"/client-requests/{$row['id']}",
			array(
				'status' => 'needed',
				'title'  => 'Fresh photos',
				'kind'   => 'images',
			)
		)->get_data();
		$this->assertSame( array( 'needed', null, 'Fresh photos', 'images' ), array( $back['status'], $back['done_at'], $back['title'], $back['kind'] ) );
		$this->assertSame( array( 'asked', 'done', 'needed' ), array_column( $this->thread( $row['id'] ), 'event' ) );

		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', "/client-requests/{$row['id']}", array( 'status' => 'lost' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', "/client-requests/{$row['id']}", array( 'title' => '' ) ) );
		$this->assertStatus( 404, $this->api_as( 'member', 'PATCH', '/client-requests/nope', array( 'status' => 'done' ) ) );
	}

	public function test_messages_and_what_the_client_sent() {
		$project = $this->project();
		$row     = $this->ask( 'lead', $project, array( 'status' => 'asked' ) )->get_data();
		$file    = $this->file();

		$this->assertStatus( 400, $this->api_as( 'member', 'POST', "/client-requests/{$row['id']}/messages", array( 'body' => ' ' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', "/client-requests/{$row['id']}/messages", array( 'files' => array( 'missing' ) ) ) );

		$res = $this->api_as( 'member', 'POST', "/client-requests/{$row['id']}/messages", array( 'body' => 'Any news?' ) );
		$this->assertStatus( 201, $res );
		$this->assertSame( 0, $res->get_data()['message']['from_client'] );
		$this->assertSame( 'asked', $res->get_data()['request']['status'], 'a team message leaves the status' );

		// Pasting the client's reply with a photo → Received, with a status line.
		$res = $this->api_as(
			'lead',
			'POST',
			"/client-requests/{$row['id']}/messages",
			array(
				'body'        => 'Here they are',
				'files'       => array( $file['id'] ),
				'from_client' => true,
				'via'         => 'whatsapp',
			)
		)->get_data();
		$this->assertSame( 1, $res['message']['from_client'] );
		$this->assertSame( 'whatsapp', $res['message']['via'] );
		$this->assertSame( 'storefront.jpg', $res['message']['files'][0]['name'] );
		$this->assertSame( 'received', $res['request']['status'] );
		$this->assertSame( array( 'asked', null, null, 'received' ), array_column( $this->thread( $row['id'] ), 'event' ) );

		// More from the client once it's Received keeps the status.
		$this->api_as(
			'member',
			'POST',
			"/client-requests/{$row['id']}/messages",
			array(
				'body'        => 'One more',
				'from_client' => true,
			)
		);
		$this->assertCount( 5, $this->thread( $row['id'] ) );

		// Deleting a message: its writer or the Super Admin; status lines stay.
		$mine = $res['message']['id'];
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/request-messages/{$mine}" ) );
		$gone = $this->api_as( 'lead', 'DELETE', "/request-messages/{$mine}" )->get_data();
		$this->assertSame( array( '', array() ), array( $gone['body'], $gone['files'] ) );
		$this->assertNotEmpty( $gone['deleted_at'] );
		$event = $this->thread( $row['id'] )[0];
		$this->assertStatus( 404, $this->api_as( 'admin', 'DELETE', "/request-messages/{$event['id']}" ) );
	}

	public function test_only_the_asker_or_the_super_admin_deletes_a_request() {
		$project = $this->project();
		$row     = $this->ask( 'member', $project )->get_data();
		$this->api_as( 'member', 'POST', "/client-requests/{$row['id']}/messages", array( 'body' => 'hello' ) );

		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', "/client-requests/{$row['id']}" ) );
		$this->assertStatus( 403, $this->api_as( 'other', 'DELETE', "/client-requests/{$row['id']}" ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::DELETE_CLIENT_REQUEST, array( 'request' => $row ) ) );
		$this->assertTrue( GRP_Permissions::can( $this->team['admin'], GRP_Permissions::DELETE_CLIENT_REQUEST, array( 'request' => $row ) ) );

		$since = GRP_Ids::now();
		$this->assertStatus( 200, $this->api_as( 'member', 'DELETE', "/client-requests/{$row['id']}" ) );
		$this->assertNull( GRP_Store::get( 'grp_client_requests', $row['id'] ) );
		$this->assertSame( array(), $this->thread( $row['id'] ), 'its thread goes too' );

		$other = $this->ask( 'lead', $project )->get_data();
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/client-requests/{$other['id']}" ) );

		$sync = $this->api_as( 'other', 'GET', '/sync', array( 'since' => $since ) )->get_data();
		$this->assertContains(
			array(
				'table' => 'client_requests',
				'id'    => $row['id'],
			),
			$sync['deletions']
		);
	}

	public function test_everyone_gets_them_through_sync_and_they_go_with_the_project() {
		$project = $this->project();
		$row     = $this->ask( 'lead', $project, array( 'status' => 'asked' ) )->get_data();

		$sync = $this->api_as( 'member', 'GET', '/sync' )->get_data();
		$this->assertSame( array( $row['id'] ), array_column( $sync['changes']['client_requests'], 'id' ) );
		$this->assertSame( 'asked', $sync['changes']['request_messages'][0]['event'] );

		$this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" );
		$this->assertNotNull( GRP_Store::get( 'grp_client_requests', $row['id'] ), 'kept while the project can be restored' );
		$entry = GRP_Store::find( 'grp_trash', array( 'doc_id' => $project['id'] ) )[0];
		$this->api_as( 'admin', 'DELETE', "/trash/{$entry['id']}" );
		$this->assertNull( GRP_Store::get( 'grp_client_requests', $row['id'] ) );
		$this->assertSame( array(), $this->thread( $row['id'] ) );
	}
}
