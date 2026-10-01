<?php
/**
 * REST: /notifications.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Per-person dismissed notifications (SPEC.md 6.9).
 */
class GRP_REST_Notifications extends GRP_REST_Controller {

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/notifications/dismiss', WP_REST_Server::CREATABLE, 'dismiss' );
	}

	/**
	 * POST /notifications/dismiss `{key}`: dismisses (or re-dismisses) a notification for the actor.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function dismiss( WP_REST_Request $request ) {
		$key = self::text( $request['key'], 191 );
		if ( '' === $key ) {
			return self::invalid( __( 'Missing notification key.', 'gridrankers-portal' ) );
		}

		$member_id = self::actor()['id'];
		$existing  = GRP_Store::find(
			'grp_dismissals',
			array(
				'member_id'  => $member_id,
				'notice_key' => $key,
			)
		);

		$row = $existing
			? GRP_Store::update( 'grp_dismissals', $existing[0]['id'], array( 'at' => GRP_Ids::now() ) )
			: GRP_Store::insert(
				'grp_dismissals',
				array(
					'member_id'  => $member_id,
					'notice_key' => $key,
					'at'         => GRP_Ids::now(),
				)
			);

		return rest_ensure_response( $row );
	}
}
