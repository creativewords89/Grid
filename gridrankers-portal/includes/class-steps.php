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
 * A task's `steps` is `[{id, name, member, due}]` (2–10 steps, in order) or null; `due` is a date on
 * meeting tasks and a day of the cycle (1–31) on monthly tasks, or null. Progress per step is kept as
 * `step_done` `{stepId: {n, at, by, started}}` — on the meeting task, or on the monthly task's cycle
 * record. A step is Not started, In progress (started, or part of its quantity done) or Completed.
 * A step counts only what the step before it has finished (the first one up to the quantity); the
 * task's count is its last step's, so finishing the last step completes the task.
 *
 * A step may also have a hand-in checklist (design SH-2B): `handin` `[{id, label, kind, required}]`,
 * kind file, link or image. What was handed in is kept as `handins` `{stepId: {itemId: {files, links,
 * by, at}}}` next to `step_done`; a step can't be Completed until its required items are in.
 */
class GRP_Steps {

	const MIN = 2;
	const MAX = 10;

	/**
	 * Most items on one step's hand-in checklist, and most files or links in one item.
	 */
	const MAX_HANDIN = 10;

	/**
	 * Kinds of hand-in item: a file (any accepted type), a link (Figma, Google Doc …) or an image.
	 */
	const HANDIN_KINDS = array( 'file', 'link', 'image' );

	/**
	 * The hand-in of a step without a checklist: optional files or links.
	 */
	const DEFAULT_HANDIN = array(
		'id'       => 'work',
		'label'    => 'Files or links',
		'kind'     => 'file',
		'required' => false,
	);

	/**
	 * Validates steps from a request.
	 *
	 * @param mixed  $raw Raw steps.
	 * @param string $due `date` (meeting tasks: YYYY-MM-DD) or `day` (monthly tasks: day of the cycle).
	 * @return array|null|WP_Error Steps, null for none.
	 */
	public static function clean( $raw, $due = 'date' ) {
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
			$when = self::due( $step['due'] ?? null, $due );
			if ( is_wp_error( $when ) ) {
				return $when;
			}
			$last = null;
			foreach ( array_reverse( $steps ) as $before ) {
				if ( null !== $before['due'] ) {
					$last = $before;
					break;
				}
			}
			if ( null !== $when && $last && $when < $last['due'] ) {
				/* translators: 1: step name, 2: the step before. */
				return new WP_Error( 'grp_invalid', sprintf( __( '“%1$s” is due before “%2$s” — each step’s date must be on or after the one before.', 'gridrankers-portal' ), trim( $name ), $last['name'] ), array( 'status' => 400 ) );
			}
			$handin = self::clean_handin( $step['handin'] ?? null );
			if ( is_wp_error( $handin ) ) {
				return $handin;
			}
			$seen[ $id ] = true;
			$steps[]     = array(
				'id'     => $id,
				'name'   => trim( $name ),
				'member' => $person['id'],
				'due'    => $when,
			) + ( $handin ? array( 'handin' => $handin ) : array() );
		}

