<?php
/**
 * REST: /activity.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Completed and logged work (SPEC.md 6.7). Members see and log their own; managers anyone's.
 */
class GRP_REST_Activity extends GRP_REST_Controller {

	const TABLE = 'grp_activity';

	const PER_PAGE = 500;

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/activity', WP_REST_Server::READABLE, 'index' );
		self::route( '/activity', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/activity/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
	}

	/**
	 * GET /activity `?member=&from=&to=&page=`. Newest first.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function index( WP_REST_Request $request ) {
		$member = (string) ( $request['member'] ?? '' );
		if ( ! self::is_manager() ) {
			if ( '' !== $member && self::actor()['id'] !== $member ) {
				return self::forbidden( __( 'You can only see your own work.', 'gridrankers-portal' ) );
			}
			$member = self::actor()['id'];
		}

		$where = array();
		if ( '' !== $member ) {
			$where['member_id'] = $member;
		}
		foreach ( array(
			'from' => 'date >=',
			'to'   => 'date <=',
		) as $param => $condition ) {
			$date = self::date( $request[ $param ] ?? '', $param );
			if ( is_wp_error( $date ) ) {
				return $date;
			}
			if ( $date ) {
				$where[ $condition ] = $date;
			}
		}

		return rest_ensure_response(
			GRP_Store::find(
				self::TABLE,
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

	/**
	 * POST /activity `{member_id?, project_id?, date?, minutes?, title?, notes?, qty?}`: "Log work".
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$member_id = (string) ( $request['member_id'] ?? '' );
		$member_id = '' !== $member_id ? $member_id : self::actor()['id'];

		if ( ! self::can( GRP_Permissions::LOG_WORK, array( 'member_id' => $member_id ) ) ) {
			return self::forbidden( __( 'You can only log your own work.', 'gridrankers-portal' ) );
		}
		if ( ! self::active_members( array( $member_id ) ) ) {
			return self::invalid( __( 'That person is no longer on the team.', 'gridrankers-portal' ) );
		}

		$project = null;
		if ( ! empty( $request['project_id'] ) ) {
			$project = GRP_Store::get( 'grp_projects', (string) $request['project_id'] );
			if ( ! $project ) {
				return self::invalid( __( 'Pick a project or Other work.', 'gridrankers-portal' ) );
			}
		}

		$date = self::date( $request['date'] ?? '', 'date' );
		if ( is_wp_error( $date ) ) {
			return $date;
		}

		$title = self::text( $request['title'] ?? '', 200 );
		$row   = array(
			'member_id'  => $member_id,
			'date'       => $date ? $date : GRP_Cycles::today(),
			'at'         => GRP_Ids::now(),
			'kind'       => 'manual',
			'source'     => 'manual',
			'project_id' => $project ? $project['id'] : null,
			'title'      => '' !== $title ? $title : ( $project ? $project['name'] : 'Other work' ),
			'detail'     => '',
			'qty'        => self::int( $request['qty'] ?? 1, 1, 999, 1 ),
			'minutes'    => isset( $request['minutes'] ) && '' !== $request['minutes'] ? self::int( $request['minutes'], 0, 1440, 0 ) : null,
			'notes'      => self::textarea( $request['notes'] ?? '', 2000 ),
		);

		return new WP_REST_Response( GRP_Store::insert( self::TABLE, $row ), 201 );
	}

	/**
	 * DELETE /activity/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_ACTIVITY, $row ) ) {
			return self::forbidden();
		}

		GRP_Store::delete( self::TABLE, $row['id'] );

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $row['id'],
			)
		);
	}
}
