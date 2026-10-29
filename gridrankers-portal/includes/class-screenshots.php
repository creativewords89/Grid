<?php
/**
 * Screenshots of tracked time (SPEC.md 6.23, tracker portal).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * The setting (how often the desktop app takes one while a timer runs), storing the pictures
 * privately, who sees them, and removing them after 30 days or with their time entry.
 */
class GRP_Screenshots {

	const TABLE = 'grp_screenshots';

	/**
	 * Setting key (`{every: minutes}`).
	 */
	const KEY = 'screenshots';

	/**
	 * The choices, in minutes (0 = off).
	 */
	const EVERY = array( 0, 5, 10, 15, 30 );

	/**
	 * Largest picture.
	 */
	const MAX_BYTES = 2097152;

	/**
	 * Kept this many days.
	 */
	const KEEP_DAYS = 30;

	/**
	 * Folder inside the private uploads folder.
	 */
	const DIR = 'shots';

	/**
	 * Picture types.
	 */
	const TYPES = array(
		IMAGETYPE_JPEG => 'jpg',
		IMAGETYPE_PNG  => 'png',
	);

	/**
	 * How often the desktop app takes one, in minutes: 0 (off) anywhere but a tracker portal.
	 *
	 * @return int
	 */
	public static function every() {
		if ( ! GRP_Link::is_tracker() ) {
			return 0;
		}
		$value = (array) GRP_REST_People::setting( self::KEY );
		$every = (int) ( $value['every'] ?? 0 );

		return in_array( $every, self::EVERY, true ) ? $every : 0;
	}