		return $steps;
	}

	/**
	 * Validates a step's hand-in checklist: `[{id, label, kind, required}]`, at most MAX_HANDIN.
	 *
	 * @param mixed $raw Raw items.
	 * @return array|WP_Error Items, empty for none.
	 */
	public static function clean_handin( $raw ) {
		if ( empty( $raw ) ) {
			return array();
		}
		if ( ! is_array( $raw ) ) {
			return new WP_Error( 'grp_invalid', __( 'Invalid hand-in checklist.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$raw = array_values( $raw );
		if ( count( $raw ) > self::MAX_HANDIN ) {
			/* translators: %d: most items. */
			return new WP_Error( 'grp_invalid', sprintf( __( 'A step can ask for at most %d things to hand in.', 'gridrankers-portal' ), self::MAX_HANDIN ), array( 'status' => 400 ) );
		}
		$items = array();
		$seen  = array();
		foreach ( $raw as $i => $item ) {
			$item  = (array) $item;
			$label = trim( sanitize_text_field( (string) ( $item['label'] ?? '' ) ) );
			$label = function_exists( 'mb_substr' ) ? mb_substr( $label, 0, 80 ) : substr( $label, 0, 80 );
			if ( '' === $label ) {
				return new WP_Error( 'grp_invalid', __( 'Say what to hand in, e.g. Article draft.', 'gridrankers-portal' ), array( 'status' => 400 ) );
			}
			$kind = (string) ( $item['kind'] ?? 'file' );
			if ( ! in_array( $kind, self::HANDIN_KINDS, true ) ) {
				return new WP_Error( 'grp_invalid', __( 'A hand-in is a file, a link or an image.', 'gridrankers-portal' ), array( 'status' => 400 ) );
			}
			$id = preg_replace( '/[^\w-]/', '', (string) ( $item['id'] ?? '' ) );
			if ( '' === $id || isset( $seen[ $id ] ) ) {
				$id = 'h' . strtolower( substr( GRP_Ids::ulid(), -8 ) ) . $i;
			}
			$id          = substr( $id, 0, 40 );
			$seen[ $id ] = true;
			$items[]     = array(
				'id'       => $id,
				'label'    => $label,
				'kind'     => $kind,
				'required' => ! empty( $item['required'] ),
			);
		}

		return $items;
	}

	/**
	 * What a step can hand in: its checklist, or — on a step without one — a single optional
	 * "Files or links" item, so anyone completing a step can hand in their work.
	 *
	 * @param array $step Step.
	 * @return array
	 */
	public static function handin( array $step ) {
		$items = is_array( $step['handin'] ?? null ) ? array_values( $step['handin'] ) : array();

		return $items ? $items : array( self::DEFAULT_HANDIN );
	}

	/**
	 * Whether an item of a step has something handed in (a file or a link).
	 *
	 * @param mixed  $handins `handins`.
	 * @param string $step_id Step id.
	 * @param string $item_id Item id.
	 * @return bool
	 */
	public static function handed_in( $handins, $step_id, $item_id ) {
		$got = is_array( $handins ) ? (array) ( $handins[ $step_id ][ $item_id ] ?? array() ) : array();

		return ! empty( $got['files'] ) || ! empty( $got['links'] );
	}

	/**
	 * The required items of a step not handed in yet.
	 *
	 * @param array $step    Step.
	 * @param mixed $handins `handins`.
	 * @return array Items.
	 */
	public static function missing( array $step, $handins ) {
		return array_values(
			array_filter(
				self::handin( $step ),
				static function ( $item ) use ( $step, $handins ) {
					return $item['required'] && ! self::handed_in( $handins, $step['id'], $item['id'] );
				}
			)
		);
	}

	/**
	 * Why a step can't be Completed yet: its first missing required item (409), or null.
	 *
	 * @param array $step    Step.
	 * @param mixed $handins `handins`.
	 * @return WP_Error|null
	 */
	public static function handin_needed( array $step, $handins ) {
		$missing = self::missing( $step, $handins );
		if ( ! $missing ) {
			return null;
		}

		return new WP_Error(
			'grp_handin_needed',
			/* translators: %s: what to hand in. */
			sprintf( __( 'Hand in “%s” first.', 'gridrankers-portal' ), $missing[0]['label'] ),
			array(
				'status'  => 409,
				'missing' => wp_list_pluck( $missing, 'id' ),
			)
		);
	}

	/**
	 * A step's due date (YYYY-MM-DD) or day of the cycle (1–31), or null.
	 *
	 * @param mixed  $raw  Raw value.
	 * @param string $kind `date` or `day`.
	 * @return string|int|null|WP_Error
	 */
	private static function due( $raw, $kind ) {
		if ( null === $raw || '' === $raw || false === $raw ) {
			return null;
		}
		if ( 'day' === $kind ) {
			$day = (int) $raw;
			if ( $day < 1 || $day > 31 ) {
				return new WP_Error( 'grp_invalid', __( 'A step’s due day is a day of the cycle, 1 to 31.', 'gridrankers-portal' ), array( 'status' => 400 ) );
			}
			return $day;
		}
		$date = (string) $raw;
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date ) || ! checkdate( (int) substr( $date, 5, 2 ), (int) substr( $date, 8, 2 ), (int) substr( $date, 0, 4 ) ) ) {
			return new WP_Error( 'grp_invalid', __( 'Pick a valid due date for each step.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}

		return $date;
	}

	/**
	 * The last step's due (the task's own deadline), or null.
	 *
	 * @param array $steps Steps.
	 * @return string|int|null
	 */
	public static function last_due( array $steps ) {
		$last = end( $steps );

		return $last ? ( $last['due'] ?? null ) : null;
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
			'n'       => $now,
			'at'      => gmdate( 'c' ),
			'by'      => $actor_id,
			'started' => $now > 0 || ! empty( $done[ $step_id ]['started'] ),
		);

		return $done;
	}

	/**
	 * A step's status: todo (Not started), doing (In progress) or done (Completed).
	 *
	 * @param mixed  $done    `step_done`.
	 * @param string $step_id Step id.
	 * @param int    $target  Quantity.
	 * @return string
	 */
	public static function state( $done, $step_id, $target ) {
		$n = self::n( $done, $step_id );
		if ( $n >= max( 1, (int) $target ) ) {
			return 'done';
		}

		return $n > 0 || ! empty( ( is_array( $done ) ? $done : array() )[ $step_id ]['started'] ) ? 'doing' : 'todo';
	}

	/**
	 * Moves a step to Not started, In progress or Completed. Completed needs the step before
	 * finished in full; In progress needs something ready; going back can't drop below what the
	 * next step already used.
	 *
	 * @param array  $steps    Steps.
	 * @param mixed  $done     `step_done`.
	 * @param string $step_id  Step id.
	 * @param string $to       todo, doing or done.
	 * @param int    $target   Quantity.
	 * @param string $actor_id Who moves it.
	 * @return array|WP_Error `[step_done, forward]`; forward is false for a move back.
	 */
	public static function set_state( array $steps, $done, $step_id, $to, $target, $actor_id ) {
		$steps  = array_values( $steps );
		$done   = is_array( $done ) ? $done : array();
		$target = max( 1, (int) $target );
		$i      = self::index( $steps, $step_id );
		if ( $i < 0 || ! in_array( $to, array( 'todo', 'doing', 'done' ), true ) ) {
			return new WP_Error( 'grp_invalid', __( 'That step no longer exists.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$was   = self::state( $done, $step_id, $target );
		$order = array(
			'todo'  => 0,
			'doing' => 1,
			'done'  => 2,
		);
		if ( $was === $to ) {
			return array( $done, true );
		}
		$ready = self::ready( $steps, $done, $i, $target );
		$prev  = $i > 0 ? $steps[ $i - 1 ] : null;
		$next  = $steps[ $i + 1 ] ?? null;
		$n     = self::n( $done, $step_id );
		if ( 'done' === $to && $ready < $target ) {
			/* translators: %s: name of the step before. */
			return new WP_Error( 'grp_step_waiting', sprintf( __( '“%s” has to be completed first.', 'gridrankers-portal' ), $prev['name'] ?? '' ), array( 'status' => 409 ) );
		}
		if ( 'doing' === $to && 'todo' === $was && $ready < 1 ) {
			/* translators: %s: name of the step before. */
			return new WP_Error( 'grp_step_waiting', sprintf( __( 'Nothing is ready yet — waiting for “%s”.', 'gridrankers-portal' ), $prev['name'] ?? '' ), array( 'status' => 409 ) );
		}
		$new = 'done' === $to ? $target : ( 'doing' === $to ? min( $n, $target - 1 ) : 0 );
		if ( $next && $new < self::n( $done, $next['id'] ) ) {
			return new WP_Error( 'grp_step_waiting', __( 'The next step already used it — move that one back first.', 'gridrankers-portal' ), array( 'status' => 409 ) );
		}
		$done[ $step_id ] = array(
			'n'       => $new,
			'at'      => gmdate( 'c' ),
			'by'      => $actor_id,
			'started' => 'todo' !== $to,
		);

		return array( $done, $order[ $to ] > $order[ $was ] );
	}

	/**
	 * What a step request asks for: `{status}` (todo, doing, done) or `{delta}` (+1 / −1), or
	 * nothing when it only hands in.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error `{status}`, `{delta}` or empty.
	 */
	public static function change( WP_REST_Request $request ) {
		$status = (string) ( $request['status'] ?? '' );
		if ( '' !== $status ) {
			if ( ! in_array( $status, array( 'todo', 'doing', 'done' ), true ) ) {
				return new WP_Error( 'grp_invalid', __( 'Invalid status.', 'gridrankers-portal' ), array( 'status' => 400 ) );
			}
			return array( 'status' => $status );
		}
		$delta = (int) $request['delta'];
		if ( 0 === $delta && null !== $request['handins'] ) {
			// Only a hand-in (design SH-2B): the step stays where it is.
			return array();
		}
		if ( 1 !== abs( $delta ) ) {
			return new WP_Error( 'grp_invalid', __( 'Progress changes one unit at a time.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}

		return array( 'delta' => $delta );
	}

	/**
	 * +1 for a move forward, −1 for a move back (Team Leaders and the Super Admin only).
	 *
	 * @param array  $change  From change().
	 * @param mixed  $done    `step_done`.
	 * @param string $step_id Step id.
	 * @param int    $target  Quantity.
	 * @return int
	 */
	public static function direction( array $change, $done, $step_id, $target ) {
		if ( isset( $change['delta'] ) ) {
			return $change['delta'];
		}
		if ( ! isset( $change['status'] ) ) {
			return 1;
		}
		$order = array(
			'todo'  => 0,
			'doing' => 1,
			'done'  => 2,
		);

		return $order[ $change['status'] ] >= $order[ self::state( $done, $step_id, $target ) ] ? 1 : -1;
	}

	/**
	 * Applies a change: the new `step_done`, or why it can't.
	 *
	 * @param array  $steps    Steps.
	 * @param mixed  $done     `step_done`.
	 * @param string $step_id  Step id.
	 * @param array  $change   From change().
	 * @param int    $target   Quantity.
	 * @param string $actor_id Who.
	 * @return array|WP_Error
	 */
	public static function apply( array $steps, $done, $step_id, array $change, $target, $actor_id ) {
		if ( ! $change ) {
			return is_array( $done ) ? $done : array();
		}
		if ( isset( $change['delta'] ) ) {
			return self::tick( $steps, $done, $step_id, $change['delta'], $target, $actor_id );
		}
		$moved = self::set_state( $steps, $done, $step_id, $change['status'], $target, $actor_id );

		return is_wp_error( $moved ) ? $moved : $moved[0];
	}

	/**
	 * The `handins` after a step request, or why the step can't be Completed: a step that is
	 * Completed after the request (newly, or with its hand-ins changed) needs every required item.
	 *
	 * @param array      $step    Step.
	 * @param mixed      $before  `step_done` before.
	 * @param mixed      $after   `step_done` after.
	 * @param mixed      $was     `handins` before.
	 * @param array|null $handins `handins` sent, or null.
	 * @param int        $target  Quantity.
	 * @return array|null|WP_Error The `handins` to keep.
	 */
	public static function check_handins( array $step, $before, $after, $was, $handins, $target ) {
		$now = null !== $handins ? $handins : $was;
		if ( 'done' === self::state( $after, $step['id'], $target ) && ( null !== $handins || 'done' !== self::state( $before, $step['id'], $target ) ) ) {
			$needed = self::handin_needed( $step, $now );
			if ( $needed ) {
				return $needed;
			}
		}

		return $now;
	}

	/**
	 * Whether any step has begun (In progress or more).
	 *
	 * @param array $steps Steps.
	 * @param mixed $done  `step_done`.
	 * @param int   $target Quantity.
	 * @return bool
	 */
	public static function begun( array $steps, $done, $target ) {
		foreach ( $steps as $step ) {
			if ( 'todo' !== self::state( $done, $step['id'], $target ) ) {
				return true;
			}
		}

		return false;
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
