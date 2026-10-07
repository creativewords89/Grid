<?php
/**
 * Table creation, schema versioning and migrations.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Creates and upgrades the plugin's custom tables (SPEC.md section 5).
 */
class GRP_Install {

	/**
	 * Current schema version. Bump it whenever get_schema() or migrations() changes.
	 */
	const DB_VERSION = 14;

	/**
	 * Option that stores the installed schema version.
	 */
	const DB_VERSION_OPTION = 'grp_db_version';

	/**
	 * Unprefixed table names, without the `{$wpdb->prefix}` part.
	 *
	 * The optional `grp_requests` table from SPEC.md section 5 is not created:
	 * there is no public access-request flow. `grp_deletions` (schema 2) is an addition:
	 * tombstones for hard-deleted rows so GET /sync can report deletions. Schema 5 adds
	 * leave, days off and posts (announcements, shout-outs) for SPEC.md 6.10; schema 6
	 * adds member location and birth year, and private notices. Schema 8 adds project details,
 * the keyword checklist columns and `grp_keywords` (SPEC.md 6.12). Schema 9 adds `undo_request` (a Team
 * Member's request to undo In progress, SPEC.md 6.6) to meeting tasks and cycle records. Schema 10 adds
 * `grp_files` (private uploads for submissions and comments) and `grp_comments` (SPEC.md 6.6). Schema 11
 * adds `grp_billing` and `grp_billing_fees`, the Super Admin's invoice tracker (SPEC.md 6.14).
 * Schema 12 repairs breakdown people (6.5); schema 13 adds `past` to keywords (moved to Past, 6.12).
 * Schema 14 adds `grp_client_requests` and `grp_request_messages`: what the team needs from a client (6.15).
	 *
	 * @var string[]
	 */
	const TABLES = array(
		'grp_members',
		'grp_sessions',
		'grp_projects',
		'grp_meeting_tasks',
		'grp_monthly_tasks',
		'grp_cycle_records',
		'grp_activity',
		'grp_audit',
		'grp_trash',
		'grp_dismissals',
		'grp_settings',
		'grp_deletions',
		'grp_leave',
		'grp_days_off',
		'grp_posts',
		'grp_keywords',
		'grp_files',
		'grp_comments',
		'grp_billing',
		'grp_billing_fees',
		'grp_client_requests',
		'grp_request_messages',
	);

	/**
	 * Activation hook.
	 */
	public static function activate() {
		self::install();
		GRP_Frontend::install_page();
		GRP_Cron::schedule();
	}

	/**
	 * Deactivation hook. Tables and data are kept.
	 */
	public static function deactivate() {
		GRP_Cron::unschedule();
		GRP_Updater::unschedule();
	}

	/**
	 * Runs the installer when the stored schema version is older than DB_VERSION.
	 */
	public static function maybe_upgrade() {
		if ( self::installed_version() < self::DB_VERSION ) {
			self::install();
		}
	}

	/**
	 * Installed schema version, 0 when the plugin has never been installed.
	 *
	 * @return int
	 */
	public static function installed_version() {
		return (int) get_option( self::DB_VERSION_OPTION, 0 );
	}

	/**
	 * Creates or updates every table, runs pending migrations and stores the new schema version.
	 */
	public static function install() {
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$from = self::installed_version();

		dbDelta( self::get_schema() );

		foreach ( self::migrations() as $version => $migration ) {
			if ( $version > $from && $version <= self::DB_VERSION ) {
				call_user_func( $migration );
			}
		}

		update_option( self::DB_VERSION_OPTION, self::DB_VERSION, false );
	}

	/**
	 * Data migrations that dbDelta cannot express, keyed by the schema version that introduces them.
	 *
	 * @return array<int, callable>
	 */
	private static function migrations() {
		return array(
			3  => array( __CLASS__, 'migrate_weekly_records' ),
			7  => array( __CLASS__, 'start_cycle_setup' ),
			11 => array( 'GRP_Billing', 'start' ),
			12 => array( __CLASS__, 'sync_breakdown_people' ),
		);
	}

