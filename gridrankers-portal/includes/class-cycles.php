<?php
/**
 * Project cycle and week maths (SPEC.md sections 6.1, 6.2, 6.4).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pure functions ported from the reference portal (periodsOf, cycleRange, cycleAt,
 * monthRange, dueAt); weeks follow the project cycle (SPEC.md 6.2), not the reference's
 * calendar-month weeks. Every function takes "today" as a
 * `Y-m-d` string so results are deterministic; dates are returned as `Y-m-d`
 * strings (period ends are inclusive, i.e. the whole end day belongs to the period).
 *
 * Projects may be `grp_projects` rows (`cycle_day`, `cycle_changes`) or reference
 * objects (`cycleDay`, `cycleChanges`); tasks may use `due_day` or `dueDay`.
 */
class GRP_Cycles {

	/**
	 * The reference builds periods from 18 months before today to 18 months after.
	 */
	const WINDOW_MONTHS = 18;

	/**
	 * Today in the site's timezone.
	 *
	 * @return string `Y-m-d`.
	 */
	public static function today() {
		return wp_date( 'Y-m-d' );
	}

	/**
	 * All periods of a project around today (port of `periodsOf`).
	 *
	 * Each period: `{key, start, end, day, cut, merged, transition, monthly, change}`.
	 * Key is `YYYY-MM` of the start, `T` + start date for transitions, with `-DD`
	 * appended when that key is already taken.
	 *
	 * @param array|object $project Project.
	 * @param string       $today   `Y-m-d`.
	 * @return array[]
	 */
	public static function periods_of( $project, $today ) {
		$changes = self::changes_of( $project );
		usort(
			$changes,
			static function ( $a, $b ) {
				return strcmp( (string) $a['from'], (string) $b['from'] );
			}
		);

		list( $ny, $nm ) = self::parts( $today );

		$day  = self::clamp_day( $changes ? ( $changes[0]['prevDay'] ?? null ) : self::cycle_day_of( $project ) );
		$cur  = self::date( $ny, $nm - self::WINDOW_MONTHS, $day );
		$stop = self::date( $ny, $nm + self::WINDOW_MONTHS, 1 );

		$out   = array();
		$keys  = array();
		$ci    = 0;
		$guard = 0;
		$push  = static function ( array $p ) use ( &$out, &$keys ) {
			$p  += array(
				'day'        => null,
				'cut'        => false,
				'merged'     => false,
				'transition' => false,
				'monthly'    => null,
				'change'     => null,
			);
			$key = $p['transition'] ? 'T' . $p['start'] : substr( $p['start'], 0, 7 );
			if ( isset( $keys[ $key ] ) ) {
				$key .= '-' . substr( $p['start'], 8, 2 );
			}
			$keys[ $key ] = true;
			$out[]        = array( 'key' => $key ) + $p;
		};

		while ( $cur < $stop && $guard++ < 300 ) {
			list( $cy, $cm ) = self::parts( $cur );
			$next_reg        = self::date( $cy, $cm + 1, $day );
			$ch              = $changes[ $ci ] ?? null;

			if ( $ch ) {
				$f = (string) $ch['from'];
				if ( $f < $cur ) {
					$f = $cur;
				}
				if ( $f <= $next_reg ) {
					if ( $f > $cur ) {
						$push(
							array(
								'start' => $cur,
								'end'   => self::end_before( $f ),
								'day'   => $day,
								'cut'   => $f < $next_reg,
							)
						);
					}
					$nd              = self::clamp_day( $ch['day'] ?? null );
					list( $fy, $fm ) = self::parts( $f );
					$first           = self::date( $fy, $fm, $nd );
					if ( $first < $f ) {
						$first = self::date( $fy, $fm + 1, $nd );
					}
					if ( $first > $f ) {
						if ( 'merge' === ( $ch['mode'] ?? '' ) ) {
							list( $xy, $xm ) = self::parts( $first );
							$nx              = self::date( $xy, $xm + 1, $nd );
							$push(
								array(
									'start'  => $f,
									'end'    => self::end_before( $nx ),
									'day'    => $nd,
									'merged' => true,
									'change' => $ch,
								)
							);
							$cur = $nx;
						} else {
							$push(
								array(
									'start'      => $f,
									'end'        => self::end_before( $first ),
									'transition' => true,
									'monthly'    => 'due' === ( $ch['mode'] ?? '' ) ? 'due' : 'waived',
									'change'     => $ch,
								)
							);
							$cur = $first;
						}
					} else {
						$cur = $first;
					}
					$day = $nd;
					++$ci;
					continue;
				}
			}

			$push(
				array(
					'start' => $cur,
					'end'   => self::end_before( $next_reg ),
					'day'   => $day,
				)
			);
			$cur = $next_reg;
		}

		return $out;
	}

