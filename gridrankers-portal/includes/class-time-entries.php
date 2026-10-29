<?php
/**
 * Time entries (SPEC.md 6.21): saving them with every server check, the one running timer, and the
 * tracked entries they put into the person's daily report.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Data layer for `grp_time_entries`, shared by /timer, /time-entries, /daily-reports and the hourly job.
 */
class GRP_Time_Entries {

	/**
	 * Table.
	 */
	const TABLE = 'grp_time_entries';

	/**
	 * Entries a batch may carry.
	 */
	const MAX_BATCH = 200;

	/**
	 * Computer clocks further off than this are flagged `clock_skew` (seconds).
	 */
	const SKEW_SECONDS = 120;

	/**
	 * Entries sent this long after they ended are flagged `late_sync` (seconds).
	 */
	const LATE_SECONDS = DAY_IN_SECONDS;

	/**
	 * Saves one entry for a person as the desktop app or the portal sends it, with every check of
	 * SPEC.md 6.21. An entry the server already has (same id) is not saved twice: it is only stopped
	 * when it was still running here and now has an end.
	 *
	 * @param array $member  The person (the actor: people only track their own time).
	 * @param array $raw     `{id?, project_id?, ref_kind?, ref_id?, period_key?, note?, started_at, ended_at?, idle_seconds?}`.
	 * @param array $context `{source: desktop|web, device_id?, clock_offset?, now?, stop_running?}`.
	 * @return array `{status: saved|exists|refused, entry?, stopped?, code?, message?}`.
	 */
	public static function save( array $member, array $raw, array $context = array() ) {
		$now = (string) ( $context['now'] ?? GRP_Ids::now() );
		$id  = preg_replace( '/[^\w-]/', '', (string) ( $raw['id'] ?? '' ) );
		if ( '' === $id ) {
			$id = GRP_Ids::ulid();
		} elseif ( strlen( $id ) < 8 || strlen( $id ) > 64 ) {
			return self::refused( 'grp_time_invalid', __( 'That entry has no valid id.', 'gridrankers-portal' ) );
		}
		if ( ! GRP_Permissions::can( $member, GRP_Permissions::TRACK_TIME, array( 'member_id' => $member['id'] ) ) ) {
			return self::refused( GRP_Permissions::missing_profile( $member ) ? 'grp_profile_incomplete' : 'grp_forbidden', __( 'You can’t track time.', 'gridrankers-portal' ) );
		}

		$known = GRP_Store::get( self::TABLE, $id );
		if ( $known ) {
			return self::known( $member, $known, $raw, $now );
		}

		$fields = self::fields( $raw, $now );
		if ( isset( $fields['code'] ) ) {
			return $fields;
		}
		$fields         += array(
			'id'        => $id,
			'member_id' => (string) $member['id'],
			'source'    => 'desktop' === ( $context['source'] ?? '' ) ? 'desktop' : 'web',
			'device_id' => $context['device_id'] ?? null,
			'synced_at' => $now,
		);
		$fields['flags'] = self::flags( $member, $fields, $context, $now );

		return GRP_Store::transaction(
			static function () use ( $member, $fields, $context, $now ) {
				$stopped = null;
				if ( null === $fields['ended_at'] ) {
					$running = self::running( $member['id'] );
					if ( $running && ! empty( $context['stop_running'] ) && $running['started_at'] < $fields['started_at'] ) {
						$stopped = self::stop( $running, $fields['started_at'], 0, $now );
					} elseif ( $running ) {
						return self::refused( 'grp_time_running', __( 'Another timer is already running.', 'gridrankers-portal' ) );
					}
				}
				$why = self::why_not( $member, $fields, $now );
				if ( $why ) {
					return $why;
				}
				$entry = GRP_Store::insert( self::TABLE, $fields );
				self::sync_report( (string) $member['id'], $entry['day'] );

				return array_filter(
					array(
						'status'  => 'saved',
						'entry'   => $entry,
						'stopped' => $stopped,
					)
				);
			}
		);
	}

