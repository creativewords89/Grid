<?php
/**
 * REST: a project's Details tab and keyword checklist (SPEC.md 6.12).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Details: descriptions with links (Team Leaders and the Super Admin edit, everyone reads).
 * Keyword checklist: one row per keyword with tick boxes, a note and a deadline. Team Leaders
 * and the Super Admin manage keywords, deadlines and the columns; everyone ticks and writes notes.
 */
class GRP_REST_Plan extends GRP_REST_Controller {

	const TABLE = 'grp_keywords';

	/**
	 * Checklist columns of a project that has not set its own.
	 */
	const DEFAULT_COLUMNS = array(
		array(
			'id'   => 'c1',
			'name' => 'On-page',
		),
		array(
			'id'   => 'c2',
			'name' => 'Content',
		),
		array(
			'id'   => 'c3',
			'name' => 'Internal links',
		),
		array(
			'id'   => 'c4',
			'name' => 'Backlinks',
		),
	);

	/**
	 * Link kinds shown as chips.
	 */
	const LINK_KINDS = array( 'sheet', 'doc', 'drive', 'other' );

	const MAX_SECTIONS = 12;
	const MAX_LINKS    = 30;
	const MAX_COLUMNS  = 8;
	const MAX_ADD      = 200;

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/projects/(?P<id>[\w-]+)/details', 'PUT', 'save_details' );
		self::route( '/projects/(?P<id>[\w-]+)/keyword-columns', 'PUT', 'save_columns' );
		self::route( '/projects/(?P<id>[\w-]+)/keywords', WP_REST_Server::CREATABLE, 'add_keywords' );
		self::route( '/keywords/(?P<id>[\w-]+)', 'PATCH', 'update_keyword' );
		self::route( '/keywords/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'delete_keyword' );
	}

	/**
	 * The link kind from its address: Google Sheets, Docs, Drive, or other.
	 *
	 * @param string $url URL.
	 * @return string
	 */
	public static function link_kind( $url ) {
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		$path = (string) wp_parse_url( $url, PHP_URL_PATH );
		if ( 'docs.google.com' === $host ) {
			if ( 0 === strpos( $path, '/spreadsheets' ) ) {
				return 'sheet';
			}
			if ( 0 === strpos( $path, '/document' ) ) {
				return 'doc';
			}
		}
		if ( 'drive.google.com' === $host ) {
			return 'drive';
		}

		return 'other';
	}

