<?php
/**
 * Row access for the plugin tables: prepared queries, JSON/int decoding, transactions, tombstones.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Thin data layer shared by the REST controllers.
 *
 * Tables are named without the WordPress prefix (e.g. `grp_projects`). Rows come back
 * as arrays with JSON columns decoded and integer columns cast.
 */
class GRP_Store {

	/**
	 * JSON columns per table.
	 */
	const JSON_COLUMNS = array(
		'grp_members'          => array( 'weekly_off' ),
		'grp_posts'            => array( 'to_members' ),
		'grp_projects'         => array( 'cycle_changes', 'cycle_log', 'cycle_reviews', 'details', 'kw_columns' ),
		'grp_keywords'         => array( 'checks', 'past' ),
		'grp_comments'         => array( 'files' ),
		'grp_meeting_tasks'    => array( 'assignees', 'progress', 'deadline', 'review', 'completion', 'undo_request', 'steps', 'step_done' ),
		'grp_monthly_tasks'    => array( 'assignees', 'parts', 'steps' ),
		'grp_cycle_records'    => array( 'by_person', 'parts', 'review', 'completion', 'undo_request', 'step_done' ),
		'grp_audit'            => array( 'changes' ),
		'grp_trash'            => array( 'data' ),
		'grp_settings'         => array( 'value' ),
		'grp_billing'          => array( 'payments' ),
		'grp_request_messages' => array( 'files' ),
	);

	/**
	 * Integer columns (cast on read; NULL stays NULL).
	 */
	const INT_COLUMNS = array(
		'active',
		'with_project',
		'wp_user_id',
		'cycle_day',
		'cycle_set',
		'target',
		'team',
		'std',
		'due_day',
		'due_from_day',
		'week',
		'count',
		'qty',
		'minutes',
		'days',
		'birth_year',
		'pinned',
		'position',
		'size',
		'skipped',
		'remind_days',
		'from_client',
	);

	/**
	 * Money columns (cast to float on read; NULL stays NULL).
	 */
	const FLOAT_COLUMNS = array(
		'amount',
		'fee',
	);

	/**
	 * Tables whose deletions are recorded for GET /sync.
	 */
	const SYNCED_TABLES = array(
		'grp_members',
		'grp_projects',
		'grp_meeting_tasks',
		'grp_monthly_tasks',
		'grp_cycle_records',
		'grp_activity',
		'grp_trash',
		'grp_dismissals',
		'grp_settings',
		'grp_leave',
		'grp_days_off',
		'grp_posts',
		'grp_keywords',
		'grp_comments',
		'grp_billing',
		'grp_billing_fees',
		'grp_client_requests',
		'grp_request_messages',
	);

	/**
	 * Current transaction depth.
	 *
	 * @var int
	 */
	private static $depth = 0;

	/**
	 * Prefixed table name.
	 *
	 * @param string $table Unprefixed table name.
	 * @return string
	 */
	public static function table( $table ) {
		return GRP_Install::table( $table );
	}

	/**
	 * One row by id.
	 *
	 * @param string $table Table.
	 * @param string $id    Row id.
	 * @return array|null
	 */
	public static function get( $table, $id ) {
		global $wpdb;

		$row = $wpdb->get_row( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( 'SELECT * FROM %i WHERE id = %s', self::table( $table ), (string) $id ),
			ARRAY_A
		);

		return $row ? self::decode( $table, $row ) : null;
	}

