<?php
/**
 * Activity crediting and audit logging (SPEC.md sections 6.7 and 6.9).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Helpers that write `grp_activity` and `grp_audit` rows.
 */
class GRP_Activity {

	/**
	 * Audit `type` for each task/project table.
	 */
	const AUDIT_TYPES = array(
		'grp_meeting_tasks' => 'items',
		'grp_monthly_tasks' => 'monthly',
		'grp_projects'      => 'client',
		'grp_members'       => 'team',
	);

	/**
	 * Writes an audit row.
	 *
	 * @param string     $kind    add, edit, status, progress, done, assign, delete, restore, review, project, cycle.
	 * @param string     $type    items, monthly, client or team.
	 * @param array      $doc     The row the event is about (`id`, `project_id`, `title` or `name`).
	 * @param array|null $actor   Acting member.
	 * @param string     $detail  Short description.
	 * @param array      $changes `[{field, label, from, to}]`.
	 * @return array The audit row.
	 */
	public static function audit( $kind, $type, array $doc, $actor, $detail = '', array $changes = array() ) {
		$project_id = 'client' === $type ? ( $doc['id'] ?? null ) : ( $doc['project_id'] ?? null );

		return GRP_Store::insert(
			'grp_audit',
			array(
				'kind'       => $kind,
				'type'       => $type,
				'doc_id'     => $doc['id'] ?? null,
				'project_id' => $project_id,
				'title'      => (string) ( 'team' === $type ? ( $doc['name'] ?? $doc['title'] ?? '' ) : ( $doc['title'] ?? $doc['name'] ?? '' ) ),
				'detail'     => (string) $detail,
				'changes'    => $changes,
				'by_member'  => $actor['id'] ?? null,
				'by_role'    => $actor ? GRP_Permissions::effective_role( $actor ) : null,
				'at'         => GRP_Ids::now(),
			)
		);
	}

	/**
	 * Credits completed units to a member (activity kind `auto`).
	 *
	 * @param string      $member_id  Member credited.
	 * @param string|null $project_id Project.
	 * @param string      $title      Task title.
	 * @param string      $detail     Detail, e.g. "2/3".
	 * @param int         $qty        Units.
	 * @param string      $source     board or monthly.
	 * @param string      $ref_key    Key used to remove the credit again.
	 * @return array The activity row.
	 */
	public static function credit( $member_id, $project_id, $title, $detail, $qty, $source, $ref_key ) {
		return GRP_Store::insert(
			'grp_activity',
			array(
				'member_id'  => (string) $member_id,
				'date'       => GRP_Cycles::today(),
				'at'         => GRP_Ids::now(),
				'kind'       => 'auto',
				'source'     => $source,
				'project_id' => $project_id,
				'title'      => (string) $title,
				'detail'     => (string) $detail,
				'qty'        => max( 1, (int) $qty ),
				'ref_key'    => $ref_key,
			)
		);
	}

	/**
	 * Removes credited units, newest first (reference `unlogActivity`).
	 *
	 * @param string   $ref_key Key passed to credit().
	 * @param int|null $qty     Units to remove; null removes all.
	 */
	public static function uncredit( $ref_key, $qty = null ) {
		$left = null === $qty ? PHP_INT_MAX : (int) $qty;

		$rows = GRP_Store::find(
			'grp_activity',
			array( 'ref_key' => $ref_key ),
			array(
				'order_by' => 'at',
				'order'    => 'DESC',
			)
		);

		foreach ( $rows as $row ) {
			if ( $left <= 0 ) {
				break;
			}
			$left -= max( 1, (int) $row['qty'] );
			GRP_Store::delete( 'grp_activity', $row['id'] );
		}
	}
}
