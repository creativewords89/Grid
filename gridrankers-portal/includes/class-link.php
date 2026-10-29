<?php
/**
 * The link between the main portal and the tracker portal (SPEC.md 6.22).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Which part this site plays (on its own, main portal, tracker portal), the link key and the
 * tracker portal's calls to the main portal.
 *
 * On the main portal the key is stored hashed in `grp_link`; on the tracker portal it is kept as
 * typed in the non-autoloaded option `grp_link_key`, since the tracker sends it on every call.
 */
class GRP_Link {

	/**
	 * Option: `{part, tracker_url, key_hash, made_at}` (main) or `{part, main_url, last_copy_at, last_error}` (tracker).
	 */
	const OPTION = 'grp_link';

	/**
	 * Option: the link key on a tracker portal (not autoloaded).
	 */
	const KEY_OPTION = 'grp_link_key';

	/**
	 * A site on its own (the default).
	 */
	const ALONE = 'alone';

	/**
	 * The main portal: profiles, reports and pay live here.
	 */
	const MAIN = 'main';

	/**
	 * The tracker portal: copies profiles from the main portal, sends it the hours.
	 */
	const TRACKER = 'tracker';

	/**
	 * Seconds a call to the main portal may take.
	 */
	const TIMEOUT = 15;

	/**
	 * The stored settings with defaults.
	 *
	 * @return array
	 */
	public static function settings() {
		$saved = get_option( self::OPTION, array() );

		return array_merge(
			array(
				'part'         => self::ALONE,
				'tracker_url'  => '',
				'key_hash'     => '',
				'made_at'      => null,
				'main_url'     => '',
				'last_copy_at' => null,
				'last_error'   => null,
			),
			is_array( $saved ) ? $saved : array()
		);
	}

	/**
	 * This site's part: alone, main or tracker.
	 *
	 * @return string
	 */
	public static function part() {
		$part = self::settings()['part'];

		return in_array( $part, array( self::MAIN, self::TRACKER ), true ) ? $part : self::ALONE;
	}

	/**
	 * Whether this site is a main portal.
	 *
	 * @return bool
	 */
	public static function is_main() {
		return self::MAIN === self::part();
	}

	/**
	 * Whether this site is a tracker portal.
	 *
	 * @return bool
	 */
	public static function is_tracker() {
		return self::TRACKER === self::part();
	}

	/**
	 * Saves part of the settings.
	 *
	 * @param array $changes Keys to change.
	 * @return array The settings.
	 */
	private static function save( array $changes ) {
		$settings = array_merge( self::settings(), $changes );
		update_option( self::OPTION, $settings, false );

		return $settings;
	}

