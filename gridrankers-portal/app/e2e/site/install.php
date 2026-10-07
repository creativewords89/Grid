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
			// A complete required profile (SPEC.md 6.10), so task work is not locked.
			'location'   => 'Rangpur',
			'birthday'   => '01-15',
			'birth_year' => 1990,
			'phone'      => '+8801700000000',
			'photo'      => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
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
// New cycle setup (SPEC.md 6.11): "Cycle Co" started a new cycle today and existed last cycle;
// the rule began today, so only cycles starting today count.
$today = GRP_Cycles::today();
$long  = gmdate( 'Y-m-d H:i:s', strtotime( $today . ' -70 days' ) );
$cycle = GRP_Store::insert(
	'grp_projects',
	array(
		'name'       => 'Cycle Co',
		'state'      => 'active',
		'cycle_day'  => min( 28, (int) substr( $today, 8, 2 ) ),
		'cycle_set'  => 1,
		'created_at' => $long,
	)
);
$since = GRP_Cycles::cycle_range( $cycle, 0, $today )['start'];
foreach ( GRP_Store::find( 'grp_settings', array( 'setting_key' => GRP_Cycle_Setup::SINCE_KEY ) ) as $row ) {
	GRP_Store::update( 'grp_settings', $row['id'], array( 'value' => array( 'date' => $since ) ) );
}
$last = GRP_Cycles::cycle_range( $cycle, -1, $today )['key'];
foreach ( array( array( 'Cycle blogs', 2, 'tm_max' ), array( 'Cycle pages', 1, null ) ) as $t ) {
	$task = GRP_Store::insert(
		'grp_monthly_tasks',
		array(
			'project_id' => $cycle['id'],
			'title'      => $t[0],
			'target'     => $t[1],
			'assignees'  => $t[2] ? array( array( 'id' => $t[2], 'n' => $t[1] ) ) : array(),
			'created_at' => $long,
		)
	);
	if ( $t[2] ) {
		GRP_Store::insert(
			'grp_cycle_records',
			array(
				'id'         => $task['id'] . '__' . $last,
				'task_id'    => $task['id'],
				'project_id' => $cycle['id'],
				'period_key' => $last,
				'count'      => 1,
				'status'     => 'doing',
			)
		);
	}
}
// Client requests (SPEC.md 6.15): Nia asked Bright Dental for the website login 4 days ago, so it
// is time to chase the client.
$bright = GRP_Store::find( 'grp_projects', array( 'name' => 'Bright Dental' ) )[0];
$asked  = gmdate( 'Y-m-d H:i:s', strtotime( $today . ' -4 days 10:00' ) );
$login  = GRP_Store::insert(
	'grp_client_requests',
	array(
		'project_id' => $bright['id'],
		'title'      => 'Website login',
		'kind'       => 'access',
		'status'     => 'asked',
		'asked_via'  => 'email',
		'asked_at'   => $asked,
		'asked_by'   => 'tm_nia',
		'created_by' => 'tm_nia',
		'created_at' => $asked,
	)
);
GRP_Store::insert(
	'grp_request_messages',
	array(
		'request_id' => $login['id'],
		'project_id' => $bright['id'],
		'body'       => '',
		'event'      => 'asked',
		'via'        => 'email',
		'created_by' => 'tm_nia',
		'created_at' => $asked,
	)
);
echo "e2e site ready\n";
