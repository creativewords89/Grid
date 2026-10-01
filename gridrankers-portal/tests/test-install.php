<?php
/**
 * Tests for GRP_Install: activation creates every table and records the schema version.
 *
 * @package GridRankers_Portal
 */

/**
 * Activation / schema versioning tests.
 */
class Test_GRP_Install extends WP_UnitTestCase {

	/**
	 * Key columns from SPEC.md section 5 that every table must have.
	 *
	 * @var array<string, string[]>
	 */
	const EXPECTED_COLUMNS = array(
		'grp_members'       => array( 'id', 'name', 'role', 'color', 'photo', 'title', 'email', 'phone', 'address', 'drive_url', 'notes', 'code_hash', 'code_salt', 'code_set_at', 'wp_user_id', 'active' ),
		'grp_sessions'      => array( 'id', 'member_id', 'token_hash', 'expires_at', 'ip', 'user_agent' ),
		'grp_projects'      => array( 'id', 'name', 'state', 'cycle_day', 'cycle_set', 'cycle_changes', 'cycle_log', 'std_cycle' ),
		'grp_meeting_tasks' => array( 'id', 'project_id', 'title', 'notes', 'url', 'priority', 'status', 'meeting_date', 'done_at', 'target', 'assignees', 'team', 'progress', 'deadline', 'review', 'completion', 'created_by' ),
		'grp_monthly_tasks' => array( 'id', 'project_id', 'title', 'notes', 'freq', 'due_mode', 'due_day', 'due_from_day', 'target', 'assignees', 'team', 'parts', 'std', 'created_by' ),
		'grp_cycle_records' => array( 'id', 'task_id', 'project_id', 'period_key', 'week', 'count', 'status', 'by_person', 'parts', 'review', 'completion', 'done_at', 'cleared_by' ),
		'grp_activity'      => array( 'id', 'member_id', 'date', 'at', 'kind', 'source', 'project_id', 'title', 'detail', 'qty', 'minutes', 'notes', 'ref_key' ),
		'grp_audit'         => array( 'id', 'kind', 'type', 'doc_id', 'project_id', 'title', 'detail', 'changes', 'by_member', 'by_role', 'at' ),
		'grp_trash'         => array( 'id', 'type', 'doc_id', 'data', 'title', 'project_id', 'deleted_at', 'deleted_by' ),
		'grp_dismissals'    => array( 'id', 'member_id', 'notice_key', 'at' ),
		'grp_settings'      => array( 'id', 'setting_key', 'value' ),
	);

	/**
	 * Uses real (not temporary) tables and starts from an uninstalled state.
	 */
	public function set_up() {
		parent::set_up();

		// WP_UnitTestCase rewrites CREATE/DROP TABLE into temporary tables, which SHOW TABLES cannot see.
		remove_filter( 'query', array( $this, '_create_temporary_tables' ) );
		remove_filter( 'query', array( $this, '_drop_temporary_tables' ) );

		$this->drop_tables();
		delete_option( GRP_Install::DB_VERSION_OPTION );
	}

	/**
	 * DDL commits implicitly, so clean up by hand.
	 */
	public function tear_down() {
		$this->drop_tables();
		delete_option( GRP_Install::DB_VERSION_OPTION );

		parent::tear_down();
	}

	/**
	 * Drops every plugin table.
	 */
	private function drop_tables() {
		global $wpdb;

		foreach ( GRP_Install::TABLES as $name ) {
			$wpdb->query( 'DROP TABLE IF EXISTS ' . GRP_Install::table( $name ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
		}
	}

	/**
	 * Whether the table exists in the database.
	 *
	 * @param string $name Unprefixed table name.
	 * @return bool
	 */
	private function table_exists( $name ) {
		global $wpdb;

		$table = GRP_Install::table( $name );

		return $table === $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Column names of a table.
	 *
	 * @param string $name Unprefixed table name.
	 * @return string[]
	 */
	private function columns( $name ) {
		global $wpdb;

		return $wpdb->get_col( 'DESCRIBE ' . GRP_Install::table( $name ), 0 ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
	}

	public function test_expected_table_list_matches_installer() {
		$this->assertSame( array_keys( self::EXPECTED_COLUMNS ), GRP_Install::TABLES );
	}

	public function test_activation_creates_all_tables() {
		foreach ( GRP_Install::TABLES as $name ) {
			$this->assertFalse( $this->table_exists( $name ), "$name should not exist before activation" );
		}

		GRP_Install::activate();

		foreach ( GRP_Install::TABLES as $name ) {
			$this->assertTrue( $this->table_exists( $name ), "$name should exist after activation" );
		}
	}

	public function test_activation_creates_spec_columns() {
		GRP_Install::activate();

		foreach ( self::EXPECTED_COLUMNS as $name => $expected ) {
			$columns = $this->columns( $name );
			foreach ( array_merge( $expected, array( 'created_at', 'updated_at' ) ) as $column ) {
				$this->assertContains( $column, $columns, "$name is missing column $column" );
			}
		}
	}

	public function test_activation_stores_schema_version() {
		$this->assertSame( 0, GRP_Install::installed_version() );

		GRP_Install::activate();

		$this->assertSame( GRP_Install::DB_VERSION, GRP_Install::installed_version() );
	}

	public function test_activation_is_idempotent_and_keeps_data() {
		global $wpdb;

		GRP_Install::activate();

		$table = GRP_Install::table( 'grp_projects' );
		$now   = gmdate( 'Y-m-d H:i:s' );
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$table,
			array(
				'id'         => 'p1',
				'name'       => 'Acme Plumbing',
				'created_at' => $now,
				'updated_at' => $now,
			)
		);

		GRP_Install::activate();

		$this->assertSame( '1', $wpdb->get_var( "SELECT COUNT(*) FROM $table" ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared,WordPress.DB.DirectDatabaseQuery
	}

	public function test_maybe_upgrade_installs_when_version_is_outdated() {
		update_option( GRP_Install::DB_VERSION_OPTION, GRP_Install::DB_VERSION - 1 );

		GRP_Install::maybe_upgrade();

		$this->assertTrue( $this->table_exists( 'grp_members' ) );
		$this->assertSame( GRP_Install::DB_VERSION, GRP_Install::installed_version() );
	}

	public function test_maybe_upgrade_does_nothing_when_current() {
		update_option( GRP_Install::DB_VERSION_OPTION, GRP_Install::DB_VERSION );

		GRP_Install::maybe_upgrade();

		$this->assertFalse( $this->table_exists( 'grp_members' ) );
	}

	public function test_activation_hook_is_registered() {
		$this->assertSame(
			10,
			has_action( 'activate_' . plugin_basename( GRP_PLUGIN_FILE ), array( 'GRP_Install', 'activate' ) )
		);
	}
}
