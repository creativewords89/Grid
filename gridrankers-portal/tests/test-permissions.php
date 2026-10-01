<?php
/**
 * Tests for GRP_Permissions: one test per row of the SPEC.md section 3 table.
 *
 * @package GridRankers_Portal
 */

/**
 * Permission matrix tests.
 */
class Test_GRP_Permissions extends WP_UnitTestCase {

	/**
	 * Acting members keyed by role.
	 *
	 * @var array<string, array>
	 */
	private $users;

	public function set_up() {
		parent::set_up();

		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );

		$this->users = array(
			'admin'  => $this->member( 'm-admin', 'admin', $wp_admin ),
			'lead'   => $this->member( 'm-lead', 'lead' ),
			'member' => $this->member( 'm-member', 'member' ),
		);
	}

	/**
	 * Builds a team member row.
	 *
	 * @param string   $id         Member id.
	 * @param string   $role       Portal role.
	 * @param int|null $wp_user_id Linked WordPress user.
	 * @return array
	 */
	private function member( $id, $role, $wp_user_id = null ) {
		return array(
			'id'         => $id,
			'role'       => $role,
			'wp_user_id' => $wp_user_id,
			'active'     => 1,
		);
	}

	/**
	 * Asserts the outcome of an action for each role.
	 *
	 * @param string              $action   Action.
	 * @param mixed               $context  Context, or a callable receiving the acting role and returning it.
	 * @param array<string, bool> $expected Expected result per role.
	 */
	private function assert_matrix( $action, $context, array $expected ) {
		foreach ( $expected as $role => $allowed ) {
			$resolved = is_callable( $context ) ? $context( $role ) : $context;
			$this->assertSame(
				$allowed,
				GRP_Permissions::can( $this->users[ $role ], $action, $resolved ),
				sprintf( '%s %s be allowed to %s', $role, $allowed ? 'should' : 'should not', $action )
			);
		}
	}

	/**
	 * A task assigned to the given member ids.
	 *
	 * @param string   $status Task status.
	 * @param string[] $ids    Assignee ids.
	 * @return array
	 */
	private function task( $status, array $ids = array() ) {
		return array(
			'status'    => $status,
			'assignees' => wp_json_encode(
				array_map(
					static function ( $id ) {
						return array(
							'id' => $id,
							'n'  => 1,
						);
					},
					$ids
				)
			),
		);
	}

	/**
	 * Row: See all projects / tasks.
	 */
	public function test_see_all_projects_and_tasks() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_PROJECTS,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Add a project.
	 */
	public function test_add_project() {
		$this->assert_matrix(
			GRP_Permissions::ADD_PROJECT,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Move project Active/Paused/Inactive.
	 */
	public function test_move_project_state() {
		$this->assert_matrix(
			GRP_Permissions::SET_PROJECT_STATE,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Delete project.
	 */
	public function test_delete_project() {
		$this->assert_matrix(
			GRP_Permissions::DELETE_PROJECT,
			null,
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Change project cycle (after first lock) — Super Admin only, with a reason.
	 */
	public function test_change_locked_project_cycle() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_PROJECT_CYCLE,
			array(
				'cycle_set' => 1,
				'reason'    => 'Client asked to align with billing',
			),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_change_locked_project_cycle_requires_reason() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_PROJECT_CYCLE,
			array(
				'cycle_set' => 1,
				'reason'    => '   ',
			),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_first_cycle_choice_is_open_to_everyone() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_PROJECT_CYCLE,
			array( 'cycle_set' => 0 ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Add a task (meeting or monthly).
	 */
	public function test_add_task() {
		$this->assert_matrix(
			GRP_Permissions::ADD_TASK,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Edit a task after it's added.
	 */
	public function test_edit_task() {
		$this->assert_matrix(
			GRP_Permissions::EDIT_TASK,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Change meeting date / responsible people.
	 */
	public function test_change_meeting_date_and_people() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_TASK_SCHEDULE,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Delete a task (soft delete).
	 */
	public function test_delete_task() {
		$this->assert_matrix(
			GRP_Permissions::DELETE_TASK,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Restore / delete forever (trash).
	 */
	public function test_manage_trash() {
		$this->assert_matrix(
			GRP_Permissions::MANAGE_TRASH,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Change status / tick progress on a task — assigned to self.
	 */
	public function test_change_status_on_own_task() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			fn ( $role ) => array(
				'task' => $this->task( 'todo', array( $this->users[ $role ]['id'] ) ),
				'to'   => 'doing',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	public function test_change_status_on_unassigned_task() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => $this->task( 'todo' ),
				'to'   => 'doing',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	public function test_change_status_on_someone_elses_task() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => $this->task( 'todo', array( 'm-other' ) ),
				'to'   => 'doing',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_tick_own_share_on_own_task() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'doing', array( $this->users[ $role ]['id'], 'm-other' ) ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => 1,
				'total_after' => 2,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	public function test_tick_progress_on_unassigned_task() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'todo' ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => 1,
				'total_after' => 1,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	public function test_tick_progress_on_someone_elses_task() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'todo', array( 'm-other' ) ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => 1,
				'total_after' => 1,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Tick another person's share / breakdown row.
	 */
	public function test_tick_another_persons_share() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'doing', array( $this->users[ $role ]['id'], 'm-other' ) ),
				'member_id'   => 'm-other',
				'delta'       => 1,
				'total_after' => 2,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Move In progress → To fix / Not started.
	 */
	public function test_move_in_progress_back_to_todo() {
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			fn ( $role ) => array(
				'task' => $this->task( 'doing', array( $this->users[ $role ]['id'] ) ),
				'to'   => 'todo',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: ... (incl. counting down to 0).
	 */
	public function test_count_down_to_zero() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'doing', array( $this->users[ $role ]['id'] ) ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => -1,
				'total_after' => 0,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_count_down_above_zero_is_allowed_on_own_share() {
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'doing', array( $this->users[ $role ]['id'] ) ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => -1,
				'total_after' => 1,
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Reopen a completed task — via Review only, never by status/progress.
	 */
	public function test_reopen_completed_task_only_via_review() {
		$expected = array(
			'admin'  => false,
			'lead'   => false,
			'member' => false,
		);

		$this->assert_matrix( GRP_Permissions::REOPEN_TASK, null, $expected );
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			fn ( $role ) => array(
				'task' => $this->task( 'done', array( $this->users[ $role ]['id'] ) ),
				'to'   => 'doing',
			),
			$expected
		);
		$this->assert_matrix(
			GRP_Permissions::TICK_PROGRESS,
			fn ( $role ) => array(
				'task'        => $this->task( 'done', array( $this->users[ $role ]['id'] ) ),
				'member_id'   => $this->users[ $role ]['id'],
				'delta'       => -1,
				'total_after' => 0,
			),
			$expected
		);
	}

	/**
	 * Row: Review completed work (accept / revise / reject).
	 */
	public function test_review_completed_work() {
		$this->assert_matrix(
			GRP_Permissions::REVIEW,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Approve own work (auto-accepted).
	 */
	public function test_own_work_auto_accepted() {
		$this->assert_matrix(
			GRP_Permissions::AUTO_ACCEPT,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: See Team dashboard / everyone's pages.
	 */
	public function test_see_team_dashboard() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_TEAM_DASHBOARD,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_see_someone_elses_page() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_MEMBER_PAGE,
			array( 'member_id' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_see_own_page() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_MEMBER_PAGE,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Row: Manage members, roles, codes.
	 */
	public function test_add_member_with_member_role() {
		$this->assert_matrix(
			GRP_Permissions::ADD_MEMBER,
			array( 'role' => 'member' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_add_member_with_lead_role() {
		$this->assert_matrix(
			GRP_Permissions::ADD_MEMBER,
			array( 'role' => 'lead' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_grant_admin_needs_linked_wp_administrator() {
		$wp_admin  = self::factory()->user->create( array( 'role' => 'administrator' ) );
		$wp_editor = self::factory()->user->create( array( 'role' => 'editor' ) );

		$this->assert_matrix(
			GRP_Permissions::SET_MEMBER_ROLE,
			array(
				'member' => array( 'wp_user_id' => $wp_admin ),
				'role'   => 'admin',
			),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);

		foreach ( array( $wp_editor, null ) as $wp_user_id ) {
			$this->assert_matrix(
				GRP_Permissions::SET_MEMBER_ROLE,
				array(
					'member' => array( 'wp_user_id' => $wp_user_id ),
					'role'   => 'admin',
				),
				array(
					'admin'  => false,
					'lead'   => false,
					'member' => false,
				)
			);
			$this->assert_matrix(
				GRP_Permissions::ADD_MEMBER,
				array(
					'role'       => 'admin',
					'wp_user_id' => $wp_user_id,
				),
				array(
					'admin'  => false,
					'lead'   => false,
					'member' => false,
				)
			);
		}
	}

	public function test_change_role() {
		$this->assert_matrix(
			GRP_Permissions::SET_MEMBER_ROLE,
			array(
				'member' => array( 'wp_user_id' => null ),
				'role'   => 'lead',
			),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_unknown_role_cannot_be_granted() {
		$this->assert_matrix(
			GRP_Permissions::SET_MEMBER_ROLE,
			array(
				'member' => array( 'wp_user_id' => null ),
				'role'   => 'owner',
			),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_set_code_for_member() {
		$this->assert_matrix(
			GRP_Permissions::SET_MEMBER_CODE,
			array( 'role' => 'member' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_set_code_for_lead() {
		$this->assert_matrix(
			GRP_Permissions::SET_MEMBER_CODE,
			array( 'role' => 'lead' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	public function test_remove_member() {
		$this->assert_matrix(
			GRP_Permissions::REMOVE_MEMBER,
			null,
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Export / import data.
	 */
	public function test_export_and_import() {
		$expected = array(
			'admin'  => true,
			'lead'   => false,
			'member' => false,
		);

		$this->assert_matrix( GRP_Permissions::EXPORT_DATA, null, $expected );
		$this->assert_matrix( GRP_Permissions::IMPORT_DATA, null, $expected );
	}

	/**
	 * Row: Log manual work (for anyone / for self).
	 */
	public function test_log_work_for_someone_else() {
		$this->assert_matrix(
			GRP_Permissions::LOG_WORK,
			array( 'member_id' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	public function test_log_work_for_self() {
		$this->assert_matrix(
			GRP_Permissions::LOG_WORK,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Super Admin must be linked to a WP user with manage_options.
	 */
	public function test_admin_role_without_wp_administrator_is_treated_as_member() {
		$wp_editor = self::factory()->user->create( array( 'role' => 'editor' ) );

		foreach ( array( null, $wp_editor, 999999 ) as $wp_user_id ) {
			$fake = $this->member( 'm-fake', 'admin', $wp_user_id );

			$this->assertSame( 'member', GRP_Permissions::effective_role( $fake ) );
			$this->assertFalse( GRP_Permissions::can( $fake, GRP_Permissions::DELETE_PROJECT ) );
			$this->assertFalse( GRP_Permissions::can( $fake, GRP_Permissions::EXPORT_DATA ) );
			$this->assertFalse( GRP_Permissions::can( $fake, GRP_Permissions::REVIEW ) );
		}
	}

	public function test_admin_loses_rights_when_wp_user_is_demoted() {
		$admin = $this->users['admin'];
		$this->assertTrue( GRP_Permissions::can( $admin, GRP_Permissions::EXPORT_DATA ) );

		get_userdata( $admin['wp_user_id'] )->set_role( 'subscriber' );

		$this->assertFalse( GRP_Permissions::can( $admin, GRP_Permissions::EXPORT_DATA ) );
	}

	public function test_no_user_inactive_user_and_unknown_role_are_denied() {
		$inactive           = $this->users['lead'];
		$inactive['active'] = 0;

		foreach ( array( null, array(), $inactive, $this->member( 'm-x', 'owner' ), $this->member( '', 'lead' ) ) as $user ) {
			$this->assertNull( GRP_Permissions::effective_role( $user ) );
			$this->assertFalse( GRP_Permissions::can( $user, GRP_Permissions::VIEW_PROJECTS ) );
		}
	}

	public function test_unknown_action_is_denied() {
		foreach ( $this->users as $user ) {
			$this->assertFalse( GRP_Permissions::can( $user, 'launch_rockets' ) );
		}
	}

	public function test_accepts_member_objects() {
		$this->assertTrue( GRP_Permissions::can( (object) $this->users['lead'], GRP_Permissions::EDIT_TASK ) );
		$this->assertFalse( GRP_Permissions::can( (object) $this->users['member'], GRP_Permissions::EDIT_TASK ) );
	}
}
