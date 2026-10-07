<?php
/**
 * Shared helpers for the portal REST controllers.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Base class: the acting member, permission checks, error helpers and input validation.
 *
 * Every route uses `signed_in` as its permission callback; finer checks call
 * GRP_Permissions::can() once the target row is loaded.
 */
abstract class GRP_REST_Controller {

	/**
	 * Registers the controller's routes on rest_api_init.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( static::class, 'register_routes' ) );
	}

	/**
	 * Registers routes.
	 */
	abstract public static function register_routes();

	/**
	 * Permission callback for every portal route: a signed-in member.
	 *
	 * @return bool
	 */
	public static function signed_in() {
		return null !== GRP_Auth::current_member();
	}

	/**
	 * Registers a route in the portal namespace.
	 *
	 * @param string $path    Route path.
	 * @param string $methods HTTP methods.
	 * @param string $method  Static method on the controller.
	 * @param array  $args    Route args.
	 */
	protected static function route( $path, $methods, $method, array $args = array() ) {
		register_rest_route(
			GRP_REST_Auth::REST_NAMESPACE,
			$path,
			array(
				'methods'             => $methods,
				'callback'            => array( static::class, $method ),
				'permission_callback' => array( __CLASS__, 'signed_in' ),
				'args'                => $args,
			)
		);
	}

	/**
	 * The signed-in member.
	 *
	 * @return array
	 */
	protected static function actor() {
		return (array) GRP_Auth::current_member();
	}

	/**
	 * Whether the actor may do something.
	 *
	 * @param string $action  GRP_Permissions action.
	 * @param mixed  $context Context.
	 * @return bool
	 */
	protected static function can( $action, $context = null ) {
		$ok = GRP_Permissions::can( self::actor(), $action, $context );
		if ( ! $ok ) {
			self::$denied = $action;
		}

		return $ok;
	}

	/**
	 * The last action can() refused in this request (for a clearer 403).
	 *
	 * @var string|null
	 */
	private static $denied = null;

	/**
	 * Whether the actor is a Super Admin or Team Leader.
	 *
	 * @return bool
	 */
	protected static function is_manager() {
		return in_array( GRP_Permissions::effective_role( self::actor() ), array( GRP_Permissions::ROLE_ADMIN, GRP_Permissions::ROLE_LEAD ), true );
	}

	/**
	 * Why a Team Member may not work on a task (SPEC.md 6.6), or null when they may.
	 *
	 * @param array $task Task row with `assignees`.
	 * @return string|null
	 */
	protected static function not_assigned_message( array $task ) {
		if ( self::is_manager() ) {
			return null;
		}
		$ids = GRP_Permissions::assignee_ids( $task['assignees'] ?? array() );
		if ( ! $ids ) {
			return __( 'Nobody is assigned to this task yet — a Team Leader or Super Admin must assign it first.', 'gridrankers-portal' );
		}
		if ( ! in_array( (string) ( self::actor()['id'] ?? '' ), $ids, true ) ) {
			return __( 'This task is assigned to someone else — only they can update it.', 'gridrankers-portal' );
		}

		return null;
	}

	/**
	 * 403 error.
	 *
	 * @param string $message Message.
	 * @return WP_Error
	 */
	protected static function forbidden( $message = '' ) {
		// Refused because the profile is incomplete (SPEC.md section 3, Profile lock): say so.
		$actor   = self::actor();
		$missing = GRP_Permissions::missing_profile( $actor );
		if ( $missing && in_array( self::$denied, GRP_Permissions::PROFILE_LOCKED, true ) && GRP_Permissions::ROLE_ADMIN !== GRP_Permissions::effective_role( $actor ) ) {
			return new WP_Error(
				'grp_profile_incomplete',
				/* translators: %s: missing profile fields, e.g. "Location, Phone number". */
				sprintf( __( 'Finish your profile first (Settings). Missing: %s.', 'gridrankers-portal' ), implode( ', ', $missing ) ),
				array(
					'status'  => 403,
					'missing' => $missing,
				)
			);
		}

		return new WP_Error( 'grp_forbidden', $message ? $message : __( "You don't have permission to do that.", 'gridrankers-portal' ), array( 'status' => 403 ) );
	}

