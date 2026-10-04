<?php
/**
 * Plugin Name:       GridRankers Portal
 * Description:       Internal team portal for GridRankers: meeting tasks, recurring deliverables, reviews and reports.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            GridRankers
 * Update URI:        https://github.com/creativewords89/Grid
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
require_once GRP_PLUGIN_DIR . 'includes/class-ids.php';
require_once GRP_PLUGIN_DIR . 'includes/class-permissions.php';
require_once GRP_PLUGIN_DIR . 'includes/class-cycles.php';
require_once GRP_PLUGIN_DIR . 'includes/class-people.php';
require_once GRP_PLUGIN_DIR . 'includes/class-weather.php';
require_once GRP_PLUGIN_DIR . 'includes/class-auth.php';
require_once GRP_PLUGIN_DIR . 'includes/class-store.php';
require_once GRP_PLUGIN_DIR . 'includes/class-activity.php';
require_once GRP_PLUGIN_DIR . 'includes/class-undo.php';
require_once GRP_PLUGIN_DIR . 'includes/class-files.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-auth.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-controller.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-projects.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-meeting-tasks.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-monthly-tasks.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-records.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-review.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-activity.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-audit.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-trash.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-members.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-notifications.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-people.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-leave.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-posts.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-plan.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-files.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-comments.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-sync.php';
require_once GRP_PLUGIN_DIR . 'includes/class-import.php';
require_once GRP_PLUGIN_DIR . 'includes/class-export.php';
require_once GRP_PLUGIN_DIR . 'includes/class-rest-data.php';
require_once GRP_PLUGIN_DIR . 'includes/class-frontend.php';
require_once GRP_PLUGIN_DIR . 'includes/class-standard-tasks.php';
require_once GRP_PLUGIN_DIR . 'includes/class-cycle-setup.php';
require_once GRP_PLUGIN_DIR . 'includes/class-cron.php';
require_once GRP_PLUGIN_DIR . 'includes/class-updater.php';

register_activation_hook( __FILE__, array( 'GRP_Install', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'GRP_Install', 'deactivate' ) );

// Run pending schema migrations after a plugin update (activation hooks do not fire on update).
add_action( 'plugins_loaded', array( 'GRP_Install', 'maybe_upgrade' ) );

GRP_REST_Auth::init();
GRP_REST_Projects::init();
GRP_REST_Meeting_Tasks::init();
GRP_REST_Monthly_Tasks::init();
GRP_REST_Records::init();
GRP_REST_Review::init();
GRP_REST_Activity::init();
GRP_REST_Audit::init();
GRP_REST_Trash::init();
GRP_REST_Members::init();
GRP_REST_Notifications::init();
GRP_REST_People::init();
GRP_REST_Leave::init();
GRP_REST_Posts::init();
GRP_REST_Plan::init();
GRP_REST_Files::init();
GRP_REST_Comments::init();
GRP_REST_Sync::init();
GRP_REST_Data::init();
GRP_Frontend::init();
GRP_Cron::init();
GRP_Updater::init();

if ( is_admin() ) {
	require_once GRP_PLUGIN_DIR . 'admin/class-settings.php';
	require_once GRP_PLUGIN_DIR . 'admin/class-import-export.php';
	GRP_Admin_Settings::init();
	GRP_Admin_Import_Export::init();
}