	/**
	 * Rows matching simple conditions.
	 *
	 * @param string $table Table.
	 * @param array  $where Column => value (equality; null means IS NULL). Keys may end in
	 *                      ` >=`, ` <=`, ` >` or ` <` for comparisons.
	 * @param array  $args  `order_by` (column), `order` (ASC|DESC), `limit`, `offset`.
	 * @return array[]
	 */
	public static function find( $table, array $where = array(), array $args = array() ) {
		global $wpdb;

		list( $clause, $values ) = self::where( $where );

		$sql    = 'SELECT * FROM %i' . $clause;
		$params = array_merge( array( self::table( $table ) ), $values );

		if ( ! empty( $args['order_by'] ) ) {
			$order    = ( isset( $args['order'] ) && 'DESC' === strtoupper( $args['order'] ) ) ? 'DESC' : 'ASC';
			$sql     .= ' ORDER BY %i ' . $order . ', id ' . $order;
			$params[] = $args['order_by'];
		}
		if ( ! empty( $args['limit'] ) ) {
			$sql     .= ' LIMIT %d OFFSET %d';
			$params[] = (int) $args['limit'];
			$params[] = (int) ( $args['offset'] ?? 0 );
		}

		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared

		return array_map(
			static function ( $row ) use ( $table ) {
				return self::decode( $table, $row );
			},
			$rows ? $rows : array()
		);
	}

