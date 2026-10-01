<?php
/**
 * REST: /posts — announcements and shout-outs (SPEC.md 6.10).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The Super Admin and Team Leaders post announcements (for everyone) and shout-outs
 * (praise for a Team Member, shown for 30 days). Removing is a soft delete.
 */
class GRP_REST_Posts extends GRP_REST_Controller {

	const TABLE = 'grp_posts';

	/**
	 * Shout-outs are shown for this many days.
	 */
	const SHOUTOUT_DAYS = 30;

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/posts', WP_REST_Server::READABLE, 'index' );
		self::route( '/posts', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/posts/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * GET /posts: active announcements (not past their date) and shout-outs of the last 30 days, newest first.
	 *
	 * @return WP_REST_Response
	 */
	public static function index() {
		$today = GRP_Cycles::today();
		$since = gmdate( 'Y-m-d H:i:s', time() - self::SHOUTOUT_DAYS * DAY_IN_SECONDS );
		$rows  = array_filter(
			GRP_Store::find( self::TABLE, array( 'deleted_at' => null ), array( 'order_by' => 'created_at' ) ),
			static function ( $row ) use ( $today, $since ) {
				return 'shoutout' === $row['kind']
					? $row['created_at'] >= $since
					: ( empty( $row['show_until'] ) || $row['show_until'] >= $today );
			}
		);

		return rest_ensure_response( array_values( array_reverse( $rows ) ) );
	}

	/**
	 * POST /posts `{kind: announcement, title, body, pinned?, show_until?}` or `{kind: shoutout, to, body}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$kind = 'shoutout' === $request['kind'] ? 'shoutout' : 'announcement';
		$body = self::textarea( $request['body'] ?? '', 2000 );
		$row  = array(
			'kind'       => $kind,
			'body'       => $body,
			'created_by' => self::actor()['id'],
		);

		if ( 'shoutout' === $kind ) {
			$to = GRP_Store::get( 'grp_members', (string) ( $request['to'] ?? '' ) );
			if ( ! self::is_manager() ) {
				return self::forbidden( __( 'Only a Team Leader or the Super Admin can send shout-outs.', 'gridrankers-portal' ) );
			}
			if ( ! $to || ! (int) $to['active'] ) {
				return self::invalid( __( 'Pick who the shout-out is for.', 'gridrankers-portal' ) );
			}
			$context = array(
				'kind'    => $kind,
				'to_role' => GRP_Permissions::effective_role( $to ),
			);
			if ( ! self::can( GRP_Permissions::MANAGE_POST, $context ) ) {
				return self::forbidden( __( 'Shout-outs are for Team Members.', 'gridrankers-portal' ) );
			}
			$row['to_member'] = $to['id'];
		} else {
			if ( ! self::can( GRP_Permissions::MANAGE_POST, array( 'kind' => $kind ) ) ) {
				return self::forbidden( __( 'Only a Team Leader or the Super Admin can post announcements.', 'gridrankers-portal' ) );
			}
			$row['title'] = self::text( $request['title'] ?? '', 191 );
			if ( '' === $row['title'] ) {
				return self::invalid( __( 'Give the announcement a title.', 'gridrankers-portal' ) );
			}
			$until = self::date( $request['show_until'] ?? '', 'date' );
			if ( is_wp_error( $until ) ) {
				return $until;
			}
			if ( $until && $until < GRP_Cycles::today() ) {
				return self::invalid( __( 'The “show until” date has already passed.', 'gridrankers-portal' ) );
			}
			$row['show_until'] = $until;
			$row['pinned']     = ! empty( $request['pinned'] ) ? 1 : 0;
		}
		if ( '' === $body ) {
			return self::invalid( __( 'Write a message.', 'gridrankers-portal' ) );
		}

		$saved = GRP_Store::transaction(
			static function () use ( $row ) {
				$saved = GRP_Store::insert( self::TABLE, $row );
				GRP_Activity::audit( 'add', 'posts', self::audit_doc( $saved ), self::actor(), 'shoutout' === $saved['kind'] ? 'Shout-out' : 'Announcement' );
				return $saved;
			}
		);

		return new WP_REST_Response( $saved, 201 );
	}

	/**
	 * DELETE /posts/{id}: the author, or the Super Admin for any post.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$post = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $post || $post['deleted_at'] ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_POST, array( 'created_by' => $post['created_by'] ) ) ) {
			return self::forbidden( __( 'Only its author or the Super Admin can remove this.', 'gridrankers-portal' ) );
		}

		$updated = GRP_Store::transaction(
			static function () use ( $post ) {
				$updated = GRP_Store::update( self::TABLE, $post['id'], array( 'deleted_at' => GRP_Ids::now() ) );
				GRP_Activity::audit( 'delete', 'posts', self::audit_doc( $post ), self::actor(), 'shoutout' === $post['kind'] ? 'Shout-out' : 'Announcement' );
				return $updated;
			}
		);

		return rest_ensure_response( $updated );
	}

	/**
	 * Audit document.
	 *
	 * @param array $post Post row.
	 * @return array
	 */
	private static function audit_doc( array $post ) {
		return array(
			'id'    => $post['id'],
			'title' => 'shoutout' === $post['kind'] ? self::name_of( $post['to_member'] ) : (string) $post['title'],
		);
	}
}
