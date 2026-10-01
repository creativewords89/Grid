<?php
/**
 * PHPUnit bootstrap: loads the WordPress test suite and the plugin.
 *
 * @package GridRankers_Portal
 */

// Composer autoloader also defines WP_PHPUNIT__DIR and loads the PHPUnit polyfills.
require_once dirname( __DIR__ ) . '/vendor/autoload.php';

if ( ! getenv( 'WP_PHPUNIT__TESTS_CONFIG' ) ) {
	putenv( // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_putenv -- wp-phpunit reads its config path from the environment.
		'WP_PHPUNIT__TESTS_CONFIG=' . __DIR__ . '/wp-tests-config.php'
	);
}

$grp_tests_dir = getenv( 'WP_PHPUNIT__DIR' );

require_once $grp_tests_dir . '/includes/functions.php';

// WP_UnitTestCase wraps each test in a transaction; GRP_Store must use savepoints inside it.
tests_add_filter( 'grp_use_savepoints', '__return_true' );

tests_add_filter(
	'muplugins_loaded',
	static function () {
		require dirname( __DIR__ ) . '/gridrankers-portal.php';
		// Admin screens load only in wp-admin; tests exercise them directly.
		require_once dirname( __DIR__ ) . '/admin/class-settings.php';
		require_once dirname( __DIR__ ) . '/admin/class-import-export.php';
	}
);

require $grp_tests_dir . '/includes/bootstrap.php';

// Real (non-temporary) plugin tables for every test; test-install.php drops and recreates them.
// The WordPress installer only resets core tables, so empty ours to start every run clean.
GRP_Install::install();
foreach ( GRP_Install::TABLES as $grp_table ) {
	$GLOBALS['wpdb']->query( 'TRUNCATE TABLE ' . GRP_Install::table( $grp_table ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery
}

require_once __DIR__ . '/class-grp-rest-testcase.php';