	/**
	 * Schema 7: the new cycle setup (SPEC.md 6.11) applies to cycles that start from today on,
	 * so projects already part-way through a cycle are not overdue the day it is installed.
	 */
	public static function start_cycle_setup() {
		if ( ! GRP_Store::find( 'grp_settings', array( 'setting_key' => GRP_Cycle_Setup::SINCE_KEY ) ) ) {
			GRP_Store::insert(
				'grp_settings',
				array(
					'id'          => 's_' . md5( GRP_Cycle_Setup::SINCE_KEY ),
					'setting_key' => GRP_Cycle_Setup::SINCE_KEY,
					'value'       => array( 'date' => GRP_Cycles::today() ),
				)
			);
		}
	}

	/**
	 * Schema 12: a monthly task's people on its breakdown rows are its people responsible (SPEC.md
	 * 6.5), as saving it in the portal does. Imported tasks could have them only on the rows, so
	 * they never reached those people's My day and stayed locked for them.
	 *
	 * @return int Tasks fixed.
	 */
	public static function sync_breakdown_people() {
		$fixed = 0;
		foreach ( GRP_Store::find( 'grp_monthly_tasks' ) as $task ) {
			$by = GRP_REST_Monthly_Tasks::breakdown_people( $task['parts'] ?? array() );
			if ( ! $by || GRP_Store::canonical( $by ) === GRP_Store::canonical( (array) ( $task['assignees'] ?? array() ) ) ) {
				continue;
			}
			GRP_Store::update(
				'grp_monthly_tasks',
				$task['id'],
				array(
					'assignees' => $by,
					'team'      => 0,
				)
			);
			++$fixed;
		}

		return $fixed;
	}

	/**
	 * Schema 3: weekly tasks follow the project cycle (SPEC.md 6.2). Records stored under a
	 * calendar-week key (`YYYY-MM-wN`) move to the cycle week containing that calendar
	 * week's first day, with their activity credits. Projects starting on day 1 keep their
	 * keys (same weeks). A record whose new key is already taken stays where it was.
	 *
	 * @return int Records moved.
	 */
	public static function migrate_weekly_records() {
		// New cycle-week keys look like old calendar-week keys: never convert twice.
		if ( get_option( 'grp_weekly_migrated' ) ) {
			return 0;
		}
		update_option( 'grp_weekly_migrated', 1, false );

		$today = GRP_Cycles::today();
		$moved = 0;

		foreach ( GRP_Store::find( 'grp_monthly_tasks', array( 'freq' => 'weekly' ) ) as $task ) {
			$project = GRP_Store::get( 'grp_projects', $task['project_id'] );
			if ( ! $project ) {
				continue;
			}
			foreach ( GRP_Store::find( 'grp_cycle_records', array( 'task_id' => $task['id'] ) ) as $rec ) {
				if ( ! preg_match( '/^(\d{4})-(\d{2})-w([1-4])$/', (string) $rec['period_key'], $m ) ) {
					continue;
				}
				$first         = sprintf( '%s-%s-%02d', $m[1], $m[2], 1 + 7 * ( (int) $m[3] - 1 ) );
				list( $p, $w ) = GRP_Cycles::week_at( $project, $first, $today );
				$key           = $p['key'] . '-w' . ( $w + 1 );
				$id            = GRP_Cycles::record_id( $task['id'], $key );
				// Outside the ±18-month window of known cycles, or nothing to change, or taken.
				$outside = $first < $p['start'] || $first > $p['end'];
				if ( $outside || $key === $rec['period_key'] || GRP_Store::get( 'grp_cycle_records', $id ) ) {
					continue;
				}

				GRP_Store::transaction(
					static function () use ( $rec, $id, $key, $w ) {
						$old = $rec['id'];
						unset( $rec['created_at'], $rec['updated_at'] );
						GRP_Store::insert(
							'grp_cycle_records',
							array_merge(
								$rec,
								array(
									'id'         => $id,
									'period_key' => $key,
									'week'       => $w + 1,
								)
							)
						);
						GRP_Store::delete( 'grp_cycle_records', $old );
						foreach ( GRP_Store::find( 'grp_activity', array( 'ref_key' => 'rec:' . $old ) ) as $credit ) {
							GRP_Store::update( 'grp_activity', $credit['id'], array( 'ref_key' => 'rec:' . $id ) );
						}
					}
				);
				++$moved;
			}
		}

		return $moved;
	}

