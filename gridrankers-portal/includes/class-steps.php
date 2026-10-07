<?php
/**
 * Task steps (SPEC.md 6.16, designs DEP-A..C): Write → Edit → Proofread, each with its own person.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pure helpers shared by meeting tasks and monthly tasks.
 *
 * A task's `steps` is `[{id, name, member}]` (2–4 steps, in order) or null. Progress per step is kept
 * as `step_done` `{stepId: {n, at, by}}` — on the meeting task, or on the monthly task's cycle record.
 * A step counts only what the step before it has finished (the first one up to the quantity); the
 * task's count is its last step's, so finishing the last step completes the task.
 */
class GRP_Steps {

	const MIN = 2;
	const MAX = 4;

	/**
	 * Validates steps from a request.
	 *
	 * @param mixed $raw Raw steps.
	 * @return array|null|WP_Error Steps, null for none.
	 */
	public static function clean( $raw ) {
		if ( empty( $raw ) ) {
			return null;
		}
		if ( ! is_array( $raw ) ) {
			return new WP_Error( 'grp_invalid', __( 'Invalid steps.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$raw = array_values( $raw );
		if ( count( $raw ) < self::MIN || count( $raw ) > self::MAX ) {
			/* translators: 1: fewest steps, 2: most steps. */
			return new WP_Error( 'grp_invalid', sprintf( __( 'Use %1$d to %2$d steps, or one step.', 'gridrankers-portal' ), self::MIN, self::MAX ), array( 'status' => 400 ) );
		}

		$steps = array();
		$seen  = array();
		foreach ( $raw as $i => $step ) {
			$step   = (array) $step;
			$name   = sanitize_text_field( (string) ( $step['name'] ?? '' ) );
			$name   = function_exists( 'mb_substr' ) ? mb_substr( $name, 0, 40 ) : substr( $name, 0, 40 );
			$member = (string) ( $step['member'] ?? '' );
			if ( '' === trim( $name ) ) {
				return new WP_Error( 'grp_invalid', __( 'Name every step, e.g. Write, Edit, Proofread.', 'gridrankers-portal' ), array( 'status' => 400 ) );
			}
			$person = '' !== $member ? GRP_Store::get( 'grp_members', $member ) : null;
			if ( ! $person || ! (int) $person['active'] ) {
				/* translators: %s: step name. */
				return new WP_Error( 'grp_invalid', sprintf( __( 'Pick who does “%s”.', 'gridrankers-portal' ), $name ), array( 'status' => 400 ) );
			}
			$id = preg_replace( '/[^\w-]/', '', (string) ( $step['id'] ?? '' ) );
			if ( '' === $id || isset( $seen[ $id ] ) ) {
				$id = 's' . strtolower( substr( GRP_Ids::ulid(), -8 ) ) . $i;
			}
			$seen[ $id ] = true;
			$steps[]     = array(
				'id'     => $id,
				'name'   => trim( $name ),
				'member' => $person['id'],
			);
		}

		return $steps;
	}

	/**
	 * The people of a stepped task: each step's person once, sharing the whole task.
	 *
	 * @param array $steps  Steps.
	 * @param int   $target Quantity.
	 * @return array `[{id, n}]`.
	 */
	public static function assignees( array $steps, $target ) {
		$out = array();
		foreach ( $steps as $step ) {
			$out[ $step['member'] ] = array(
				'id' => $step['member'],
				'n'  => max( 1, (int) $target ),
			);
		}

		return array_values( $out );
	}

	/**
	 * Whether a task has steps.
	 *
	 * @param array $task Task row.
	 * @return bool
	 */
	public static function on( array $task ) {
		return is_array( $task['steps'] ?? null ) && count( $task['steps'] ) >= self::MIN;
	}

	/**
	 * Units a step has finished.
	 *
	 * @param mixed  $done    `step_done` value.
	 * @param string $step_id Step id.
	 * @return int
	 */
	public static function n( $done, $step_id ) {
		$done = is_array( $done ) ? $done : array();

		return (int) ( $done[ $step_id ]['n'] ?? 0 );
	}

	/**
	 * The task's count: what its last step has finished.
	 *
	 * @param array $steps Steps.
	 * @param mixed $done  `step_done`.
	 * @return int
	 */
	public static function count( array $steps, $done ) {
		$last = end( $steps );

		return $last ? self::n( $done, $last['id'] ) : 0;
	}

	/**
	 * Index of a step by id, or -1.
	 *
	 * @param array  $steps   Steps.
	 * @param string $step_id Step id.
	 * @return int
	 */
	public static function index( array $steps, $step_id ) {
		foreach ( array_values( $steps ) as $i => $step ) {
			if ( $step['id'] === $step_id ) {
				return $i;
			}
		}

		return -1;
	}

	/**
	 * Most a step may have finished: the quantity for the first, else what the step before finished.
	 *
	 * @param array $steps  Steps.
	 * @param mixed $done   `step_done`.
	 * @param int   $i      Step index.
	 * @param int   $target Quantity.
	 * @return int
	 */
	public static function ready( array $steps, $done, $i, $target ) {
		$target = max( 1, (int) $target );

		return 0 === $i ? $target : min( $target, self::n( $done, $steps[ $i - 1 ]['id'] ) );
	}

	/**
	 * One step moves by one unit: the new `step_done`, or why it can't.
	 *
	 * @param array  $steps    Steps.
	 * @param mixed  $done     `step_done`.
	 * @param string $step_id  Step id.
	 * @param int    $delta    +1 or -1.
	 * @param int    $target   Quantity.
	 * @param string $actor_id Who ticks.
	 * @return array|WP_Error
	 */
	public static function tick( array $steps, $done, $step_id, $delta, $target, $actor_id ) {
		$steps = array_values( $steps );
		$done  = is_array( $done ) ? $done : array();
		$i     = self::index( $steps, $step_id );
		if ( $i < 0 ) {
			return new WP_Error( 'grp_invalid', __( 'That step no longer exists.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$was = self::n( $done, $step_id );
		$now = $was + ( $delta > 0 ? 1 : -1 );
		if ( $delta > 0 && $now > self::ready( $steps, $done, $i, $target ) ) {
			$message = 0 === $i || self::n( $done, $steps[ $i - 1 ]['id'] ) >= $target
				? __( 'This step is finished.', 'gridrankers-portal' )
				/* translators: %s: name of the step before. */
				: sprintf( __( 'Nothing is ready yet — waiting for “%s”.', 'gridrankers-portal' ), $steps[ $i - 1 ]['name'] );
			return new WP_Error( 'grp_step_waiting', $message, array( 'status' => 409 ) );
		}
		if ( $delta < 0 && ( $now < 0 || ( isset( $steps[ $i + 1 ] ) && $now < self::n( $done, $steps[ $i + 1 ]['id'] ) ) ) ) {
			return new WP_Error( 'grp_step_waiting', __( 'The next step already used it — count that one back first.', 'gridrankers-portal' ), array( 'status' => 409 ) );
		}
		$done[ $step_id ] = array(
			'n'  => $now,
			'at' => gmdate( 'c' ),
			'by' => $actor_id,
		);

		return $done;
	}

	/**
	 * After Revise: the last step gives back one unit.
	 *
	 * @param array $steps Steps.
	 * @param mixed $done  `step_done`.
	 * @return array
	 */
	public static function revise( array $steps, $done ) {
		$done = is_array( $done ) ? $done : array();
		$last = end( $steps );
		if ( $last && self::n( $done, $last['id'] ) > 0 ) {
			$done[ $last['id'] ]['n'] = self::n( $done, $last['id'] ) - 1;
		}

		return $done;
	}

	/**
	 * Keeps only the steps that still exist, each within what the step before it finished.
	 *
	 * @param array $steps  Steps.
	 * @param mixed $done   `step_done`.
	 * @param int   $target Quantity.
	 * @return array
	 */
	public static function fit( array $steps, $done, $target ) {
		$done = is_array( $done ) ? $done : array();
		$out  = array();
		foreach ( array_values( $steps ) as $i => $step ) {
			if ( ! isset( $done[ $step['id'] ] ) ) {
				continue;
			}
			$out[ $step['id'] ]      = (array) $done[ $step['id'] ];
			$out[ $step['id'] ]['n'] = min( self::n( $done, $step['id'] ), self::ready( $steps, $out, $i, $target ) );
		}

		return $out;
	}

	/**
	 * The activity credit ref of a step's units.
	 *
	 * @param string $prefix  `stepi` (meeting task) or `stepr` (cycle record).
	 * @param string $id      Task or record id.
	 * @param string $step_id Step id.
	 * @return string
	 */
	public static function ref( $prefix, $id, $step_id ) {
		return $prefix . ':' . $id . ':' . $step_id;
	}
}
