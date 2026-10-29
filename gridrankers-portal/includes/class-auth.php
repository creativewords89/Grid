<?php
/**
 * Code login, sessions, lockouts and current-user resolution (SPEC.md section 4).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Authentication for portal team members.
 *
 * Super Admins use their WordPress login and are mapped to the team member linked by
 * `wp_user_id`. Team Leaders and Members sign in with a code and get a session cookie.
 */
class GRP_Auth {

	/**
	 * Session cookie name.
	 */
	const COOKIE = 'grp_session';

	/**
	 * Session lifetime in seconds (30 days).
	 */
	const SESSION_TTL = 30 * DAY_IN_SECONDS;

	/**
	 * Desktop tracker device token lifetime in seconds (30 days, renewed on use; SPEC.md 6.21).
	 */
	const DEVICE_TTL = 30 * DAY_IN_SECONDS;

	/**
	 * A device's last-seen time and expiry are renewed at most this often.
	 */
	const DEVICE_TOUCH_SECONDS = 5 * MINUTE_IN_SECONDS;

	/**
	 * Failed attempts allowed before a lockout.
	 */
	const MAX_ATTEMPTS = 5;

	/**
	 * Lockout length in seconds (15 minutes).
	 */
	const LOCK_SECONDS = 15 * MINUTE_IN_SECONDS;

	/**
	 * Minimum length of a code set by an admin or team leader.
	 */
	const CODE_MIN_LENGTH = 6;

	/**
	 * Length of a generated code.
	 */
	const CODE_GENERATED_LENGTH = 8;

	/**
	 * Characters used for generated codes (no 0/O, 1/I/L).
	 */
	const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

	/**
	 * Member resolved for the current request (false = not resolved yet).
	 *
	 * @var array|null|false
	 */
	private static $current = false;

	/**
	 * Raw session token issued during this request, used before the cookie round-trips.
	 *
	 * @var string|null
	 */
	private static $request_token = null;

	/**
	 * Device token sent with this request (`Authorization: Bearer`): null when none was sent,
	 * '' when the header held no valid token.
	 *
	 * @var string|null
	 */
	private static $bearer = null;

	/**
	 * Device the current request signed in with (desktop tracker), or null.
	 *
	 * @var array|null
	 */
	private static $device = null;

	/**
	 * Signs a member in with their code.
	 *
	 * Legacy imported hashes (`sha256(salt:code)`) are verified and immediately rehashed
	 * with password_hash(). Super Admins cannot sign in with a code.
	 *
	 * @param string $code       Code as typed.
	 * @param string $ip         Client IP address.
	 * @param string $user_agent Client user agent.
	 * @return array|WP_Error `{member, token}` on success.
	 */
	public static function login( $code, $ip, $user_agent = '' ) {
		$code = trim( (string) $code );

		if ( self::is_locked( $ip ) ) {
			return new WP_Error(
				'grp_locked',
				__( 'Too many attempts. Try again in 15 minutes.', 'gridrankers-portal' ),
				array( 'status' => 429 )
			);
		}

		$member = '' === $code ? null : self::find_member_by_code( $code );
		if ( ! $member ) {
			// Generic message: never reveal whether a member exists.
			self::record_failure( $ip );
			return new WP_Error(
				'grp_invalid_code',
				__( "That code doesn't match anyone.", 'gridrankers-portal' ),
				array( 'status' => 401 )
			);
		}

		self::clear_failures( $ip );
		$token = self::create_session( $member['id'], $ip, $user_agent );
		self::set_cookie( $token, time() + self::SESSION_TTL );

		self::$request_token = $token;
		self::$current       = $member;

		return array(
			'member' => $member,
			'token'  => $token,
		);
	}

