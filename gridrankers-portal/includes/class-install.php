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
	const DB_VERSION = 2;

	/**
	 * Option that stores the installed schema version.
	 */
	const DB_VERSION_OPTION = 'grp_db_version';

	/**
	 * Unprefixed table names, without the `{$wpdb->prefix}` part.
	 *
	 * The optional `grp_requests` table from SPEC.md section 5 is not created:
	 * there is no public access-request flow. `grp_deletions` (schema 2) is an addition:
	 * tombstones for hard-deleted rows so GET /sync can report deletions.
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
		return array();
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
				freq enum('monthly','weekly') NOT NULL DEFAULT 'monthly',
				due_mode enum('none','weekly','date','dates','monthly') NOT NULL DEFAULT 'monthly',
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
		);
	}
}
