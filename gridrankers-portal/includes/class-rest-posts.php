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
	 * Audit text per kind.
	 */
	const KIND_TEXT = array(
		'announcement' => 'Notice to everyone',
		'notice'       => 'Notice',
		'shoutout'     => 'Shout-out',
	);

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/posts', WP_REST_Server::READABLE, 'index' );
		self::route( '/posts', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/posts/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * GET /posts: current notices the viewer may see (not past their date) and shout-outs of the last 30 days, newest first.
	 *
	 * @return WP_REST_Response
	 */
	public static function index() {
		$today = GRP_Cycles::today();
		$since = gmdate( 'Y-m-d H:i:s', time() - self::SHOUTOUT_DAYS * DAY_IN_SECONDS );
		$actor = self::actor();
		$rows  = array_filter(
			GRP_Store::find( self::TABLE, array( 'deleted_at' => null ), array( 'order_by' => 'created_at' ) ),
			static function ( $row ) use ( $today, $since, $actor ) {
				$current = 'shoutout' === $row['kind']
					? $row['created_at'] >= $since && ( empty( $row['show_until'] ) || $row['show_until'] >= $today )
					: ( empty( $row['show_until'] ) || $row['show_until'] >= $today );
				return $current && self::visible_to( $row, $actor );
			}
		);

		return rest_ensure_response( array_values( array_reverse( $rows ) ) );
	}

	/**
	 * POST /posts (SPEC.md 6.10): `{kind: announcement, title?, body, show_until?, pinned?}` for
	 * everyone; `{kind: notice, to: [ids], title?, body, show_until?}` for chosen people (private);
	 * `{kind: shoutout, to: [ids] | id, body}` for chosen Team Members.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$kind = in_array( $request['kind'], array( 'shoutout', 'notice' ), true ) ? (string) $request['kind'] : 'announcement';
		if ( ! self::can( GRP_Permissions::MANAGE_POST, array( 'kind' => 'announcement' ) ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can send notices.', 'gridrankers-portal' ) );
		}
		$body = self::textarea( $request['body'] ?? '', 2000 );
		$row  = array(
			'kind'       => $kind,
			'title'      => self::text( $request['title'] ?? '', 191 ),
			'body'       => $body,
			'created_by' => self::actor()['id'],
			'pinned'     => 'announcement' === $kind && ! empty( $request['pinned'] ) ? 1 : 0,
		);
		if ( '' === $row['title'] ) {
			$row['title'] = null;
		}

		if ( 'announcement' !== $kind ) {
			$ids = array_values( array_unique( array_filter( array_map( 'strval', (array) ( $request['to'] ?? array() ) ) ) ) );
			$to  = self::active_members( $ids );
			if ( ! $ids || count( $to ) !== count( $ids ) ) {
				return self::invalid( __( 'Pick who it is for.', 'gridrankers-portal' ) );
			}
			foreach ( $to as $person ) {
				$context = array(
					'kind'    => $kind,
					'to_role' => GRP_Permissions::effective_role( $person ),
				);
				if ( ! self::can( GRP_Permissions::MANAGE_POST, $context ) ) {
					return self::forbidden( __( 'Shout-outs are for Team Members.', 'gridrankers-portal' ) );
				}
			}
			$row['to_members'] = $ids;
			$row['to_member']  = 1 === count( $ids ) ? $ids[0] : null;
		}

		$until = self::date( $request['show_until'] ?? '', 'date' );
		if ( is_wp_error( $until ) ) {
			return $until;
		}
		if ( $until && $until < GRP_Cycles::today() ) {
			return self::invalid( __( 'The “show until” date has already passed.', 'gridrankers-portal' ) );
		}
		$row['show_until'] = $until;
		if ( '' === $body ) {
			return self::invalid( __( 'Write a message.', 'gridrankers-portal' ) );
		}

		$saved = GRP_Store::transaction(
			static function () use ( $row ) {
				$saved = GRP_Store::insert( self::TABLE, $row );
				GRP_Activity::audit( 'add', 'posts', self::audit_doc( $saved ), self::actor(), self::KIND_TEXT[ $saved['kind'] ] );
				return $saved;
			}
		);

		return new WP_REST_Response( $saved, 201 );
	}

	/**
	 * Recipients of a post: its people, or null for everyone.
	 *
	 * @param array $post Post row.
	 * @return string[]|null
	 */
	public static function recipients( array $post ) {
		if ( is_array( $post['to_members'] ?? null ) ) {
			return array_map( 'strval', $post['to_members'] );
		}

		return empty( $post['to_member'] ) ? null : array( (string) $post['to_member'] );
	}

	/**
	 * Whether a viewer may receive a post: a notice to chosen people is private to them,
	 * its author and the Super Admin; everything else is for everyone.
	 *
	 * @param array $post   Post row.
	 * @param array $viewer Member.
	 * @return bool
	 */
	public static function visible_to( array $post, array $viewer ) {
		if ( 'notice' !== $post['kind'] || GRP_Permissions::ROLE_ADMIN === GRP_Permissions::effective_role( $viewer ) ) {
			return true;
		}

		return (string) $post['created_by'] === (string) $viewer['id'] || in_array( (string) $viewer['id'], (array) self::recipients( $post ), true );
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
				GRP_Activity::audit( 'delete', 'posts', self::audit_doc( $post ), self::actor(), self::KIND_TEXT[ $post['kind'] ] ?? 'Notice' );
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
		$to = self::recipients( $post );
		return array(
			'id'    => $post['id'],
			'title' => $post['title'] ? (string) $post['title'] : ( null === $to ? 'Everyone' : implode( ', ', array_map( array( __CLASS__, 'name_of' ), $to ) ) ),
		);
	}
}