	/**
	 * Signs the current user out: deletes the session token and, for a WordPress
	 * Super Admin, ends the WordPress session too.
	 */
	public static function logout() {
		global $wpdb;

		$token = self::request_token();
		if ( $token ) {
			$wpdb->delete( self::table( 'grp_sessions' ), array( 'token_hash' => self::hash_token( $token ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		}
		self::set_cookie( '', time() - YEAR_IN_SECONDS );

		if ( is_user_logged_in() ) {
			wp_logout();
		}

		self::$request_token = null;
		self::$current       = null;
	}

	/**
	 * Signs the desktop tracker in with a code (SPEC.md 6.21): same lockout and error as login(),
	 * but no cookie — the app gets a device token, stored only as its hash in `grp_devices`.
	 * Someone who hasn't set up their pay (6.19) is told to do it on the portal first.
	 *
	 * @param string $code        Code as typed.
	 * @param string $ip          Client IP address.
	 * @param string $name        Device name (e.g. the computer's name).
	 * @param string $platform    Platform (win32, darwin…).
	 * @param string $app_version App version.
	 * @return array|WP_Error `{member, token, device}` on success.
	 */
	public static function device_login( $code, $ip, $name = '', $platform = '', $app_version = '' ) {
		global $wpdb;

		$code = trim( (string) $code );
		if ( self::is_locked( $ip ) ) {
			return new WP_Error(
				'grp_locked',
				__( 'Too many attempts. Try again in 15 minutes.', 'gridrankers-portal' ),
				array( 'status' => 429 )
			);
		}

		$member = '' === $code ? null : self::find_member_by_code( $code );
		if ( ! $member ) {
			self::record_failure( $ip );
			return new WP_Error(
				'grp_invalid_code',
				__( "That code doesn't match anyone.", 'gridrankers-portal' ),
				array( 'status' => 401 )
			);
		}
		self::clear_failures( $ip );

		if ( GRP_Pay::needs_setup( $member ) ) {
			return new WP_Error( 'grp_pay_needed', __( 'Set up your working hours, salary and payment details on the portal first.', 'gridrankers-portal' ), array( 'status' => 403 ) );
		}

		$now   = GRP_Ids::now();
		$token = bin2hex( random_bytes( 32 ) );
		$id    = GRP_Ids::ulid();
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table( 'grp_devices' ),
			array(
				'id'           => $id,
				'member_id'    => $member['id'],
				'name'         => self::clip( $name, 191 ),
				'platform'     => self::clip( $platform, 32 ),
				'app_version'  => self::clip( $app_version, 32 ),
				'token_hash'   => self::hash_token( $token ),
				'expires_at'   => GRP_Ids::now( time() + self::DEVICE_TTL ),
				'last_seen_at' => $now,
				'ip'           => substr( (string) $ip, 0, 45 ),
				'created_at'   => $now,
				'updated_at'   => $now,
			)
		);

		return array(
			'member' => $member,
			'token'  => $token,
			'device' => self::public_device( GRP_Store::get( 'grp_devices', $id ) ),
		);
	}

	/**
	 * Uses the device token of this request instead of the session cookie (the REST guard calls it
	 * for `Authorization: Bearer`). A malformed token signs nobody in.
	 *
	 * @param string $token Raw token.
	 */
	public static function use_bearer( $token ) {
		self::$bearer  = preg_match( '/^[a-f0-9]{64}$/', (string) $token ) ? (string) $token : '';
		self::$device  = null;
		self::$current = false;
	}

	/**
	 * Whether this request came with a device token.
	 *
	 * @return bool
	 */
	public static function uses_device() {
		return null !== self::$bearer;
	}

	/**
	 * The device the current request signed in with, or null.
	 *
	 * @return array|null
	 */
	public static function current_device() {
		self::current_member();

		return self::$device;
	}

	/**
	 * Revokes one device: its token stops working at once.
	 *
	 * @param string $device_id Device id.
	 */
	public static function revoke_device( $device_id ) {
		global $wpdb;

		$now = GRP_Ids::now();
		$wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'UPDATE %i SET revoked_at = %s, updated_at = %s WHERE id = %s AND revoked_at IS NULL', self::table( 'grp_devices' ), $now, $now, $device_id )
		);
		self::$current = false;
	}

	/**
	 * A person's signed-in devices: not revoked and not expired, newest first.
	 *
	 * @param string $member_id Member id.
	 * @return array[]
	 */
	public static function devices( $member_id ) {
		global $wpdb;

		$rows = $wpdb->get_results( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT * FROM %i WHERE member_id = %s AND revoked_at IS NULL AND expires_at > %s ORDER BY created_at DESC, id DESC',
				self::table( 'grp_devices' ),
				$member_id,
				GRP_Ids::now()
			),
			ARRAY_A
		);