	/**
	 * PUT /projects/{id}/details `{sections: [{id?, title, text, links: [{id?, title, url, kind?}]}]}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save_details( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::EDIT_PROJECT_DETAILS ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can edit the project details.', 'gridrankers-portal' ) );
		}
		$raw = $request['sections'];
		if ( ! is_array( $raw ) ) {
			return self::invalid( __( 'Send the sections.', 'gridrankers-portal' ) );
		}
		if ( count( $raw ) > self::MAX_SECTIONS ) {
			/* translators: %d: maximum number of sections. */
			return self::invalid( sprintf( __( 'Up to %d sections.', 'gridrankers-portal' ), self::MAX_SECTIONS ) );
		}

		$sections = array();
		foreach ( array_values( $raw ) as $sec ) {
			$sec   = is_array( $sec ) ? $sec : array();
			$title = self::text( $sec['title'] ?? '', 80 );
			if ( '' === $title ) {
				return self::invalid( __( 'Give every section a title.', 'gridrankers-portal' ) );
			}
			$links     = array();
			$raw_links = is_array( $sec['links'] ?? null ) ? array_values( $sec['links'] ) : array();
			if ( count( $raw_links ) > self::MAX_LINKS ) {
				/* translators: %d: maximum number of links. */
				return self::invalid( sprintf( __( 'Up to %d links in a section.', 'gridrankers-portal' ), self::MAX_LINKS ) );
			}
			foreach ( $raw_links as $link ) {
				$link = is_array( $link ) ? $link : array();
				$url  = self::url( $link['url'] ?? '' );
				if ( is_wp_error( $url ) ) {
					return $url;
				}
				if ( '' === $url ) {
					return self::invalid( __( 'Paste the link.', 'gridrankers-portal' ) );
				}
				$name    = self::text( $link['title'] ?? '', 80 );
				$kind    = in_array( $link['kind'] ?? '', self::LINK_KINDS, true ) ? $link['kind'] : self::link_kind( $url );
				$links[] = array(
					'id'    => self::item_id( $link['id'] ?? '' ),
					'title' => '' !== $name ? $name : (string) wp_parse_url( $url, PHP_URL_HOST ),
					'url'   => $url,
					'kind'  => $kind,
				);
			}
			$sections[] = array(
				'id'    => self::item_id( $sec['id'] ?? '' ),
				'title' => $title,
				'text'  => self::textarea( $sec['text'] ?? '', 5000 ),
				'links' => $links,
			);
		}

		$updated = GRP_Store::transaction(
			static function () use ( $project, $sections ) {
				$updated = GRP_Store::update( 'grp_projects', $project['id'], array( 'details' => array( 'sections' => $sections ) ) );
				GRP_Activity::audit( 'edit', 'client', $updated, self::actor(), 'details edited' );
				return $updated;
			}
		);

		return rest_ensure_response( $updated );
	}

	/**
	 * PUT /projects/{id}/keyword-columns `{columns: [{id?, name}]}`. Ticks of a removed column are kept
	 * but not shown.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save_columns( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_KEYWORDS ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can change the columns.', 'gridrankers-portal' ) );
		}
		$raw = is_array( $request['columns'] ) ? array_values( $request['columns'] ) : array();
		if ( ! $raw || count( $raw ) > self::MAX_COLUMNS ) {
			/* translators: %d: maximum number of columns. */
			return self::invalid( sprintf( __( 'Keep 1 to %d columns.', 'gridrankers-portal' ), self::MAX_COLUMNS ) );
		}
		$columns = array();
		$seen    = array();
		foreach ( $raw as $col ) {
			$col  = is_array( $col ) ? $col : array();
			$name = self::text( $col['name'] ?? '', 40 );
			if ( '' === $name ) {
				return self::invalid( __( 'Give every column a name.', 'gridrankers-portal' ) );
			}
			$id = self::item_id( $col['id'] ?? '' );
			if ( isset( $seen[ $id ] ) ) {
				$id = self::item_id( '' );
			}
			$seen[ $id ] = true;
			$columns[]   = array(
				'id'   => $id,
				'name' => $name,
			);
		}

		return rest_ensure_response( GRP_Store::update( 'grp_projects', $project['id'], array( 'kw_columns' => $columns ) ) );
	}

	/**
	 * POST /projects/{id}/keywords `{keywords: [string], deadline?}` — one or many (pasted from a
	 * sheet). Blank lines and keywords already on the project are skipped.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function add_keywords( WP_REST_Request $request ) {
		$project = GRP_Store::get( 'grp_projects', $request['id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_KEYWORDS ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can add keywords.', 'gridrankers-portal' ) );
		}
		$deadline = self::date( $request['deadline'] ?? '', 'deadline' );
		if ( is_wp_error( $deadline ) ) {
			return $deadline;
		}
		$raw = is_array( $request['keywords'] ) ? $request['keywords'] : array();
		if ( count( $raw ) > self::MAX_ADD ) {
			/* translators: %d: maximum number of keywords. */
			return self::invalid( sprintf( __( 'Add up to %d keywords at a time.', 'gridrankers-portal' ), self::MAX_ADD ) );
		}

		$existing = GRP_Store::find( self::TABLE, array( 'project_id' => $project['id'] ) );
		$known    = array();
		$position = 0;
		foreach ( $existing as $row ) {
			$position = max( $position, (int) $row['position'] );

			$known[ mb_strtolower( $row['keyword'] ) ] = true;
		}
		$new = array();
		foreach ( $raw as $kw ) {
			$kw  = self::text( is_scalar( $kw ) ? $kw : '', 191 );
			$key = mb_strtolower( $kw );
			if ( '' === $kw || isset( $known[ $key ] ) ) {
				continue;
			}
			$known[ $key ] = true;
			$new[]         = $kw;
		}
		if ( ! $new ) {
			return self::invalid( __( 'Those keywords are already on the list.', 'gridrankers-portal' ), 'grp_keywords_none' );
		}

		$actor = self::actor();
		$rows  = GRP_Store::transaction(
			static function () use ( $project, $new, $deadline, $position, $actor ) {
				$rows = array();
				foreach ( $new as $i => $kw ) {
					$rows[] = GRP_Store::insert(
						self::TABLE,
						array(
							'project_id' => $project['id'],
							'keyword'    => $kw,
							'checks'     => new stdClass(),
							'deadline'   => $deadline,
							'position'   => $position + $i + 1,
							'created_by' => $actor['id'],
						)
					);
				}
				return $rows;
			}
		);

		return new WP_REST_Response( $rows, 201 );
	}

	/**
	 * PATCH /keywords/{id}. Everyone: `{check: {column, on: true}}`, `{note}`, and
	 * `{ask_untick: {column, note?}}` on a ticked box. Team Leaders and the Super Admin also:
	 * `{check: {column, on: false}}` (untick), `{keep: {column}}` (keep it ticked, the request
	 * answered), `{keyword}`, `{deadline}` (YYYY-MM-DD or '' for none), `{position}`.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update_keyword( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		$project = GRP_Store::get( 'grp_projects', $row['project_id'] );
		if ( ! $project ) {
			return self::not_found();
		}
		$params  = $request->get_json_params();
		$params  = is_array( $params ) ? $params : $request->get_params();
		$changes = array();

		$managed = array_intersect( array_keys( $params ), array( 'keyword', 'deadline', 'position' ) );
		if ( $managed && ! self::can( GRP_Permissions::MANAGE_KEYWORDS ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can change keywords and deadlines.', 'gridrankers-portal' ) );
		}
		if ( ( isset( $params['check'] ) || isset( $params['ask_untick'] ) || array_key_exists( 'note', $params ) ) && ! self::can( GRP_Permissions::TICK_KEYWORD ) ) {
			return self::forbidden();
		}
		// Unticking is for Team Leaders and the Super Admin; everyone else asks them (SPEC.md 6.12).
		$unticks = isset( $params['check'] ) && is_array( $params['check'] ) && empty( $params['check']['on'] );
		if ( ( $unticks || isset( $params['keep'] ) ) && ! self::can( GRP_Permissions::UNTICK_KEYWORD ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can untick a box. Ask them to untick it.', 'gridrankers-portal' ) );
		}

		if ( array_key_exists( 'keyword', $params ) ) {
			$kw = self::text( $params['keyword'], 191 );
			if ( '' === $kw ) {
				return self::invalid( __( 'Enter the keyword.', 'gridrankers-portal' ) );
			}
			foreach ( GRP_Store::find( self::TABLE, array( 'project_id' => $row['project_id'] ) ) as $other ) {
				if ( $other['id'] !== $row['id'] && mb_strtolower( $other['keyword'] ) === mb_strtolower( $kw ) ) {
					return self::conflict( __( 'That keyword is already on the list.', 'gridrankers-portal' ), 'grp_keyword_taken' );
				}
			}
			$changes['keyword'] = $kw;
		}
		if ( array_key_exists( 'deadline', $params ) ) {
			$deadline = self::date( $params['deadline'], 'deadline' );
			if ( is_wp_error( $deadline ) ) {
				return $deadline;
			}
			$changes['deadline'] = $deadline;
		}
		if ( array_key_exists( 'position', $params ) ) {
			$changes['position'] = self::int( $params['position'], 0, 1000000, (int) $row['position'] );
		}
		if ( array_key_exists( 'note', $params ) ) {
			$note            = self::textarea( $params['note'], 500 );
			$changes['note'] = '' !== $note ? $note : null;
		}
		foreach ( array( 'check', 'ask_untick', 'keep' ) as $key ) {
			if ( ! isset( $params[ $key ] ) ) {
				continue;
			}
			$input = is_array( $params[ $key ] ) ? $params[ $key ] : array();
			$col   = (string) ( $input['column'] ?? '' );
			if ( ! in_array( $col, wp_list_pluck( self::columns( $project ), 'id' ), true ) ) {
				return self::invalid( __( 'Unknown column.', 'gridrankers-portal' ) );
			}
			$checks = isset( $changes['checks'] ) ? (array) $changes['checks'] : ( is_array( $row['checks'] ) ? $row['checks'] : array() );
			$ticked = isset( $checks[ $col ] ) && is_array( $checks[ $col ] );
			if ( 'check' === $key && ! empty( $input['on'] ) ) {
				// Ticking a ticked box keeps who ticked it first.
				if ( ! $ticked ) {
					$checks[ $col ] = array(
						'by' => self::actor()['id'],
						'at' => GRP_Ids::now(),
					);
				}
			} elseif ( 'check' === $key ) {
				unset( $checks[ $col ] );
			} elseif ( ! $ticked ) {
				return self::invalid( __( 'That box is not ticked.', 'gridrankers-portal' ), 'grp_not_ticked' );
			} elseif ( 'ask_untick' === $key ) {
				$checks[ $col ]['ask'] = array(
					'by'   => self::actor()['id'],
					'at'   => GRP_Ids::now(),
					'note' => self::textarea( $input['note'] ?? '', 300 ),
				);
			} else {
				unset( $checks[ $col ]['ask'] );
			}
			$changes['checks'] = $checks ? $checks : new stdClass();
		}
		if ( ! $changes ) {
			return rest_ensure_response( $row );
		}

		return rest_ensure_response( GRP_Store::update( self::TABLE, $row['id'], $changes ) );
	}

	/**
	 * DELETE /keywords/{id}. Team Leaders and the Super Admin.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function delete_keyword( WP_REST_Request $request ) {
		$row = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $row ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::MANAGE_KEYWORDS ) ) {
			return self::forbidden( __( 'Only a Team Leader or the Super Admin can remove keywords.', 'gridrankers-portal' ) );
		}
		GRP_Store::delete( self::TABLE, $row['id'] );

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $row['id'],
			)
		);
	}

	/**
	 * The project's checklist columns (its own or the defaults).
	 *
	 * @param array $project Project row.
	 * @return array[]
	 */
	public static function columns( array $project ) {
		return is_array( $project['kw_columns'] ?? null ) && $project['kw_columns'] ? $project['kw_columns'] : self::DEFAULT_COLUMNS;
	}

	/**
	 * A short id for a section, link or column: the given one when well-formed, else a new one.
	 *
	 * @param mixed $id Raw id.
	 * @return string
	 */
	private static function item_id( $id ) {
		$id = (string) $id;

		return preg_match( '/^[A-Za-z0-9_-]{1,40}$/', $id ) ? $id : 'i' . strtolower( substr( GRP_Ids::ulid(), -10 ) );
	}
}
