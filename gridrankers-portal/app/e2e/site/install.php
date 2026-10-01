<?php
/**
 * Installs WordPress, activates the plugin and seeds the e2e team and projects.
 *
 * @package GridRankers_Portal
 */

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- CLI script.

define( 'WP_INSTALLING', true );
$_SERVER['HTTP_HOST'] = 'localhost';
require getenv( 'E2E_DIR' ) . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

wp_install( 'GridRankers', 'owner', 'GridRankers@gmail.com', false, '', 'owner-pass-123' );
$result = activate_plugin( 'gridrankers-portal/gridrankers-portal.php' );
if ( is_wp_error( $result ) ) {
	fwrite( STDERR, $result->get_error_message() . "\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
	exit( 1 );
}

$owner = get_user_by( 'login', 'owner' );
$team  = array(
	array( 'tm_owner', 'Grid Owner', 'admin', $owner->ID, null ),
	array( 'tm_lee', 'Lee Lead', 'lead', null, 'LEADCODE1' ),
	array( 'tm_max', 'Max Member', 'member', null, 'MAXCODE11' ),
	array( 'tm_nia', 'Nia Member', 'member', null, 'NIACODE11' ),
);
foreach ( $team as $m ) {
	GRP_Store::insert(
		'grp_members',
		array(
			'id'         => $m[0],
			'name'       => $m[1],
			'role'       => $m[2],
			'wp_user_id' => $m[3],
			'active'     => 1,
		)
	);
	if ( $m[4] ) {
		GRP_Auth::set_code( $m[0], $m[4] );
	}
}
foreach ( array( array( 'Acme Plumbing', 'active' ), array( 'Bright Dental', 'active' ) ) as $p ) {
	$project = GRP_Store::insert(
		'grp_projects',
		array(
			'name'      => $p[0],
			'state'     => $p[1],
			'cycle_day' => 1,
			'cycle_set' => 1,
		)
	);
	GRP_Standard_Tasks::ensure( $project, GRP_Cycles::today() );
}
echo "e2e site ready\n";