	/**
	 * 404 error.
	 *
	 * @return WP_Error
	 */
	protected static function not_found() {
		return new WP_Error( 'grp_not_found', __( 'Not found. It may have been deleted.', 'gridrankers-portal' ), array( 'status' => 404 ) );
	}

	/**
	 * 400 error.
	 *
	 * @param string $message Message.
	 * @param string $code    Error code.
	 * @return WP_Error
	 */
	protected static function invalid( $message, $code = 'grp_invalid' ) {
		return new WP_Error( $code, $message, array( 'status' => 400 ) );
	}

	/**
	 * 409 error.
	 *
	 * @param string $message Message.
	 * @param string $code    Error code.
	 * @return WP_Error
	 */
	protected static function conflict( $message, $code = 'grp_conflict' ) {
		return new WP_Error( $code, $message, array( 'status' => 409 ) );
	}

	/**
	 * Single-line text, trimmed and cut to `$max` characters.
	 *
	 * @param mixed $value Raw value.
	 * @param int   $max   Max length.
	 * @return string
	 */
	protected static function text( $value, $max = 200 ) {
		return mb_substr( trim( sanitize_text_field( (string) $value ) ), 0, $max );
	}

	/**
	 * Multi-line text.
	 *
	 * @param mixed $value Raw value.
	 * @param int   $max   Max length.
	 * @return string
	 */
	protected static function textarea( $value, $max = 10000 ) {
		return mb_substr( trim( sanitize_textarea_field( (string) $value ) ), 0, $max );
	}

	/**
	 * An http(s) URL or ''.
	 *
	 * @param mixed  $value       Raw value.
	 * @param string $https_label Field label for the error message.
	 * @return string|WP_Error
	 */
	protected static function url( $value, $https_label = 'link' ) {
		$value = trim( (string) $value );
		if ( '' === $value ) {
			return '';
		}
		// Syntax only: wp_http_validate_url() resolves the host, which rejects valid client URLs.
		if ( ! preg_match( '#^https?://[^/\s]+#i', $value ) || false === filter_var( $value, FILTER_VALIDATE_URL ) ) {
			/* translators: %s: field name. */
			return self::invalid( sprintf( __( 'The %s should start with https://', 'gridrankers-portal' ), $https_label ) );
		}

		return esc_url_raw( $value, array( 'http', 'https' ) );
	}

