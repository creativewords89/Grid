<?php
/**
 * Project cycle and week maths (SPEC.md sections 6.1, 6.2, 6.4).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pure functions ported from the reference portal (periodsOf, cycleRange, cycleAt,
 * monthRange, weekRange, activeWeek, dueAt). Every function takes "today" as a
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
	 * Calendar-month week `$w` (0–3): 1–7, 8–14, 15–21, 22–end (port of `weekRange`).
	 *
	 * @param int    $w     Week index 0–3.
	 * @param int    $off   Months from the current one.
	 * @param string $today `Y-m-d`.
	 * @return array `{start, end}`.
	 */
	public static function week_range( $w, $off, $today ) {
		$month         = self::month_range( $off, $today );
		list( $y, $m ) = self::parts( $month['start'] );
		$w             = (int) $w;

		return array(
			'start' => self::date( $y, $m, 1 + $w * 7 ),
			'end'   => $w < 3 ? self::date( $y, $m, 7 + $w * 7 ) : $month['end'],
		);
	}

	/**
	 * Week index (0–3) containing today within the month `$off` (port of `activeWeek`).
	 * Months in the future give 0, months in the past give 3.
	 *
	 * @param int    $off   Months from the current one.
	 * @param string $today `Y-m-d`.
	 * @return int
	 */
	public static function active_week( $off, $today ) {
		$month = self::month_range( $off, $today );
		if ( $today < $month['start'] ) {
			return 0;
		}
		if ( $today > $month['end'] ) {
			return 3;
		}
		for ( $w = 3; $w >= 0; $w-- ) {
			if ( $today >= self::week_range( $w, $off, $today )['start'] ) {
				return $w;
			}
		}

		return 0;
	}

	/**
	 * Due date of a recurring task in a period (port of `dueAt`).
	 *
	 * Weekly tasks: end of week `$w` (default: the active week). Monthly tasks: end of
	 * the cycle, or day `due_day` of the cycle capped at the cycle end.
	 *
	 * @param array|object $task    Monthly task.
	 * @param array|object $project Project.
	 * @param int|null     $w       Week index for weekly tasks.
	 * @param int          $off     Cycles (months for weekly tasks) from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return string `Y-m-d`.
	 */
	public static function due_at( $task, $project, $w, $off, $today ) {
		$task = (array) $task;

		if ( self::is_weekly( $task ) ) {
			return self::week_range( null === $w ? self::active_week( $off, $today ) : $w, $off, $today )['end'];
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
	 * Period key of a recurring task: `YYYY-MM-wN` for weekly tasks, else the cycle key.
	 *
	 * @param array|object $task    Monthly task.
	 * @param array|object $project Project.
	 * @param int|null     $w       Week index for weekly tasks (default: active week).
	 * @param int          $off     Cycles (months for weekly tasks) from the current one.
	 * @param string       $today   `Y-m-d`.
	 * @return string
	 */
	public static function period_key( $task, $project, $w, $off, $today ) {
		if ( self::is_weekly( (array) $task ) ) {
			$w = null === $w ? self::active_week( $off, $today ) : (int) $w;
			return self::month_range( $off, $today )['key'] . '-w' . ( $w + 1 );
		}

		return self::cycle_range( $project, $off, $today )['key'];
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