	/**
	 * Full table name including the WordPress prefix.
	 *
	 * @param string $name Unprefixed table name, e.g. `grp_members`.
	 * @return string
	 */
	public static function table( $name ) {
		global $wpdb;

		return $wpdb->prefix . $name;
	}

	/**
	 * CREATE TABLE statements in the format dbDelta expects.
	 *
	 * @return string[]
	 */
	public static function get_schema() {
		global $wpdb;

		$collate = $wpdb->get_charset_collate();
		$t       = array();
		foreach ( self::TABLES as $name ) {
			$t[ $name ] = self::table( $name );
		}

		return array(
			"CREATE TABLE {$t['grp_members']} (
				id varchar(64) NOT NULL,
				name varchar(191) NOT NULL DEFAULT '',
				role enum('admin','lead','member') NOT NULL DEFAULT 'member',
				color varchar(32) NOT NULL DEFAULT '',
				photo text NULL,
				title varchar(191) NOT NULL DEFAULT '',
				email varchar(191) NOT NULL DEFAULT '',
				phone varchar(64) NOT NULL DEFAULT '',
				address text NULL,
				drive_url text NULL,
				notes longtext NULL,
				code_hash varchar(255) NULL,
				code_salt varchar(64) NULL,
				code_set_at datetime NULL,
				wp_user_id bigint(20) unsigned NULL,
				active tinyint(1) NOT NULL DEFAULT 1,
				birthday char(5) NULL,
				birth_year smallint(4) unsigned NULL,
				location varchar(191) NULL,
				weekly_off json NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY wp_user_id (wp_user_id),
				KEY role (role),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_sessions']} (
				id varchar(64) NOT NULL,
				member_id varchar(64) NOT NULL,
				token_hash char(64) NOT NULL,
				expires_at datetime NOT NULL,
				ip varchar(45) NOT NULL DEFAULT '',
				user_agent varchar(255) NOT NULL DEFAULT '',
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY token_hash (token_hash),
				KEY member_id (member_id),
				KEY expires_at (expires_at)
			) $collate;",

			"CREATE TABLE {$t['grp_projects']} (
				id varchar(64) NOT NULL,
				name varchar(191) NOT NULL,
				state enum('active','paused','inactive') NOT NULL DEFAULT 'active',
				cycle_day tinyint(2) unsigned NOT NULL DEFAULT 1,
				cycle_set tinyint(1) NOT NULL DEFAULT 0,
				cycle_changes json NULL,
				cycle_log json NULL,
				std_cycle varchar(32) NULL,
				cycle_reviews json NULL,
				details json NULL,
				kw_columns json NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY name (name),
				KEY state (state),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_meeting_tasks']} (
				id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				title text NOT NULL,
				notes longtext NULL,
				url text NULL,
				priority enum('urgent','high','normal','low') NOT NULL DEFAULT 'normal',
				status enum('todo','doing','done') NOT NULL DEFAULT 'todo',
				meeting_date date NULL,
				done_at datetime NULL,
				target int(10) unsigned NOT NULL DEFAULT 1,
				assignees json NULL,
				team tinyint(1) NOT NULL DEFAULT 0,
				progress json NULL,
				deadline json NULL,
				review json NULL,
				completion json NULL,
				undo_request json NULL,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY project_id (project_id),
				KEY status (status),
				KEY meeting_date (meeting_date),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_monthly_tasks']} (
				id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				title text NOT NULL,
				notes longtext NULL,
				freq enum('monthly','weekly','biweekly') NOT NULL DEFAULT 'monthly',
				due_mode enum('none','weekly','biweekly','date','dates','monthly') NOT NULL DEFAULT 'monthly',
				due_day tinyint(2) unsigned NULL,
				due_from_day tinyint(2) unsigned NULL,
				target int(10) unsigned NOT NULL DEFAULT 1,
				assignees json NULL,
				team tinyint(1) NOT NULL DEFAULT 0,
				parts json NULL,
				std tinyint(1) NOT NULL DEFAULT 0,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY project_id (project_id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_cycle_records']} (
				id varchar(191) NOT NULL,
				task_id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				period_key varchar(32) NOT NULL,
				week tinyint(1) unsigned NULL,
				count int(10) unsigned NOT NULL DEFAULT 0,
				status enum('todo','doing','done','skipped') NOT NULL DEFAULT 'todo',
				by_person json NULL,
				parts json NULL,
				review json NULL,
				completion json NULL,
				undo_request json NULL,
				done_at datetime NULL,
				cleared_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY task_id (task_id),
				KEY project_id (project_id),
				KEY period_key (period_key),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_activity']} (
				id varchar(64) NOT NULL,
				member_id varchar(64) NOT NULL,
				date date NOT NULL,
				at datetime NOT NULL,
				kind enum('auto','manual') NOT NULL DEFAULT 'auto',
				source enum('board','monthly','manual') NOT NULL DEFAULT 'board',
				project_id varchar(64) NULL,
				title text NULL,
				detail text NULL,
				qty int(10) unsigned NOT NULL DEFAULT 0,
				minutes int(10) unsigned NULL,
				notes text NULL,
				ref_key varchar(191) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY member_id (member_id),
				KEY project_id (project_id),
				KEY date (date),
				KEY at (at),
				KEY ref_key (ref_key),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_audit']} (
				id varchar(64) NOT NULL,
				kind varchar(32) NOT NULL,
				type varchar(32) NOT NULL,
				doc_id varchar(191) NULL,
				project_id varchar(64) NULL,
				title text NULL,
				detail text NULL,
				changes json NULL,
				by_member varchar(64) NULL,
				by_role varchar(16) NULL,
				at datetime NOT NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY project_id (project_id),
				KEY doc_id (doc_id),
				KEY by_member (by_member),
				KEY at (at),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_trash']} (
				id varchar(64) NOT NULL,
				type varchar(32) NOT NULL,
				doc_id varchar(191) NOT NULL,
				data json NULL,
				title text NULL,
				project_id varchar(64) NULL,
				with_project tinyint(1) NOT NULL DEFAULT 0,
				deleted_at datetime NOT NULL,
				deleted_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY doc_id (doc_id),
				KEY project_id (project_id),
				KEY deleted_at (deleted_at),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_dismissals']} (
				id varchar(64) NOT NULL,
				member_id varchar(64) NOT NULL,
				notice_key varchar(191) NOT NULL,
				at datetime NOT NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY member_notice (member_id,notice_key),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_settings']} (
				id varchar(64) NOT NULL,
				setting_key varchar(191) NOT NULL,
				value json NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY setting_key (setting_key),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_deletions']} (
				id varchar(64) NOT NULL,
				table_name varchar(32) NOT NULL,
				doc_id varchar(191) NOT NULL,
				deleted_at datetime NOT NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY table_doc (table_name,doc_id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_leave']} (
				id varchar(64) NOT NULL,
				member_id varchar(64) NOT NULL,
				type enum('day','sick') NOT NULL DEFAULT 'day',
				from_date date NOT NULL,
				to_date date NOT NULL,
				days tinyint(3) unsigned NOT NULL DEFAULT 0,
				reason text NULL,
				status enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
				decided_by varchar(64) NULL,
				decided_at datetime NULL,
				message text NULL,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY member_id (member_id),
				KEY from_date (from_date),
				KEY to_date (to_date),
				KEY status (status),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_days_off']} (
				id varchar(64) NOT NULL,
				kind enum('event','seasonal') NOT NULL DEFAULT 'event',
				name varchar(191) NOT NULL DEFAULT '',
				from_date date NOT NULL,
				to_date date NOT NULL,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY from_date (from_date),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_posts']} (
				id varchar(64) NOT NULL,
				kind enum('announcement','shoutout','notice') NOT NULL DEFAULT 'announcement',
				title varchar(191) NULL,
				body text NOT NULL,
				to_member varchar(64) NULL,
				to_members json NULL,
				pinned tinyint(1) NOT NULL DEFAULT 0,
				show_until date NULL,
				created_by varchar(64) NULL,
				deleted_at datetime NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY kind (kind),
				KEY to_member (to_member),
				KEY created_at (created_at),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_keywords']} (
				id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				keyword varchar(191) NOT NULL,
				checks json NULL,
				note text NULL,
				deadline date NULL,
				past json NULL,
				position int(11) NOT NULL DEFAULT 0,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY project_id (project_id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_files']} (
				id varchar(64) NOT NULL,
				name varchar(191) NOT NULL,
				mime varchar(100) NOT NULL,
				size int(11) NOT NULL DEFAULT 0,
				path varchar(255) NOT NULL,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY created_by (created_by)
			) $collate;",

			"CREATE TABLE {$t['grp_comments']} (
				id varchar(64) NOT NULL,
				ref_kind enum('item','record') NOT NULL,
				ref_id varchar(128) NOT NULL,
				project_id varchar(64) NULL,
				body text NOT NULL,
				files json NULL,
				created_by varchar(64) NULL,
				deleted_at datetime NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY ref (ref_kind,ref_id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_billing']} (
				id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				project_name varchar(191) NOT NULL DEFAULT '',
				cycle_key varchar(32) NOT NULL,
				cycle_start date NOT NULL,
				cycle_end date NOT NULL,
				amount decimal(12,2) NULL,
				currency varchar(8) NOT NULL DEFAULT '',
				sent_at date NULL,
				sent_by varchar(64) NULL,
				ref varchar(191) NULL,
				skipped tinyint(1) NOT NULL DEFAULT 0,
				note text NULL,
				payments json NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY project_cycle (project_id,cycle_key),
				KEY cycle_end (cycle_end),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_billing_fees']} (
				id varchar(64) NOT NULL,
				fee decimal(12,2) NULL,
				currency varchar(8) NOT NULL DEFAULT '',
				remind_days tinyint(3) unsigned NOT NULL DEFAULT 3,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_client_requests']} (
				id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				title varchar(191) NOT NULL,
				kind enum('images','info','page','access','other') NOT NULL DEFAULT 'other',
				details text NULL,
				status enum('needed','asked','received','done') NOT NULL DEFAULT 'needed',
				asked_via varchar(20) NULL,
				asked_at datetime NULL,
				asked_by varchar(64) NULL,
				done_at datetime NULL,
				done_by varchar(64) NULL,
				created_by varchar(64) NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY project_id (project_id),
				KEY updated_at (updated_at)
			) $collate;",

			"CREATE TABLE {$t['grp_request_messages']} (
				id varchar(64) NOT NULL,
				request_id varchar(64) NOT NULL,
				project_id varchar(64) NOT NULL,
				body text NOT NULL,
				files json NULL,
				from_client tinyint(1) NOT NULL DEFAULT 0,
				via varchar(20) NULL,
				event varchar(20) NULL,
				created_by varchar(64) NULL,
				deleted_at datetime NULL,
				created_at datetime NOT NULL,
				updated_at datetime NOT NULL,
				PRIMARY KEY  (id),
				KEY request_id (request_id),
				KEY updated_at (updated_at)
			) $collate;",
		);
	}
}
