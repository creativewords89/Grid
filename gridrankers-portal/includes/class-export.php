<?php
/**
 * JSON export in the `gridrankers-portal-export` version 1 format.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Builds an export with the same shape as the old portal's "Export all data",
 * so it can be imported again (GRP_Import) and read by the same tools.
 * Sign-in sessions are not exported; codes are exported as stored (hashed).
 */
class GRP_Export {

	/**
	 * Builds the export.
	 *
	 * @param array|null $actor Exporting member (for `exportedBy`).
	 * @return array
	 */
	public static function build( $actor = null ) {
		$data = array(
			'clients'     => array_map( array( __CLASS__, 'project' ), GRP_Store::find( 'grp_projects', array(), array( 'order_by' => 'created_at' ) ) ),
			'items'       => array_map( array( __CLASS__, 'meeting_task' ), GRP_Store::find( 'grp_meeting_tasks', array(), array( 'order_by' => 'created_at' ) ) ),
			'monthly'     => array_map( array( __CLASS__, 'monthly_task' ), GRP_Store::find( 'grp_monthly_tasks', array(), array( 'order_by' => 'created_at' ) ) ),
			'monthlyDone' => array_map( array( __CLASS__, 'record' ), GRP_Store::find( 'grp_cycle_records', array(), array( 'order_by' => 'created_at' ) ) ),
			'team'        => array_map( array( __CLASS__, 'member' ), GRP_Store::find( 'grp_members', array(), array( 'order_by' => 'created_at' ) ) ),
			'settings'    => array_map( array( __CLASS__, 'setting' ), GRP_Store::find( 'grp_settings' ) ),
			'activity'    => array_map( array( __CLASS__, 'activity' ), GRP_Store::find( 'grp_activity', array(), array( 'order_by' => 'at' ) ) ),
			'edits'       => array_map( array( __CLASS__, 'audit' ), GRP_Store::find( 'grp_audit', array(), array( 'order_by' => 'at' ) ) ),
			'trash'       => array_map( array( __CLASS__, 'trash' ), GRP_Store::find( 'grp_trash', array(), array( 'order_by' => 'deleted_at' ) ) ),
			'dismissals'  => self::dismissals(),
			'leave'       => array_map( array( __CLASS__, 'leave' ), GRP_Store::find( 'grp_leave', array(), array( 'order_by' => 'created_at' ) ) ),
			'daysOff'     => array_map( array( __CLASS__, 'day_off' ), GRP_Store::find( 'grp_days_off', array(), array( 'order_by' => 'from_date' ) ) ),
			'posts'       => array_map( array( __CLASS__, 'post' ), GRP_Store::find( 'grp_posts', array(), array( 'order_by' => 'created_at' ) ) ),
			'keywords'    => array_map( array( __CLASS__, 'keyword' ), GRP_Store::find( 'grp_keywords', array(), array( 'order_by' => 'created_at' ) ) ),
			'visitors'    => array(),
		);

		return array(
			'format'     => GRP_Import::FORMAT,
			'version'    => 1,
			'exportedAt' => gmdate( 'c' ),
			'exportedBy' => $actor['name'] ?? '',
			'source'     => 'wordpress',
			'notes'      => 'Codes are password_hash() values in team[].codeHash (or legacy sha256(salt + ":" + code) with codeSalt). Dates are ISO strings.',
			'data'       => $data,
		);
	}

	/**
	 * ISO 8601 from a UTC DATETIME.
	 *
	 * @param string|null $datetime Value.
	 * @return string|null
	 */
	private static function iso( $datetime ) {
		return $datetime ? gmdate( 'Y-m-d\TH:i:s\Z', strtotime( $datetime . ' UTC' ) ) : null;
	}

	/**
	 * Drops null values.
	 *
	 * @param array $doc Document.
	 * @return array
	 */
	private static function clean( array $doc ) {
		return array_filter(
			$doc,
			static function ( $v ) {
				return null !== $v;
			}
		);
	}

