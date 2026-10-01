<?php
/**
 * REST: /export and /import.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Export / import all data (Super Admin only; SPEC.md sections 8 and 10).
 */
class GRP_REST_Data extends GRP_REST_Controller {

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/export', WP_REST_Server::READABLE, 'export' );
		self::route( '/import', WP_REST_Server::CREATABLE, 'import' );
	}

	/**
	 * GET /export.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function export() {
		if ( ! self::can( GRP_Permissions::EXPORT_DATA ) ) {
			return self::forbidden( __( 'Only the Super Admin can export the data.', 'gridrankers-portal' ) );
		}

		$response = rest_ensure_response( GRP_Export::build( self::actor() ) );
		$response->header( 'Cache-Control', 'no-store' );
		$response->header( 'Content-Disposition', 'attachment; filename="gridrankers-portal-export-' . GRP_Cycles::today() . '.json"' );

		return $response;
	}

	/**
	 * POST /import (`?dry_run=1` to only count). Body: the export JSON.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function import( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::IMPORT_DATA ) ) {
			return self::forbidden( __( 'Only the Super Admin can import data.', 'gridrankers-portal' ) );
		}

		$export = $request->get_json_params();
		if ( is_array( $export ) && isset( $export['export'] ) && is_array( $export['export'] ) ) {
			$export = $export['export'];
		}

		$summary = GRP_Import::run( $export, (bool) $request->get_param( 'dry_run' ) );
		if ( is_wp_error( $summary ) ) {
			return $summary;
		}
		if ( ! $summary['dry_run'] ) {
			GRP_Activity::audit( 'import', 'team', array( 'title' => 'Data import' ), self::actor(), self::summary_line( $summary ) );
		}

		return rest_ensure_response( $summary );
	}

	/**
	 * One-line summary: "12 projects, 340 tasks…".
	 *
	 * @param array $summary Import summary.
	 * @return string
	 */
	public static function summary_line( array $summary ) {
		$parts = array();
		foreach ( $summary['counts'] as $collection => $c ) {
			$n = $c['inserted'] + $c['updated'];
			if ( $n ) {
				$parts[] = "$n $collection";
			}
		}

		return $parts ? 'imported ' . implode( ', ', $parts ) : 'nothing imported';
	}
}