	/**
	 * Sets how often (Super Admin; the caller checks).
	 *
	 * @param int $every Minutes, one of EVERY.
	 * @return int|WP_Error
	 */
	public static function set_every( $every ) {
		if ( ! GRP_Link::is_tracker() ) {
			return new WP_Error( 'grp_tracker_only', __( 'Screenshots are set on the tracker portal.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		$every = (int) $every;
		if ( ! in_array( $every, self::EVERY, true ) ) {
			return new WP_Error( 'grp_invalid', __( 'Pick Off, or every 5, 10, 15 or 30 minutes.', 'gridrankers-portal' ), array( 'status' => 400 ) );
		}
		GRP_REST_People::set_setting( self::KEY, array( 'every' => $every ) );

		return $every;
	}

	/**
	 * Stores a screenshot of a person's time entry, sent by their desktop app. Sent again (same id),
	 * it is not stored twice.
	 *
	 * @param array  $member   The person (the actor).
	 * @param array  $entry    Their time entry.
	 * @param array  $upload   One entry of `$_FILES`.
	 * @param string $id       Id made on the computer.
	 * @param string $taken_at `Y-m-d H:i:s` UTC.
	 * @return array|WP_Error `{status: saved|exists, screenshot}`.
	 */
	public static function store( array $member, array $entry, array $upload, $id, $taken_at ) {
		$id = (string) $id;
		if ( ! preg_match( '/^[\w-]{8,64}$/', $id ) ) {
			return self::error( __( 'That screenshot has no valid id.', 'gridrankers-portal' ) );
		}
		$known = GRP_Store::get( self::TABLE, $id );
		if ( $known ) {
			if ( (string) $known['member_id'] !== (string) $member['id'] ) {
				return self::error( __( 'That screenshot id is taken.', 'gridrankers-portal' ), 409 );
			}
			return array(
				'status'     => 'exists',
				'screenshot' => self::meta( $known ),
			);
		}
		if ( (string) $entry['member_id'] !== (string) $member['id'] || ! empty( $entry['deleted_at'] ) ) {
			return self::error( __( 'That time entry isn’t yours.', 'gridrankers-portal' ), 403 );
		}
		if ( ! self::every() ) {
			return self::error( __( 'Screenshots are off.', 'gridrankers-portal' ), 409, 'grp_screenshots_off' );
		}
		$taken_at = (string) $taken_at;
		$end      = empty( $entry['ended_at'] ) ? GRP_Ids::now( time() + 120 ) : GRP_Ids::now( strtotime( $entry['ended_at'] . ' UTC' ) + 120 );
		if ( ! GRP_Time::is_datetime( $taken_at ) || $taken_at < (string) $entry['started_at'] || $taken_at > $end ) {
			return self::error( __( 'That screenshot wasn’t taken while this timer ran.', 'gridrankers-portal' ) );
		}

		if ( ! empty( $upload['error'] ) || empty( $upload['tmp_name'] ) || ! is_file( $upload['tmp_name'] ) ) {
			return self::error( __( 'The screenshot did not arrive. Try again.', 'gridrankers-portal' ) );
		}
		$size = (int) filesize( $upload['tmp_name'] );
		if ( $size <= 0 || $size > self::MAX_BYTES ) {
			return self::error( __( 'A screenshot can be at most 2 MB.', 'gridrankers-portal' ), 413 );
		}
		$info = getimagesize( $upload['tmp_name'] );
		if ( ! $info || ! isset( self::TYPES[ $info[2] ] ) ) {
			return self::error( __( 'A screenshot must be a JPEG or PNG picture.', 'gridrankers-portal' ) );
		}

		$dir = GRP_Files::base_dir();
		if ( is_wp_error( $dir ) ) {
			return $dir;
		}
		$sub = self::DIR . '/' . gmdate( 'Y/m' );
		if ( ! wp_mkdir_p( "$dir/$sub" ) ) {
			return self::error( __( 'The uploads folder is not writable.', 'gridrankers-portal' ), 500 );
		}
		$path = $sub . '/' . strtolower( $id ) . '-' . strtolower( wp_generate_password( 12, false ) ) . '.' . self::TYPES[ $info[2] ];

		/** This filter is documented in includes/class-files.php */
		$moved = apply_filters( 'grp_files_move', null, $upload['tmp_name'], "$dir/$path" );
		if ( null === $moved ) {
			$moved = is_uploaded_file( $upload['tmp_name'] ) && move_uploaded_file( $upload['tmp_name'], "$dir/$path" );
		}
		if ( ! $moved ) {
			return self::error( __( 'The screenshot could not be saved. Try again.', 'gridrankers-portal' ), 500 );
		}

		$row = GRP_Store::insert(
			self::TABLE,
			array(
				'id'        => $id,
				'member_id' => (string) $member['id'],
				'entry_id'  => (string) $entry['id'],
				'day'       => (string) $entry['day'],
				'taken_at'  => $taken_at,
				'path'      => $path,
				'width'     => (int) $info[0],
				'height'    => (int) $info[1],
				'size'      => $size,
			)
		);

		return array(
			'status'     => 'saved',
			'screenshot' => self::meta( $row ),
		);
	}

	/**
	 * What the portal shows of a screenshot (never its path).
	 *
	 * @param array $row Row.
	 * @return array
	 */
	public static function meta( array $row ) {
		return array(
			'id'        => (string) $row['id'],
			'member_id' => (string) $row['member_id'],
			'entry_id'  => (string) $row['entry_id'],
			'day'       => (string) $row['day'],
			'taken_at'  => (string) $row['taken_at'],
			'width'     => (int) $row['width'],
			'height'    => (int) $row['height'],
		);
	}

	/**
	 * A person's screenshots on a day, by time.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 * @return array[]
	 */
	public static function of_day( $member_id, $day ) {
		return array_map(
			array( __CLASS__, 'meta' ),
			GRP_Store::find(
				self::TABLE,
				array(
					'member_id' => (string) $member_id,
					'day'       => (string) $day,
				),
				array( 'order_by' => 'taken_at' )
			)
		);
	}

	/**
	 * Absolute path of a screenshot's picture, or null when it is gone.
	 *
	 * @param array $row Row.
	 * @return string|null
	 */
	public static function path( array $row ) {
		$dir = GRP_Files::base_dir();
		if ( is_wp_error( $dir ) || ! preg_match( '#^shots/\d{4}/\d{2}/[a-z0-9_-]+\.(jpg|png)$#', (string) $row['path'] ) ) {
			return null;
		}
		$path = "$dir/{$row['path']}";

		return is_file( $path ) ? $path : null;
	}

	/**
	 * Deletes a screenshot and its picture.
	 *
	 * @param array $row Row.
	 */
	public static function delete( array $row ) {
		$path = self::path( $row );
		if ( $path ) {
			wp_delete_file( $path );
		}
		GRP_Store::delete( self::TABLE, (string) $row['id'] );
	}

	/**
	 * Deletes a time entry's screenshots (the entry was deleted).
	 *
	 * @param string $entry_id Entry.
	 * @return int How many.
	 */
	public static function delete_for_entry( $entry_id ) {
		$rows = GRP_Store::find( self::TABLE, array( 'entry_id' => (string) $entry_id ) );
		array_map( array( __CLASS__, 'delete' ), $rows );

		return count( $rows );
	}

	/**
	 * The hourly job: deletes screenshots older than 30 days.
	 *
	 * @param string|null $now Now (UTC).
	 * @return int How many.
	 */
	public static function purge( $now = null ) {
		$now  = $now ? $now : GRP_Ids::now();
		$rows = GRP_Store::find( self::TABLE, array( 'taken_at <' => GRP_Ids::now( strtotime( $now . ' UTC' ) - self::KEEP_DAYS * DAY_IN_SECONDS ) ) );
		array_map( array( __CLASS__, 'delete' ), $rows );

		return count( $rows );
	}

	/**
	 * An error.
	 *
	 * @param string $message Message.
	 * @param int    $status  HTTP status.
	 * @param string $code    Code.
	 * @return WP_Error
	 */
	private static function error( $message, $status = 400, $code = 'grp_screenshot' ) {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}
}
