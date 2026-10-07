<?php
/**
 * REST: client requests on a project's Details tab (SPEC.md 6.15, designs DP-B and DP-G).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * What the team needs from a client (new GBP images, a missing Privacy Policy page…), each with a
 * status and a conversation thread where the client's answer, text or files, is kept. Everyone on
 * the team asks, changes the status and writes (locked while the profile is incomplete); whoever
 * added a request, or the Super Admin, deletes it. Both tables reach everyone through GET /sync.
 */
class GRP_REST_Client_Requests extends GRP_REST_Controller {

	const TABLE    = 'grp_client_requests';
	const MESSAGES = 'grp_request_messages';

	const KINDS    = array( 'images', 'info', 'page', 'access', 'other' );
	const STATUSES = array( 'needed', 'asked', 'received', 'done' );
	const VIAS     = array( 'email', 'whatsapp', 'phone', 'meeting', 'other' );

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/projects/(?P<id>[\w-]+)/client-requests', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/client-requests/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/client-requests/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'delete' );
		self::route( '/client-requests/(?P<id>[\w-]+)/messages', WP_REST_Server::CREATABLE, 'add_message' );
		self::route( '/request-messages/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'delete_message' );
	}

	/**
	 * 403 unless the actor may work on client requests.
	 *
	 * @return WP_Error|null
	 */
	private static function refuse() {
		return self::can( GRP_Permissions::CLIENT_REQUEST ) ? null : self::forbidden();
	}

	/**
	 * A "via" value, or null.
	 *
	 * @param mixed $value Raw value.
	 * @return string|null
	 */
	private static function via( $value ) {
		$value = sanitize_key( (string) $value );
		return in_array( $value, self::VIAS, true ) ? $value : null;
	}

	/**
	 * Request fields for a status change, plus the thread line that records it.
	 *
	 * @param array       $request Current request (empty when new).
	 * @param string      $status  New status.
	 * @param string|null $via     How the client was asked.
	 * @return array{0: array, 1: array} Fields, event message (empty when nothing changes).
	 */
	private static function status_change( array $request, $status, $via ) {
		if ( ( $request['status'] ?? '' ) === $status ) {
			return array( array(), array() );
		}
		$actor  = self::actor()['id'];
		$now    = GRP_Ids::now();
		$fields = array( 'status' => $status );
		if ( 'asked' === $status ) {
			$fields += array(
				'asked_at'  => $now,
				'asked_by'  => $actor,
				'asked_via' => $via,
			);
		}
		if ( 'done' === $status ) {
			$fields += array(
				'done_at' => $now,
				'done_by' => $actor,
			);
		} else {
			$fields += array(
				'done_at' => null,
				'done_by' => null,
			);
		}

		return array(
			$fields,
			array(
				'body'  => '',
				'event' => $status,
				'via'   => 'asked' === $status ? $via : null,
			),
		);
	}

	/**
	 * Adds a line to a request's thread.
	 *
	 * @param array $request Request row.
	 * @param array $message Fields: body, files, from_client, via, event.
	 * @return array
	 */
	private static function write( array $request, array $message ) {
		return GRP_Store::insert(
			self::MESSAGES,
			array(
				'request_id'  => $request['id'],
				'project_id'  => $request['project_id'],
				'body'        => $message['body'] ?? '',
				'files'       => $message['files'] ?? array(),
				'from_client' => empty( $message['from_client'] ) ? 0 : 1,
				'via'         => $message['via'] ?? null,
				'event'       => $message['event'] ?? null,
				'created_by'  => self::actor()['id'],
			)
		);
	}

