<?php
/**
 * REST: comments on a task's submission (SPEC.md 6.6, design SF-B).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * POST /comments `{kind: item|record, id, body, files?}` and DELETE /comments/{id}. Comments reach
 * everyone through GET /sync (`comments`).
 */
class GRP_REST_Comments extends GRP_REST_Controller {

	const TABLE = 'grp_comments';

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/comments', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/comments/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'delete' );
	}

	/**
	 * POST /comments.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$kind = (string) $request['kind'];
		$id   = (string) $request['id'];
		if ( 'item' === $kind ) {
			$row  = GRP_Store::get( 'grp_meeting_tasks', $id );
			$task = $row;
		} elseif ( 'record' === $kind ) {
			$row  = GRP_Store::get( 'grp_cycle_records', $id );
			$task = $row ? GRP_Store::get( 'grp_monthly_tasks', $row['task_id'] ) : null;
		} else {
			return self::invalid( __( 'Invalid comment kind.', 'gridrankers-portal' ) );
		}
		if ( ! $row || ! $task ) {
			return self::not_found();
		}
		if ( ! self::can(
			GRP_Permissions::COMMENT,
			array(
				'task'       => $task,
				'completion' => $row['completion'] ?? null,
				'review'     => $row['review'] ?? null,
			)
		) ) {
			return self::forbidden( __( 'Only the people on this task, its reviewer, Team Leaders and the Super Admin can comment.', 'gridrankers-portal' ) );
		}

		$body  = self::textarea( $request['body'] ?? '', 2000 );
		$files = self::attached_files( $request['files'] ?? array() );
		if ( is_wp_error( $files ) ) {
			return $files;
		}
		if ( '' === $body && ! $files ) {
			return self::invalid( __( 'Write a comment or attach a file.', 'gridrankers-portal' ) );
		}

		$comment = GRP_Store::insert(
			self::TABLE,
			array(
				'ref_kind'   => $kind,
				'ref_id'     => $row['id'],
				'project_id' => $row['project_id'],
				'body'       => $body,
				'files'      => $files,
				'created_by' => self::actor()['id'],
			)
		);

		$response = rest_ensure_response( $comment );
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * DELETE /comments/{id}: the text and files go; the row stays as "deleted" so everyone's copy
	 * updates on the next sync.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function delete( WP_REST_Request $request ) {
		$comment = GRP_Store::get( self::TABLE, (string) $request['id'] );
		if ( ! $comment || ! empty( $comment['deleted_at'] ) ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_COMMENT, array( 'comment' => $comment ) ) ) {
			return self::forbidden( __( 'Only the person who wrote it can delete a comment.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response(
			GRP_Store::update(
				self::TABLE,
				$comment['id'],
				array(
					'body'       => '',
					'files'      => array(),
					'deleted_at' => GRP_Ids::now(),
				)
			)
		);
	}
}