	/**
	 * A `Y-m-d` date, null for empty, or WP_Error.
	 *
	 * @param mixed  $value Raw value.
	 * @param string $label Field label.
	 * @return string|null|WP_Error
	 */
	protected static function date( $value, $label = 'date' ) {
		$value = trim( (string) $value );
		if ( '' === $value ) {
			return null;
		}
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m ) || ! checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) ) {
			/* translators: %s: field name. */
			return self::invalid( sprintf( __( 'Invalid %s.', 'gridrankers-portal' ), $label ) );
		}

		return $value;
	}

	/**
	 * Clamped integer.
	 *
	 * @param mixed $value   Raw value.
	 * @param int   $min     Minimum.
	 * @param int   $max     Maximum.
	 * @param int   $fallback Value when empty / not numeric.
	 * @return int
	 */
	protected static function int( $value, $min, $max, $fallback ) {
		if ( ! is_numeric( $value ) ) {
			return $fallback;
		}

		return max( $min, min( $max, (int) $value ) );
	}

	/**
	 * Active members by id.
	 *
	 * @param string[] $ids Member ids.
	 * @return array<string, array>
	 */
	protected static function active_members( array $ids ) {
		$out = array();
		if ( ! $ids ) {
			return $out;
		}
		foreach ( GRP_Store::find(
			'grp_members',
			array(
				'id'     => array_values( array_unique( array_map( 'strval', $ids ) ) ),
				'active' => 1,
			)
		) as $member ) {
			$out[ $member['id'] ] = $member;
		}

		return $out;
	}

	/**
	 * Validates and normalises assignees `[{id, n}]` (SPEC.md section 6.5).
	 *
	 * One person gets the whole target; several people keep their shares when every share
	 * is at least 1 and they add up to the target, otherwise the target is split evenly.
	 * With `$team`, everyone shares the whole task (n = target).
	 *
	 * @param mixed $raw    Raw assignees.
	 * @param int   $target Task quantity.
	 * @param bool  $team   Whole-task team.
	 * @return array|WP_Error
	 */
	protected static function assignees( $raw, $target, $team = false ) {
		if ( empty( $raw ) ) {
			return array();
		}
		if ( ! is_array( $raw ) ) {
			return self::invalid( __( 'Invalid responsible people.', 'gridrankers-portal' ) );
		}

		$list = array();
		foreach ( $raw as $item ) {
			$item = is_array( $item ) ? $item : array( 'id' => $item );
			$id   = (string) ( $item['id'] ?? '' );
			if ( '' === $id || isset( $list[ $id ] ) ) {
				continue;
			}
			$list[ $id ] = (int) ( $item['n'] ?? 0 );
		}

		$known = self::active_members( array_keys( $list ) );
		if ( count( $known ) !== count( $list ) ) {
			return self::invalid( __( 'Someone you picked is no longer on the team.', 'gridrankers-portal' ) );
		}

		$ids   = array_keys( $list );
		$count = count( $ids );
		if ( $team || 1 === $count ) {
			return array_map(
				static function ( $id ) use ( $target ) {
					return array(
						'id' => $id,
						'n'  => $target,
					);
				},
				$ids
			);
		}

		$valid = array_sum( $list ) === $target && min( $list ) >= 1;
		$out   = array();
		foreach ( $ids as $i => $id ) {
			$n     = $valid ? $list[ $id ] : max( 1, intdiv( $target, $count ) + ( $i < $target % $count ? 1 : 0 ) );
			$out[] = array(
				'id' => $id,
				'n'  => $n,
			);
		}

		return $out;
	}

	/**
	 * The submission sent when work is completed (SPEC.md 6.6, design SF-A):
	 * `{note, link, links[], files[], comment, by, at}`, or WP_Error when `$required` and the note is
	 * missing ("What you did"). Everyone fills it in, Team Leaders and the Super Admin included.
	 * A leader may also name a `reviewer` (read by new_review()).
	 *
	 * @param WP_REST_Request $request  Request with `note`, `link` / `links`, `files`, `comment`, `reviewer`.
	 * @param bool            $required Whether a note is required.
	 * @return array|null|WP_Error
	 */
	protected static function completion( WP_REST_Request $request, $required ) {
		self::$reviewer = '';
		$fields         = self::submission_fields( $request );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}
		if ( null === $fields ) {
			return $required ? self::invalid( __( 'Add a few words about what you completed.', 'gridrankers-portal' ), 'grp_completion_required' ) : null;
		}

		$reviewer = (string) ( $request['reviewer'] ?? '' );
		if ( '' !== $reviewer ) {
			$member = GRP_Store::get( 'grp_members', $reviewer );
			if ( ! self::can( GRP_Permissions::REQUEST_REVIEW ) || ! $member || ! (int) $member['active'] || self::actor()['id'] === $member['id'] ) {
				return self::invalid( __( 'Pick who should review it.', 'gridrankers-portal' ) );
			}
			self::$reviewer = $member['id'];
		}

		return $fields + array(
			'by' => self::actor()['id'],
			'at' => gmdate( 'c' ),
		);
	}

	/**
	 * Reviewer a Team Leader picked in the submission form, for new_review().
	 *
	 * @var string
	 */
	private static $reviewer = '';

	/**
	 * Most links and files on one submission or comment.
	 */
	const MAX_ATTACHMENTS = 10;

	/**
	 * The editable part of a submission: `{note, link, links, files, comment}`, null when the
	 * note is missing, or WP_Error.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|null|WP_Error
	 */
	protected static function submission_fields( WP_REST_Request $request ) {
		$note = self::textarea( $request['note'] ?? '', 2000 );
		if ( mb_strlen( $note ) < 3 ) {
			return null;
		}

		$raw = $request['links'] ?? null;
		$raw = is_array( $raw ) ? $raw : array( $request['link'] ?? '' );
		if ( count( $raw ) > self::MAX_ATTACHMENTS ) {
			return self::invalid( __( 'Add at most 10 links.', 'gridrankers-portal' ) );
		}
		$links = array();
		foreach ( $raw as $value ) {
			$url = self::url( is_scalar( $value ) ? $value : '' );
			if ( is_wp_error( $url ) ) {
				return $url;
			}
			if ( '' !== $url && ! in_array( $url, $links, true ) ) {
				$links[] = $url;
			}
		}

		$files = self::attached_files( $request['files'] ?? array() );
		if ( is_wp_error( $files ) ) {
			return $files;
		}

		return array(
			'note'    => $note,
			'link'    => $links[0] ?? '',
			'links'   => $links,
			'files'   => $files,
			'comment' => self::textarea( $request['comment'] ?? '', 1000 ),
		);
	}

	/**
	 * Uploaded files attached by id: `[{id, mime, name, size}]`, or WP_Error for an unknown id
	 * or too many.
	 *
	 * @param mixed $raw File ids (or `{id}` objects).
	 * @return array|WP_Error
	 */
	protected static function attached_files( $raw ) {
		$raw = is_array( $raw ) ? $raw : array();
		if ( count( $raw ) > self::MAX_ATTACHMENTS ) {
			return self::invalid( __( 'Attach at most 10 files.', 'gridrankers-portal' ) );
		}
		$files = array();
		foreach ( $raw as $item ) {
			$id   = is_array( $item ) ? (string) ( $item['id'] ?? '' ) : (string) $item;
			$file = '' !== $id ? GRP_Store::get( 'grp_files', $id ) : null;
			if ( ! $file ) {
				return self::invalid( __( 'One of the files is missing. Upload it again.', 'gridrankers-portal' ) );
			}
			$files[ $file['id'] ] = GRP_Files::meta( $file );
		}

		return array_values( $files );
	}

	/**
	 * A new review for completed work: managers' work is accepted automatically unless they
	 * asked someone to review it in the submission form; members' work waits for review
	 * (SPEC.md section 6.6).
	 *
	 * @return array
	 */
	protected static function new_review() {
		$actor = self::actor();
		$now   = gmdate( 'c' );

		if ( '' !== self::$reviewer ) {
			return array(
				'state'       => 'pending',
				'submittedBy' => $actor['id'],
				'submittedAt' => $now,
				'reviewer'    => self::$reviewer,
				'note'        => '',
			);
		}
		if ( self::can( GRP_Permissions::AUTO_ACCEPT ) ) {
			return array(
				'state'       => 'accepted',
				'auto'        => 1,
				'by'          => $actor['id'],
				'at'          => $now,
				'submittedBy' => $actor['id'],
				'submittedAt' => $now,
			);
		}

		return array(
			'state'       => 'pending',
			'submittedBy' => $actor['id'],
			'submittedAt' => $now,
		);
	}

	/**
	 * Edits a saved submission in place (SPEC.md 6.6, design SF-B): the person who submitted it, or a
	 * Team Leader / the Super Admin. Keeps `by` and `at`, adds `edited_by` / `edited_at`.
	 *
	 * @param array|null      $completion Saved submission.
	 * @param WP_REST_Request $request    Request with the new fields.
	 * @return array|WP_Error
	 */
	protected static function edited_submission( $completion, WP_REST_Request $request ) {
		if ( ! is_array( $completion ) || empty( $completion['by'] ) ) {
			return self::conflict( __( 'There is no submission to edit yet.', 'gridrankers-portal' ), 'grp_no_submission' );
		}
		if ( ! self::can( GRP_Permissions::EDIT_SUBMISSION, array( 'completion' => $completion ) ) ) {
			return self::forbidden( __( 'Only the person who submitted it, a Team Leader or the Super Admin can edit this submission.', 'gridrankers-portal' ) );
		}
		$fields = self::submission_fields( $request );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}
		if ( null === $fields ) {
			return self::invalid( __( 'Add a few words about what you completed.', 'gridrankers-portal' ), 'grp_completion_required' );
		}

		return array_merge(
			$completion,
			$fields,
			array(
				'edited_by' => self::actor()['id'],
				'edited_at' => gmdate( 'c' ),
			)
		);
	}

	/**
	 * Display name of a member id (for audit details).
	 *
	 * @param string|null $id Member id.
	 * @return string
	 */
	protected static function name_of( $id ) {
		if ( ! $id ) {
			return __( 'Unassigned', 'gridrankers-portal' );
		}
		$member = GRP_Store::get( 'grp_members', $id );

		return $member ? $member['name'] : __( 'Someone', 'gridrankers-portal' );
	}

	/**
	 * Moves a row to the trash (soft delete) and removes it from its table.
	 *
	 * @param string $table        Table.
	 * @param array  $row          Row.
	 * @param bool   $with_project Deleted as part of deleting its project (restored with it).
	 * @return array The trash row.
	 */
	protected static function trash( $table, array $row, $with_project = false ) {
		$trash = GRP_Store::insert(
			'grp_trash',
			array(
				'type'         => $table,
				'doc_id'       => $row['id'],
				'data'         => $row,
				'title'        => (string) ( $row['title'] ?? $row['name'] ?? '' ),
				'project_id'   => 'grp_projects' === $table ? $row['id'] : ( $row['project_id'] ?? null ),
				'with_project' => $with_project ? 1 : 0,
				'deleted_at'   => GRP_Ids::now(),
				'deleted_by'   => self::actor()['id'],
			)
		);
		GRP_Store::delete( $table, $row['id'] );

		return $trash;
	}

	/**
	 * Field-by-field changes for the audit log.
	 *
	 * @param array $before Row before.
	 * @param array $after  Row after.
	 * @param array $labels Field => label.
	 * @return array[]
	 */
	protected static function diff( array $before, array $after, array $labels ) {
		$changes = array();
		foreach ( $labels as $field => $label ) {
			$from = $before[ $field ] ?? null;
			$to   = $after[ $field ] ?? null;
			// Empty and NULL are the same to a person reading the log.
			if ( wp_json_encode( GRP_Store::canonical( $from ) ) === wp_json_encode( GRP_Store::canonical( $to ) ) || ( ! is_array( $from ) && ! is_array( $to ) && (string) $from === (string) $to ) ) {
				continue;
			}
			$changes[] = array(
				'field' => $field,
				'label' => $label,
				'from'  => self::field_text( $field, $from ),
				'to'    => self::field_text( $field, $to ),
			);
		}

		return $changes;
	}

	/**
	 * Human-readable field value for the audit log.
	 *
	 * @param string $field Field.
	 * @param mixed  $value Value.
	 * @return string
	 */
	protected static function field_text( $field, $value ) {
		if ( 'assignees' === $field ) {
			$names = array_map(
				static function ( $a ) {
					return self::name_of( $a['id'] ?? '' ) . ( isset( $a['n'] ) && $a['n'] > 1 ? ' ×' . $a['n'] : '' );
				},
				(array) $value
			);
			return $names ? implode( ', ', $names ) : 'Unassigned';
		}
		if ( 'project_id' === $field ) {
			$project = $value ? GRP_Store::get( 'grp_projects', $value ) : null;
			return $project ? $project['name'] : ( '' === (string) $value ? 'General' : '—' );
		}
		if ( 'deadline' === $field ) {
			return is_array( $value ) ? (string) ( $value['type'] ?? 'none' ) : 'none';
		}
		if ( 'status' === $field ) {
			return GRP_REST_Meeting_Tasks::STATUS_TEXT[ $value ] ?? (string) $value;
		}
		if ( 'steps' === $field ) {
			$names = array_map(
				static function ( $step ) {
					return ( $step['name'] ?? '' ) . ' (' . self::name_of( $step['member'] ?? '' ) . ')';
				},
				(array) $value
			);
			return $names ? implode( ' → ', $names ) : 'one step';
		}
		if ( 'parts' === $field ) {
			$names = wp_list_pluck( (array) $value, 'name' );
			return $names ? implode( ', ', $names ) : 'none';
		}

		return ( null === $value || '' === $value ) ? 'empty' : (string) $value;
	}
}