	/**
	 * Stops a running entry, rebuilds its day's report and returns it.
	 *
	 * @param array      $entry        Running entry.
	 * @param string     $ended_at     `Y-m-d H:i:s` UTC.
	 * @param int        $idle_seconds Idle time kept in it.
	 * @param string     $now          Now (UTC); unused, kept for callers.
	 * @param array|null $flags        More flags.
	 * @return array The stopped entry.
	 */
	public static function stop( array $entry, $ended_at, $idle_seconds = 0, $now = null, $flags = null ) {
		$ended   = max( (string) $ended_at, (string) $entry['started_at'] );
		$changes = array(
			'ended_at'     => $ended,
			'seconds'      => GRP_Time::seconds( $entry['started_at'], $ended ),
			'idle_seconds' => max( 0, (int) $idle_seconds ),
		);
		if ( $flags ) {
			$changes['flags'] = array_merge( (array) ( $entry['flags'] ?? array() ), $flags );
		}
		$stopped = GRP_Store::update( self::TABLE, $entry['id'], $changes );
		self::sync_report( (string) $entry['member_id'], $entry['day'] );

		return $stopped;
	}

	/**
	 * Changes an entry's times, task or note (PATCH /time-entries/{id}); the permission check is the
	 * caller's. Every check of save() applies again.
	 *
	 * @param array  $entry  Entry.
	 * @param array  $raw    Changed fields.
	 * @param string $editor Who edits it.
	 * @param string $now    Now (UTC).
	 * @return array `{status: saved|refused, entry?, code?, message?}`.
	 */
	public static function edit( array $entry, array $raw, $editor, $now = null ) {
		$now    = $now ? $now : GRP_Ids::now();
		$member = GRP_Store::get( 'grp_members', (string) $entry['member_id'] );
		$merged = array_merge(
			array(
				'project_id' => $entry['project_id'],
				'ref_kind'   => $entry['ref_kind'],
				'ref_id'     => $entry['ref_id'],
				'period_key' => $entry['period_key'],
				'note'       => $entry['note'],
				'started_at' => $entry['started_at'],
				'ended_at'   => $entry['ended_at'],
			),
			array_intersect_key( $raw, array_flip( array( 'project_id', 'ref_kind', 'ref_id', 'period_key', 'note', 'started_at', 'ended_at', 'idle_seconds' ) ) )
		);
		if ( null === $merged['ended_at'] && ! empty( $entry['ended_at'] ) ) {
			return self::refused( 'grp_time_invalid', __( 'A stopped entry can’t be started again.', 'gridrankers-portal' ) );
		}
		$fields = self::fields( $merged, $now );
		if ( isset( $fields['code'] ) ) {
			return $fields;
		}
		$fields['id']        = $entry['id'];
		$fields['member_id'] = $entry['member_id'];
		$fields['edited_by'] = (string) $editor;
		$kept                = array_diff_key( (array) ( $entry['flags'] ?? array() ), array( 'day_off' => true ) );
		$fields['flags']     = array_merge( $kept, self::flags( (array) $member, $fields, array(), $now, false ) );

		return GRP_Store::transaction(
			static function () use ( $entry, $member, $fields, $now ) {
				$why = self::locked( (string) $entry['member_id'], $entry['day'] ) ?? self::why_not( (array) $member, $fields, $now );
				if ( $why ) {
					return $why;
				}
				$updated = GRP_Store::update( self::TABLE, $entry['id'], $fields );
				self::sync_report( (string) $entry['member_id'], $entry['day'] );
				if ( $updated['day'] !== $entry['day'] ) {
					self::sync_report( (string) $entry['member_id'], $updated['day'] );
				}

				return array(
					'status' => 'saved',
					'entry'  => $updated,
				);
			}
		);
	}

