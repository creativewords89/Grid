<?php
/**
 * Every portal permission rule (SPEC.md section 3), in one place.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Decides whether a team member may perform an action. Default deny.
 *
 * A "member" is a `grp_members` row (array or object) with at least `id`, `role`,
 * `wp_user_id` and `active`. Contexts passed to can() are plain arrays/objects
 * whose expected keys are documented on each action constant.
 */
class GRP_Permissions {

	const ROLE_ADMIN  = 'admin';
	const ROLE_LEAD   = 'lead';
	const ROLE_MEMBER = 'member';

	/** See all projects and tasks. */
	const VIEW_PROJECTS = 'view_projects';

	/** Add a project. */
	const ADD_PROJECT = 'add_project';

	/** Move a project between Active / Paused / Inactive. */
	const SET_PROJECT_STATE = 'set_project_state';

	/** Delete a project. */
	const DELETE_PROJECT = 'delete_project';

	/** Set or change a project's cycle day. Object: project `{cycle_set, reason?}`. */
	const CHANGE_PROJECT_CYCLE = 'change_project_cycle';

	/** Add a meeting or monthly task. */
	const ADD_TASK = 'add_task';

	/** Edit a task after it has been added. */
	const EDIT_TASK = 'edit_task';

	/** Change a meeting task's date or responsible people. */
	const CHANGE_TASK_SCHEDULE = 'change_task_schedule';

	/** Soft-delete a task. */
	const DELETE_TASK = 'delete_task';

	/** Restore from trash or delete forever. */
	const MANAGE_TRASH = 'manage_trash';

	/** Change a task's status. Object: `{task: {status, assignees}, to}`. */
	const CHANGE_STATUS = 'change_status';

	/** Tick progress on a task. Object: `{task: {status, assignees}, member_id, delta, total_after}`. */
	const TICK_PROGRESS = 'tick_progress';

	/** Reopen a completed task outside the review flow. Never allowed. */
	const REOPEN_TASK = 'reopen_task';

	/** Accept / revise / reject completed work. */
	const REVIEW = 'review';

	/** Own completions are accepted without review. */
	const AUTO_ACCEPT = 'auto_accept';

	/** See the Team dashboard. */
	const VIEW_TEAM_DASHBOARD = 'view_team_dashboard';

	/** See a member's page. Object: `{member_id}`. */
	const VIEW_MEMBER_PAGE = 'view_member_page';

	/** Add or approve a member. Object: `{role, wp_user_id?}` of the new member. */
	const ADD_MEMBER = 'add_member';

	/** Change a member's role. Object: `{member: {wp_user_id}, role}`. */
	const SET_MEMBER_ROLE = 'set_member_role';

	/** Set a member's sign-in code. Object: the target member `{role}`. */
	const SET_MEMBER_CODE = 'set_member_code';

	/** Remove a member. */
	const REMOVE_MEMBER = 'remove_member';

	/** Export data. */
	const EXPORT_DATA = 'export_data';

	/** Import data. */
	const IMPORT_DATA = 'import_data';

	/** Log manual work. Context: `{member_id}` the work is logged for. */
	const LOG_WORK = 'log_work';

	/** Rename a project (not in the section 3 table; managers, like moving projects). */
	const EDIT_PROJECT = 'edit_project';

	/** Edit a member's profile (name, contact, photo…). Context: `{member_id}`. Super Admin or self. */
	const EDIT_MEMBER_PROFILE = 'edit_member_profile';

	/** Link a member to a WordPress user. Super Admin only. */
	const LINK_WP_USER = 'link_wp_user';

	/** Delete an activity row. Context: `{member_id, kind}`. Super Admin any; others their own manual rows. */
	const DELETE_ACTIVITY = 'delete_activity';

	/** Mark a missed recurring period as skipped. Managers. */
	const SKIP_PERIOD = 'skip_period';