	/**
	 * The period containing today, shifted by `$off` cycles (port of `cycleRange`).
	 *
	 * @param array|object $project Project.
	 * @param int          $off     Cycles from the current one (negative = past).
	 * @param string       $today   `Y-m-d`.
	 * @return array
	 */
	public static function cycle_range( $project, $off, $today ) {
		$list = self::periods_of( $project, $today );
		$i    = self::index_containing( $list, $today );

		return $list[ max( 0, min( count( $list ) - 1, $i + (int) $off ) ) ];
	}

	/**
	 * The period containing a date, or the last period (port of `cycleAt`).
	 *
	 * Used to place meeting tasks in the cycle of their meeting (or created) date.
	 *
	 * @param array|object $project Project.
	 * @param string       $date    `Y-m-d`.
	 * @param string       $today   `Y-m-d`.
	 * @return array
	 */
	public static function cycle_at( $project, $date, $today ) {
		$list = self::periods_of( $project, $today );

		return $list[ self::index_containing( $list, $date ) ];
	}

	/**
	 * Calendar month `$off` months from today (port of `monthRange`).
	 *
	 * @param int    $off   Months from the current one.
	 * @param string $today `Y-m-d`.
	 * @return array `{key, start, end}`.
	 */
	public static function month_range( $off, $today ) {
		list( $y, $m ) = self::parts( $today );
		$start         = self::date( $y, $m + (int) $off, 1 );

		return array(
			'key'   => substr( $start, 0, 7 ),
			'start' => $start,
			'end'   => self::date( $y, $m + (int) $off + 1, 0 ),
		);
	}

	/**
	 * Weeks of a period, counted from its start: 7-day weeks, the last one taking the
	 * leftover days. A period has `max(1, floor(days / 7))` weeks (SPEC.md 6.2).
	 *
	 * @param array $period Period with `start` and `end`.
	 * @return array[] `[{start, end}]`.
	 */
	public static function weeks_in( array $period ) {
		$days              = self::days_between( $period['start'], $period['end'] ) + 1;
		$n                 = max( 1, intdiv( $days, 7 ) );
		list( $y, $m, $d ) = self::parts( $period['start'] );
		$weeks             = array();
		for ( $w = 0; $w < $n; $w++ ) {
			$weeks[] = array(
				'start' => self::date( $y, $m, $d + 7 * $w ),
				'end'   => $w < $n - 1 ? self::date( $y, $m, $d + 7 * $w + 6 ) : $period['end'],
			);
		}

		return $weeks;
	}

	/**
	 * Weeks of the project's cycle `$off` cycles from the current one.
	 *
	 * @param array|object $project Project.
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return array[]
	 */
	public static function weeks_of( $project, $off, $today ) {
		return self::weeks_in( self::cycle_range( $project, $off, $today ) );
	}

	/**
	 * Two-week periods of a period (SPEC.md 6.2): pairs of its weeks, the last one taking a
	 * leftover week (`max(1, floor(weeks / 2))` of them). Each also says which weeks it covers.
	 *
	 * @param array $period Period with `start` and `end`.
	 * @return array[] `[{start, end, from_week, to_week}]` (weeks 1-based).
	 */
	public static function halves_in( array $period ) {
		$weeks = self::weeks_in( $period );
		$n     = max( 1, intdiv( count( $weeks ), 2 ) );
		$out   = array();
		for ( $h = 0; $h < $n; $h++ ) {
			$last  = $h === $n - 1 ? count( $weeks ) - 1 : 2 * $h + 1;
			$out[] = array(
				'start'     => $weeks[ 2 * $h ]['start'],
				'end'       => $weeks[ $last ]['end'],
				'from_week' => 2 * $h + 1,
				'to_week'   => $last + 1,
			);
		}

		return $out;
	}