	/**
	 * Project → client.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function project( array $r ) {
		return self::clean(
			array(
				'id'           => $r['id'],
				'name'         => $r['name'],
				'pstate'       => $r['state'],
				'active'       => 'active' === $r['state'],
				'cycleDay'     => $r['cycle_set'] ? $r['cycle_day'] : null,
				'cycleSet'     => (bool) $r['cycle_set'],
				'cycleChanges' => $r['cycle_changes'] ?? array(),
				'cycleLog'     => $r['cycle_log'] ?? array(),
				'stdCycle'     => $r['std_cycle'],
				'cycleReviews' => $r['cycle_reviews'] ?? new stdClass(),
				'details'      => $r['details'],
				'kwColumns'    => $r['kw_columns'],
				'createdAt'    => self::iso( $r['created_at'] ),
				'updatedAt'    => self::iso( $r['updated_at'] ),
			)
		);
	}

	/**
	 * Meeting task → item.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function meeting_task( array $r ) {
		$deadline  = (array) ( $r['deadline'] ?? array() );
		$assignees = (array) ( $r['assignees'] ?? array() );

		return self::clean(
			array(
				'id'         => $r['id'],
				'clientId'   => $r['project_id'],
				'title'      => $r['title'],
				'notes'      => $r['notes'],
				'url'        => $r['url'],
				'priority'   => $r['priority'],
				'status'     => $r['status'],
				'meeting'    => $r['meeting_date'] ? $r['meeting_date'] : '',
				'doneAt'     => self::iso( $r['done_at'] ),
				'target'     => $r['target'],
				'whoId'      => $assignees[0]['id'] ?? '',
				'assignees'  => $assignees,
				'team'       => (bool) $r['team'],
				'by'         => (object) ( $r['progress'] ?? array() ),
				'count'      => array_sum( (array) ( $r['progress'] ?? array() ) ),
				'dueType'    => $deadline['type'] ?? 'none',
				'dueWeeks'   => $deadline['weeks'] ?? null,
				'dueDate'    => $deadline['date'] ?? null,
				'dueFrom'    => $deadline['from'] ?? null,
				'dueTo'      => $deadline['to'] ?? null,
				'dueMonth'   => $deadline['month'] ?? null,
				'review'     => $r['review'],
				'completion' => $r['completion'],
				'createdBy'  => $r['created_by'],
				'createdAt'  => self::iso( $r['created_at'] ),
				'updatedAt'  => self::iso( $r['updated_at'] ),
			)
		);
	}

	/**
	 * Monthly task → monthly.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function monthly_task( array $r ) {
		$assignees = (array) ( $r['assignees'] ?? array() );

		return self::clean(
			array(
				'id'         => $r['id'],
				'clientId'   => $r['project_id'],
				'title'      => $r['title'],
				'notes'      => $r['notes'],
				'freq'       => $r['freq'],
				'dueMode'    => $r['due_mode'],
				'dueDay'     => $r['due_day'],
				'dueFromDay' => $r['due_from_day'],
				'target'     => $r['target'],
				'whoId'      => $assignees[0]['id'] ?? '',
				'assignees'  => $assignees,
				'team'       => (bool) $r['team'],
				'parts'      => $r['parts'],
				'std'        => (bool) $r['std'],
				'createdBy'  => $r['created_by'],
				'createdAt'  => self::iso( $r['created_at'] ),
				'updatedAt'  => self::iso( $r['updated_at'] ),
			)
		);
	}

	/**
	 * Cycle record → monthlyDone.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function record( array $r ) {
		$month = preg_replace( '/-w\d$/', '', (string) $r['period_key'] );

		return self::clean(
			array(
				'id'         => $r['id'],
				'taskId'     => $r['task_id'],
				'clientId'   => $r['project_id'],
				'month'      => $month,
				'week'       => $r['week'],
				'count'      => $r['count'],
				'status'     => $r['status'],
				'by'         => (object) ( $r['by_person'] ?? array() ),
				'parts'      => null === $r['parts'] ? null : (object) $r['parts'],
				'review'     => $r['review'],
				'completion' => $r['completion'],
				'doneAt'     => self::iso( $r['done_at'] ),
				'clearedBy'  => $r['cleared_by'],
				'createdAt'  => self::iso( $r['created_at'] ),
				'updatedAt'  => self::iso( $r['updated_at'] ),
			)
		);
	}

	/**
	 * Member → team.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function member( array $r ) {
		return self::clean(
			array(
				'id'        => $r['id'],
				'name'      => $r['name'],
				'role'      => $r['role'],
				'color'     => $r['color'],
				'photo'     => $r['photo'],
				'title'     => $r['title'],
				'email'     => $r['email'],
				'phone'     => $r['phone'],
				'address'   => $r['address'],
				'driveUrl'  => $r['drive_url'],
				'notes'     => $r['notes'],
				'codeHash'  => $r['code_hash'],
				'codeSalt'  => $r['code_salt'],
				'codeSetAt' => self::iso( $r['code_set_at'] ),
				'wpUserId'  => $r['wp_user_id'],
				'active'    => (bool) $r['active'],
				'birthday'  => $r['birthday'],
				'birthYear' => $r['birth_year'],
				'location'  => $r['location'],
				'weeklyOff' => $r['weekly_off'],
				'createdAt' => self::iso( $r['created_at'] ),
			)
		);
	}

	/**
	 * Setting → settings document.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function setting( array $r ) {
		return array( 'id' => $r['setting_key'] ) + (array) $r['value'];
	}

	/**
	 * Activity row → activity.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function activity( array $r ) {
		return self::clean(
			array(
				'id'       => $r['id'],
				'personId' => $r['member_id'],
				'date'     => $r['date'],
				'at'       => self::iso( $r['at'] ),
				'kind'     => $r['kind'],
				'source'   => $r['source'],
				'clientId' => $r['project_id'],
				'title'    => $r['title'],
				'detail'   => $r['detail'],
				'qty'      => $r['qty'],
				'minutes'  => $r['minutes'],
				'notes'    => $r['notes'],
				'refKey'   => $r['ref_key'],
			)
		);
	}

	/**
	 * Audit row → edit.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function audit( array $r ) {
		return self::clean(
			array(
				'id'       => $r['id'],
				'kind'     => $r['kind'],
				'type'     => $r['type'],
				'docId'    => $r['doc_id'],
				'clientId' => $r['project_id'],
				'title'    => $r['title'],
				'detail'   => $r['detail'],
				'changes'  => $r['changes'] ?? array(),
				'byId'     => $r['by_member'],
				'byRole'   => $r['by_role'],
				'at'       => self::iso( $r['at'] ),
			)
		);
	}

	/**
	 * Trash row → trash (data mapped back to the export shape).
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function trash( array $r ) {
		$type   = array_search( $r['type'], GRP_Import::TRASH_TYPES, true );
		$data   = (array) $r['data'] + array(
			'created_at'   => null,
			'updated_at'   => null,
			'notes'        => '',
			'url'          => '',
			'priority'     => 'normal',
			'status'       => 'todo',
			'meeting_date' => null,
			'done_at'      => null,
			'target'       => 1,
			'team'         => 0,
			'progress'     => array(),
			'deadline'     => null,
			'review'       => null,
			'completion'   => null,
			'created_by'   => null,
			'freq'         => 'monthly',
			'due_mode'     => 'monthly',
			'due_day'      => null,
			'due_from_day' => null,
			'parts'        => null,
			'std'          => 0,
			'state'        => 'active',
			'cycle_day'    => 1,
			'cycle_set'    => 0,
			'std_cycle'    => null,
		);
		$mapper = array(
			'items'   => 'meeting_task',
			'monthly' => 'monthly_task',
			'clients' => 'project',
		)[ $type ] ?? null;

		return self::clean(
			array(
				'id'        => $r['id'],
				'type'      => $type ? $type : $r['type'],
				'docId'     => $r['doc_id'],
				'data'      => $mapper ? self::$mapper( $data ) : $r['data'],
				'title'     => $r['title'],
				'clientId'  => $r['project_id'],
				'deletedAt' => self::iso( $r['deleted_at'] ),
				'byId'      => $r['deleted_by'],
			)
		);
	}

	/**
	 * Leave row → leave.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function leave( array $r ) {
		return self::clean(
			array(
				'id'        => $r['id'],
				'personId'  => $r['member_id'],
				'type'      => $r['type'],
				'from'      => $r['from_date'],
				'to'        => $r['to_date'],
				'days'      => $r['days'],
				'reason'    => $r['reason'],
				'status'    => $r['status'],
				'decidedBy' => $r['decided_by'],
				'decidedAt' => self::iso( $r['decided_at'] ),
				'message'   => $r['message'],
				'by'        => $r['created_by'],
				'createdAt' => self::iso( $r['created_at'] ),
			)
		);
	}

	/**
	 * Days-off row → daysOff.
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function day_off( array $r ) {
		return self::clean(
			array(
				'id'        => $r['id'],
				'kind'      => $r['kind'],
				'name'      => $r['name'],
				'from'      => $r['from_date'],
				'to'        => $r['to_date'],
				'by'        => $r['created_by'],
				'createdAt' => self::iso( $r['created_at'] ),
			)
		);
	}

	/**
	 * Post row → posts (announcements and shout-outs).
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function post( array $r ) {
		return self::clean(
			array(
				'id'        => $r['id'],
				'kind'      => $r['kind'],
				'title'     => $r['title'],
				'body'      => $r['body'],
				'toId'      => $r['to_member'],
				'toIds'     => $r['to_members'],
				'pinned'    => (bool) $r['pinned'],
				'showUntil' => $r['show_until'],
				'by'        => $r['created_by'],
				'deletedAt' => self::iso( $r['deleted_at'] ),
				'createdAt' => self::iso( $r['created_at'] ),
			)
		);
	}

	/**
	 * Keyword checklist row (SPEC.md 6.12).
	 *
	 * @param array $r Row.
	 * @return array
	 */
	public static function keyword( array $r ) {
		return self::clean(
			array(
				'id'        => $r['id'],
				'projectId' => $r['project_id'],
				'keyword'   => $r['keyword'],
				'checks'    => $r['checks'] ? $r['checks'] : new stdClass(),
				'note'      => $r['note'],
				'deadline'  => $r['deadline'],
				'position'  => (int) $r['position'],
				'by'        => $r['created_by'],
				'createdAt' => self::iso( $r['created_at'] ),
			)
		);
	}

	/**
	 * Dismissals grouped per person: `{id: memberId, items: {key: at}}`.
	 *
	 * @return array
	 */
	private static function dismissals() {
		$by = array();
		foreach ( GRP_Store::find( 'grp_dismissals', array(), array( 'order_by' => 'at' ) ) as $r ) {
			$by[ $r['member_id'] ][ $r['notice_key'] ] = self::iso( $r['at'] );
		}

		$out = array();
		foreach ( $by as $member_id => $items ) {
			$out[] = array(
				'id'    => $member_id,
				'items' => $items,
			);
		}

		return $out;
	}
}
