<?php
/**
 * REST tests for /activity, /audit, /trash, /members, /notifications and /sync.
 *
 * @package GridRankers_Portal
 */

/**
 * Team, logging, trash and sync controllers.
 */
class Test_GRP_REST_Team extends GRP_REST_TestCase {

	public function test_log_work_for_self_and_managers_for_anyone() {
		$self = $this->api_as(
			'member',
			'POST',
			'/activity',
			array(
				'minutes' => 45,
				'notes'   => 'Client call',
			)
		);
		$this->assertStatus( 201, $self );
		$this->assertSame( 'manual', $self->get_data()['kind'] );
		$this->assertSame( 'Other work', $self->get_data()['title'] );
		$this->assertSame( 45, $self->get_data()['minutes'] );
		$this->assertSame( $this->team['member']['id'], $self->get_data()['member_id'] );

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/activity', array( 'member_id' => $this->team['other']['id'] ) ) );
		$this->assertStatus( 201, $this->api_as( 'lead', 'POST', '/activity', array( 'member_id' => $this->team['other']['id'] ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/activity', array( 'project_id' => 'nope' ) ) );
	}

	public function test_activity_visibility() {
		$this->api_as( 'member', 'POST', '/activity', array( 'notes' => 'mine' ) );
		$this->api_as( 'other', 'POST', '/activity', array( 'notes' => 'theirs' ) );

		$mine = $this->api_as( 'member', 'GET', '/activity' );
		$this->assertSame( array( 'mine' ), wp_list_pluck( $mine->get_data(), 'notes' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/activity', array( 'member' => $this->team['other']['id'] ) ) );

		$all = $this->api_as( 'lead', 'GET', '/activity' );
		$this->assertCount( 2, $all->get_data() );
		$this->assertCount( 1, $this->api_as( 'lead', 'GET', '/activity', array( 'member' => $this->team['other']['id'] ) )->get_data() );
	}

	public function test_delete_activity_rules() {
		$own   = $this->api_as( 'member', 'POST', '/activity', array( 'notes' => 'mine' ) )->get_data();
		$other = $this->api_as( 'other', 'POST', '/activity', array( 'notes' => 'theirs' ) )->get_data();
		$auto  = GRP_Activity::credit( $this->team['member']['id'], null, 'Blogs', '1/1', 1, 'monthly', 'rec:x' );

		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/activity/{$other['id']}" ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/activity/{$auto['id']}" ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', "/activity/{$other['id']}" ) );
		$this->assertStatus( 200, $this->api_as( 'member', 'DELETE', "/activity/{$own['id']}" ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/activity/{$auto['id']}" ) );
	}

	public function test_audit_filters() {
		$a = $this->project( 'A' );
		$this->project( 'B' );

		$all = $this->api_as( 'member', 'GET', '/audit' );
		$this->assertStatus( 200, $all );
		$this->assertCount( 2, $all->get_data() );

		$only_a = $this->api_as( 'member', 'GET', '/audit', array( 'project' => $a['id'] ) );
		$this->assertCount( 1, $only_a->get_data() );

		$this->assertCount( 0, $this->api_as( 'member', 'GET', '/audit', array( 'to' => '2000-01-01' ) )->get_data() );
		$this->assertStatus( 400, $this->api_as( 'member', 'GET', '/audit', array( 'from' => 'yesterday' ) ) );
	}

	public function test_trash_restore_and_delete_forever() {
		$project  = $this->project();
		$task     = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Restore me',
				'assignees'  => array( array( 'id' => $this->team['member']['id'] ) ),
			)
		)->get_data();
		$trash_id = $this->api_as( 'lead', 'DELETE', "/meeting-tasks/{$task['id']}" )->get_data()['trash_id'];

		$this->assertStatus( 403, $this->api_as( 'member', 'GET', '/trash' ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/trash/$trash_id/restore" ) );
		$this->assertCount( 1, $this->api_as( 'lead', 'GET', '/trash' )->get_data() );

		$restored = $this->api_as( 'lead', 'POST', "/trash/$trash_id/restore" );
		$this->assertStatus( 200, $restored );
		$this->assertSame( $task['id'], $restored->get_data()['id'] );
		$this->assertSame( $task['assignees'], $restored->get_data()['assignees'] );
		$this->assertSame( $task['created_at'], $restored->get_data()['created_at'] );
		$this->assertNull( GRP_Store::get( 'grp_trash', $trash_id ) );
		$this->assertSame( 'restore', GRP_Store::find( 'grp_audit', array( 'kind' => 'restore' ) )[0]['kind'] );

		$trash_id = $this->api_as( 'admin', 'DELETE', "/meeting-tasks/{$task['id']}" )->get_data()['trash_id'];
		$this->assertStatus( 403, $this->api_as( 'member', 'DELETE', "/trash/$trash_id" ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/trash/$trash_id" ) );
		$this->assertStatus( 404, $this->api_as( 'admin', 'POST', "/trash/$trash_id/restore" ) );
	}

	public function test_trash_restore_needs_project_and_purges_after_30_days() {
		$project  = $this->project();
		$task     = $this->api_as(
			'lead',
			'POST',
			'/monthly-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Orphan',
			)
		)->get_data();
		$trash_id = $this->api_as( 'lead', 'DELETE', "/monthly-tasks/{$task['id']}" )->get_data()['trash_id'];
		$this->api_as( 'admin', 'DELETE', "/projects/{$project['id']}" );

		$response = $this->api_as( 'admin', 'POST', "/trash/$trash_id/restore" );
		$this->assertStatus( 409, $response );
		$this->assertSame( 'grp_project_missing', $response->get_data()['code'] );

		GRP_Store::update( 'grp_trash', $trash_id, array( 'deleted_at' => GRP_Ids::now( time() - 31 * DAY_IN_SECONDS ) ) );
		$ids = wp_list_pluck( $this->api_as( 'admin', 'GET', '/trash' )->get_data(), 'id' );
		$this->assertNotContains( $trash_id, $ids );
	}

	public function test_members_list_hides_secrets_and_others_contact_details() {
		GRP_Store::update( 'grp_members', $this->team['other']['id'], array( 'email' => 'olu@example.com' ) );

		$list = $this->api_as( 'member', 'GET', '/members' )->get_data();
		$this->assertCount( 4, $list );
		foreach ( $list as $m ) {
			$this->assertArrayNotHasKey( 'code_hash', $m );
			$this->assertArrayNotHasKey( 'code_salt', $m );
		}
		$other = wp_list_filter( $list, array( 'id' => $this->team['other']['id'] ) );
		$this->assertArrayNotHasKey( 'email', reset( $other ) );

		$lead_view = wp_list_filter( $this->api_as( 'lead', 'GET', '/members' )->get_data(), array( 'id' => $this->team['other']['id'] ) );
		$this->assertSame( 'olu@example.com', reset( $lead_view )['email'] );
	}

	public function test_add_member_roles() {
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/members', array( 'name' => 'New' ) ) );
		$this->assertStatus(
			403,
			$this->api_as(
				'lead',
				'POST',
				'/members',
				array(
					'name' => 'New',
					'role' => 'lead',
				)
			)
		);
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', '/members', array( 'name' => ' ' ) ) );

		$member = $this->api_as( 'lead', 'POST', '/members', array( 'name' => 'Nia New' ) );
		$this->assertStatus( 201, $member );
		$this->assertSame( 'member', $member->get_data()['role'] );
		$this->assertMatchesRegularExpression( '/^#[0-9a-f]{6}$/i', $member->get_data()['color'] );

		$lead = $this->api_as(
			'admin',
			'POST',
			'/members',
			array(
				'name' => 'Lou Lead',
				'role' => 'lead',
			)
		);
		$this->assertSame( 'lead', $lead->get_data()['role'] );

		$this->assertStatus(
			403,
			$this->api_as(
				'admin',
				'POST',
				'/members',
				array(
					'name' => 'Fake Admin',
					'role' => 'admin',
				)
			)
		);
	}

	public function test_profile_and_role_changes() {
		$me    = $this->team['member']['id'];
		$other = $this->team['other']['id'];

		$own = $this->api_as(
			'member',
			'PATCH',
			"/members/$me",
			array(
				'title' => 'SEO specialist',
				'phone' => '0123',
			)
		);
		$this->assertStatus( 200, $own );
		$this->assertSame( 'SEO specialist', $own->get_data()['title'] );

		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/members/$other", array( 'title' => 'Intern' ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'PATCH', "/members/$other", array( 'title' => 'Intern' ) ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'PATCH', "/members/$me", array( 'role' => 'lead' ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'PATCH', "/members/$other", array( 'role' => 'lead' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', "/members/$me", array( 'email' => 'not-an-email' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'PATCH', "/members/$me", array( 'drive_url' => 'javascript:alert(1)' ) ) );

		$promoted = $this->api_as( 'admin', 'PATCH', "/members/$other", array( 'role' => 'lead' ) );
		$this->assertStatus( 200, $promoted );
		$this->assertSame( 'lead', $promoted->get_data()['role'] );
		$this->assertCount( 0, GRP_Store::find( 'grp_sessions', array( 'member_id' => $other ) ), 'role change signs them out' );

		$no_link = $this->api_as( 'admin', 'PATCH', "/members/$me", array( 'role' => 'admin' ) );
		$this->assertStatus( 400, $no_link );
		$this->assertSame( 'grp_admin_needs_wp_admin', $no_link->get_data()['code'] );

		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		$granted  = $this->api_as(
			'admin',
			'PATCH',
			"/members/$me",
			array(
				'wp_user_id' => $wp_admin,
				'role'       => 'admin',
			)
		);
		$this->assertStatus( 200, $granted );
		$this->assertSame( 'admin', $granted->get_data()['role'] );

		$this->assertStatus( 409, $this->api_as( 'admin', 'PATCH', '/members/' . $this->team['admin']['id'], array( 'role' => 'member' ) ) );
	}

	public function test_remove_member() {
		$other = $this->team['other']['id'];

		$this->assertStatus( 403, $this->api_as( 'lead', 'DELETE', "/members/$other" ) );
		$this->assertStatus( 409, $this->api_as( 'admin', 'DELETE', '/members/' . $this->team['admin']['id'] ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'DELETE', "/members/$other" ) );

		$this->assertSame( 0, GRP_Store::get( 'grp_members', $other )['active'] );
		$this->assertCount( 0, GRP_Store::find( 'grp_sessions', array( 'member_id' => $other ) ) );
		$this->assertStatus( 401, $this->api_as( 'other', 'GET', '/projects' ), 'removed members are signed out' );
	}

	public function test_set_code() {
		$member = $this->team['member']['id'];
		$lead   = $this->team['lead']['id'];

		$this->assertStatus( 403, $this->api_as( 'member', 'POST', "/members/$member/code", array( 'code' => 'ABCDEF' ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', "/members/$lead/code", array( 'code' => 'ABCDEF' ) ) );
		$this->assertStatus( 400, $this->api_as( 'lead', 'POST', "/members/$member/code", array( 'code' => 'ABC' ) ) );

		$generated = $this->api_as( 'lead', 'POST', "/members/$member/code", array( 'generate' => true ) );
		$this->assertStatus( 200, $generated );
		$code = $generated->get_data()['code'];
		$this->assertMatchesRegularExpression( '/^[A-Z2-9]{8}$/', $code );

		// Old sessions revoked; the new code works.
		$this->assertStatus( 401, $this->api_as( 'member', 'GET', '/projects' ) );
		$this->as_nobody();
		$this->assertStatus( 200, $this->api( 'POST', '/auth/login', array( 'code' => $code ) ) );

		$this->assertStatus( 200, $this->api_as( 'admin', 'POST', "/members/$lead/code", array( 'code' => 'LEADNEW1' ) ) );
		$audit = GRP_Store::find( 'grp_audit', array( 'doc_id' => $lead ) );
		$this->assertStringNotContainsString( 'LEADNEW1', wp_json_encode( $audit ) );
	}

	public function test_dismiss_notification() {
		$first = $this->api_as( 'member', 'POST', '/notifications/dismiss', array( 'key' => 'urgent:t1' ) );
		$this->assertStatus( 200, $first );
		$this->api_as( 'member', 'POST', '/notifications/dismiss', array( 'key' => 'urgent:t1' ) );
		$this->api_as( 'lead', 'POST', '/notifications/dismiss', array( 'key' => 'urgent:t1' ) );

		$this->assertCount( 1, GRP_Store::find( 'grp_dismissals', array( 'member_id' => $this->team['member']['id'] ) ) );
		$this->assertCount( 2, GRP_Store::find( 'grp_dismissals', array( 'notice_key' => 'urgent:t1' ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'POST', '/notifications/dismiss', array( 'key' => '' ) ) );
	}

	public function test_sync_initial_incremental_and_deletions() {
		$project = $this->project();

		$initial = $this->api_as( 'member', 'GET', '/sync' );
		$this->assertStatus( 200, $initial );
		$this->assertSame( 'no-store', $initial->get_headers()['Cache-Control'] );
		$data = $initial->get_data();
		$this->assertCount( 1, $data['changes']['projects'] );
		$this->assertCount( 4, $data['changes']['members'] );
		$this->assertSame( array(), $data['changes']['trash'], 'members do not get the trash' );
		$this->assertFalse( $data['more'] );

		// Later changes, including a hard delete.
		$since = GRP_Ids::now( time() + 60 );
		$task  = $this->api_as(
			'lead',
			'POST',
			'/meeting-tasks',
			array(
				'project_id' => $project['id'],
				'title'      => 'Fresh',
			)
		)->get_data();
		global $wpdb;
		$wpdb->update( GRP_Install::table( 'grp_meeting_tasks' ), array( 'updated_at' => $since ), array( 'id' => $task['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$log = $this->api_as( 'member', 'POST', '/activity', array( 'notes' => 'temp' ) )->get_data();
		$this->api_as( 'member', 'DELETE', "/activity/{$log['id']}" );
		$wpdb->query( $wpdb->prepare( 'UPDATE %i SET updated_at = %s', GRP_Install::table( 'grp_deletions' ), $since ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		$delta = $this->api_as( 'member', 'GET', '/sync', array( 'since' => $since ) )->get_data();
		$this->assertSame( array( $task['id'] ), wp_list_pluck( $delta['changes']['meeting_tasks'], 'id' ) );
		$this->assertSame( array(), $delta['changes']['projects'] );
		$this->assertContains(
			array(
				'table' => 'activity',
				'id'    => $log['id'],
			),
			$delta['deletions']
		);

		$this->assertStatus( 400, $this->api_as( 'member', 'GET', '/sync', array( 'since' => 'yesterday' ) ) );
	}

	public function test_sync_scopes_activity_and_dismissals_to_member() {
		$this->api_as( 'member', 'POST', '/activity', array( 'notes' => 'mine' ) );
		$this->api_as( 'other', 'POST', '/activity', array( 'notes' => 'theirs' ) );
		$this->api_as( 'other', 'POST', '/notifications/dismiss', array( 'key' => 'k' ) );

		$member = $this->api_as( 'member', 'GET', '/sync' )->get_data()['changes'];
		$this->assertSame( array( 'mine' ), wp_list_pluck( $member['activity'], 'notes' ) );
		$this->assertSame( array(), $member['dismissals'] );

		$lead = $this->api_as( 'lead', 'GET', '/sync' )->get_data()['changes'];
		$this->assertCount( 2, $lead['activity'] );
	}

	public function test_every_portal_route_needs_sign_in() {
		$routes = array_filter(
			array_keys( rest_get_server()->get_routes() ),
			static function ( $route ) {
				return str_starts_with( $route, '/gr-portal/v1/' ) && ! str_starts_with( $route, '/gr-portal/v1/auth/' );
			}
		);
		$this->assertGreaterThan( 20, count( $routes ) );

		$this->as_nobody();
		foreach ( $routes as $route ) {
			$path = str_replace( '/gr-portal/v1', '', preg_replace( '/\(\?P<\w+>[^)]+\)/', 'x', $route ) );
			foreach ( array_keys( rest_get_server()->get_routes()[ $route ][0]['methods'] ) as $method ) {
				$this->assertSame( 401, $this->api( $method, $path )->get_status(), "$method $path" );
			}
		}
	}
}