	/**
	 * The parts a recurring task is tracked in within a period: weeks for weekly tasks,
	 * two-week periods for bi-weekly ones, null for monthly tasks (the whole period).
	 *
	 * @param array|object $task   Monthly task.
	 * @param array        $period Period.
	 * @return array[]|null
	 */
	public static function slots_in( $task, array $period ) {
		$task = (array) $task;
		if ( self::is_weekly( $task ) ) {
			return self::weeks_in( $period );
		}

		return self::is_biweekly( $task ) ? self::halves_in( $period ) : null;
	}

	/**
	 * Slot (week or two-week period) of a task containing today in cycle `$off`: the first
	 * for future cycles, the last for past ones.
	 *
	 * @param array|object $task    Monthly task.
	 * @param array|object $project Project.
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return int
	 */
	public static function active_slot( $task, $project, $off, $today ) {
		$slots = (array) self::slots_in( $task, self::cycle_range( $project, $off, $today ) );
		for ( $i = count( $slots ) - 1; $i > 0; $i-- ) {
			if ( $today >= $slots[ $i ]['start'] ) {
				return $i;
			}
		}

		return 0;
	}

	/**
	 * Week `$w` (0-based, clamped to the period's weeks) of a project's cycle.
	 *
	 * @param array|object $project Project.
	 * @param int          $w       Week index.
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return array `{start, end}`.
	 */
	public static function week_range( $project, $w, $off, $today ) {
		$weeks = self::weeks_of( $project, $off, $today );

		return $weeks[ max( 0, min( count( $weeks ) - 1, (int) $w ) ) ];
	}

	/**
	 * Index of the week containing today in cycle `$off`: the first week for future
	 * cycles, the last week for past ones.
	 *
	 * @param array|object $project Project.
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return int
	 */
	public static function active_week( $project, $off, $today ) {
		$weeks = self::weeks_of( $project, $off, $today );
		for ( $w = count( $weeks ) - 1; $w > 0; $w-- ) {
			if ( $today >= $weeks[ $w ]['start'] ) {
				return $w;
			}
		}

		return 0;
	}

	/**
	 * Due date of a recurring task in a period (port of `dueAt`, with cycle weeks).
	 *
	 * Weekly / bi-weekly tasks: end of week or two-week period `$w` (default: the active one)
	 * of the cycle. Monthly tasks: end of the cycle, or day `due_day` of the cycle capped at
	 * the cycle end.
	 *
	 * @param array|object $task    Monthly task.
	 * @param array|object $project Project.
	 * @param int|null     $w       Week index for weekly tasks.
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return string `Y-m-d`.
	 */
	public static function due_at( $task, $project, $w, $off, $today ) {
		$task = (array) $task;

		$slots = self::slots_in( $task, self::cycle_range( $project, $off, $today ) );
		if ( $slots ) {
			$i = null === $w ? self::active_slot( $task, $project, $off, $today ) : (int) $w;
			return $slots[ max( 0, min( count( $slots ) - 1, $i ) ) ]['end'];
		}

		$range   = self::cycle_range( $project, $off, $today );
		$due_day = (int) ( $task['due_day'] ?? $task['dueDay'] ?? 0 );
		if ( ! $due_day ) {
			return $range['end'];
		}

		list( $y, $m, $d ) = self::parts( $range['start'] );
		$x                 = self::date( $y, $m, $d + $due_day - 1 );

		return $x > $range['end'] ? $range['end'] : $x;
	}

	/**
	 * Period key of a recurring task: `{cycle key}-wN` for weekly tasks, `{cycle key}-hN` for
	 * bi-weekly ones (N = two-week period), else the cycle key.
	 *
	 * @param array|object $task    Monthly task.
	 * @param array|object $project Project.
	 * @param int|null     $w       Week index for weekly tasks (default: active week).
	 * @param int          $off     Cycles from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return string
	 */
	public static function period_key( $task, $project, $w, $off, $today ) {
		$cycle = self::cycle_range( $project, $off, $today )['key'];
		$task  = (array) $task;
		if ( self::is_weekly( $task ) || self::is_biweekly( $task ) ) {
			$w = null === $w ? self::active_slot( $task, $project, $off, $today ) : (int) $w;
			return $cycle . ( self::is_weekly( $task ) ? '-w' : '-h' ) . ( $w + 1 );
		}

		return $cycle;
	}

