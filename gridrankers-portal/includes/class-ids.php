<?php
/**
 * Identifier and timestamp helpers.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * ULID ids (SPEC.md section 5) and UTC DATETIME strings.
 */
class GRP_Ids {

	/**
	 * Crockford base32 alphabet used by ULIDs.
	 */
	const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

	/**
	 * A new 26-character ULID: 48-bit millisecond timestamp + 80 random bits.
	 *
	 * @return string
	 */
	public static function ulid() {
		$time = (int) floor( microtime( true ) * 1000 );
		$out  = '';

		for ( $i = 0; $i < 10; $i++ ) {
			$out  = self::ULID_ALPHABET[ $time % 32 ] . $out;
			$time = intdiv( $time, 32 );
		}

		$random = random_bytes( 10 );
		$bits   = '';
		for ( $i = 0; $i < 10; $i++ ) {
			$bits .= str_pad( decbin( ord( $random[ $i ] ) ), 8, '0', STR_PAD_LEFT );
		}
		foreach ( str_split( $bits, 5 ) as $chunk ) {
			$out .= self::ULID_ALPHABET[ bindec( $chunk ) ];
		}

		return $out;
	}

	/**
	 * Current time as a UTC MySQL DATETIME string.
	 *
	 * @param int|null $timestamp Unix timestamp, defaults to now.
	 * @return string
	 */
	public static function now( $timestamp = null ) {
		return gmdate( 'Y-m-d H:i:s', null === $timestamp ? time() : $timestamp );
	}
}