	/**
	 * Whether `$user` may perform `$action` on `$context`.
	 *
	 * @param array|object|null $user    Acting team member.
	 * @param string            $action  One of the class constants.
	 * @param array|object|null $context Action-specific context.
	 * @return bool
	 */
	public static function can( $user, $action, $context = null ) {
		$role = self::effective_role( $user );
		if ( null === $role ) {
			return false;
		}

		$user    = (array) $user;
		$context = null === $context ? array() : (array) $context;
		$manager = self::ROLE_ADMIN === $role || self::ROLE_LEAD === $role;
		$admin   = self::ROLE_ADMIN === $role;

		switch ( $action ) {
			case self::VIEW_PROJECTS:
			case self::ADD_PROJECT:
			case self::ADD_TASK:
				return true;

			case self::SET_PROJECT_STATE:
			case self::EDIT_PROJECT:
			case self::SKIP_PERIOD:
			case self::EDIT_TASK:
			case self::CHANGE_TASK_SCHEDULE:
			case self::DELETE_TASK:
			case self::MANAGE_TRASH:
			case self::REVIEW:
			case self::AUTO_ACCEPT:
			case self::VIEW_TEAM_DASHBOARD:
				return $manager;

			case self::DELETE_PROJECT:
			case self::REMOVE_MEMBER:
			case self::LINK_WP_USER:
			case self::EXPORT_DATA:
			case self::IMPORT_DATA:
				return $admin;

			case self::CHANGE_PROJECT_CYCLE:
				// The first choice locks the cycle; after that only Super Admin, with a reason.
				if ( empty( $context['cycle_set'] ) ) {
					return true;
				}
				return $admin && '' !== trim( (string) ( $context['reason'] ?? '' ) );

			case self::CHANGE_STATUS:
				return self::can_change_status( $user, $manager, $context );

			case self::TICK_PROGRESS:
				return self::can_tick_progress( $user, $manager, $context );

			case self::REOPEN_TASK:
				// Completed tasks reopen only through review actions.
				return false;

			case self::VIEW_MEMBER_PAGE:
			case self::LOG_WORK:
				return $manager || self::is_self( $user, $context['member_id'] ?? null );

			case self::EDIT_MEMBER_PROFILE:
				return $admin || self::is_self( $user, $context['member_id'] ?? null );

			case self::DELETE_ACTIVITY:
				return $admin || ( 'manual' === ( $context['kind'] ?? '' ) && self::is_self( $user, $context['member_id'] ?? null ) );

			case self::ADD_MEMBER:
				if ( $admin ) {
					return self::role_assignable( $context['role'] ?? '', $context['wp_user_id'] ?? null );
				}
				return $manager && self::ROLE_MEMBER === ( $context['role'] ?? '' );

			case self::SET_MEMBER_ROLE:
				$target = (array) ( $context['member'] ?? array() );
				return $admin && self::role_assignable( $context['role'] ?? '', $target['wp_user_id'] ?? null );

			case self::SET_MEMBER_CODE:
				if ( $admin ) {
					return true;
				}
				return $manager && self::ROLE_MEMBER === ( $context['role'] ?? '' );
		}

		return false;
	}

	/**
	 * The role a member actually holds, or null when they hold none.
	 *
	 * Inactive members hold no role. `admin` is only honoured when the member is linked
	 * to a WordPress user with `manage_options`; otherwise it is treated as `member`.
	 *
	 * @param array|object|null $user Team member.
	 * @return string|null
	 */
	public static function effective_role( $user ) {
		if ( empty( $user ) ) {
			return null;
		}

		$user = (array) $user;
		if ( empty( $user['id'] ) || ( isset( $user['active'] ) && ! (int) $user['active'] ) ) {
			return null;
		}

		$role = $user['role'] ?? '';
		if ( self::ROLE_ADMIN === $role ) {
			return self::wp_user_is_admin( $user['wp_user_id'] ?? null ) ? self::ROLE_ADMIN : self::ROLE_MEMBER;
		}

		return in_array( $role, array( self::ROLE_LEAD, self::ROLE_MEMBER ), true ) ? $role : null;
	}