	/**
	 * The cycle week containing a date: `[period, week index]`.
	 *
	 * @param array|object $project Project.
	 * @param string       $date    `Y-m-d`.
	 * @param string       $today   `Y-m-d`.
	 * @return array
	 */
	public static function week_at( $project, $date, $today ) {
		$period = self::cycle_at( $project, $date, $today );
		$weeks  = self::weeks_in( $period );
		for ( $w = count( $weeks ) - 1; $w > 0; $w-- ) {
			if ( $date >= $weeks[ $w ]['start'] ) {
				return array( $period, $w );
			}
		}

		return array( $period, 0 );
	}

	/**
	 * `grp_cycle_records` id: `{taskId}__{periodKey}`.
	 *
	 * @param string $task_id    Task id.
	 * @param string $period_key Period key.
	 * @return string
	 */
	public static function record_id( $task_id, $period_key ) {
		return $task_id . '__' . $period_key;
	}

	/**
	 * Whether a task repeats weekly.
	 *
	 * @param array $task Task.
	 * @return bool
	 */
	public static function is_weekly( array $task ) {
		return 'weekly' === ( $task['freq'] ?? '' );
	}

	/**
	 * Whether a task repeats every two weeks (twice in a normal cycle).
	 *
	 * @param array $task Task.
	 * @return bool
	 */
	public static function is_biweekly( array $task ) {
		return 'biweekly' === ( $task['freq'] ?? '' );
	}

	/**
	 * Index of the period containing a date, or the last index.
	 *
	 * @param array[] $periods Periods.
	 * @param string  $date `Y-m-d`.
	 * @return int
	 */
	private static function index_containing( array $periods, $date ) {
		foreach ( $periods as $i => $p ) {
			if ( $date >= $p['start'] && $date <= $p['end'] ) {
				return $i;
			}
		}

		return count( $periods ) - 1;
	}

	/**
	 * Cycle changes of a project as arrays.
	 *
	 * @param array|object $project Project.
	 * @return array[]
	 */
	private static function changes_of( $project ) {
		$project = (array) $project;
		$changes = $project['cycle_changes'] ?? $project['cycleChanges'] ?? array();
		if ( is_string( $changes ) ) {
			$changes = json_decode( $changes, true );
		}
		if ( ! is_array( $changes ) ) {
			return array();
		}

		$out = array();
		foreach ( $changes as $change ) {
			$change = (array) $change;
			if ( ! empty( $change['from'] ) ) {
				$out[] = $change;
			}
		}

		return $out;
	}

	/**
	 * Cycle day of a project.
	 *
	 * @param array|object $project Project.
	 * @return mixed
	 */
	private static function cycle_day_of( $project ) {
		$project = (array) $project;

		return $project['cycle_day'] ?? $project['cycleDay'] ?? null;
	}

	/**
	 * Clamps a cycle day to 1–28; empty values become 1 (reference `clampDay`).
	 *
	 * @param mixed $day Day.
	 * @return int
	 */
	private static function clamp_day( $day ) {
		$day = (int) $day;

		return min( 28, max( 1, $day ? $day : 1 ) );
	}

	/**
	 * Normalised `Y-m-d` like JavaScript's `new Date(y, monthIndex, d)`: months and days overflow.
	 *
	 * @param int $y          Year.
	 * @param int $month_index Zero-based month (may be out of range).
	 * @param int $d          Day (may be out of range).
	 * @return string
	 */
	private static function date( $y, $month_index, $d ) {
		return gmdate( 'Y-m-d', gmmktime( 0, 0, 0, $month_index + 1, $d, $y ) );
	}

	/**
	 * Whole days from `$a` to `$b` (`Y-m-d`).
	 *
	 * @param string $a Date.
	 * @param string $b Date.
	 * @return int
	 */
	private static function days_between( $a, $b ) {
		return (int) round( ( strtotime( $b . ' 00:00:00 UTC' ) - strtotime( $a . ' 00:00:00 UTC' ) ) / DAY_IN_SECONDS );
	}

	/**
	 * Year, zero-based month and day of a `Y-m-d` date.
	 *
	 * @param string $ymd Date.
	 * @return int[]
	 */
	private static function parts( $ymd ) {
		list( $y, $m, $d ) = array_map( 'intval', explode( '-', substr( (string) $ymd, 0, 10 ) ) );

		return array( $y, $m - 1, $d );
	}

	/**
	 * The day before a date (reference `endBefore`, which returns 23:59:59 of that day).
	 *
	 * @param string $ymd Date.
	 * @return string
	 */
	private static function end_before( $ymd ) {
		list( $y, $m, $d ) = self::parts( $ymd );

		return self::date( $y, $m, $d - 1 );
	}
}
