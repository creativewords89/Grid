<?php
/**
 * JSON import from the current portal's "Export all data" (SPEC.md section 10).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Maps a `gridrankers-portal-export` (version 1) into the plugin tables.
 *
 * Original ids are kept and every row is upserted by id, so importing the same file
 * twice changes nothing. Timestamps may be epoch milliseconds or ISO strings.
 */
class GRP_Import {

	const FORMAT = 'gridrankers-portal-export';

	/**
	 * Export collection => table (in import order: projects before tasks, tasks before records).
	 */
	const COLLECTIONS = array(
		'team'        => 'grp_members',
		'clients'     => 'grp_projects',
		'items'       => 'grp_meeting_tasks',
		'monthly'     => 'grp_monthly_tasks',
		'monthlyDone' => 'grp_cycle_records',
		'activity'    => 'grp_activity',
		'edits'       => 'grp_audit',
		'trash'       => 'grp_trash',
		'dismissals'  => 'grp_dismissals',
		'settings'    => 'grp_settings',
		'leave'       => 'grp_leave',
		'daysOff'     => 'grp_days_off',
		'posts'       => 'grp_posts',
		'keywords'    => 'grp_keywords',
	);

	/**
	 * Tables whose rows belong to one project and are skipped with it.
	 */
	const PROJECT_CHILDREN = array( 'grp_meeting_tasks', 'grp_monthly_tasks', 'grp_cycle_records', 'grp_keywords' );

	/**
	 * Settings documents that are not imported (old in-browser admin code, Google Drive secret).
	 */
	const SKIPPED_SETTINGS = array( 'admin', 'gdrive' );

	/**
	 * Member fields an import fills in but never empties.
	 */
	const KEEP_PROFILE = array( 'photo', 'phone', 'email', 'address', 'title', 'drive_url', 'notes', 'birthday', 'birth_year', 'location', 'weekly_off' );

	/**
	 * Trash types in the export => tables.
	 */
	const TRASH_TYPES = array(
		'items'   => 'grp_meeting_tasks',
		'monthly' => 'grp_monthly_tasks',
		'clients' => 'grp_projects',
	);

