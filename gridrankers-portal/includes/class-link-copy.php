<?php
/**
 * Profiles copied from the main portal to the tracker portal (SPEC.md 6.22).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The main portal answers `GET /link/people`; the tracker portal copies it every 5 minutes
 * (`grp_link_sync`) into its own tables with the same ids, and refuses every change to them.
 */
class GRP_Link_Copy {

	/**
	 * The tracker portal's copy job.
	 */
	const HOOK = 'grp_link_sync';

	/**
	 * Its WP-Cron schedule.
	 */
	const SCHEDULE = 'grp_five_minutes';

	/**
	 * Columns copied per table (anything else stays as the tracker portal has it, or empty). Never
	 * codes, salary, payment details, leave type or reason, addresses or notes.
	 */
	const COLUMNS = array(
		'grp_members'       => array( 'id', 'name', 'role', 'color', 'photo', 'title', 'email', 'phone', 'active', 'birthday', 'birth_year', 'location', 'weekly_off', 'employment', 'employment_since', 'work_start', 'code_set_at', 'created_at' ),
		'grp_pay'           => array( 'id', 'member_id', 'day_minutes', 'created_at' ),
		'grp_days_off'      => array( 'id', 'kind', 'name', 'from_date', 'to_date', 'created_at' ),
		'grp_leave'         => array( 'id', 'member_id', 'type', 'from_date', 'to_date', 'days', 'status', 'created_at' ),
		'grp_projects'      => array( 'id', 'name', 'state', 'cycle_day', 'cycle_set', 'cycle_changes', 'cycle_log', 'created_at' ),
		'grp_meeting_tasks' => array( 'id', 'project_id', 'title', 'priority', 'status', 'meeting_date', 'assignees', 'team', 'created_at' ),
		'grp_monthly_tasks' => array( 'id', 'project_id', 'title', 'freq', 'due_mode', 'due_day', 'due_from_day', 'target', 'assignees', 'team', 'std', 'created_at' ),
		'grp_cycle_records' => array( 'id', 'task_id', 'project_id', 'period_key', 'week', 'count', 'status', 'created_at' ),
	);

	/**
	 * Team settings copied (`grp_settings.setting_key`).
	 */
	const SETTINGS = array( GRP_REST_People::WEEKLY_KEY, GRP_Time::START_KEY );

	/**
	 * Routes a tracker portal still writes to; every other change is made on the main portal.
	 */
	const TRACKER_WRITES = array( '/auth/', '/timer', '/time-entries', '/devices/', '/notifications/dismiss' );