	/**
	 * A clean site address: https (http only for this computer), no path, query or trailing slash.
	 *
	 * @param string $url Typed address.
	 * @return string|WP_Error
	 */
	public static function clean_url( $url ) {
		$url = trim( (string) $url );
		if ( '' !== $url && ! preg_match( '#^[a-z][a-z0-9+.-]*://#i', $url ) ) {
			$url = 'https://' . $url;
		}
		$parts  = wp_parse_url( $url );
		$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
		$host   = strtolower( (string) ( $parts['host'] ?? '' ) );
		$local  = in_array( $host, array( 'localhost', '127.0.0.1' ), true );
		if ( '' === $host || ! ( 'https' === $scheme || ( 'http' === $scheme && $local ) ) || isset( $parts['user'] ) || isset( $parts['query'] ) ) {
			return new WP_Error( 'grp_link_url', __( 'Type the site address, starting with https:// (for example https://bot.gridrankers.com).', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$path = rtrim( (string) ( $parts['path'] ?? '' ), '/' );

		return $scheme . '://' . $host . ( isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '' ) . $path;
	}

	/**
	 * Sets this site on its own: the link ends on both sides of it.
	 */
	public static function set_alone() {
		delete_option( self::KEY_OPTION );
		self::save(
			array(
				'part'     => self::ALONE,
				'key_hash' => '',
				'made_at'  => null,
			)
		);
	}

	/**
	 * Sets this site as the main portal for a tracker portal's address.
	 *
	 * @param string $tracker_url The tracker portal's address.
	 * @return array|WP_Error The settings.
	 */
	public static function set_main( $tracker_url ) {
		$url = self::clean_url( $tracker_url );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		delete_option( self::KEY_OPTION );

		return self::save(
			array(
				'part'        => self::MAIN,
				'tracker_url' => $url,
			)
		);
	}

	/**
	 * Makes a new link key on the main portal: the old one stops working at once. The key is
	 * returned once, to show and copy; only its hash is kept.
	 *
	 * @return string|WP_Error
	 */
	public static function make_key() {
		if ( ! self::is_main() ) {
			return new WP_Error( 'grp_link_off', __( 'Set this site to Main portal first.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$key = bin2hex( random_bytes( 32 ) );
		self::save(
			array(
				'key_hash' => hash( 'sha256', $key ),
				'made_at'  => gmdate( 'Y-m-d H:i:s' ),
			)
		);

		return $key;
	}

	/**
	 * Unlink on the main portal: no key works any more.
	 */
	public static function unlink() {
		self::save(
			array(
				'key_hash' => '',
				'made_at'  => null,
			)
		);
	}

	/**
	 * Whether a main portal has a key.
	 *
	 * @return bool
	 */
	public static function has_key() {
		return self::is_main() && '' !== self::settings()['key_hash'];
	}

	/**
	 * Whether a key is this main portal's link key.
	 *
	 * @param string $key Key from the request.
	 * @return bool
	 */
	public static function key_ok( $key ) {
		$hash = self::settings()['key_hash'];

		return self::is_main() && '' !== $hash && preg_match( '/^[a-f0-9]{64}$/', (string) $key ) && hash_equals( $hash, hash( 'sha256', (string) $key ) );
	}

	/**
	 * Sets this site as a tracker portal of a main portal.
	 *
	 * @param string      $main_url The main portal's address.
	 * @param string|null $key      The link key; null or '' keeps the saved one.
	 * @return array|WP_Error The settings.
	 */
	public static function set_tracker( $main_url, $key = null ) {
		$url = self::clean_url( $main_url );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		$key = strtolower( trim( (string) $key ) );
		if ( '' === $key ) {
			$key = (string) get_option( self::KEY_OPTION, '' );
		}
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $key ) ) {
			return new WP_Error( 'grp_link_key_format', __( 'Paste the link key made on the main portal: 64 letters and numbers.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		update_option( self::KEY_OPTION, $key, false );

		return self::save(
			array(
				'part'     => self::TRACKER,
				'main_url' => $url,
				'key_hash' => '',
				'made_at'  => null,
			)
		);
	}

	/**
	 * The main portal's address on a tracker portal, '' when not set.
	 *
	 * @return string
	 */
	public static function main_url() {
		return self::is_tracker() ? (string) self::settings()['main_url'] : '';
	}

	/**
	 * Calls the main portal's `/link/{path}` from a tracker portal.
	 *
	 * @param string     $method HTTP method.
	 * @param string     $path   Path under /link/, e.g. `ping`.
	 * @param array|null $body   JSON body.
	 * @return array|WP_Error The answer.
	 */
	public static function call( $method, $path, $body = null ) {
		$main = self::main_url();
		$key  = (string) get_option( self::KEY_OPTION, '' );
		if ( '' === $main || '' === $key ) {
			return new WP_Error( 'grp_link_off', __( 'Set this site to Tracker portal with the main portal’s address and link key first.', 'gridrankers-portal' ) );
		}
		$host = (string) wp_parse_url( $main, PHP_URL_HOST );
		$url  = add_query_arg( 'rest_route', rawurlencode( '/' . GRP_REST_Auth::REST_NAMESPACE . '/link/' . ltrim( $path, '/' ) ), $main . '/' );
		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT,
			'redirection' => 0,
			'headers'     => array(
				'Authorization' => 'Bearer ' . $key,
				'Accept'        => 'application/json',
			),
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}

		$res = wp_remote_request( $url, $args );
		if ( is_wp_error( $res ) ) {
			/* translators: %s: site address, e.g. bot.gridrankers.com. */
			return new WP_Error( 'grp_link_unreachable', sprintf( __( 'Can’t reach %s. Check the address, or try again in a minute.', 'gridrankers-portal' ), $host ) );
		}
		$status = (int) wp_remote_retrieve_response_code( $res );
		$data   = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$code   = is_array( $data ) ? (string) ( $data['code'] ?? '' ) : '';

		if ( 401 === $status && 'grp_link_key' === $code ) {
			/* translators: %s: site address. */
			return new WP_Error( 'grp_link_key', sprintf( __( 'The link key is wrong. Make a new one on %s and paste it here.', 'gridrankers-portal' ), $host ) );
		}
		if ( 404 === $status && 'grp_link_off' === $code ) {
			/* translators: %s: site address. */
			return new WP_Error( 'grp_link_off', sprintf( __( '%s isn’t set to Main portal (WP admin → GridRankers → Settings → Sites).', 'gridrankers-portal' ), $host ) );
		}
		if ( 404 === $status && in_array( $code, array( 'rest_no_route', 'rest_invalid_handler' ), true ) ) {
			/* translators: %s: site address. */
			return new WP_Error( 'grp_link_old', sprintf( __( '%s doesn’t have the link yet. Update its GridRankers Portal plugin.', 'gridrankers-portal' ), $host ) );
		}
		if ( ! is_array( $data ) ) {
			/* translators: %s: site address. */
			return new WP_Error( 'grp_link_not_portal', sprintf( __( '%s isn’t a GridRankers portal.', 'gridrankers-portal' ), $host ) );
		}
		if ( $status < 200 || $status >= 300 ) {
			return new WP_Error( '' !== $code ? $code : 'grp_link_failed', (string) ( $data['message'] ?? __( 'Something went wrong. Try again.', 'gridrankers-portal' ) ), array( 'status' => $status ) );
		}

		return $data;
	}

	/**
	 * Test connection on a tracker portal: asks the main portal's `/link/ping`.
	 *
	 * @return array|WP_Error `{message, ...ping}` or why not.
	 */
	public static function test() {
		$ping = self::call( 'GET', 'ping' );
		if ( is_wp_error( $ping ) ) {
			self::save( array( 'last_error' => $ping->get_error_message() ) );
			return $ping;
		}
		self::save( array( 'last_error' => null ) );
		$host = (string) wp_parse_url( self::main_url(), PHP_URL_HOST );

		return array_merge(
			$ping,
			array(
				/* translators: 1: site address, 2: number of people. */
				'message' => sprintf( _n( 'Connected to %1$s · %2$d person', 'Connected to %1$s · %2$d people', (int) ( $ping['people'] ?? 0 ), 'gridrankers-portal' ), $host, (int) ( $ping['people'] ?? 0 ) ),
			)
		);
	}

	/**
	 * Records the tracker portal's last copy from the main portal.
	 *
	 * @param string|null $error Why it failed, or null when it worked.
	 */
	public static function copied( $error ) {
		self::save(
			null === $error ? array(
				'last_copy_at' => gmdate( 'Y-m-d H:i:s' ),
				'last_error'   => null,
			) : array( 'last_error' => $error )
		);
	}

	/**
	 * Gate for `/link/*` (called by the API guard): only on a main portal, only with the link key,
	 * and wrong keys count against the IP like wrong codes.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public static function guard( WP_REST_Request $request ) {
		if ( ! self::is_main() ) {
			return new WP_Error( 'grp_link_off', __( 'This site isn’t a main portal.', 'gridrankers-portal' ), array( 'status' => 404 ) );
		}
		$ip = GRP_Auth::client_ip();
		if ( GRP_Auth::is_locked( $ip ) ) {
			return new WP_Error( 'grp_link_locked', __( 'Too many wrong link keys. Try again in 15 minutes.', 'gridrankers-portal' ), array( 'status' => 429 ) );
		}
		$key = preg_match( '/^Bearer\s+(\S+)$/i', trim( (string) $request->get_header( 'Authorization' ) ), $m ) ? $m[1] : '';
		if ( ! self::key_ok( $key ) ) {
			GRP_Auth::count_failure( $ip );
			return new WP_Error( 'grp_link_key', __( 'The link key is wrong.', 'gridrankers-portal' ), array( 'status' => 401 ) );
		}

		return true;
	}

	/**
	 * Permission callback of the `/link/*` routes (the guard already ran; this checks again).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return bool
	 */
	public static function request_ok( WP_REST_Request $request ) {
		return preg_match( '/^Bearer\s+(\S+)$/i', trim( (string) $request->get_header( 'Authorization' ) ), $m ) && self::key_ok( $m[1] );
	}
}
