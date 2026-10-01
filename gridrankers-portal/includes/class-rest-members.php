<?php
/**
 * REST: /members.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Team members: list, add, edit profile / role, remove, set sign-in code.
 */
class GRP_REST_Members extends GRP_REST_Controller {

	const TABLE = 'grp_members';

	/**
	 * Avatar colours for new members (reference PALETTE).
	 */
	const PALETTE = array( '#2753C9', '#C2410C', '#0E7C66', '#9333EA', '#B45309', '#BE185D', '#0369A1', '#4D7C0F' );

	/**
	 * Profile fields: name => max length (0 = multi-line).
	 */
	const PROFILE_FIELDS = array(
		'name'      => 191,
		'title'     => 191,
		'email'     => 191,
		'phone'     => 64,
		'address'   => 0,
		'drive_url' => -1,
		'photo'     => -1,
		'notes'     => 0,
		'color'     => 32,
	);

	/**
	 * Fields only managers and the member themself can see.
	 */
	const PRIVATE_FIELDS = array( 'email', 'phone', 'address', 'drive_url', 'notes', 'code_set_at', 'wp_user_id' );

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/members', WP_REST_Server::READABLE, 'index' );
		self::route( '/members', WP_REST_Server::CREATABLE, 'create' );
		self::route( '/members/(?P<id>[\w-]+)', WP_REST_Server::READABLE, 'show' );
		self::route( '/members/(?P<id>[\w-]+)', 'PATCH', 'update' );
		self::route( '/members/(?P<id>[\w-]+)', WP_REST_Server::DELETABLE, 'destroy' );
		self::route( '/members/(?P<id>[\w-]+)/code', WP_REST_Server::CREATABLE, 'set_code' );
	}

	/**
	 * A member as the current viewer may see them (no secrets; contact details only
	 * for managers and the member themself).
	 *
	 * @param array      $member Member row.
	 * @param array|null $viewer Viewing member (default: the actor).
	 * @return array
	 */
	public static function visible( array $member, $viewer = null ) {
		$viewer = $viewer ? $viewer : self::actor();
		$out    = GRP_Auth::public_member( $member );

		$manager = in_array( GRP_Permissions::effective_role( $viewer ), array( GRP_Permissions::ROLE_ADMIN, GRP_Permissions::ROLE_LEAD ), true );
		if ( ! $manager && ( $viewer['id'] ?? null ) !== $member['id'] ) {
			foreach ( self::PRIVATE_FIELDS as $field ) {
				unset( $out[ $field ] );
			}
		}

		return $out;
	}

	/**
	 * GET /members (including removed members, flagged active = 0).
	 *
	 * @return WP_REST_Response
	 */
	public static function index() {
		return rest_ensure_response( array_map( array( __CLASS__, 'visible' ), GRP_Store::find( self::TABLE, array(), array( 'order_by' => 'name' ) ) ) );
	}

	/**
	 * GET /members/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function show( WP_REST_Request $request ) {
		$member = GRP_Store::get( self::TABLE, $request['id'] );

		return $member ? rest_ensure_response( self::visible( $member ) ) : self::not_found();
	}

	/**
	 * POST /members `{name, role?, title?, email?, phone?, color?, wp_user_id?}`.
	 *
	 * Team Leaders can add people as Member only; only the Super Admin grants admin
	 * (to a member linked to a WordPress administrator).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create( WP_REST_Request $request ) {
		$role       = $request['role'] ? (string) $request['role'] : GRP_Permissions::ROLE_MEMBER;
		$wp_user_id = $request['wp_user_id'] ? (int) $request['wp_user_id'] : null;

		if ( ! self::can(
			GRP_Permissions::ADD_MEMBER,
			array(
				'role'       => $role,
				'wp_user_id' => $wp_user_id,
			)
		) ) {
			return self::forbidden( __( 'Team Leaders can add people as Team Member only.', 'gridrankers-portal' ) );
		}
		if ( $wp_user_id && ! self::can( GRP_Permissions::LINK_WP_USER ) ) {
			return self::forbidden();
		}

		$fields = self::profile( $request, true );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}

		$count  = count( GRP_Store::find( self::TABLE ) );
		$member = GRP_Store::transaction(
			static function () use ( $fields, $role, $wp_user_id, $count ) {
				$member = GRP_Store::insert(
					self::TABLE,
					$fields + array(
						'role'       => $role,
						'wp_user_id' => $wp_user_id,
						'active'     => 1,
						'color'      => self::PALETTE[ $count % count( self::PALETTE ) ],
					)
				);
				GRP_Activity::audit( 'add', 'team', $member, self::actor(), $role );
				return $member;
			}
		);

		return new WP_REST_Response( self::visible( $member ), 201 );
	}

	/**
	 * PATCH /members/{id}: profile fields (self or Super Admin), `role` (Super Admin),
	 * `wp_user_id` (Super Admin), `active` (Super Admin; re-adds a removed member).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update( WP_REST_Request $request ) {
		$member = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $member ) {
			return self::not_found();
		}

		$changes = array();

		$profile = self::profile( $request, false );
		if ( is_wp_error( $profile ) ) {
			return $profile;
		}
		if ( $profile && ! self::can( GRP_Permissions::EDIT_MEMBER_PROFILE, array( 'member_id' => $member['id'] ) ) ) {
			return self::forbidden( __( 'Only the Super Admin can change other people’s details.', 'gridrankers-portal' ) );
		}
		$changes += $profile;

		if ( null !== $request->get_param( 'wp_user_id' ) ) {
			if ( ! self::can( GRP_Permissions::LINK_WP_USER ) ) {
				return self::forbidden();
			}
			$changes['wp_user_id'] = $request['wp_user_id'] ? (int) $request['wp_user_id'] : null;
		}

		if ( null !== $request->get_param( 'role' ) && $request['role'] !== $member['role'] ) {
			$role   = (string) $request['role'];
			$target = array( 'wp_user_id' => $changes['wp_user_id'] ?? $member['wp_user_id'] );
			if ( ! self::can(
				GRP_Permissions::SET_MEMBER_ROLE,
				array(
					'member' => $target,
					'role'   => $role,
				)
			) ) {
				return GRP_Permissions::ROLE_ADMIN === $role && self::can( GRP_Permissions::LINK_WP_USER )
					? self::invalid( __( 'A Super Admin must be linked to a WordPress administrator account.', 'gridrankers-portal' ), 'grp_admin_needs_wp_admin' )
					: self::forbidden( __( 'Only the Super Admin can change roles.', 'gridrankers-portal' ) );
			}
			if ( self::actor()['id'] === $member['id'] ) {
				return self::conflict( __( "You can't change your own role.", 'gridrankers-portal' ) );
			}
			$changes['role'] = $role;
		}

		if ( null !== $request->get_param( 'active' ) ) {
			if ( ! self::can( GRP_Permissions::REMOVE_MEMBER ) ) {
				return self::forbidden();
			}
			$changes['active'] = $request['active'] ? 1 : 0;
			if ( ! $changes['active'] && self::actor()['id'] === $member['id'] ) {
				return self::conflict( __( "You can't remove yourself.", 'gridrankers-portal' ) );
			}
		}

		if ( ! $changes ) {
			return rest_ensure_response( self::visible( $member ) );
		}

		$updated = GRP_Store::transaction(
			static function () use ( $member, $changes ) {
				$updated = GRP_Store::update( self::TABLE, $member['id'], $changes );
				if ( isset( $changes['role'] ) || ( isset( $changes['active'] ) && ! $changes['active'] ) ) {
					GRP_Auth::revoke_sessions( $member['id'] );
				}
				$labels = array_combine( array_keys( $changes ), array_map( 'strval', array_keys( $changes ) ) );
				unset( $labels['notes'], $labels['photo'] );
				$diff = self::diff( $member, $updated, $labels );
				if ( isset( $changes['photo'] ) && (string) $changes['photo'] !== (string) $member['photo'] ) {
					// Never copy the image itself into the log.
					$diff[] = array(
						'field' => 'photo',
						'label' => 'photo',
						'from'  => $member['photo'] ? 'photo' : 'none',
						'to'    => $changes['photo'] ? 'new photo' : 'removed',
					);
				}
				if ( $diff ) {
					GRP_Activity::audit( 'edit', 'team', $updated, self::actor(), '', $diff );
				}
				return $updated;
			}
		);

		return rest_ensure_response( self::visible( $updated ) );
	}

	/**
	 * DELETE /members/{id}: Super Admin removes someone (kept for history, signed out).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function destroy( WP_REST_Request $request ) {
		$member = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $member ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::REMOVE_MEMBER ) ) {
			return self::forbidden( __( 'Only the Super Admin can remove people.', 'gridrankers-portal' ) );
		}
		if ( self::actor()['id'] === $member['id'] ) {
			return self::conflict( __( "You can't remove yourself.", 'gridrankers-portal' ) );
		}

		GRP_Store::transaction(
			static function () use ( $member ) {
				GRP_Store::update( self::TABLE, $member['id'], array( 'active' => 0 ) );
				GRP_Auth::revoke_sessions( $member['id'] );
				GRP_Activity::audit( 'delete', 'team', $member, self::actor(), 'removed from the team' );
			}
		);

		return rest_ensure_response(
			array(
				'deleted' => true,
				'id'      => $member['id'],
			)
		);
	}

	/**
	 * POST /members/{id}/code `{code?, generate?}`. Returns the code once so it can be
	 * passed on; it is stored hashed. All the member's sessions are revoked.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_code( WP_REST_Request $request ) {
		$member = GRP_Store::get( self::TABLE, $request['id'] );
		if ( ! $member || ! (int) $member['active'] ) {
			return self::not_found();
		}
		if ( ! self::can( GRP_Permissions::SET_MEMBER_CODE, $member ) ) {
			return self::forbidden( __( 'Team Leaders can set codes for Team Members only.', 'gridrankers-portal' ) );
		}

		$code = trim( (string) $request['code'] );
		if ( $request['generate'] || '' === $code ) {
			do {
				$code = GRP_Auth::generate_code();
				$set  = GRP_Auth::set_code( $member['id'], $code );
			} while ( is_wp_error( $set ) && 'grp_code_taken' === $set->get_error_code() );
		} else {
			$set = GRP_Auth::set_code( $member['id'], $code );
		}
		if ( is_wp_error( $set ) ) {
			return $set;
		}

		GRP_Activity::audit( 'edit', 'team', $member, self::actor(), 'sign-in code set' );

		return rest_ensure_response(
			array(
				'id'       => $member['id'],
				'code'     => $code,
				'has_code' => true,
			)
		);
	}

	/**
	 * Validated profile fields present in the request.
	 *
	 * @param WP_REST_Request $request  Request.
	 * @param bool            $creating Whether a name is required.
	 * @return array|WP_Error
	 */
	private static function profile( WP_REST_Request $request, $creating ) {
		$out = array();
		foreach ( self::PROFILE_FIELDS as $field => $max ) {
			if ( null === $request->get_param( $field ) ) {
				continue;
			}
			$value = $request[ $field ];
			if ( 'photo' === $field && is_string( $value ) && str_starts_with( $value, 'data:' ) ) {
				// Cropped 160 px photo from the app (as in the reference portal).
				if ( strlen( $value ) > 300000 || ! preg_match( '#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$#', $value ) ) {
					return self::invalid( __( 'That photo could not be used. Try a smaller JPEG or PNG.', 'gridrankers-portal' ) );
				}
				$out[ $field ] = $value;
				continue;
			}
			if ( -1 === $max ) {
				$value = self::url( $value, str_replace( '_', ' ', $field ) );
				if ( is_wp_error( $value ) ) {
					return $value;
				}
			} elseif ( 0 === $max ) {
				$value = self::textarea( $value, 5000 );
			} else {
				$value = self::text( $value, $max );
			}
			if ( 'email' === $field && '' !== $value && ! is_email( $value ) ) {
				return self::invalid( __( 'Invalid email address.', 'gridrankers-portal' ) );
			}
			if ( 'color' === $field && '' !== $value && ! sanitize_hex_color( $value ) ) {
				return self::invalid( __( 'Invalid colour.', 'gridrankers-portal' ) );
			}
			$out[ $field ] = $value;
		}

		if ( ( $creating || isset( $out['name'] ) ) && '' === ( $out['name'] ?? '' ) ) {
			return self::invalid( __( 'Enter a name.', 'gridrankers-portal' ) );
		}

		return $out;
	}
}
