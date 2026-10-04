<?php
/**
 * Requests to undo In progress (SPEC.md 6.6): a Team Member who moved a task to In progress by
 * mistake asks a Team Leader or the Super Admin to put it back to Not started.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Shared by meeting tasks and cycle records: the request stored in `undo_request`, the reason check and
 * the answer sent to the person as a private notice.
 */
class GRP_Undo {

	/**
	 * Shortest reason accepted: they must say what the mistake was and why.
	 */
	const MIN_REASON = 10;

	/**
	 * Days the answer stays in the person's Notices.
	 */
	const NOTICE_DAYS = 7;

	/**
	 * The pending request on a row, or null.
	 *
	 * @param array|null $row Task or record.
	 * @return array|null
	 */
	public static function pending( $row ) {
		$undo = is_array( $row ) ? ( $row['undo_request'] ?? null ) : null;

		return is_array( $undo ) && ! empty( $undo['by'] ) ? $undo : null;
	}

	/**
	 * A new request, or WP_Error when the reason is too short.
	 *
	 * @param mixed $reason Raw reason.
	 * @param array $actor  Asking member.
	 * @return array|WP_Error
	 */
	public static function request( $reason, array $actor ) {
		$reason = trim( sanitize_textarea_field( (string) $reason ) );
		if ( mb_strlen( $reason ) < self::MIN_REASON ) {
			return new WP_Error( 'grp_undo_reason', __( 'Write what the mistake was and why it should be undone.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}

		return array(
			'by'     => $actor['id'],
			'at'     => GRP_Ids::now(),
			'reason' => mb_substr( $reason, 0, 500 ),
		);
	}

	/**
	 * Tells the person who asked how their request was answered.
	 *
	 * @param array  $undo     The request.
	 * @param bool   $approved Undone (true) or kept In progress.
	 * @param string $title    Task title.
	 * @param string $note     The decider's note (optional).
	 * @param array  $actor    Deciding member.
	 */
	public static function answer( array $undo, $approved, $title, $note, array $actor ) {
		$body = $approved
			/* translators: %s: task title. */
			? sprintf( __( '“%s” is back to Not started.', 'gridrankers-portal' ), $title )
			/* translators: %s: task title. */
			: sprintf( __( '“%s” stays In progress.', 'gridrankers-portal' ), $title );
		$note = trim( sanitize_textarea_field( (string) $note ) );
		GRP_Store::insert(
			'grp_posts',
			array(
				'kind'       => 'notice',
				'title'      => $approved ? __( 'Undo approved', 'gridrankers-portal' ) : __( 'Undo not approved', 'gridrankers-portal' ),
				'body'       => '' !== $note ? $body . "\n" . mb_substr( $note, 0, 500 ) : $body,
				'created_by' => $actor['id'],
				'to_members' => array( $undo['by'] ),
				'to_member'  => $undo['by'],
				'show_until' => gmdate( 'Y-m-d', strtotime( GRP_Cycles::today() . ' +' . self::NOTICE_DAYS . ' days' ) ),
			)
		);
	}
}
