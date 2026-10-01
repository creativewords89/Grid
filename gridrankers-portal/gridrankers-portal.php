<?php
/**
 * Plugin Name:       GridRankers Portal
 * Description:       Internal team portal for GridRankers: meeting tasks, recurring deliverables, reviews and reports.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            GridRankers
 * Text Domain:       gridrankers-portal
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

define( 'GRP_VERSION', '0.1.0' );
define( 'GRP_PLUGIN_FILE', __FILE__ );
define( 'GRP_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'GRP_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once GRP_PLUGIN_DIR . 'includes/class-install.php';

register_activation_hook( __FILE__, array( 'GRP_Install', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'GRP_Install', 'deactivate' ) );

// Run pending schema migrations after a plugin update (activation hooks do not fire on update).
add_action( 'plugins_loaded', array( 'GRP_Install', 'maybe_upgrade' ) );

if ( is_admin() ) {
	require_once GRP_PLUGIN_DIR . 'admin/class-settings.php';
	GRP_Admin_Settings::init();
}
