<?php
/**
 * New cycle setup (SPEC.md 6.11): within 3 days of a project's new cycle, a Team Leader or the
 * Super Admin assigns every monthly task and reviews last cycle's monthly tasks.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Last-cycle reviews, stored per project in `cycle_reviews` `{cycleKey: {taskId: review}}`.
 */
class GRP_Cycle_Setup {

	/** Setting `{date}`: the day the rule started; cycles starting before it are exempt. */
	const SINCE_KEY = 'cycle_setup_since';

	/** Days from the cycle start to finish the setup (day 1 to day 3). */
	const DAYS = 3;

	/** Cycles of reviews kept on a project. */
	const KEEP = 3;

	/** Days a feedback notice stays in the Notices box. */
	const FEEDBACK_DAYS = 14;

	/**
	 * Records the review of one monthly task of the project's previous cycle. Feedback (`$ok`
	 * false) goes to the task's responsible people as a private notice.
	 *
	 * @param array  $project Project row.
	 * @param array  $task    Monthly task of that project.
	 * @param bool   $ok      True for "Looks good", false for feedback.
	 * @param string $note    Feedback text (required when `$ok` is false).
	 * @param array  $actor   Acting member.
	 * @param string $today   `Y-m-d`.
	 * @return array Updated project.
	 */
	public static function review( array $project, array $task, $ok, $note, array $actor, $today ) {
		$cycle = GRP_Cycles::cycle_range( $project, -1, $today );
		$to    = $ok ? array() : self::responsible( $task );

		if ( ! $ok && $to ) {
			GRP_Store::insert(
				'grp_posts',
				array(
					'kind'       => 'notice',
					/* translators: %s: monthly task title. */
					'title'      => sprintf( __( 'Feedback: %s', 'gridrankers-portal' ), $task['title'] ),
					'body'       => $note,
					'created_by' => $actor['id'],
					'to_members' => $to,
					'to_member'  => 1 === count( $to ) ? $to[0] : null,
					'show_until' => gmdate( 'Y-m-d', strtotime( $today . ' +' . self::FEEDBACK_DAYS . ' days' ) ),
				)
			);
		}

		$reviews = is_array( $project['cycle_reviews'] ?? null ) ? $project['cycle_reviews'] : array();
		$done    = isset( $reviews[ $cycle['key'] ] ) && is_array( $reviews[ $cycle['key'] ] ) ? $reviews[ $cycle['key'] ] : array();

		$done[ (string) $task['id'] ] = array(
			'ok'   => (bool) $ok,
			'note' => $ok ? '' : $note,
			'to'   => $to,
			'by'   => $actor['id'],
			'at'   => GRP_Ids::now(),
		);
		$reviews[ $cycle['key'] ]     = $done;
		// Keep the latest cycles only (keys sort by date).
		uksort( $reviews, 'strcmp' );
		$reviews = array_slice( $reviews, -self::KEEP, null, true );

		$updated = GRP_Store::update( 'grp_projects', $project['id'], array( 'cycle_reviews' => $reviews ) );
		GRP_Activity::audit( 'project', 'client', $updated, $actor, ( $ok ? 'reviewed last cycle: ' : 'sent feedback on last cycle: ' ) . $task['title'] );

		return $updated;
	}

	/**
	 * Active members responsible for a monthly task (Responsible people and breakdown rows).
	 *
	 * @param array $task Monthly task.
	 * @return string[] Member ids.
	 */
	public static function responsible( array $task ) {
		$ids = array();
		foreach ( (array) ( $task['assignees'] ?? array() ) as $a ) {
			$ids[] = (string) ( is_array( $a ) ? ( $a['id'] ?? '' ) : $a );
		}
		foreach ( (array) ( $task['parts'] ?? array() ) as $part ) {
			foreach ( (array) ( $part['people'] ?? array() ) as $a ) {
				$ids[] = (string) ( is_array( $a ) ? ( $a['id'] ?? '' ) : $a );
			}
		}
		$out = array();
		foreach ( array_unique( array_filter( $ids ) ) as $id ) {
			$member = GRP_Store::get( 'grp_members', $id );
			if ( $member && (int) $member['active'] ) {
				$out[] = $id;
			}
		}
		return $out;
	}
}
