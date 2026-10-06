<?php
/**
 * REST: /audit.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Recent Activities: the audit log, newest first.
 */
class GRP_REST_Audit extends GRP_REST_Controller {

	const PER_PAGE = 300;

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/audit', WP_REST_Server::READABLE, 'index' );
	}

	/**
	 * GET /audit `?project=&general=&from=&to=&page=` (dates inclusive, UTC); `general=1`: the
	 * General tasks' changes (no project, SPEC.md 6.13).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index( WP_REST_Request $request ) {
		$where = array();
		if ( ! empty( $request['project'] ) ) {
			$where['project_id'] = (string) $request['project'];
		} elseif ( rest_sanitize_boolean( $request['general'] ?? false ) ) {
			$where['project_id'] = GRP_REST_Meeting_Tasks::GENERAL;
			$where['type']       = 'items';
		}

		$from = self::date( $request['from'] ?? '', 'from date' );
		$to   = self::date( $request['to'] ?? '', 'to date' );
		if ( is_wp_error( $from ) ) {
			return $from;
		}
		if ( is_wp_error( $to ) ) {
			return $to;
		}
		if ( $from ) {
			$where['at >='] = $from . ' 00:00:00';
		}
		if ( $to ) {
			$where['at <='] = $to . ' 23:59:59';
		}

		return rest_ensure_response(
			GRP_Store::find(
				'grp_audit',
				$where,
				array(
					'order_by' => 'at',
					'order'    => 'DESC',
					'limit'    => self::PER_PAGE,
					'offset'   => self::PER_PAGE * max( 0, (int) $request['page'] ),
				)
			)
		);
	}
}
