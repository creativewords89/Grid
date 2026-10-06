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
			'name'       => $id,
		) + GRP_REST_TestCase::FULL_PROFILE;
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
	 * Row: Add a project (Super Admin and Team Leader).
	 */
	public function test_add_project() {
		$this->assert_matrix(
			GRP_Permissions::ADD_PROJECT,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Add a General task, not part of any project (Super Admin and Team Leader).
	 */
	public function test_add_general_task() {
		$this->assert_matrix(
			GRP_Permissions::ADD_GENERAL_TASK,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assertContains( GRP_Permissions::ADD_GENERAL_TASK, GRP_Permissions::PROFILE_LOCKED );
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
				'member' => false,
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
				'member' => false,
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

	/**
	 * Supporting actions used by the REST controllers.
	 */
	public function test_supporting_actions() {
		$managers = array(
			'admin'  => true,
			'lead'   => true,
			'member' => false,
		);
		$admin    = array(
			'admin'  => true,
			'lead'   => false,
			'member' => false,
		);

		$this->assert_matrix( GRP_Permissions::EDIT_PROJECT, null, $managers );
		$this->assert_matrix( GRP_Permissions::SKIP_PERIOD, null, $managers );
		$this->assert_matrix( GRP_Permissions::LINK_WP_USER, null, $admin );
		$this->assert_matrix( GRP_Permissions::EDIT_MEMBER_PROFILE, array( 'member_id' => 'm-other' ), $admin );
		$this->assert_matrix(
			GRP_Permissions::EDIT_MEMBER_PROFILE,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::DELETE_ACTIVITY,
			array(
				'member_id' => 'm-other',
				'kind'      => 'manual',
			),
			$admin
		);
		$this->assert_matrix(
			GRP_Permissions::DELETE_ACTIVITY,
			fn ( $role ) => array(
				'member_id' => $this->users[ $role ]['id'],
				'kind'      => 'manual',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::DELETE_ACTIVITY,
			fn ( $role ) => array(
				'member_id' => $this->users[ $role ]['id'],
				'kind'      => 'auto',
			),
			$admin
		);
	}

	/**
	 * Row: See the Projects tab of the Dashboard.
	 */
	public function test_projects_tab() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_PROJECTS_TAB,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Take / request day leave for self — never the Super Admin, never for someone else.
	 */
	public function test_take_leave() {
		$this->assert_matrix(
			GRP_Permissions::TAKE_LEAVE,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => false,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::TAKE_LEAVE,
			array( 'member_id' => 'm-other' ),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Issue a day off — Team Leaders and the Super Admin, to Team Members and Team Leaders,
	 * never to themselves or the Super Admin.
	 */
	public function test_issue_leave() {
		$this->assert_matrix(
			GRP_Permissions::ISSUE_LEAVE,
			array(
				'member_id' => 'm-other',
				'role'      => 'member',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::ISSUE_LEAVE,
			array(
				'member_id' => 'm-other-lead',
				'role'      => 'lead',
			),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::ISSUE_LEAVE,
			array(
				'member_id' => 'm-owner',
				'role'      => 'admin',
			),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::ISSUE_LEAVE,
			fn ( $role ) => array(
				'member_id' => $this->users[ $role ]['id'],
				'role'      => $role,
			),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Rows: project details and the keyword checklist (SPEC.md 6.12) — everyone edits details,
	 * manages keywords, ticks, unticks and writes notes.
	 */
	public function test_project_details_and_keywords() {
		foreach ( array( GRP_Permissions::EDIT_PROJECT_DETAILS, GRP_Permissions::MANAGE_KEYWORDS ) as $action ) {
			$this->assert_matrix(
				$action,
				null,
				array(
					'admin'  => true,
					'lead'   => true,
					'member' => true,
				)
			);
			$this->assertContains( $action, GRP_Permissions::PROFILE_LOCKED, 'locked while the profile is incomplete' );
		}
		$this->assert_matrix(
			GRP_Permissions::TICK_KEYWORD,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::UNTICK_KEYWORD,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assertContains( GRP_Permissions::UNTICK_KEYWORD, GRP_Permissions::PROFILE_LOCKED );
		$this->assertContains( GRP_Permissions::TICK_KEYWORD, GRP_Permissions::PROFILE_LOCKED, 'ticking is work: locked while the profile is incomplete' );
	}

	/**
	 * Row: Approve / reject a Team Member's leave request (Team Leaders' leave never waits).
	 */
	public function test_decide_leave() {
		$this->assert_matrix(
			GRP_Permissions::DECIDE_LEAVE,
			array( 'role' => 'member' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::DECIDE_LEAVE,
			array( 'role' => 'lead' ),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Cancel leave — Super Admin anyone's; Team Leader own + Team Members'; Team Member own pending only.
	 */
	public function test_cancel_leave() {
		$leave = static fn ( $member_id, $role, $status ) => array(
			'member_id' => $member_id,
			'role'      => $role,
			'status'    => $status,
		);
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			$leave( 'm-other', 'member', 'approved' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			$leave( 'm-other-lead', 'lead', 'approved' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			fn ( $role ) => $leave( $this->users[ $role ]['id'], $role, 'pending' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			fn ( $role ) => $leave( $this->users[ $role ]['id'], $role, 'approved' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		// A day off a Team Leader issued to another leader: theirs to cancel.
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			fn ( $role ) => $leave( 'm-other-lead', 'lead', 'approved' ) + array( 'created_by' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::CANCEL_LEAVE,
			$leave( 'm-other', 'member', 'rejected' ),
			array(
				'admin'  => false,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Leave type, reason and message: managers and the person themself only.
	 */
	public function test_view_leave_details() {
		$this->assert_matrix(
			GRP_Permissions::VIEW_LEAVE_DETAILS,
			array( 'member_id' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::VIEW_LEAVE_DETAILS,
			array( 'member_id' => 'm-member' ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
	}

	/**
	 * Rows: leave settlement and reports; days off and automatic messages (Super Admin).
	 */
	public function test_leave_report_and_people_settings() {
		$admin_only = array(
			'admin'  => true,
			'lead'   => false,
			'member' => false,
		);
		$this->assert_matrix( GRP_Permissions::VIEW_LEAVE_REPORT, null, $admin_only );
		$this->assert_matrix( GRP_Permissions::MANAGE_PEOPLE_SETTINGS, null, $admin_only );
	}

	/**
	 * Rows: post / remove announcements and shout-outs (shout-outs only to Team Members).
	 */
	public function test_manage_posts() {
		$managers = array(
			'admin'  => true,
			'lead'   => true,
			'member' => false,
		);
		$nobody   = array(
			'admin'  => false,
			'lead'   => false,
			'member' => false,
		);
		$this->assert_matrix( GRP_Permissions::MANAGE_POST, array( 'kind' => 'announcement' ), $managers );
		$this->assert_matrix(
			GRP_Permissions::MANAGE_POST,
			array(
				'kind'    => 'shoutout',
				'to_role' => 'member',
			),
			$managers
		);
		$this->assert_matrix(
			GRP_Permissions::MANAGE_POST,
			array(
				'kind'    => 'shoutout',
				'to_role' => 'lead',
			),
			$nobody
		);
		$this->assert_matrix(
			GRP_Permissions::MANAGE_POST,
			array( 'created_by' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
		$this->assert_matrix( GRP_Permissions::MANAGE_POST, fn ( $role ) => array( 'created_by' => $this->users[ $role ]['id'] ), $managers );
	}

	/**
	 * Rows: ask someone to review own work (managers); answer a review asked of you.
	 */
	public function test_review_requests() {
		$this->assert_matrix(
			GRP_Permissions::REQUEST_REVIEW,
			null,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::ANSWER_REVIEW_REQUEST,
			fn ( $role ) => array( 'reviewer' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::ANSWER_REVIEW_REQUEST,
			array( 'reviewer' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Row: Set own birthday.
	 */
	public function test_set_birthday() {
		$this->assert_matrix(
			GRP_Permissions::SET_BIRTHDAY,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::SET_BIRTHDAY,
			array( 'member_id' => 'm-other' ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}

	/**
	 * Profile lock: Team Leaders and Members with an incomplete profile can't work on tasks;
	 * the Super Admin is only reminded.
	 */
	public function test_incomplete_profile_locks_task_work() {
		foreach ( $this->users as $role => $user ) {
			$this->users[ $role ] = array_merge(
				$user,
				array(
					'location'   => '',
					'birth_year' => null,
				)
			);
		}
		$locked = array(
			'admin'  => true,
			'lead'   => false,
			'member' => false,
		);
		$this->assert_matrix( GRP_Permissions::ADD_TASK, null, $locked );
		$this->assert_matrix(
			GRP_Permissions::CHANGE_STATUS,
			array(
				'task' => $this->task( 'todo' ),
				'to'   => 'doing',
			),
			$locked
		);
		$this->assert_matrix( GRP_Permissions::LOG_WORK, fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ), $locked );
		// Not task work: leave and the profile itself stay open.
		$this->assert_matrix(
			GRP_Permissions::TAKE_LEAVE,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => false,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::EDIT_MEMBER_PROFILE,
			fn ( $role ) => array( 'member_id' => $this->users[ $role ]['id'] ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assertSame( array( 'Location', 'Date of birth' ), GRP_Permissions::missing_profile( $this->users['member'] ) );
		$this->assertSame( array( 'Full name', 'Location', 'Date of birth', 'Phone number', 'Photo' ), GRP_Permissions::missing_profile( array() ) );
	}

	public function test_everyone_uploads_and_opens_files() {
		$all = array(
			'admin'  => true,
			'lead'   => true,
			'member' => true,
		);
		$this->assert_matrix( GRP_Permissions::UPLOAD_FILE, null, $all );
		$this->assert_matrix( GRP_Permissions::DOWNLOAD_FILE, null, $all );
		$this->assertContains( GRP_Permissions::UPLOAD_FILE, GRP_Permissions::PROFILE_LOCKED );
	}

	public function test_edit_submission() {
		$this->assert_matrix(
			GRP_Permissions::EDIT_SUBMISSION,
			array( 'completion' => array( 'by' => 'm-member' ) ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::EDIT_SUBMISSION,
			array( 'completion' => array( 'by' => 'm-other' ) ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		$this->assertContains( GRP_Permissions::EDIT_SUBMISSION, GRP_Permissions::PROFILE_LOCKED );
	}

	public function test_comment_on_a_submission() {
		$others = array(
			'task'       => $this->task( 'done', array( 'm-other' ) ),
			'completion' => array( 'by' => 'm-other' ),
			'review'     => array( 'state' => 'pending' ),
		);
		$this->assert_matrix(
			GRP_Permissions::COMMENT,
			$others,
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => false,
			)
		);
		foreach ( array(
			'assigned'  => array( 'task' => $this->task( 'done', array( 'm-member' ) ) ),
			'submitted' => array( 'completion' => array( 'by' => 'm-member' ) ) + $others,
			'reviewer'  => array( 'review' => array( 'reviewer' => 'm-member' ) ) + $others,
		) as $why => $context ) {
			$this->assertTrue( GRP_Permissions::can( $this->users['member'], GRP_Permissions::COMMENT, $context ), $why );
		}
	}

	public function test_delete_comment() {
		$this->assert_matrix(
			GRP_Permissions::DELETE_COMMENT,
			fn ( $role ) => array( 'comment' => array( 'created_by' => $this->users[ $role ]['id'] ) ),
			array(
				'admin'  => true,
				'lead'   => true,
				'member' => true,
			)
		);
		$this->assert_matrix(
			GRP_Permissions::DELETE_COMMENT,
			array( 'comment' => array( 'created_by' => 'm-other' ) ),
			array(
				'admin'  => true,
				'lead'   => false,
				'member' => false,
			)
		);
	}
}