	/**
	 * Inserts a row. Sets `id` (ULID) when missing and the timestamps.
	 *
	 * @param string $table Table.
	 * @param array  $row   Column values (JSON columns as PHP arrays).
	 * @return array The stored row.
	 */
	public static function insert( $table, array $row ) {
		global $wpdb;

		$now = GRP_Ids::now();
		$row = array_merge(
			array(
				'id'         => GRP_Ids::ulid(),
				'created_at' => $now,
			),
			$row,
			array( 'updated_at' => $now )
		);

		$wpdb->insert( self::table( $table ), self::encode( $table, $row ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		return self::get( $table, $row['id'] );
	}

	/**
	 * Updates columns of a row and bumps `updated_at`.
	 *
	 * @param string $table   Table.
	 * @param string $id      Row id.
	 * @param array  $changes Column values (JSON columns as PHP arrays).
	 * @return array|null The updated row.
	 */
	public static function update( $table, $id, array $changes ) {
		global $wpdb;

		unset( $changes['id'], $changes['created_at'] );
		$changes['updated_at'] = GRP_Ids::now();

		$wpdb->update( self::table( $table ), self::encode( $table, $changes ), array( 'id' => $id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		return self::get( $table, $id );
	}

	/**
	 * Hard-deletes a row and records a tombstone for synced tables.
	 *
	 * @param string $table Table.
	 * @param string $id    Row id.
	 * @return bool Whether a row was deleted.
	 */
	public static function delete( $table, $id ) {
		global $wpdb;

		$deleted = (bool) $wpdb->delete( self::table( $table ), array( 'id' => $id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		if ( $deleted && in_array( $table, self::SYNCED_TABLES, true ) ) {
			$now = GRP_Ids::now();
			$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				self::table( 'grp_deletions' ),
				array(
					'id'         => GRP_Ids::ulid(),
					'table_name' => $table,
					'doc_id'     => $id,
					'deleted_at' => $now,
					'created_at' => $now,
					'updated_at' => $now,
				)
			);
		}

		return $deleted;
	}

	/**
	 * Runs `$callback` in a transaction. Rolls back and rethrows on exception, and rolls
	 * back when the callback returns a WP_Error. Nested calls use savepoints.
	 *
	 * @param callable $callback Work to do.
	 * @return mixed The callback's return value.
	 * @throws Throwable Whatever the callback throws.
	 */
	public static function transaction( callable $callback ) {
		// Inside an outer transaction (or the test suite's), only savepoints are safe.
		$savepoint = self::$depth > 0 || apply_filters( 'grp_use_savepoints', false );
		$name      = 'grp_sp_' . self::$depth;

		self::control( $savepoint ? "SAVEPOINT $name" : 'START TRANSACTION' );
		++self::$depth;

		try {
			$result = $callback();
		} catch ( Throwable $e ) {
			--self::$depth;
			self::control( $savepoint ? "ROLLBACK TO SAVEPOINT $name" : 'ROLLBACK' );
			throw $e;
		}

		--self::$depth;
		if ( is_wp_error( $result ) ) {
			self::control( $savepoint ? "ROLLBACK TO SAVEPOINT $name" : 'ROLLBACK' );
		} else {
			self::control( $savepoint ? "RELEASE SAVEPOINT $name" : 'COMMIT' );
		}

		return $result;
	}

	/**
	 * Runs a transaction-control statement built only from constants in transaction().
	 *
	 * @param string $sql Statement.
	 */
	private static function control( $sql ) {
		global $wpdb;

		$wpdb->query( $sql ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- no user input.
	}

	/**
	 * Decodes JSON columns and casts integer columns of a raw row.
	 *
	 * @param string $table Table.
	 * @param array  $row   Raw row.
	 * @return array
	 */
	public static function decode( $table, array $row ) {
		foreach ( self::JSON_COLUMNS[ $table ] ?? array() as $column ) {
			if ( isset( $row[ $column ] ) && is_string( $row[ $column ] ) ) {
				$row[ $column ] = self::canonical( json_decode( $row[ $column ], true ) );
			}
		}
		foreach ( self::INT_COLUMNS as $column ) {
			if ( isset( $row[ $column ] ) && is_numeric( $row[ $column ] ) ) {
				$row[ $column ] = (int) $row[ $column ];
			}
		}
		foreach ( self::FLOAT_COLUMNS as $column ) {
			if ( isset( $row[ $column ] ) && is_numeric( $row[ $column ] ) ) {
				$row[ $column ] = (float) $row[ $column ];
			}
		}

		return $row;
	}

	/**
	 * Sorts the keys of every JSON object in a value (lists keep their order). MySQL's JSON type
	 * reorders object keys while MariaDB keeps them, so rows read the same on both.
	 *
	 * @param mixed $value Decoded JSON value.
	 * @return mixed
	 */
	public static function canonical( $value ) {
		if ( ! is_array( $value ) ) {
			return $value;
		}
		$value = array_map( array( __CLASS__, 'canonical' ), $value );
		if ( ! array_is_list( $value ) ) {
			ksort( $value, SORT_STRING );
		}

		return $value;
	}

	/**
	 * Encodes JSON columns for writing.
	 *
	 * @param string $table Table.
	 * @param array  $row   Row.
	 * @return array
	 */
	private static function encode( $table, array $row ) {
		foreach ( self::JSON_COLUMNS[ $table ] ?? array() as $column ) {
			if ( array_key_exists( $column, $row ) && null !== $row[ $column ] && ! is_string( $row[ $column ] ) ) {
				$row[ $column ] = wp_json_encode( self::canonical( $row[ $column ] ) );
			}
		}

		return $row;
	}

	/**
	 * Builds a WHERE clause with placeholders.
	 *
	 * @param array $where Conditions.
	 * @return array `[sql, values]`.
	 */
	private static function where( array $where ) {
		$parts  = array();
		$values = array();

		foreach ( $where as $key => $value ) {
			$op     = '=';
			$column = $key;
			if ( preg_match( '/^(\w+)\s*(>=|<=|>|<)$/', $key, $m ) ) {
				$column = $m[1];
				$op     = $m[2];
			}

			if ( null === $value ) {
				$parts[]  = '%i IS NULL';
				$values[] = $column;
			} elseif ( is_array( $value ) ) {
				if ( ! $value ) {
					$parts[] = '0 = 1';
					continue;
				}
				$parts[]  = '%i IN (' . implode( ',', array_fill( 0, count( $value ), is_int( reset( $value ) ) ? '%d' : '%s' ) ) . ')';
				$values[] = $column;
				$values   = array_merge( $values, array_values( $value ) );
			} else {
				$parts[]  = '%i ' . $op . ' ' . ( is_int( $value ) ? '%d' : '%s' );
				$values[] = $column;
				$values[] = $value;
			}
		}

		return array( $parts ? ' WHERE ' . implode( ' AND ', $parts ) : '', $values );
	}
}