	/**
	 * Status changes. Done → anything goes through review; In progress → To fix
	 * is for managers; members may only touch tasks assigned to them or unassigned.
	 *
	 * @param array $user    Acting member.
	 * @param bool  $manager Whether the actor is Super Admin or Team Leader.
	 * @param array $context `{task, to}`.
	 * @return bool
	 */
	private static function can_change_status( array $user, $manager, array $context ) {
		$task = (array) ( $context['task'] ?? array() );
		$from = $task['status'] ?? '';
		$to   = $context['to'] ?? '';

		if ( 'done' === $from || ! self::may_work_on( $user, $manager, $task ) ) {
			return false;
		}
		if ( 'doing' === $from && 'todo' === $to ) {
			return $manager;
		}

		return true;
	}

	/**
	 * Progress ticks. Members tick only their own share on tasks they may work on;
	 * counting down to 0 is for managers; completed tasks change only via review.
	 *
	 * @param array $user    Acting member.
	 * @param bool  $manager Whether the actor is Super Admin or Team Leader.
	 * @param array $context `{task, member_id, delta, total_after}`.
	 * @return bool
	 */
	private static function can_tick_progress( array $user, $manager, array $context ) {
		$task = (array) ( $context['task'] ?? array() );

		if ( 'done' === ( $task['status'] ?? '' ) || ! self::may_work_on( $user, $manager, $task ) ) {
			return false;
		}
		if ( ! $manager && ! self::is_self( $user, $context['member_id'] ?? $user['id'] ) ) {
			return false;
		}
		if ( (int) ( $context['delta'] ?? 0 ) < 0 && 0 === (int) ( $context['total_after'] ?? 1 ) ) {
			return $manager;
		}

		return true;
	}

	/**
	 * Managers work on any task; members only on tasks assigned to them or unassigned.
	 *
	 * @param array $user    Acting member.
	 * @param bool  $manager Whether the actor is Super Admin or Team Leader.
	 * @param array $task    Task row with `assignees`.
	 * @return bool
	 */
	private static function may_work_on( array $user, $manager, array $task ) {
		if ( $manager ) {
			return true;
		}

		$ids = self::assignee_ids( $task['assignees'] ?? array() );

		return ! $ids || in_array( (string) $user['id'], $ids, true );
	}

	/**
	 * Member ids from an assignees value (`[{id, n}]`, as JSON or decoded).
	 *
	 * @param mixed $assignees Assignees column value.
	 * @return string[]
	 */
	public static function assignee_ids( $assignees ) {
		if ( is_string( $assignees ) ) {
			$assignees = json_decode( $assignees, true );
		}
		if ( ! is_array( $assignees ) ) {
			return array();
		}

		$ids = array();
		foreach ( $assignees as $assignee ) {
			$assignee = (array) $assignee;
			if ( isset( $assignee['id'] ) && '' !== (string) $assignee['id'] ) {
				$ids[] = (string) $assignee['id'];
			}
		}

		return $ids;
	}

	/**
	 * Whether a role can be given to a member. `admin` needs a linked WP administrator.
	 *
	 * @param string   $role       Role to grant.
	 * @param int|null $wp_user_id Linked WordPress user id of the target member.
	 * @return bool
	 */
	private static function role_assignable( $role, $wp_user_id ) {
		if ( self::ROLE_ADMIN === $role ) {
			return self::wp_user_is_admin( $wp_user_id );
		}

		return in_array( $role, array( self::ROLE_LEAD, self::ROLE_MEMBER ), true );
	}

	/**
	 * Whether the WordPress user exists and has `manage_options`.
	 *
	 * @param int|null $wp_user_id WordPress user id.
	 * @return bool
	 */
	private static function wp_user_is_admin( $wp_user_id ) {
		$wp_user_id = (int) $wp_user_id;

		return $wp_user_id > 0 && user_can( $wp_user_id, 'manage_options' );
	}

	/**
	 * Whether a member id refers to the acting user.
	 *
	 * @param array $user      Acting member.
	 * @param mixed $member_id Member id to compare.
	 * @return bool
	 */
	private static function is_self( array $user, $member_id ) {
		return null !== $member_id && '' !== (string) $member_id && (string) $user['id'] === (string) $member_id;
	}
}