	/**
	 * POST /projects/{id}/client-requests `{title, kind?, details?, status?: needed|asked, via?}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$title = self::text( $request['title'] ?? '', 191 );
		if ( '' === $title ) {
			return self::invalid( __( 'Say what you need from the client.', 'gridrankers-portal' ) );
		}
		$kind   = in_array( $request['kind'], self::KINDS, true ) ? $request['kind'] : 'other';
		$status = 'asked' === $request['status'] ? 'asked' : 'needed';

		$row = GRP_Store::transaction(
			static function () use ( $project, $title, $kind, $status, $request ) {
				$row = GRP_Store::insert(
					self::TABLE,
					array(
						'project_id' => $project['id'],
						'title'      => $title,
						'kind'       => $kind,
						'details'    => self::textarea( $request['details'] ?? '', 4000 ),
						'status'     => 'needed',
						'created_by' => self::actor()['id'],
					)
				);
				if ( 'asked' === $status ) {
					list( $fields, $event ) = self::status_change( $row, 'asked', self::via( $request['via'] ) );
					$row                    = GRP_Store::update( self::TABLE, $row['id'], $fields );
					$row['event_message']   = self::write( $row, $event );
				}
				return $row;
			}
		);

		$response = rest_ensure_response( $row );
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * PATCH /client-requests/{id} `{title?, kind?, details?, status?, via?}`. A status change adds a
	 * line to the thread ("Status → Asked client · by email"), returned as `event_message`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}

		$fields = array();
		$params = $request->get_json_params() ?? array();
		if ( array_key_exists( 'title', $params ) ) {
			$fields['title'] = self::text( $params['title'], 191 );
			if ( '' === $fields['title'] ) {
				return self::invalid( __( 'Say what you need from the client.', 'gridrankers-portal' ) );
			}
		}
		if ( array_key_exists( 'kind', $params ) ) {
			if ( ! in_array( $params['kind'], self::KINDS, true ) ) {
				return self::invalid( __( 'Unknown type.', 'gridrankers-portal' ) );
			}
			$fields['kind'] = $params['kind'];
		}
		if ( array_key_exists( 'details', $params ) ) {
			$fields['details'] = self::textarea( $params['details'], 4000 );
		}
		$event = array();
		if ( array_key_exists( 'status', $params ) ) {
			if ( ! in_array( $params['status'], self::STATUSES, true ) ) {
				return self::invalid( __( 'Unknown status.', 'gridrankers-portal' ) );
			}
			list( $change, $event ) = self::status_change( $row, $params['status'], self::via( $params['via'] ?? null ) );
			$fields                += $change;
		}
		if ( ! $fields ) {
			return rest_ensure_response( $row );
		}

		$row = GRP_Store::transaction(
			static function () use ( $row, $fields, $event ) {
				$row = GRP_Store::update( self::TABLE, $row['id'], $fields );
				if ( $event ) {
					$row['event_message'] = self::write( $row, $event );
				}
				return $row;
			}
		);

		return rest_ensure_response( $row );
	}

	/**
	 * DELETE /client-requests/{id}: the request and its thread. Whoever added it, or the Super Admin.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function delete( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_CLIENT_REQUEST, array( 'request' => $row ) ) ) {
			return self::forbidden( __( 'Only the person who added it, or the Super Admin, can delete a request.', 'gridrankers-portal' ) );
		}
		GRP_Store::transaction(
			static function () use ( $row ) {
				foreach ( GRP_Store::find( self::MESSAGES, array( 'request_id' => $row['id'] ) ) as $message ) {
					GRP_Store::delete( self::MESSAGES, $message['id'] );
				}
				GRP_Store::delete( self::TABLE, $row['id'] );
			}
		);

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $row['id'],
			)
		);
	}

	/**
	 * POST /client-requests/{id}/messages `{body, files?, from_client?, via?}`. What the client sent
	 * moves a Needed or Asked request to Received.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function add_message( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$denied = self::refuse();
		if ( $denied ) {
			return $denied;
		}
		$body  = self::textarea( $request['body'] ?? '', 4000 );
		$files = self::attached_files( $request['files'] ?? array() );
		if ( is_wp_error( $files ) ) {
			return $files;
		}
		if ( '' === $body && ! $files ) {
			return self::invalid( __( 'Write a message or attach a file.', 'gridrankers-portal' ) );
		}
		$from_client = rest_sanitize_boolean( $request['from_client'] ?? false );

		$event_message = null;
		$message       = GRP_Store::transaction(
			static function () use ( $row, $body, $files, $from_client, $request, &$event_message ) {
				$message = self::write(
					$row,
					array(
						'body'        => $body,
						'files'       => $files,
						'from_client' => $from_client,
						'via'         => $from_client ? self::via( $request['via'] ?? null ) : null,
					)
				);
				if ( $from_client && in_array( $row['status'], array( 'needed', 'asked' ), true ) ) {
					list( $fields, $event ) = self::status_change( $row, 'received', null );
					$row                    = GRP_Store::update( self::TABLE, $row['id'], $fields );
					$event_message          = self::write( $row, $event );
				} else {
					// Bumps the request so the list shows when it last changed.
					GRP_Store::update( self::TABLE, $row['id'], array() );
				}
				return $message;
			}
		);

		$response = rest_ensure_response(
			array(
				'message' => $message,
				'event'   => $event_message,
				'request' => GRP_Store::get( self::TABLE, $row['id'] ),
			)
		);
		$response->set_status( 201 );

		return $response;
	}

	/**
	 * DELETE /request-messages/{id}: the text and files go, the row stays as "deleted". Whoever wrote
	 * it, or the Super Admin; status lines can't be deleted.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function delete_message( WP_REST_Request $request ) {
		$message = GRP_Store::get( self::MESSAGES, $request['id'] );
		if ( ! $message || ! empty( $message['deleted_at'] ) || ! empty( $message['event'] ) ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::DELETE_COMMENT, array( 'comment' => $message ) ) ) {
			return self::forbidden( __( 'Only the person who wrote it can delete a message.', 'gridrankers-portal' ) );
		}

		return rest_ensure_response(
			GRP_Store::update(
				self::MESSAGES,
				$message['id'],
				array(
					'body'       => '',
					'files'      => array(),
					'deleted_at' => GRP_Ids::now(),
				)
			)
		);
	}
}
