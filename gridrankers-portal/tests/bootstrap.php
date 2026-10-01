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

tests_add_filter(
	'muplugins_loaded',
	static function () {
		require dirname( __DIR__ ) . '/gridrankers-portal.php';
	}
);

require $grp_tests_dir . '/includes/bootstrap.php';