	/**
	 * Hooks the job, its schedule and the read-only gate.
	 */
	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval -- 5 minutes is the copy's interval (SPEC.md 6.22).
		add_action( self::HOOK, array( __CLASS__, 'run' ) );
		add_action( 'init', array( __CLASS__, 'schedule' ) );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'read_only' ), 11, 3 );
	}

	/**
	 * Adds the 5-minute WP-Cron schedule.
	 *
	 * @param array $schedules Schedules.
	 * @return array
	 */
	public static function cron_schedules( $schedules ) {
		$schedules[ self::SCHEDULE ] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 5 minutes', 'gridrankers-portal' ),
		);

		return $schedules;
	}

	/**
	 * Schedules the job on a tracker portal, and removes it anywhere else.
	 */
	public static function schedule() {
		$next = wp_next_scheduled( self::HOOK );
		if ( GRP_Link::is_tracker() && ! $next ) {
			wp_schedule_event( time() + 30, self::SCHEDULE, self::HOOK );
		} elseif ( ! GRP_Link::is_tracker() && $next ) {
			wp_clear_scheduled_hook( self::HOOK );
		}
	}

	/**
	 * Main portal: what the tracker portal copies (GET /link/people).
	 *
	 * @param string|null $today `Y-m-d` (default: today in the site time zone).
	 * @return array
	 */
	public static function payload( $today = null ) {
		$today = $today ? $today : GRP_Cycles::today();

		$pay = array();
		foreach ( GRP_Store::find( 'grp_pay' ) as $row ) {
			// Only whether pay is set up, and the working hours.
			if ( GRP_Pay::complete( $row ) ) {
				$pay[] = array(
					'id'          => (string) $row['member_id'],
					'member_id'   => (string) $row['member_id'],
					'day_minutes' => (int) $row['day_minutes'],
					'created_at'  => $row['created_at'],
				);
			}
		}

		$leave = array();
		foreach ( GRP_Store::find( 'grp_leave', array( 'status' => 'approved' ) ) as $row ) {
			// Leave is "Leave" on the tracker portal: never its type or reason.
			$leave[] = array_merge( self::pick( 'grp_leave', $row ), array( 'type' => 'day' ) );
		}

		$projects = array();
		foreach ( GRP_Store::find( 'grp_projects' ) as $project ) {
			$projects[ (string) $project['id'] ] = $project;
		}
		// The current period's records of monthly tasks, so the tracker knows which are finished.
		$records = array();
		$monthly = GRP_Store::find( 'grp_monthly_tasks' );
		foreach ( $monthly as $task ) {
			$project = $projects[ (string) $task['project_id'] ] ?? null;
			if ( $project ) {
				$record = GRP_Store::get( 'grp_cycle_records', GRP_Cycles::record_id( $task['id'], GRP_Cycles::period_key( $task, $project, null, 0, $today ) ) );
				if ( $record ) {
					$records[] = self::pick( 'grp_cycle_records', $record );
				}
			}
		}

		$settings = array();
		foreach ( self::SETTINGS as $key ) {
			$rows             = GRP_Store::find( 'grp_settings', array( 'setting_key' => $key ) );
			$settings[ $key ] = $rows ? $rows[0]['value'] : null;
		}

		return array(
			'members'       => self::pick_all( 'grp_members', GRP_Store::find( 'grp_members' ) ),
			'pay'           => $pay,
			'days_off'      => self::pick_all( 'grp_days_off', GRP_Store::find( 'grp_days_off' ) ),
			'leave'         => $leave,
			'projects'      => self::pick_all( 'grp_projects', array_values( $projects ) ),
			'meeting_tasks' => self::pick_all( 'grp_meeting_tasks', GRP_Store::find( 'grp_meeting_tasks' ) ),
			'monthly_tasks' => self::pick_all( 'grp_monthly_tasks', $monthly ),
			'records'       => $records,
			'settings'      => $settings,
			'timezone'      => array(
				'timezone_string' => (string) get_option( 'timezone_string', '' ),
				'gmt_offset'      => (float) get_option( 'gmt_offset', 0 ),
			),
		);
	}

	/**
	 * Tracker portal: copies the main portal now (the job, Sync now, Test connection).
	 *
	 * @return array|WP_Error What changed.
	 */
	public static function run() {
		if ( ! GRP_Link::is_tracker() ) {
			return new WP_Error( 'grp_link_off', __( 'This site isn’t a tracker portal.', 'gridrankers-portal' ) );
		}
		$data = GRP_Link::call( 'GET', 'people' );
		if ( is_wp_error( $data ) ) {
			GRP_Link::copied( $data->get_error_message() );
			return $data;
		}
		// Never an empty or broken answer: that would make everyone inactive here.
		if ( empty( $data['members'] ) || ! is_array( $data['members'] ) || ! array_is_list( $data['members'] ) ) {
			$host = (string) wp_parse_url( GRP_Link::main_url(), PHP_URL_HOST );
			/* translators: %s: the main portal's address. */
			$error = new WP_Error( 'grp_link_no_people', sprintf( __( '%s sent no profiles. Nothing was changed.', 'gridrankers-portal' ), $host ) );
			GRP_Link::copied( $error->get_error_message() );
			return $error;
		}
		$summary = self::apply( $data );
		GRP_Link::copied( null );

		return $summary;
	}

	/**
	 * Tracker portal: makes its copy match the main portal's answer. Rows that didn't change are
	 * left alone (so /sync sends nothing new); people the main portal no longer has are made
	 * inactive (their time stays); someone made inactive or given a new code is signed out.
	 *
	 * @param array $data The answer of GET /link/people.
	 * @return array `{table: {added, changed, removed}, signed_out}`.
	 */
	public static function apply( array $data ) {
		return GRP_Store::transaction(
			static function () use ( $data ) {
				$summary = array();
				$before  = array();
				foreach ( GRP_Store::find( 'grp_members' ) as $m ) {
					$before[ (string) $m['id'] ] = $m;
				}

				$tables = array(
					'grp_members'       => 'members',
					'grp_pay'           => 'pay',
					'grp_days_off'      => 'days_off',
					'grp_leave'         => 'leave',
					'grp_projects'      => 'projects',
					'grp_meeting_tasks' => 'meeting_tasks',
					'grp_monthly_tasks' => 'monthly_tasks',
					'grp_cycle_records' => 'records',
				);
				foreach ( $tables as $table => $key ) {
					$rows = isset( $data[ $key ] ) && is_array( $data[ $key ] ) ? $data[ $key ] : array();
					if ( 'grp_leave' === $table ) {
						$rows = array_values( array_filter( $rows, static fn ( $r ) => 'approved' === ( $r['status'] ?? '' ) ) );
					}
					$summary[ $key ] = self::mirror( $table, $rows );
				}
				$summary['settings'] = self::copy_settings( isset( $data['settings'] ) && is_array( $data['settings'] ) ? $data['settings'] : array() );
				self::copy_timezone( isset( $data['timezone'] ) && is_array( $data['timezone'] ) ? $data['timezone'] : array() );

				// Signed out: made inactive, or a new code.
				$signed_out = 0;
				foreach ( $before as $id => $old ) {
					$new  = GRP_Store::get( 'grp_members', $id );
					$gone = ! $new || ( (int) $old['active'] && ! (int) $new['active'] );
					if ( $gone || ( $new && ! empty( $old['code_set_at'] ) && (string) $old['code_set_at'] !== (string) $new['code_set_at'] ) ) {
						GRP_Auth::revoke_sessions( $id );
						++$signed_out;
					}
				}
				$summary['signed_out'] = $signed_out;

				return $summary;
			}
		);
	}

	/**
	 * Makes one table match the main portal's rows.
	 *
	 * @param string $table Table.
	 * @param array  $rows  The main portal's rows.
	 * @return array `{added, changed, removed}`.
	 */
	private static function mirror( $table, array $rows ) {
		$count = array(
			'added'   => 0,
			'changed' => 0,
			'removed' => 0,
		);
		$local = array();
		foreach ( GRP_Store::find( $table ) as $row ) {
			$local[ (string) $row['id'] ] = $row;
		}

		$seen = array();
		foreach ( $rows as $raw ) {
			if ( ! is_array( $raw ) || '' === (string) ( $raw['id'] ?? '' ) ) {
				continue;
			}
			$row               = self::pick( $table, $raw );
			$id                = (string) $row['id'];
			$seen[ $id ]       = true;
			$row['created_at'] = self::datetime( $row['created_at'] ?? null );
			if ( ! isset( $local[ $id ] ) ) {
				GRP_Store::insert( $table, $row );
				++$count['added'];
				continue;
			}
			$changes = array();
			foreach ( $row as $column => $value ) {
				if ( 'id' !== $column && 'created_at' !== $column && ! self::same( $table, $column, $local[ $id ][ $column ] ?? null, $value ) ) {
					$changes[ $column ] = $value;
				}
			}
			if ( $changes ) {
				GRP_Store::update( $table, $id, $changes );
				++$count['changed'];
			}
		}

		foreach ( $local as $id => $row ) {
			if ( isset( $seen[ $id ] ) ) {
				continue;
			}
			if ( 'grp_members' === $table ) {
				// Their time entries stay; they just can't sign in.
				if ( (int) $row['active'] ) {
					GRP_Store::update( $table, $id, array( 'active' => 0 ) );
					++$count['removed'];
				}
				continue;
			}
			GRP_Store::delete( $table, $id );
			++$count['removed'];
		}

		return $count;
	}

	/**
	 * Copies the team settings.
	 *
	 * @param array $settings `{key: value|null}`.
	 * @return int Settings changed.
	 */
	private static function copy_settings( array $settings ) {
		$changed = 0;
		foreach ( self::SETTINGS as $key ) {
			$value = $settings[ $key ] ?? null;
			$rows  = GRP_Store::find( 'grp_settings', array( 'setting_key' => $key ) );
			if ( null === $value ) {
				foreach ( $rows as $row ) {
					GRP_Store::delete( 'grp_settings', $row['id'] );
					++$changed;
				}
				continue;
			}
			if ( ! $rows ) {
				GRP_Store::insert(
					'grp_settings',
					array(
						'setting_key' => $key,
						'value'       => $value,
					)
				);
				++$changed;
			} elseif ( ! self::same( 'grp_settings', 'value', $rows[0]['value'], $value ) ) {
				GRP_Store::update( 'grp_settings', $rows[0]['id'], array( 'value' => $value ) );
				++$changed;
			}
		}

		return $changed;
	}

	/**
	 * Copies the site time zone, so days start at the same moment on both sites.
	 *
	 * @param array $tz `{timezone_string, gmt_offset}`.
	 */
	private static function copy_timezone( array $tz ) {
		$zone = (string) ( $tz['timezone_string'] ?? '' );
		if ( '' !== $zone && in_array( $zone, timezone_identifiers_list(), true ) ) {
			update_option( 'timezone_string', $zone );
		} elseif ( isset( $tz['gmt_offset'] ) && is_numeric( $tz['gmt_offset'] ) ) {
			update_option( 'timezone_string', '' );
			update_option( 'gmt_offset', (float) $tz['gmt_offset'] );
		}
	}

	/**
	 * Whether a stored value equals a copied one.
	 *
	 * @param string $table  Table.
	 * @param string $column Column.
	 * @param mixed  $stored Value on the tracker portal (decoded).
	 * @param mixed  $copied Value from the main portal.
	 * @return bool
	 */
	private static function same( $table, $column, $stored, $copied ) {
		if ( in_array( $column, GRP_Store::JSON_COLUMNS[ $table ] ?? array(), true ) ) {
			return wp_json_encode( GRP_Store::canonical( $stored ) ) === wp_json_encode( GRP_Store::canonical( $copied ) );
		}
		if ( null === $stored || null === $copied ) {
			return null === $stored && null === $copied;
		}

		return (string) $stored === (string) $copied;
	}

	/**
	 * A row with only the copied columns.
	 *
	 * @param string $table Table.
	 * @param array  $row   Row.
	 * @return array
	 */
	private static function pick( $table, array $row ) {
		$out = array();
		foreach ( self::COLUMNS[ $table ] as $column ) {
			if ( array_key_exists( $column, $row ) ) {
				$out[ $column ] = $row[ $column ];
			}
		}

		return $out;
	}

	/**
	 * Rows with only the copied columns.
	 *
	 * @param string $table Table.
	 * @param array  $rows  Rows.
	 * @return array[]
	 */
	private static function pick_all( $table, array $rows ) {
		return array_map( static fn ( $row ) => self::pick( $table, $row ), $rows );
	}

	/**
	 * A `Y-m-d H:i:s` time, or now.
	 *
	 * @param mixed $value Value.
	 * @return string
	 */
	private static function datetime( $value ) {
		return is_string( $value ) && preg_match( '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $value ) ? $value : GRP_Ids::now();
	}

	/**
	 * Filter rest_pre_dispatch on a tracker portal: profiles, pay, leave, days off, projects and tasks
	 * are changed on the main portal only (403 `grp_main_portal`).
	 *
	 * @param mixed           $result  Response so far.
	 * @param WP_REST_Server  $server  Server.
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function read_only( $result, $server, $request ) {
		$base = '/' . GRP_REST_Auth::REST_NAMESPACE;
		$path = (string) $request->get_route();
		if ( null !== $result || ! GRP_Link::is_tracker() || ! str_starts_with( $path, $base . '/' ) || in_array( $request->get_method(), array( 'GET', 'HEAD', 'OPTIONS' ), true ) ) {
			return $result;
		}
		$path = substr( $path, strlen( $base ) );
		foreach ( self::TRACKER_WRITES as $open ) {
			if ( str_ends_with( $open, '/' ) ? str_starts_with( $path, $open ) : ( $path === $open || str_starts_with( $path, $open . '/' ) ) ) {
				return $result;
			}
		}
		$host = (string) wp_parse_url( GRP_Link::main_url(), PHP_URL_HOST );

		/* translators: %s: the main portal's address, e.g. bot.gridrankers.com. */
		return new WP_Error( 'grp_main_portal', sprintf( __( 'Change this on %s.', 'gridrankers-portal' ), $host ), array( 'status' => 403 ) );
	}
}
