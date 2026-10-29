<?php
/**
 * REST: /devices — a person's signed-in desktop trackers.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * See and revoke desktop tracker sign-ins (SPEC.md 6.21).
 */
class GRP_REST_Devices extends GRP_REST_Controller {

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/devices', WP_REST_Server::READABLE, 'index' );
		self::route( '/devices/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * GET /devices?member=: a person's signed-in devices (the actor's own by default).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index( WP_REST_Request $request ) {
		$id     = (string) ( $request['member'] ?? '' );
		$member = '' === $id ? self::actor() : GRP_Store::get( 'grp_members', $id );
		if ( ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_DEVICES, self::owner( $member ) ) ) {
			return self::forbidden();
		}

		return rest_ensure_response( GRP_Auth::devices( (string) $member['id'] ) );
	}

	/**
	 * DELETE /devices/{id}: Revoke — that computer's tracker is signed out at once; time it hasn't
	 * sent yet stays on the computer and uploads after the next sign-in.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$device = GRP_Store::get( 'grp_devices', (string) $request['id'] );
		$member = $device ? GRP_Store::get( 'grp_members', (string) $device['member_id'] ) : null;
		if ( ! $device || ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_DEVICES, self::owner( $member ) ) ) {
			return self::forbidden();
		}

		if ( empty( $device['revoked_at'] ) ) {
			GRP_Store::transaction(
				static function () use ( $device, $member ) {
					GRP_Auth::revoke_device( $device['id'] );
					/* translators: %s: device name. */
					GRP_Activity::audit( 'edit', 'team', $member, self::actor(), sprintf( __( 'desktop tracker signed out: %s', 'gridrankers-portal' ), '' !== $device['name'] ? $device['name'] : $device['platform'] ) );
				}
			);
		}

		return rest_ensure_response( array( 'revoked' => true ) );
	}

	/**
	 * Permission context of a device's owner.
	 *
	 * @param array $member Owner.
	 * @return array `{member_id, role}`.
	 */
	private static function owner( array $member ) {
		return array(
			'member_id' => (string) $member['id'],
			'role'      => GRP_Permissions::effective_role( $member ),
		);
	}
}