	/**
	 * Deletes an entry (kept with `deleted_at`, so a resent upload is not saved again) and takes its
	 * time out of the report. The permission check is the caller's.
	 *
	 * @param array  $entry  Entry.
	 * @param string $editor Who deletes it.
	 * @return array `{status: saved|refused, entry?, code?, message?}`.
	 */
	public static function delete( array $entry, $editor ) {
		$locked = self::locked( (string) $entry['member_id'], $entry['day'] );
		if ( $locked ) {
			return $locked;
		}

		return GRP_Store::transaction(
			static function () use ( $entry, $editor ) {
				$now     = GRP_Ids::now();
				$changes = array(
					'deleted_at' => $now,
					'edited_by'  => (string) $editor,
				);
				if ( empty( $entry['ended_at'] ) ) {
					$changes['ended_at'] = max( $now, $entry['started_at'] );
					$changes['seconds']  = GRP_Time::seconds( $entry['started_at'], $changes['ended_at'] );
				}
				$deleted = GRP_Store::update( self::TABLE, $entry['id'], $changes );
				self::sync_report( (string) $entry['member_id'], $entry['day'] );

				return array(
					'status' => 'saved',
					'entry'  => $deleted,
				);
			}
		);
	}

	/**
	 * A person's running entry, or null.
	 *
	 * @param string $member_id Person.
	 * @return array|null
	 */
	public static function running( $member_id ) {
		global $wpdb;

		$id = $wpdb->get_var( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT id FROM %i WHERE member_id = %s AND ended_at IS NULL AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1',
				GRP_Install::table( self::TABLE ),
				$member_id
			)
		);