		return array_map( array( __CLASS__, 'public_device' ), (array) $rows );
	}

	/**
	 * Device row without its token hash.
	 *
	 * @param array|null $device Device row.
	 * @return array|null
	 */
	public static function public_device( $device ) {
		if ( ! $device ) {
			return null;
		}
		unset( $device['token_hash'] );

		return $device;
	}

	/**
	 * The team member making this request, or null.
	 *
	 * @return array|null
	 */
	public static function current_member() {
		if ( false === self::$current ) {
			self::$current = self::resolve_current_member();
		}

		return self::$current;
	}

	/**
	 * Forgets the member resolved for this request (tests, and after login/logout).
	 */
	public static function reset() {
		self::$current       = false;
		self::$request_token = null;
		self::$bearer        = null;
		self::$device        = null;
	}

	/**
	 * Whether the current WordPress user is an administrator with no linked team member,
	 * i.e. the portal should offer "Set up GridRankers".
	 *
	 * @return bool
	 */
	public static function needs_setup() {
		$wp_user_id = get_current_user_id();

		return $wp_user_id && user_can( $wp_user_id, 'manage_options' ) && ! self::member_for_wp_user( $wp_user_id );
	}

	/**
	 * Creates the Super Admin team member for the current WordPress administrator.
	 *
	 * @param string $name Display name.
	 * @return array|WP_Error The new member.
	 */
	public static function setup_admin_member( $name ) {
		global $wpdb;

		if ( ! self::needs_setup() ) {
			return new WP_Error( 'grp_setup_not_allowed', __( 'GridRankers is already set up for this account.', 'gridrankers-portal' ), array( 'status' => 403 ) );
		}

		$wp_user = wp_get_current_user();
		$name    = sanitize_text_field( (string) $name );
		if ( '' === $name ) {
			$name = $wp_user->display_name;
		}

		$now = GRP_Ids::now();
		$id  = GRP_Ids::ulid();
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table( 'grp_members' ),
			array(
				'id'         => $id,
				'name'       => $name,
				'role'       => GRP_Permissions::ROLE_ADMIN,
				'email'      => $wp_user->user_email,
				'wp_user_id' => $wp_user->ID,
				'active'     => 1,
				'created_at' => $now,
				'updated_at' => $now,
			)
		);

		self::$current = false;

		return self::get_member( $id );
	}

	/**
	 * Sets a member's code (permission checks are the caller's job).
	 *
	 * Codes must be at least 6 characters and unique across the team. Setting a code
	 * revokes all of the member's sessions.
	 *
	 * @param string $member_id Member id.
	 * @param string $code      New code.
	 * @return true|WP_Error
	 */
	public static function set_code( $member_id, $code ) {
		global $wpdb;

		$code = trim( (string) $code );
		if ( strlen( $code ) < self::CODE_MIN_LENGTH ) {
			return new WP_Error(
				'grp_code_too_short',
				/* translators: %d: minimum number of characters. */
				sprintf( __( 'Use at least %d characters for the code.', 'gridrankers-portal' ), self::CODE_MIN_LENGTH ),
				array( 'status' => 400 )
			);
		}

		if ( ! self::get_member( $member_id ) ) {
			return new WP_Error( 'grp_member_not_found', __( 'That person no longer exists.', 'gridrankers-portal' ), array( 'status' => 404 ) );
		}

		$taken = self::find_member_by_code( $code, false );
		if ( $taken && $taken['id'] !== $member_id ) {
			return new WP_Error( 'grp_code_taken', __( 'Someone else already uses that code. Pick another.', 'gridrankers-portal' ), array( 'status' => 409 ) );
		}

		$now = GRP_Ids::now();
		$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table( 'grp_members' ),
			array(
				'code_hash'   => password_hash( $code, PASSWORD_DEFAULT ),
				'code_salt'   => null,
				'code_set_at' => $now,
				'updated_at'  => $now,
			),
			array( 'id' => $member_id )
		);

		self::revoke_sessions( $member_id );

		return true;
	}

	/**
	 * A random code from CODE_ALPHABET.
	 *
	 * @return string
	 */
	public static function generate_code() {
		$max  = strlen( self::CODE_ALPHABET ) - 1;
		$code = '';
		for ( $i = 0; $i < self::CODE_GENERATED_LENGTH; $i++ ) {
			$code .= self::CODE_ALPHABET[ random_int( 0, $max ) ];
		}

		return $code;
	}

	/**
	 * Deletes every session of a member and revokes their desktop devices (SPEC.md 6.21).
	 *
	 * @param string $member_id Member id.
	 */
	public static function revoke_sessions( $member_id ) {
		global $wpdb;

		$wpdb->delete( self::table( 'grp_sessions' ), array( 'member_id' => $member_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$now = GRP_Ids::now();
		$wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'UPDATE %i SET revoked_at = %s, updated_at = %s WHERE member_id = %s AND revoked_at IS NULL', self::table( 'grp_devices' ), $now, $now, $member_id )
		);
		self::$current = false;
	}

	/**
	 * Whether sign-in from this IP is currently locked.
	 *
	 * @param string $ip Client IP address.
	 * @return bool
	 */
	public static function is_locked( $ip ) {
		$state = get_transient( self::lock_key( $ip ) );

		return is_array( $state ) && ! empty( $state['until'] ) && $state['until'] > time();
	}

	/**
	 * Client IP address. Uses REMOTE_ADDR only; filter `grp_client_ip` behind a trusted proxy.
	 *
	 * @return string
	 */
	public static function client_ip() {
		$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';

		return (string) apply_filters( 'grp_client_ip', $ip );
	}

	/**
	 * Team member row without secret columns.
	 *
	 * @param array $member Member row.
	 * @return array
	 */
	public static function public_member( array $member ) {
		$member['has_code'] = ! empty( $member['code_hash'] );
		unset( $member['code_hash'], $member['code_salt'] );

		return $member;
	}

	/**
	 * Resolves the current member: a linked WordPress administrator first, then the session cookie.
	 *
	 * @return array|null
	 */
	private static function resolve_current_member() {
		global $wpdb;

		if ( null !== self::$bearer ) {
			return self::resolve_device();
		}

		$wp_user_id = get_current_user_id();
		if ( $wp_user_id && user_can( $wp_user_id, 'manage_options' ) ) {
			$member = self::member_for_wp_user( $wp_user_id );
			if ( $member ) {
				return $member;
			}
		}

		$token = self::request_token();
		if ( ! $token ) {
			return null;
		}

		$members  = self::table( 'grp_members' );
		$sessions = self::table( 'grp_sessions' );
		$member   = $wpdb->get_row( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT m.* FROM %i m INNER JOIN %i s ON s.member_id = m.id
				WHERE s.token_hash = %s AND s.expires_at > %s AND m.active = 1 AND m.role <> %s',
				$members,
				$sessions,
				self::hash_token( $token ),
				GRP_Ids::now(),
				GRP_Permissions::ROLE_ADMIN
			),
			ARRAY_A
		);

		return $member ? $member : null;
	}

	/**
	 * Resolves the device token: an active Team Leader or Team Member on a device that is neither
	 * revoked nor expired. Renews the device's expiry and last-seen time every few minutes.
	 *
	 * @return array|null
	 */
	private static function resolve_device() {
		global $wpdb;

		if ( '' === self::$bearer ) {
			return null;
		}

		$now = GRP_Ids::now();
		$row = $wpdb->get_row( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT d.id AS grp_device_id, d.last_seen_at AS grp_device_seen, m.* FROM %i m INNER JOIN %i d ON d.member_id = m.id
				WHERE d.token_hash = %s AND d.revoked_at IS NULL AND d.expires_at > %s AND m.active = 1 AND m.role <> %s',
				self::table( 'grp_members' ),
				self::table( 'grp_devices' ),
				self::hash_token( self::$bearer ),
				$now,
				GRP_Permissions::ROLE_ADMIN
			),
			ARRAY_A
		);
		if ( ! $row ) {
			return null;
		}

		$device_id = $row['grp_device_id'];
		$seen      = $row['grp_device_seen'] ? strtotime( $row['grp_device_seen'] . ' UTC' ) : 0;
		unset( $row['grp_device_id'], $row['grp_device_seen'] );
		if ( time() - $seen >= self::DEVICE_TOUCH_SECONDS ) {
			$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				self::table( 'grp_devices' ),
				array(
					'last_seen_at' => $now,
					'expires_at'   => GRP_Ids::now( time() + self::DEVICE_TTL ),
					'ip'           => substr( self::client_ip(), 0, 45 ),
					'updated_at'   => $now,
				),
				array( 'id' => $device_id )
			);
		}
		self::$device = self::public_device( GRP_Store::get( 'grp_devices', $device_id ) );

		return $row;
	}

	/**
	 * A single-line text, trimmed to a length.
	 *
	 * @param mixed $value Value.
	 * @param int   $max   Most characters.
	 * @return string
	 */
	private static function clip( $value, $max ) {
		return mb_substr( sanitize_text_field( (string) $value ), 0, $max );
	}

	/**
	 * Active member linked to a WordPress user.
	 *
	 * @param int $wp_user_id WordPress user id.
	 * @return array|null
	 */
	private static function member_for_wp_user( $wp_user_id ) {
		global $wpdb;

		$member = $wpdb->get_row( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				'SELECT * FROM %i WHERE wp_user_id = %d AND active = 1 ORDER BY created_at ASC LIMIT 1',
				self::table( 'grp_members' ),
				$wp_user_id
			),
			ARRAY_A
		);

		return $member ? $member : null;
	}

	/**
	 * Member by id.
	 *
	 * @param string $id Member id.
	 * @return array|null
	 */
	private static function get_member( $id ) {
		global $wpdb;

		$member = $wpdb->get_row( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'SELECT * FROM %i WHERE id = %s', self::table( 'grp_members' ), $id ),
			ARRAY_A
		);

		return $member ? $member : null;
	}

	/**
	 * Finds the member whose code matches. Codes are unique, so the first match wins.
	 *
	 * @param string $code         Code as typed.
	 * @param bool   $signing_in   True for sign-in: only active non-admin members match,
	 *                             and legacy hashes are upgraded on match.
	 * @return array|null
	 */
	private static function find_member_by_code( $code, $signing_in = true ) {
		global $wpdb;

		$rows = $wpdb->get_results( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare(
				"SELECT * FROM %i WHERE code_hash IS NOT NULL AND code_hash <> ''",
				self::table( 'grp_members' )
			),
			ARRAY_A
		);

		foreach ( $rows as $row ) {
			if ( ! self::code_matches( $code, $row ) ) {
				continue;
			}
			if ( ! $signing_in ) {
				return $row;
			}
			if ( ! (int) $row['active'] || GRP_Permissions::ROLE_ADMIN === $row['role'] ) {
				return null;
			}
			return self::upgrade_hash( $code, $row );
		}

		return null;
	}

	/**
	 * Verifies a code against a member's stored hash (password_hash or legacy sha256).
	 *
	 * @param string $code   Code as typed.
	 * @param array  $member Member row.
	 * @return bool
	 */
	private static function code_matches( $code, array $member ) {
		if ( ! empty( $member['code_salt'] ) ) {
			return hash_equals( strtolower( (string) $member['code_hash'] ), hash( 'sha256', $member['code_salt'] . ':' . $code ) );
		}

		return password_verify( $code, (string) $member['code_hash'] );
	}

	/**
	 * Rehashes a legacy or outdated hash with password_hash() and clears the salt.
	 *
	 * @param string $code   Verified code.
	 * @param array  $member Member row.
	 * @return array Updated member row.
	 */
	private static function upgrade_hash( $code, array $member ) {
		global $wpdb;

		if ( empty( $member['code_salt'] ) && ! password_needs_rehash( $member['code_hash'], PASSWORD_DEFAULT ) ) {
			return $member;
		}

		$member['code_hash']  = password_hash( $code, PASSWORD_DEFAULT );
		$member['code_salt']  = null;
		$member['updated_at'] = GRP_Ids::now();

		$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table( 'grp_members' ),
			array(
				'code_hash'  => $member['code_hash'],
				'code_salt'  => null,
				'updated_at' => $member['updated_at'],
			),
			array( 'id' => $member['id'] )
		);

		return $member;
	}

	/**
	 * Stores a new session and returns its raw token. Only the token's hash is stored.
	 *
	 * @param string $member_id  Member id.
	 * @param string $ip         Client IP address.
	 * @param string $user_agent Client user agent.
	 * @return string
	 */
	private static function create_session( $member_id, $ip, $user_agent ) {
		global $wpdb;

		$table = self::table( 'grp_sessions' );
		$now   = GRP_Ids::now();
		$token = bin2hex( random_bytes( 32 ) );

		// Housekeeping: drop this member's expired sessions.
		$wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'DELETE FROM %i WHERE member_id = %s AND expires_at <= %s', $table, $member_id, $now )
		);

		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$table,
			array(
				'id'         => GRP_Ids::ulid(),
				'member_id'  => $member_id,
				'token_hash' => self::hash_token( $token ),
				'expires_at' => GRP_Ids::now( time() + self::SESSION_TTL ),
				'ip'         => substr( (string) $ip, 0, 45 ),
				'user_agent' => substr( (string) $user_agent, 0, 255 ),
				'created_at' => $now,
				'updated_at' => $now,
			)
		);

		return $token;
	}

	/**
	 * Session token from this request (issued now, or from the cookie).
	 *
	 * @return string|null
	 */
	private static function request_token() {
		if ( self::$request_token ) {
			return self::$request_token;
		}

		$token = isset( $_COOKIE[ self::COOKIE ] ) ? sanitize_text_field( wp_unslash( $_COOKIE[ self::COOKIE ] ) ) : '';

		return preg_match( '/^[a-f0-9]{64}$/', $token ) ? $token : null;
	}

	/**
	 * Sends the session cookie: HttpOnly, SameSite=Lax, Secure on HTTPS.
	 *
	 * @param string $value   Token, or '' to clear.
	 * @param int    $expires Unix expiry time.
	 */
	private static function set_cookie( $value, $expires ) {
		if ( headers_sent() ) {
			return;
		}

		setcookie(
			self::COOKIE,
			$value,
			array(
				'expires'  => $expires,
				'path'     => COOKIEPATH ? COOKIEPATH : '/',
				'domain'   => COOKIE_DOMAIN ? COOKIE_DOMAIN : '',
				'secure'   => is_ssl(),
				'httponly' => true,
				'samesite' => 'Lax',
			)
		);
	}

	/**
	 * Hash of a session token as stored in `grp_sessions`.
	 *
	 * @param string $token Raw token.
	 * @return string
	 */
	private static function hash_token( $token ) {
		return hash( 'sha256', $token );
	}

	/**
	 * Counts a failed attempt from outside sign-in (a wrong link key, SPEC.md 6.22) toward the same
	 * lockout as wrong codes.
	 *
	 * @param string $ip Client IP address.
	 */
	public static function count_failure( $ip ) {
		self::record_failure( $ip );
	}

	/**
	 * Counts a failed attempt; the 5th failure locks the IP for 15 minutes.
	 *
	 * @param string $ip Client IP address.
	 */
	private static function record_failure( $ip ) {
		$state = get_transient( self::lock_key( $ip ) );
		$count = ( is_array( $state ) ? (int) $state['count'] : 0 ) + 1;

		set_transient(
			self::lock_key( $ip ),
			array(
				'count' => $count,
				'until' => $count >= self::MAX_ATTEMPTS ? time() + self::LOCK_SECONDS : 0,
			),
			self::LOCK_SECONDS
		);
	}

	/**
	 * Clears failed attempts after a successful sign-in.
	 *
	 * @param string $ip Client IP address.
	 */
	private static function clear_failures( $ip ) {
		delete_transient( self::lock_key( $ip ) );
	}

	/**
	 * Transient key for an IP's failed attempts.
	 *
	 * @param string $ip Client IP address.
	 * @return string
	 */
	private static function lock_key( $ip ) {
		return 'grp_login_' . md5( (string) $ip );
	}

	/**
	 * Prefixed table name.
	 *
	 * @param string $name Unprefixed table name.
	 * @return string
	 */
	private static function table( $name ) {
		return GRP_Install::table( $name );
	}
}
