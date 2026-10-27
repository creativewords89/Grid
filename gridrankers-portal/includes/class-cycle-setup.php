<?php
/**
 * New cycle setup (SPEC.md 6.11): within 3 days of a project's new cycle, a Team Leader or the
 * Super Admin assigns every monthly task and reviews last cycle's monthly and meeting tasks.
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
	 * Records the review of one monthly or meeting task of the project's previous cycle.
	 * Feedback (`$ok` false) goes to the task's responsible people as a private notice; a
	 * carried-over meeting task (`$carry`) gets that date as its deadline.
	 *
	 * @param array       $project Project row.
	 * @param array       $task    Monthly or meeting task of that project.
	 * @param bool        $ok      True for "Looks good", false for feedback.
	 * @param string      $note    Feedback text (required when `$ok` is false).
	 * @param array       $actor   Acting member.
	 * @param string      $today   `Y-m-d`.
	 * @param string|null $carry   New deadline `Y-m-d` for an open meeting task.
	 * @return array Updated project.
	 */
	public static function review( array $project, array $task, $ok, $note, array $actor, $today, $carry = null ) {
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

		if ( $carry ) {
			$moved = GRP_Store::update(
				'grp_meeting_tasks',
				$task['id'],
				array(
					'deadline' => array(
						'type' => 'date',
						'date' => $carry,
					),
					'carried'  => array(
						'from'    => 'meeting',
						'task_id' => (string) $task['id'],
						'cycle'   => $cycle['key'],
						'label'   => self::label( $cycle ),
					),
				)
			);
			GRP_Activity::audit( 'edit', 'items', $moved, $actor, 'carried over to ' . $carry );
		}

		$done[ (string) $task['id'] ] = array(
			'ok'   => (bool) $ok,
			'note' => $ok ? '' : $note,
			'to'   => $to,
			'by'   => $actor['id'],
			'at'   => GRP_Ids::now(),
		);
		if ( $carry ) {
			$done[ (string) $task['id'] ]['carry'] = $carry;
		}
		$reviews[ $cycle['key'] ] = $done;
		// Keep the latest cycles only (keys sort by date).
		uksort( $reviews, 'strcmp' );
		$reviews = array_slice( $reviews, -self::KEEP, null, true );

		$updated = GRP_Store::update( 'grp_projects', $project['id'], array( 'cycle_reviews' => $reviews ) );
		GRP_Activity::audit( 'project', 'client', $updated, $actor, ( $ok ? 'reviewed last cycle: ' : 'sent feedback on last cycle: ' ) . $task['title'] );

		return $updated;
	}

	/**
	 * Short name of a cycle for "left from Sep": the month it starts in.
	 *
	 * @param array $cycle `{start}`.
	 * @return string
	 */
	public static function label( array $cycle ) {
		return gmdate( 'M', strtotime( $cycle['start'] . ' 00:00:00 UTC' ) );
	}

	/**
	 * The catch-up task already made from a monthly task for a cycle, or null.
	 *
	 * @param array  $task  Monthly task.
	 * @param string $cycle Cycle key.
	 * @return array|null
	 */
	public static function catch_up_of( array $task, $cycle ) {
		foreach ( GRP_Store::find( 'grp_meeting_tasks', array( 'project_id' => $task['project_id'] ) ) as $row ) {
			$from = is_array( $row['carried'] ?? null ) ? $row['carried'] : array();
			$same = array( 'monthly', (string) $task['id'], $cycle ) === array( $from['from'] ?? '', (string) ( $from['task_id'] ?? '' ), $from['cycle'] ?? '' );
			if ( empty( $row['deleted_at'] ) && $same ) {
				return $row;
			}
		}

		return null;
	}

	/**
	 * Moves what a monthly task left unfinished last cycle into this one (SPEC.md 6.11, design
	 * CO-1A): a one-off meeting task "{title} — N left from Sep" for its people, with that deadline.
	 * Last cycle's record stays as it was.
	 *
	 * @param array  $project Project row.
	 * @param array  $task    Monthly task.
	 * @param int    $left    Units to catch up.
	 * @param string $due     Deadline `Y-m-d`.
	 * @param array  $actor   Acting member.
	 * @param string $today   `Y-m-d`.
	 * @return array The catch-up meeting task.
	 */
	public static function catch_up( array $project, array $task, $left, $due, array $actor, $today ) {
		$cycle  = GRP_Cycles::cycle_range( $project, -1, $today );
		$label  = self::label( $cycle );
		$people = self::responsible( $task );
		$row    = GRP_Store::insert(
			'grp_meeting_tasks',
			array(
				'project_id'   => $project['id'],
				/* translators: 1: monthly task title, 2: units left, 3: month the cycle started. */
				'title'        => sprintf( __( '%1$s — %2$d left from %3$s', 'gridrankers-portal' ), $task['title'], $left, $label ),
				/* translators: 1: monthly task title, 2: month the cycle started. */
				'notes'        => sprintf( __( 'Catch-up from the monthly task “%1$s”, not finished in the %2$s cycle.', 'gridrankers-portal' ), $task['title'], $label ),
				'priority'     => 'normal',
				'status'       => 'todo',
				'meeting_date' => $today,
				'target'       => $left,
				'assignees'    => array_map(
					static function ( $id ) use ( $left ) {
						return array(
							'id' => $id,
							'n'  => $left,
						);
					},
					$people
				),
				'team'         => count( $people ) > 1 ? 1 : 0,
				'progress'     => array(),
				'deadline'     => array(
					'type' => 'date',
					'date' => $due,
				),
				'carried'      => array(
					'from'    => 'monthly',
					'task_id' => (string) $task['id'],
					'cycle'   => $cycle['key'],
					'label'   => $label,
					'left'    => $left,
				),
				'created_by'   => $actor['id'],
			)
		);
		GRP_Activity::audit( 'add', 'items', $row, $actor, 'catch-up from ' . $label . ' · ' . $task['title'] );

		return $row;
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