		return $id ? GRP_Store::get( self::TABLE, $id ) : null;
	}

	/**
	 * A person's entries (not deleted) from one day to another, oldest first.
	 *
	 * @param string $member_id Person.
	 * @param string $from      First day.
	 * @param string $to        Last day.
	 * @return array[]
	 */
	public static function between( $member_id, $from, $to ) {
		global $wpdb;

		$ids = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT id FROM %i WHERE member_id = %s AND day >= %s AND day <= %s AND deleted_at IS NULL ORDER BY started_at ASC',
				GRP_Install::table( self::TABLE ),
				$member_id,
				$from,
				$to
			)
		);

		return array_values( array_filter( array_map( static fn ( $id ) => GRP_Store::get( self::TABLE, $id ), $ids ) ) );
	}

	/**
	 * The hourly job: stops every timer running for more than 12 hours at its 12th hour, flagged
	 * `auto_stopped`.
	 *
	 * @param string|null $now Now (UTC).
	 * @return int Timers stopped.
	 */
	public static function stop_forgotten( $now = null ) {
		global $wpdb;

		$now = $now ? $now : GRP_Ids::now();
		$ids = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT id FROM %i WHERE ended_at IS NULL AND deleted_at IS NULL AND started_at <= %s',
				GRP_Install::table( self::TABLE ),
				GRP_Ids::now( strtotime( $now . ' UTC' ) - GRP_Time::MAX_ENTRY_SECONDS )
			)
		);
		foreach ( $ids as $id ) {
			$entry = GRP_Store::get( self::TABLE, $id );
			self::stop( $entry, GRP_Ids::now( strtotime( $entry['started_at'] . ' UTC' ) + GRP_Time::MAX_ENTRY_SECONDS ), 0, $now, array( 'auto_stopped' => true ) );
		}

		return count( $ids );
	}

	/**
	 * Rebuilds the tracked entries of a person's report for a day from their time entries (a draft
	 * report is made when there is none). Handwritten entries and whether it was sent are kept. A
	 * locked report (sent on an earlier day, or its month paid) is never changed: pay stays as billed.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 */
	public static function sync_report( $member_id, $day ) {
		if ( self::locked( $member_id, $day ) ) {
			return;
		}
		$id      = GRP_Daily_Reports::row_id( $member_id, $day );
		$report  = GRP_Store::get( 'grp_daily_reports', $id );
		$before  = array_values( (array) ( $report['entries'] ?? array() ) );
		$entries = self::with_tracked( $before, $member_id, $day );
		if ( $entries === $before ) {
			return;
		}
		if ( $report ) {
			GRP_Store::update( 'grp_daily_reports', $id, array( 'entries' => $entries ) );
		} elseif ( $entries ) {
			GRP_Store::insert(
				'grp_daily_reports',
				array(
					'id'        => $id,
					'member_id' => $member_id,
					'day'       => $day,
					'entries'   => $entries,
				)
			);
		}
	}

	/**
	 * Report entries with the tracked ones rebuilt from the day's time entries.
	 *
	 * @param array[] $entries   Report entries.
	 * @param string  $member_id Person.
	 * @param string  $day       `Y-m-d`.
	 * @return array[]
	 */
	public static function with_tracked( array $entries, $member_id, $day ) {
		$times  = self::between( $member_id, $day, $day );
		$titles = array();
		foreach ( $times as $time ) {
			$key = $time['ref_kind'] . ':' . $time['ref_id'];
			if ( 'item' === $time['ref_kind'] && ! isset( $titles[ $key ] ) ) {
				$titles[ $key ] = (string) ( GRP_Store::get( 'grp_meeting_tasks', (string) $time['ref_id'] )['title'] ?? '' );
			} elseif ( 'record' === $time['ref_kind'] && ! isset( $titles[ $key ] ) ) {
				$titles[ $key ] = (string) ( GRP_Store::get( 'grp_monthly_tasks', (string) $time['ref_id'] )['title'] ?? '' );
			}
		}

		return GRP_Time::with_tracked( $entries, $times, array_filter( $titles ) );
	}

	/**
	 * A report save from the portal (PUT /daily-reports) with its tracked entries kept: an entry sent
	 * with a tracked entry's id stays tracked (its details, files and links are taken, never its
	 * minutes or title), and tracked entries always follow the time entries.
	 *
	 * @param array[] $cleaned   Entries as cleaned from the request.
	 * @param array[] $existing  The report's entries before the save.
	 * @param string  $member_id Person.
	 * @param string  $day       `Y-m-d`.
	 * @return array[]
	 */
	public static function keep_tracked( array $cleaned, array $existing, $member_id, $day ) {
		$tracked = array();
		foreach ( $existing as $entry ) {
			$entry = (array) $entry;
			if ( GRP_Time::is_tracked( $entry ) ) {
				$tracked[ (string) $entry['id'] ] = $entry;
			}
		}
		$out = array();
		foreach ( $cleaned as $entry ) {
			$id = (string) $entry['id'];
			if ( isset( $tracked[ $id ] ) ) {
				$entry = array(
					'details' => $entry['details'],
					'files'   => $entry['files'],
					'links'   => $entry['links'],
				) + $tracked[ $id ];
				unset( $tracked[ $id ] );
			}
			$out[] = $entry;
		}

		// Tracked entries left out come back as long as their time does (fix the time entries instead).
		return self::with_tracked( array_merge( $out, array_values( $tracked ) ), $member_id, $day );
	}

	/**
	 * What the timer offers a person to track (SPEC.md 6.21): their open meeting tasks and General
	 * tasks, their monthly tasks of the current period, and the active projects for No task.
	 *
	 * @param array       $member Person.
	 * @param string|null $today  Today.
	 * @return array `{projects: [{id, name}], tasks: [{kind, id, title, project_id, project_name, period_key}]}`.
	 */
	public static function tasks_for( array $member, $today = null ) {
		$today    = $today ? $today : GRP_Cycles::today();
		$id       = (string) $member['id'];
		$projects = array();
		foreach ( GRP_Store::find( 'grp_projects', array( 'state' => 'active' ), array( 'order_by' => 'name' ) ) as $project ) {
			$projects[ $project['id'] ] = $project;
		}

		$tasks = array();
		foreach ( GRP_Store::find( 'grp_meeting_tasks', array(), array( 'order_by' => 'created_at' ) ) as $task ) {
			$project_id = (string) ( $task['project_id'] ?? '' );
			if ( 'done' === $task['status'] || ( '' !== $project_id && ! isset( $projects[ $project_id ] ) ) || ! in_array( $id, GRP_Permissions::assignee_ids( $task['assignees'] ), true ) ) {
				continue;
			}
			$tasks[] = array(
				'kind'         => 'item',
				'id'           => (string) $task['id'],
				'title'        => (string) $task['title'],
				'project_id'   => $project_id,
				'project_name' => '' === $project_id ? '' : (string) $projects[ $project_id ]['name'],
				'period_key'   => null,
			);
		}
		foreach ( GRP_Store::find( 'grp_monthly_tasks', array(), array( 'order_by' => 'created_at' ) ) as $task ) {
			$project = $projects[ (string) $task['project_id'] ] ?? null;
			if ( ! $project || ! in_array( $id, GRP_Permissions::assignee_ids( $task['assignees'] ), true ) ) {
				continue;
			}
			$key    = GRP_Cycles::period_key( $task, $project, null, 0, $today );
			$record = GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $task['id'], $key ) );
			if ( $record && in_array( $record['status'], array( 'done', 'skipped' ), true ) ) {
				continue;
			}
			$tasks[] = array(
				'kind'         => 'record',
				'id'           => (string) $task['id'],
				'title'        => (string) $task['title'],
				'project_id'   => (string) $project['id'],
				'project_name' => (string) $project['name'],
				'period_key'   => $key,
			);
		}

		return array(
			'projects' => array_values(
				array_map(
					static fn ( $p ) => array(
						'id'   => (string) $p['id'],
						'name' => (string) $p['name'],
					),
					$projects
				)
			),
			'tasks'    => $tasks,
		);
	}

	/**
	 * Why a day's time can't change any more, or null: its report was sent on an earlier day, or that
	 * month's salary is marked paid (SPEC.md 6.18; then Ask to change).
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 * @return array|null A refusal.
	 */
	public static function locked( $member_id, $day ) {
		$report = GRP_Store::get( 'grp_daily_reports', GRP_Daily_Reports::row_id( $member_id, $day ) );
		$slip   = GRP_Store::get( 'grp_payslips', GRP_Pay::slip_id( $member_id, substr( $day, 0, 7 ) ) );
		if ( ( $report && ! empty( $report['sent_at'] ) && $day < GRP_Cycles::today() ) || ( $slip && ! empty( $slip['paid_at'] ) ) ) {
			return self::refused( 'grp_report_locked', __( 'That day’s report is sent. Ask to change it instead.', 'gridrankers-portal' ) );
		}

		return null;
	}

	/**
	 * An entry the server already has (same id): ignored, or stopped when it ran here and has ended.
	 *
	 * @param array  $member Person.
	 * @param array  $known  Stored entry.
	 * @param array  $raw    Entry as sent.
	 * @param string $now    Now (UTC).
	 * @return array
	 */
	private static function known( array $member, array $known, array $raw, $now ) {
		if ( (string) $known['member_id'] !== (string) $member['id'] ) {
			return self::refused( 'grp_time_id_taken', __( 'That entry id is taken.', 'gridrankers-portal' ) );
		}
		$ended_at = $raw['ended_at'] ?? null;
		if ( empty( $known['ended_at'] ) && empty( $known['deleted_at'] ) && null !== $ended_at ) {
			$why = GRP_Time::invalid_times( $known['started_at'], (string) $ended_at, $now );
			if ( $why ) {
				return self::refused( $why, self::message( $why ) );
			}
			$locked = self::locked( (string) $member['id'], $known['day'] );
			if ( $locked ) {
				return $locked;
			}
			$overlap = GRP_Time::overlapping(
				array(
					'id'         => $known['id'],
					'member_id'  => $known['member_id'],
					'started_at' => $known['started_at'],
					'ended_at'   => (string) $ended_at,
				),
				self::near( (string) $member['id'], $known['started_at'], (string) $ended_at ),
				$now
			);
			if ( $overlap ) {
				return self::refused( 'grp_time_overlap', self::message( 'grp_time_overlap' ) );
			}

			return array(
				'status' => 'saved',
				'entry'  => self::stop( $known, (string) $ended_at, (int) ( $raw['idle_seconds'] ?? 0 ), $now ),
			);
		}

		return array(
			'status' => 'exists',
			'entry'  => $known,
		);
	}

	/**
	 * Clean fields of an entry, or a refusal.
	 *
	 * @param array  $raw Entry as sent.
	 * @param string $now Now (UTC).
	 * @return array
	 */
	private static function fields( array $raw, $now ) {
		$started = isset( $raw['started_at'] ) ? (string) $raw['started_at'] : '';
		$ended   = isset( $raw['ended_at'] ) && '' !== (string) $raw['ended_at'] ? (string) $raw['ended_at'] : null;
		$why     = GRP_Time::invalid_times( $started, $ended, $now );
		if ( $why ) {
			return self::refused( $why, self::message( $why ) );
		}

		$kind       = in_array( $raw['ref_kind'] ?? 'none', array( 'item', 'record', 'none' ), true ) ? (string) ( $raw['ref_kind'] ?? 'none' ) : 'none';
		$ref_id     = null;
		$period_key = null;
		$project_id = isset( $raw['project_id'] ) && '' !== (string) $raw['project_id'] ? (string) $raw['project_id'] : null;
		if ( 'item' === $kind ) {
			$task = GRP_Store::get( 'grp_meeting_tasks', (string) ( $raw['ref_id'] ?? '' ) );
			if ( ! $task ) {
				return self::refused( 'grp_time_task', __( 'That task doesn’t exist any more.', 'gridrankers-portal' ) );
			}
			$ref_id     = (string) $task['id'];
			$project_id = '' === (string) $task['project_id'] ? null : (string) $task['project_id'];
		} elseif ( 'record' === $kind ) {
			$task = GRP_Store::get( 'grp_monthly_tasks', (string) ( $raw['ref_id'] ?? '' ) );
			if ( ! $task ) {
				return self::refused( 'grp_time_task', __( 'That task doesn’t exist any more.', 'gridrankers-portal' ) );
			}
			$ref_id     = (string) $task['id'];
			$project_id = (string) $task['project_id'];
			$period_key = substr( preg_replace( '/[^\w-]/', '', (string) ( $raw['period_key'] ?? '' ) ), 0, 32 );
			$period_key = '' === $period_key ? null : $period_key;
		} elseif ( null !== $project_id && ! GRP_Store::get( 'grp_projects', $project_id ) ) {
			return self::refused( 'grp_time_task', __( 'That project doesn’t exist any more.', 'gridrankers-portal' ) );
		}

		return array(
			'day'          => GRP_Time::day_of( $started ),
			'project_id'   => $project_id,
			'ref_kind'     => $kind,
			'ref_id'       => $ref_id,
			'period_key'   => $period_key,
			'started_at'   => $started,
			'ended_at'     => $ended,
			'seconds'      => null === $ended ? 0 : GRP_Time::seconds( $started, $ended ),
			'idle_seconds' => max( 0, min( GRP_Time::MAX_ENTRY_SECONDS, (int) ( $raw['idle_seconds'] ?? 0 ) ) ),
			'note'         => mb_substr( sanitize_textarea_field( (string) ( $raw['note'] ?? '' ) ), 0, 500 ),
		);
	}

	/**
	 * Why an entry can't be stored for its day, or null: too long ago, the report locked, or it
	 * overlaps the person's other entries.
	 *
	 * @param array  $member Person.
	 * @param array  $fields Entry fields.
	 * @param string $now    Now (UTC).
	 * @return array|null A refusal.
	 */
	private static function why_not( array $member, array $fields, $now ) {
		if ( $fields['day'] < GRP_People::add_days( GRP_Cycles::today(), -GRP_Daily_Reports::BACK_DAYS ) ) {
			return self::refused( 'grp_time_too_old', __( 'That day is too long ago to report.', 'gridrankers-portal' ) );
		}
		$locked = self::locked( (string) $member['id'], $fields['day'] );
		if ( $locked ) {
			return $locked;
		}
		$overlap = GRP_Time::overlapping( $fields, self::near( (string) $member['id'], $fields['started_at'], $fields['ended_at'] ?? $now ), $now );

		return $overlap ? self::refused( 'grp_time_overlap', self::message( 'grp_time_overlap' ) ) : null;
	}

	/**
	 * Flags of an entry: `day_off`, `late_sync`, `clock_skew`.
	 *
	 * @param array  $member    Person.
	 * @param array  $fields    Entry fields.
	 * @param array  $context   `{clock_offset?}`.
	 * @param string $now       Now (UTC).
	 * @param bool   $uploading Whether the app is sending it now (late sync and clock skew apply).
	 * @return array
	 */
	private static function flags( array $member, array $fields, array $context, $now, $uploading = true ) {
		$leaves = GRP_Store::find(
			'grp_leave',
			array(
				'member_id' => $member['id'],
				'status'    => 'approved',
			)
		);
		$day    = GRP_Time::schedule_day( $fields['day'], $member, GRP_REST_People::team_weekly(), GRP_REST_People::days_off(), $leaves, GRP_Time::work_day( $member, null, null ) );
		$flags  = array();
		if ( ! $day['working'] ) {
			$flags['day_off'] = true;
		}
		if ( $uploading && null !== $fields['ended_at'] && strtotime( $now . ' UTC' ) - strtotime( $fields['ended_at'] . ' UTC' ) > self::LATE_SECONDS ) {
			$flags['late_sync'] = true;
		}
		$offset = (int) ( $context['clock_offset'] ?? 0 );
		if ( $uploading && abs( $offset ) > self::SKEW_SECONDS ) {
			$flags['clock_skew'] = $offset;
		}

		return $flags;
	}

	/**
	 * A person's entries that could overlap a time span (it plus 12 hours either side).
	 *
	 * @param string $member_id Person.
	 * @param string $from      Start (UTC).
	 * @param string $to        End (UTC).
	 * @return array[]
	 */
	private static function near( $member_id, $from, $to ) {
		global $wpdb;

		$ids = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT id FROM %i WHERE member_id = %s AND deleted_at IS NULL AND started_at < %s AND ( ended_at IS NULL OR ended_at > %s )',
				GRP_Install::table( self::TABLE ),
				$member_id,
				GRP_Ids::now( strtotime( $to . ' UTC' ) + GRP_Time::MAX_ENTRY_SECONDS ),
				GRP_Ids::now( strtotime( $from . ' UTC' ) - GRP_Time::MAX_ENTRY_SECONDS )
			)
		);

		return array_values( array_filter( array_map( static fn ( $id ) => GRP_Store::get( self::TABLE, $id ), $ids ) ) );
	}

	/**
	 * A refusal.
	 *
	 * @param string $code    Error code.
	 * @param string $message Message.
	 * @return array
	 */
	private static function refused( $code, $message ) {
		return array(
			'status'  => 'refused',
			'code'    => $code,
			'message' => $message,
		);
	}

	/**
	 * The message for an entry check.
	 *
	 * @param string $code Error code.
	 * @return string
	 */
	private static function message( $code ) {
		switch ( $code ) {
			case 'grp_time_future':
				return __( 'That time hasn’t come yet. Check your computer’s clock.', 'gridrankers-portal' );
			case 'grp_time_order':
				return __( 'The end must be after the start.', 'gridrankers-portal' );
			case 'grp_time_too_long':
				return __( 'One entry can be 12 hours at most.', 'gridrankers-portal' );
			case 'grp_time_overlap':
				return __( 'That time overlaps another entry of yours.', 'gridrankers-portal' );
		}

		return __( 'Those times aren’t valid.', 'gridrankers-portal' );
	}
}