	/**
	 * Imports an export.
	 *
	 * @param mixed $export  Decoded JSON.
	 * @param bool  $dry_run Validate and count without keeping any change.
	 * @return array|WP_Error Summary: `{counts: {collection: {inserted, updated, skipped}}, warnings: []}`.
	 */
	public static function run( $export, $dry_run = false ) {
		if ( ! is_array( $export ) || self::FORMAT !== ( $export['format'] ?? '' ) || ! is_array( $export['data'] ?? null ) ) {
			return new WP_Error( 'grp_import_format', __( "This isn't a GridRankers portal export.", 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		if ( 1 !== (int) ( $export['version'] ?? 0 ) ) {
			return new WP_Error( 'grp_import_version', __( 'Unsupported export version.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}

		$summary = array(
			'counts'   => array(),
			'warnings' => array(),
		);

		$result = GRP_Store::transaction(
			static function () use ( $export, $dry_run, &$summary ) {
				// Projects skipped for a name clash; their tasks and records are skipped too.
				$skipped_projects = array();
				foreach ( self::COLLECTIONS as $collection => $table ) {
					$summary['counts'][ $collection ] = array(
						'inserted' => 0,
						'updated'  => 0,
						'skipped'  => 0,
					);
					foreach ( (array) ( $export['data'][ $collection ] ?? array() ) as $doc ) {
						$rows = is_array( $doc ) ? self::map( $collection, $doc, $summary['warnings'] ) : array();
						if ( ! $rows ) {
							++$summary['counts'][ $collection ]['skipped'];
							continue;
						}
						foreach ( $rows as $row ) {
							if ( in_array( $table, self::PROJECT_CHILDREN, true ) && isset( $skipped_projects[ (string) $row['project_id'] ] ) ) {
								++$summary['counts'][ $collection ]['skipped'];
								continue;
							}
							$outcome = self::upsert( $table, $row, $summary['warnings'] );
							if ( 'grp_projects' === $table && 'skipped' === $outcome ) {
								$skipped_projects[ $row['id'] ] = true;
							}
							++$summary['counts'][ $collection ][ $outcome ];
						}
					}
				}
				$skipped_collections = array_diff( array_keys( $export['data'] ), array_keys( self::COLLECTIONS ) );
				foreach ( $skipped_collections as $collection ) {
					$summary['counts'][ $collection ] = array(
						'inserted' => 0,
						'updated'  => 0,
						'skipped'  => count( (array) $export['data'][ $collection ] ),
					);
				}

				// A dry run rolls everything back.
				return $dry_run ? new WP_Error( 'grp_dry_run', 'dry run' ) : true;
			}
		);

		if ( is_wp_error( $result ) && 'grp_dry_run' !== $result->get_error_code() ) {
			return $result;
		}

		$summary['dry_run']  = (bool) $dry_run;
		$summary['warnings'] = array_values( array_unique( $summary['warnings'] ) );

		return $summary;
	}

	/**
	 * Maps one export document to zero or more rows.
	 *
	 * @param string   $collection Collection.
	 * @param array    $doc        Document.
	 * @param string[] $warnings   Warnings (appended).
	 * @return array[]
	 */
	public static function map( $collection, array $doc, array &$warnings ) {
		switch ( $collection ) {
			case 'team':
				$row = self::member( $doc );
				if ( $row && 'admin' === $row['role'] && empty( $row['wp_user_id'] ) ) {
					/* translators: %s: member name. */
					$warnings[] = sprintf( __( '%s is a Super Admin in the old portal. Link them to a WordPress administrator (Team → Settings) to restore their rights.', 'gridrankers-portal' ), $row['name'] );
				}
				return $row ? array( $row ) : array();
			case 'clients':
				return self::wrap( self::project( $doc ) );
			case 'items':
				return self::wrap( self::meeting_task( $doc ) );
			case 'monthly':
				return self::wrap( self::monthly_task( $doc ) );
			case 'monthlyDone':
				return self::wrap( self::record( $doc ) );
			case 'activity':
				return self::wrap( self::activity( $doc ) );
			case 'edits':
				return self::wrap( self::audit( $doc ) );
			case 'trash':
				return self::wrap( self::trash( $doc ) );
			case 'dismissals':
				return self::dismissals( $doc );
			case 'settings':
				return self::wrap( self::setting( $doc ) );
			case 'leave':
				return self::wrap( self::leave( $doc ) );
			case 'daysOff':
				return self::wrap( self::day_off( $doc ) );
			case 'posts':
				return self::wrap( self::post( $doc ) );
			case 'keywords':
				return self::wrap( self::keyword( $doc ) );
		}

		return array();
	}

	/**
	 * `team` → grp_members. Legacy code hashes are kept (sha256 + salt); accountId is dropped.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function member( array $d ) {
		$id   = self::id( $d['id'] ?? '' );
		$name = trim( (string) ( $d['name'] ?? '' ) );
		if ( ! $id || '' === $name ) {
			return null;
		}
		$role = in_array( $d['role'] ?? '', array( 'admin', 'lead', 'member' ), true ) ? $d['role'] : 'member';

		return array(
			'id'          => $id,
			'name'        => mb_substr( $name, 0, 191 ),
			'role'        => $role,
			'color'       => (string) ( $d['color'] ?? '' ),
			'photo'       => isset( $d['photo'] ) ? (string) $d['photo'] : null,
			'title'       => mb_substr( (string) ( $d['title'] ?? '' ), 0, 191 ),
			'email'       => mb_substr( (string) ( $d['email'] ?? '' ), 0, 191 ),
			'phone'       => mb_substr( (string) ( $d['phone'] ?? '' ), 0, 64 ),
			'address'     => isset( $d['address'] ) ? (string) $d['address'] : null,
			'drive_url'   => isset( $d['driveUrl'] ) ? (string) $d['driveUrl'] : ( $d['drive_url'] ?? null ),
			'notes'       => isset( $d['notes'] ) ? (string) $d['notes'] : null,
			'code_hash'   => ! empty( $d['codeHash'] ) ? (string) $d['codeHash'] : null,
			'code_salt'   => ! empty( $d['codeSalt'] ) ? (string) $d['codeSalt'] : null,
			'code_set_at' => self::time( $d['codeSetAt'] ?? null ),
			'wp_user_id'  => ! empty( $d['wpUserId'] ) ? (int) $d['wpUserId'] : null,
			'active'      => isset( $d['active'] ) ? ( $d['active'] ? 1 : 0 ) : 1,
			'birthday'    => self::birthday( $d['birthday'] ?? null ),
			'birth_year'  => ! empty( $d['birthYear'] ) ? (int) $d['birthYear'] : null,
			'location'    => isset( $d['location'] ) ? mb_substr( (string) $d['location'], 0, 191 ) : null,
			'weekly_off'  => GRP_People::weekdays( $d['weeklyOff'] ?? null ),
			'created_at'  => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `MM-DD` birthday, or null.
	 *
	 * @param mixed $value Raw value.
	 * @return string|null
	 */
	public static function birthday( $value ) {
		if ( is_string( $value ) && preg_match( '/^(\d{2})-(\d{2})$/', $value, $m ) && checkdate( (int) $m[1], (int) $m[2], 2024 ) ) {
			return $value;
		}

		return null;
	}

	/**
	 * `leave` → grp_leave (schema 5 exports).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function leave( array $d ) {
		$id   = self::id( $d['id'] ?? '' );
		$from = self::ymd( $d['from'] ?? null );
		$to   = self::ymd( $d['to'] ?? null );
		if ( ! $id || empty( $d['personId'] ) || ! $from || ! $to || $to < $from ) {
			return null;
		}

		return array(
			'id'         => $id,
			'member_id'  => (string) $d['personId'],
			'type'       => 'sick' === ( $d['type'] ?? '' ) ? 'sick' : 'day',
			'from_date'  => $from,
			'to_date'    => $to,
			'days'       => max( 0, min( 255, (int) ( $d['days'] ?? 0 ) ) ),
			'reason'     => isset( $d['reason'] ) ? (string) $d['reason'] : null,
			'status'     => in_array( $d['status'] ?? '', array( 'pending', 'approved', 'rejected', 'cancelled' ), true ) ? $d['status'] : 'pending',
			'decided_by' => ! empty( $d['decidedBy'] ) ? (string) $d['decidedBy'] : null,
			'decided_at' => self::time( $d['decidedAt'] ?? null ),
			'message'    => isset( $d['message'] ) ? (string) $d['message'] : null,
			'created_by' => ! empty( $d['by'] ) ? (string) $d['by'] : null,
			'created_at' => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `daysOff` → grp_days_off.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function day_off( array $d ) {
		$id   = self::id( $d['id'] ?? '' );
		$from = self::ymd( $d['from'] ?? null );
		$to   = self::ymd( $d['to'] ?? null ) ?? $from;
		if ( ! $id || ! $from || $to < $from ) {
			return null;
		}

		return array(
			'id'         => $id,
			'kind'       => 'seasonal' === ( $d['kind'] ?? '' ) ? 'seasonal' : 'event',
			'name'       => mb_substr( (string) ( $d['name'] ?? '' ), 0, 191 ),
			'from_date'  => $from,
			'to_date'    => $to,
			'created_by' => ! empty( $d['by'] ) ? (string) $d['by'] : null,
			'created_at' => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `posts` → grp_posts (announcements and shout-outs).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function post( array $d ) {
		$id   = self::id( $d['id'] ?? '' );
		$body = (string) ( $d['body'] ?? '' );
		if ( ! $id || '' === trim( $body ) ) {
			return null;
		}

		return array(
			'id'         => $id,
			'kind'       => in_array( $d['kind'] ?? '', array( 'shoutout', 'notice' ), true ) ? $d['kind'] : 'announcement',
			'title'      => isset( $d['title'] ) ? mb_substr( (string) $d['title'], 0, 191 ) : null,
			'body'       => $body,
			'to_member'  => ! empty( $d['toId'] ) ? (string) $d['toId'] : null,
			'to_members' => is_array( $d['toIds'] ?? null ) ? array_values( array_map( 'strval', $d['toIds'] ) ) : null,
			'pinned'     => ! empty( $d['pinned'] ) ? 1 : 0,
			'show_until' => self::ymd( $d['showUntil'] ?? null ),
			'created_by' => ! empty( $d['by'] ) ? (string) $d['by'] : null,
			'deleted_at' => self::time( $d['deletedAt'] ?? null ),
			'created_at' => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `keywords` → grp_keywords (SPEC.md 6.12).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function keyword( array $d ) {
		$id      = self::id( $d['id'] ?? '' );
		$keyword = trim( (string) ( $d['keyword'] ?? '' ) );
		if ( ! $id || '' === $keyword || empty( $d['projectId'] ) ) {
			return null;
		}

		return array(
			'id'         => $id,
			'project_id' => (string) $d['projectId'],
			'keyword'    => mb_substr( $keyword, 0, 191 ),
			'checks'     => is_array( $d['checks'] ?? null ) && $d['checks'] ? $d['checks'] : new stdClass(),
			'note'       => isset( $d['note'] ) ? mb_substr( (string) $d['note'], 0, 500 ) : null,
			'deadline'   => self::ymd( $d['deadline'] ?? null ),
			'position'   => (int) ( $d['position'] ?? 0 ),
			'created_by' => ! empty( $d['by'] ) ? (string) $d['by'] : null,
			'created_at' => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `clients` → grp_projects (`pstate` / `active` → state).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function project( array $d ) {
		$id   = self::id( $d['id'] ?? '' );
		$name = trim( (string) ( $d['name'] ?? '' ) );
		if ( ! $id || '' === $name ) {
			return null;
		}

		$state = $d['pstate'] ?? null;
		if ( ! in_array( $state, array( 'active', 'paused', 'inactive' ), true ) ) {
			$state = array_key_exists( 'active', $d ) && ! $d['active'] ? 'inactive' : 'active';
		}
		$day = (int) ( $d['cycleDay'] ?? 0 );

		$row = array(
			'id'            => $id,
			'name'          => mb_substr( $name, 0, 191 ),
			'state'         => $state,
			'cycle_day'     => min( 28, max( 1, $day ? $day : 1 ) ),
			'cycle_set'     => ! empty( $d['cycleSet'] ) || $day ? 1 : 0,
			'cycle_changes' => array_values( (array) ( $d['cycleChanges'] ?? array() ) ),
			'cycle_log'     => array_values( (array) ( $d['cycleLog'] ?? array() ) ),
			'std_cycle'     => isset( $d['stdCycle'] ) ? (string) $d['stdCycle'] : null,
			'created_at'    => self::time( $d['createdAt'] ?? null ),
		);
		// Details and checklist columns (SPEC.md 6.12) come only from this portal's own export.
		if ( is_array( $d['details'] ?? null ) && $d['details'] ) {
			$row['details'] = $d['details'];
		}
		if ( is_array( $d['kwColumns'] ?? null ) && $d['kwColumns'] ) {
			$row['kw_columns'] = array_values( $d['kwColumns'] );
		}
		// Cycle reviews (SPEC.md 6.11) come only from this portal's own export: never blank them.
		if ( is_array( $d['cycleReviews'] ?? null ) && $d['cycleReviews'] ) {
			$row['cycle_reviews'] = $d['cycleReviews'];
		}
		return $row;
	}

	/**
	 * `items` → grp_meeting_tasks.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function meeting_task( array $d ) {
		$id = self::id( $d['id'] ?? '' );
		// No clientId (or an empty one): a General task (SPEC.md 6.13).
		if ( ! $id ) {
			return null;
		}
		$target = max( 1, (int) ( $d['target'] ?? 1 ) );

		return array(
			'id'           => $id,
			'project_id'   => (string) ( $d['clientId'] ?? '' ),
			'title'        => (string) ( $d['title'] ?? '' ),
			'notes'        => (string) ( $d['notes'] ?? '' ),
			'url'          => (string) ( $d['url'] ?? '' ),
			'priority'     => in_array( $d['priority'] ?? '', array( 'urgent', 'high', 'normal', 'low' ), true ) ? $d['priority'] : 'normal',
			'status'       => in_array( $d['status'] ?? '', array( 'todo', 'doing', 'done' ), true ) ? $d['status'] : 'todo',
			'meeting_date' => self::ymd( $d['meeting'] ?? null ),
			'done_at'      => self::time( $d['doneAt'] ?? null ),
			'target'       => $target,
			'assignees'    => self::assignees( $d, $target ),
			'team'         => ! empty( $d['team'] ) ? 1 : 0,
			'progress'     => self::counts( $d['by'] ?? array() ),
			'deadline'     => self::deadline( $d ),
			'review'       => is_array( $d['review'] ?? null ) ? $d['review'] : null,
			'completion'   => is_array( $d['completion'] ?? null ) ? $d['completion'] : null,
			'created_by'   => isset( $d['createdBy'] ) ? (string) $d['createdBy'] : null,
			'created_at'   => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `monthly` → grp_monthly_tasks.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function monthly_task( array $d ) {
		$id = self::id( $d['id'] ?? '' );
		if ( ! $id || empty( $d['clientId'] ) ) {
			return null;
		}

		$weekly = 'weekly' === ( $d['freq'] ?? '' );
		$mode   = $d['dueMode'] ?? null;
		if ( ! in_array( $mode, array( 'none', 'weekly', 'biweekly', 'date', 'dates', 'monthly' ), true ) ) {
			$mode = $weekly ? 'weekly' : ( ! empty( $d['dueDay'] ) ? 'date' : 'monthly' );
		}
		$target = max( 1, (int) ( $d['target'] ?? 1 ) );

		$parts = null;
		if ( ! empty( $d['parts'] ) && is_array( $d['parts'] ) ) {
			$parts = array();
			foreach ( $d['parts'] as $i => $p ) {
				$p = (array) $p;
				if ( '' === trim( (string) ( $p['name'] ?? '' ) ) ) {
					continue;
				}
				$n      = max( 1, (int) ( $p['n'] ?? 1 ) );
				$people = array();
				if ( ! empty( $p['people'] ) && is_array( $p['people'] ) ) {
					$people = self::assignee_list( $p['people'], $n );
				} elseif ( ! empty( $p['who'] ) ) {
					$people = array(
						array(
							'id' => (string) $p['who'],
							'n'  => $n,
						),
					);
				}
				$parts[] = array(
					'id'     => (string) ( $p['id'] ?? 'p' . $i ),
					'name'   => (string) $p['name'],
					'n'      => $n,
					'people' => $people,
				);
			}
		}

		return array(
			'id'           => $id,
			'project_id'   => (string) $d['clientId'],
			'title'        => (string) ( $d['title'] ?? '' ),
			'notes'        => (string) ( $d['notes'] ?? '' ),
			'freq'         => 'biweekly' === $mode ? 'biweekly' : ( $weekly || 'weekly' === $mode ? 'weekly' : 'monthly' ),
			'due_mode'     => $mode,
			'due_day'      => ! empty( $d['dueDay'] ) ? (int) $d['dueDay'] : null,
			'due_from_day' => ! empty( $d['dueFromDay'] ) ? (int) $d['dueFromDay'] : null,
			'target'       => $target,
			'assignees'    => self::assignees( $d, $target ),
			'team'         => ! empty( $d['team'] ) ? 1 : 0,
			'parts'        => $parts,
			'std'          => ! empty( $d['std'] ) || str_starts_with( $id, 'std_' ) ? 1 : 0,
			'created_by'   => isset( $d['createdBy'] ) ? (string) $d['createdBy'] : null,
			'created_at'   => self::time( $d['createdAt'] ?? null ),
		);
	}

	/**
	 * `monthlyDone` → grp_cycle_records (period key from the id `{taskId}__{key}`, or month + week).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function record( array $d ) {
		$id      = self::id( $d['id'] ?? '', 191 );
		$task_id = (string) ( $d['taskId'] ?? '' );
		if ( ! $id || '' === $task_id ) {
			return null;
		}

		$week = ! empty( $d['week'] ) ? (int) $d['week'] : null;
		$key  = str_starts_with( $id, $task_id . '__' ) ? substr( $id, strlen( $task_id ) + 2 ) : (string) ( $d['month'] ?? '' ) . ( $week ? '-w' . $week : '' );
		if ( '' === $key ) {
			return null;
		}
		$status = in_array( $d['status'] ?? '', array( 'todo', 'doing', 'done', 'skipped' ), true ) ? $d['status'] : 'doing';

		return array(
			'id'         => $id,
			'task_id'    => $task_id,
			'project_id' => (string) ( $d['clientId'] ?? '' ),
			'period_key' => $key,
			'week'       => $week,
			'count'      => max( 0, (int) ( $d['count'] ?? 0 ) ),
			'status'     => $status,
			'by_person'  => self::counts( $d['by'] ?? array() ),
			'parts'      => is_array( $d['parts'] ?? null ) ? $d['parts'] : null,
			'review'     => is_array( $d['review'] ?? null ) ? $d['review'] : null,
			'completion' => is_array( $d['completion'] ?? null ) ? $d['completion'] : null,
			'done_at'    => self::time( $d['doneAt'] ?? ( $d['skippedAt'] ?? null ) ),
			'cleared_by' => isset( $d['clearedBy'] ) ? (string) $d['clearedBy'] : null,
			'created_at' => self::time( $d['createdAt'] ?? ( $d['updatedAt'] ?? null ) ),
		);
	}

	/**
	 * `activity` → grp_activity.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function activity( array $d ) {
		$id = self::id( $d['id'] ?? '' );
		$at = self::time( $d['at'] ?? null );
		if ( ! $id || empty( $d['personId'] ) || ! $at ) {
			return null;
		}
		$kind = 'manual' === ( $d['kind'] ?? '' ) ? 'manual' : 'auto';

		return array(
			'id'         => $id,
			'member_id'  => (string) $d['personId'],
			'date'       => self::ymd( $d['date'] ?? null ) ?? substr( $at, 0, 10 ),
			'at'         => $at,
			'kind'       => $kind,
			'source'     => in_array( $d['source'] ?? '', array( 'board', 'monthly', 'manual' ), true ) ? $d['source'] : ( 'manual' === $kind ? 'manual' : 'board' ),
			'project_id' => ! empty( $d['clientId'] ) ? (string) $d['clientId'] : null,
			'title'      => (string) ( $d['title'] ?? '' ),
			'detail'     => (string) ( $d['detail'] ?? '' ),
			'qty'        => max( 0, (int) ( $d['qty'] ?? 1 ) ),
			'minutes'    => isset( $d['minutes'] ) && '' !== $d['minutes'] ? max( 0, (int) $d['minutes'] ) : null,
			'notes'      => (string) ( $d['notes'] ?? '' ),
			'ref_key'    => ! empty( $d['refKey'] ) ? (string) $d['refKey'] : null,
			'created_at' => $at,
		);
	}

	/**
	 * `edits` → grp_audit.
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function audit( array $d ) {
		$id = self::id( $d['id'] ?? '' );
		$at = self::time( $d['at'] ?? null );
		if ( ! $id || ! $at ) {
			return null;
		}

		return array(
			'id'         => $id,
			'kind'       => mb_substr( (string) ( $d['kind'] ?? 'edit' ), 0, 32 ),
			'type'       => mb_substr( (string) ( $d['type'] ?? '' ), 0, 32 ),
			'doc_id'     => isset( $d['docId'] ) ? (string) $d['docId'] : null,
			'project_id' => ! empty( $d['clientId'] ) ? (string) $d['clientId'] : null,
			'title'      => (string) ( $d['title'] ?? '' ),
			'detail'     => (string) ( $d['detail'] ?? '' ),
			'changes'    => array_values( (array) ( $d['changes'] ?? array() ) ),
			'by_member'  => ! empty( $d['byId'] ) ? (string) $d['byId'] : null,
			'by_role'    => ! empty( $d['byRole'] ) ? (string) $d['byRole'] : null,
			'at'         => $at,
			'created_at' => $at,
		);
	}

	/**
	 * `trash` → grp_trash (the deleted row is mapped like a live one).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function trash( array $d ) {
		$id    = self::id( $d['id'] ?? '' );
		$table = self::TRASH_TYPES[ $d['type'] ?? '' ] ?? null;
		if ( ! $id || ! $table || ! is_array( $d['data'] ?? null ) ) {
			return null;
		}

		$mapper = array(
			'grp_meeting_tasks' => 'meeting_task',
			'grp_monthly_tasks' => 'monthly_task',
			'grp_projects'      => 'project',
		)[ $table ];
		$data   = self::$mapper( $d['data'] );
		if ( ! $data ) {
			return null;
		}
		$deleted_at = self::time( $d['deletedAt'] ?? null ) ?? GRP_Ids::now();

		return array(
			'id'         => $id,
			'type'       => $table,
			'doc_id'     => $data['id'],
			'data'       => array_filter(
				$data,
				static function ( $v ) {
					return null !== $v;
				}
			),
			'title'      => (string) ( $d['title'] ?? ( $data['title'] ?? $data['name'] ?? '' ) ),
			'project_id' => 'grp_projects' === $table ? $data['id'] : ( $data['project_id'] ?? null ),
			'deleted_at' => $deleted_at,
			'deleted_by' => ! empty( $d['byId'] ) ? (string) $d['byId'] : null,
			'created_at' => $deleted_at,
		);
	}

	/**
	 * `dismissals` (one document per person: `{id: memberId, items: {key: at}}`) → grp_dismissals.
	 *
	 * @param array $d Document.
	 * @return array[]
	 */
	public static function dismissals( array $d ) {
		$member_id = (string) ( $d['id'] ?? '' );
		if ( '' === $member_id || ! is_array( $d['items'] ?? null ) ) {
			return array();
		}

		$rows = array();
		foreach ( $d['items'] as $key => $at ) {
			$rows[] = array(
				'id'         => 'd_' . md5( $member_id . '|' . $key ),
				'member_id'  => $member_id,
				'notice_key' => mb_substr( (string) $key, 0, 191 ),
				'at'         => self::time( $at ) ?? GRP_Ids::now(),
			);
		}

		return $rows;
	}

	/**
	 * `settings` → grp_settings (key = document id; secrets skipped).
	 *
	 * @param array $d Document.
	 * @return array|null
	 */
	public static function setting( array $d ) {
		$key = (string) ( $d['id'] ?? '' );
		if ( '' === $key || in_array( $key, self::SKIPPED_SETTINGS, true ) ) {
			return null;
		}
		unset( $d['id'] );

		return array(
			'id'          => 's_' . md5( $key ),
			'setting_key' => mb_substr( $key, 0, 191 ),
			'value'       => $d,
		);
	}

	/**
	 * Inserts or updates a row by id.
	 *
	 * @param string   $table    Table.
	 * @param array    $row      Row.
	 * @param string[] $warnings Warnings (appended).
	 * @return string inserted, updated or skipped.
	 */
	private static function upsert( $table, array $row, array &$warnings ) {
		if ( 'grp_projects' === $table ) {
			foreach ( GRP_Store::find( 'grp_projects', array( 'name' => $row['name'] ) ) as $same ) {
				if ( $same['id'] !== $row['id'] ) {
					/* translators: %s: project name. */
					$warnings[] = sprintf( __( 'Skipped project “%s”: another project already has that name.', 'gridrankers-portal' ), $row['name'] );
					return 'skipped';
				}
			}
		}
		if ( 'grp_dismissals' === $table || 'grp_settings' === $table ) {
			$unique = 'grp_dismissals' === $table
				? array(
					'member_id'  => $row['member_id'],
					'notice_key' => $row['notice_key'],
				)
				: array( 'setting_key' => $row['setting_key'] );
			$found  = GRP_Store::find( $table, $unique );
			if ( $found ) {
				$row['id'] = $found[0]['id'];
			}
		}

		$existing = GRP_Store::get( $table, $row['id'] );
		if ( $existing ) {
			unset( $row['created_at'] );
			if ( 'grp_members' === $table ) {
				// Keep codes already moved to password_hash() and WordPress links made since.
				if ( ! empty( $existing['code_hash'] ) && empty( $existing['code_salt'] ) ) {
					unset( $row['code_hash'], $row['code_salt'], $row['code_set_at'] );
				}
				if ( ! empty( $existing['wp_user_id'] ) && empty( $row['wp_user_id'] ) ) {
					unset( $row['wp_user_id'] );
				}
				// An export without a profile field (e.g. from the old portal) never blanks one
				// filled in here: the required profile (SPEC.md 6.10) would lock the person.
				foreach ( self::KEEP_PROFILE as $field ) {
					if ( array_key_exists( $field, $row ) && ( null === $row[ $field ] || '' === $row[ $field ] ) && ! empty( $existing[ $field ] ) ) {
						unset( $row[ $field ] );
					}
				}
			}
			GRP_Store::update( $table, $row['id'], $row );
			return 'updated';
		}

		if ( empty( $row['created_at'] ) ) {
			unset( $row['created_at'] );
		}
		GRP_Store::insert( $table, $row );

		return 'inserted';
	}

	/**
	 * Wraps a single row.
	 *
	 * @param array|null $row Row.
	 * @return array[]
	 */
	private static function wrap( $row ) {
		return $row ? array( $row ) : array();
	}

	/**
	 * Responsible people: `assignees` or the legacy single `whoId`.
	 *
	 * @param array $d      Task document.
	 * @param int   $target Quantity.
	 * @return array
	 */
	private static function assignees( array $d, $target ) {
		if ( ! empty( $d['assignees'] ) && is_array( $d['assignees'] ) ) {
			return self::assignee_list( $d['assignees'], $target );
		}
		if ( ! empty( $d['whoId'] ) ) {
			return array(
				array(
					'id' => (string) $d['whoId'],
					'n'  => $target,
				),
			);
		}

		return array();
	}

	/**
	 * `[{id, n}]` with string ids and n ≥ 1.
	 *
	 * @param array $people Raw list.
	 * @param int   $target Default n.
	 * @return array
	 */
	private static function assignee_list( array $people, $target ) {
		$out = array();
		foreach ( $people as $a ) {
			$a = (array) $a;
			if ( empty( $a['id'] ) ) {
				continue;
			}
			$out[] = array(
				'id' => (string) $a['id'],
				'n'  => max( 1, (int) ( $a['n'] ?? $target ) ),
			);
		}

		return $out;
	}

	/**
	 * `{key: count}` with integer counts.
	 *
	 * @param mixed $counts Raw counts.
	 * @return array
	 */
	private static function counts( $counts ) {
		$out = array();
		foreach ( (array) $counts as $k => $v ) {
			$out[ (string) $k ] = max( 0, (int) $v );
		}

		return $out;
	}

	/**
	 * Meeting task deadline from the legacy fields (SPEC.md 6.3).
	 *
	 * @param array $d Item document.
	 * @return array
	 */
	private static function deadline( array $d ) {
		$type = $d['dueType'] ?? 'none';
		$ref  = self::ymd( $d['dueRef'] ?? null );

		switch ( $type ) {
			case 'weekly':
				$weeks = array_values( array_filter( array_map( array( __CLASS__, 'ymd' ), (array) ( $d['dueWeeks'] ?? array() ) ) ) );
				if ( ! $weeks && $ref ) {
					$weeks = array( gmdate( 'Y-m-d', strtotime( $ref . ' UTC -' . ( (int) gmdate( 'N', strtotime( $ref . ' UTC' ) ) - 1 ) . ' days' ) ) );
				}
				sort( $weeks );
				return $weeks ? array(
					'type'  => 'weekly',
					'weeks' => $weeks,
				) : array( 'type' => 'none' );

			case 'monthly':
				$month = ! empty( $d['dueMonth'] ) ? (string) $d['dueMonth'] : ( $ref ? substr( $ref, 0, 7 ) : '' );
				return $month ? array(
					'type'  => 'monthly',
					'month' => $month,
				) : array( 'type' => 'none' );

			case 'biweekly':
				// Written by this plugin's export (two weeks from a Monday).
				$from = self::ymd( $d['dueFrom'] ?? null );
				return $from ? array(
					'type' => 'biweekly',
					'from' => $from,
					'to'   => self::ymd( $d['dueTo'] ?? null ) ? self::ymd( $d['dueTo'] ) : gmdate( 'Y-m-d', strtotime( $from . ' 00:00:00 UTC +13 days' ) ),
				) : array( 'type' => 'none' );

			case 'date':
				$date = self::ymd( $d['dueDate'] ?? null );
				return $date ? array(
					'type' => 'date',
					'date' => $date,
				) : array( 'type' => 'none' );

			case 'dates':
				$from = self::ymd( $d['dueFrom'] ?? null );
				$to   = self::ymd( $d['dueTo'] ?? null );
				if ( ( ! $from || ! $to ) && ! empty( $d['dueDates'] ) && is_array( $d['dueDates'] ) ) {
					$dates = array_values( array_filter( array_map( array( __CLASS__, 'ymd' ), $d['dueDates'] ) ) );
					sort( $dates );
					$from = $dates[0] ?? null;
					$to   = $dates ? end( $dates ) : null;
				}
				return $from && $to ? array(
					'type' => 'dates',
					'from' => min( $from, $to ),
					'to'   => max( $from, $to ),
				) : array( 'type' => 'none' );
		}

		return array( 'type' => 'none' );
	}

	/**
	 * Id string, or '' when missing / too long.
	 *
	 * @param mixed $id  Raw id.
	 * @param int   $max Column length.
	 * @return string
	 */
	private static function id( $id, $max = 64 ) {
		$id = trim( (string) $id );

		return strlen( $id ) <= $max ? $id : '';
	}

	/**
	 * UTC DATETIME from epoch milliseconds or an ISO / date string; null when empty.
	 *
	 * @param mixed $value Raw time.
	 * @return string|null
	 */
	public static function time( $value ) {
		if ( null === $value || '' === $value || false === $value ) {
			return null;
		}
		if ( is_numeric( $value ) ) {
			return gmdate( 'Y-m-d H:i:s', (int) floor( (float) $value / 1000 ) );
		}
		$ts = strtotime( (string) $value );

		return false === $ts ? null : gmdate( 'Y-m-d H:i:s', $ts );
	}

	/**
	 * `Y-m-d` from a date-ish value; null when empty or invalid.
	 *
	 * @param mixed $value Raw date.
	 * @return string|null
	 */
	public static function ymd( $value ) {
		if ( is_string( $value ) && preg_match( '/^(\d{4})-(\d{2})-(\d{2})/', $value, $m ) && checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) ) {
			return $m[1] . '-' . $m[2] . '-' . $m[3];
		}
		$time = self::time( $value );

		return $time ? substr( $time, 0, 10 ) : null;
	}
}
