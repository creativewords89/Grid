<?php
/**
 * The Super Admin's invoice tracker (SPEC.md 6.14): one row per project per ended cycle.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Billing rows, their payment tag and the daily reminders that depend on it.
 *
 * Not for sending invoices: the Super Admin ticks "Invoice sent" and records payments
 * so nothing is forgotten. Rows and fees reach only the Super Admin.
 */
class GRP_Billing {

	/**
	 * Option `Y-m-d`, the day the tracker started (schema 11): each project's cycle that had just
	 * ended by then, and every cycle after it, get a row; older cycles don't.
	 */
	const SINCE_OPTION = 'grp_billing_since';

	/** Ended cycles per project that get a row when it is missing (plus the current one). */
	const KEEP_BACK = 6;

	/** Default days after the invoice is sent before an unpaid invoice is Overdue. */
	const REMIND_DAYS = 3;

	/** Default currency symbol. */
	const CURRENCY = '$';

	/** Payment tags. CURRENT: the cycle is still running and its invoice isn't sent yet. */
	const CURRENT = 'current';
	const TO_SEND = 'to_send';
	const WAITING = 'waiting';
	const PARTLY  = 'partly';
	const OVERDUE = 'overdue';
	const PAID    = 'paid';
	const SKIPPED = 'skipped';

	/**
	 * Schema 11: the tracker starts today.
	 */
	public static function start() {
		if ( ! get_option( self::SINCE_OPTION ) ) {
			update_option( self::SINCE_OPTION, GRP_Cycles::today(), false );
		}
	}

	/**
	 * The day the tracker started.
	 *
	 * @return string `Y-m-d`.
	 */
	public static function since() {
		$since = (string) get_option( self::SINCE_OPTION, '' );

		return preg_match( '/^\d{4}-\d{2}-\d{2}$/', $since ) ? $since : GRP_Cycles::today();
	}

	/**
	 * Creates the missing rows for active projects: their current cycle (so every active project is
	 * on the list from day one, to bill early if wanted) and their ended cycles. Safe to repeat.
	 *
	 * @param string $today `Y-m-d`.
	 * @return int Rows created.
	 */
	public static function ensure( $today ) {
		$since = self::since();
		$fees  = array_column( GRP_Store::find( 'grp_billing_fees' ), null, 'id' );
		$made  = 0;

		foreach ( GRP_Store::find( 'grp_projects', array( 'state' => 'active' ) ) as $project ) {
			$created = substr( (string) $project['created_at'], 0, 10 );
			$cycles  = array_values(
				array_filter(
					GRP_Cycles::periods_of( $project, $today ),
					static function ( $p ) use ( $today, $created ) {
						// A waived transition between two cycle days is not a billing cycle.
						$waived = $p['transition'] && 'due' !== $p['monthly'];
						return $p['start'] <= $today && $p['end'] >= $created && ! $waived;
					}
				)
			);
			// From the cycle that had just ended when the tracker started.
			$before = array_keys(
				array_filter(
					$cycles,
					static function ( $p ) use ( $since ) {
						return $p['end'] < $since;
					}
				)
			);
			$cycles = array_slice( $cycles, $before ? max( $before ) : 0 );
			$fee    = $fees[ $project['id'] ] ?? null;

			foreach ( array_slice( $cycles, -self::KEEP_BACK - 1 ) as $period ) {
				$id = self::row_id( $project['id'], $period['key'] );
				if ( GRP_Store::get( 'grp_billing', $id ) ) {
					continue;
				}
				GRP_Store::insert(
					'grp_billing',
					array(
						'id'           => $id,
						'project_id'   => $project['id'],
						'project_name' => $project['name'],
						'cycle_key'    => $period['key'],
						'cycle_start'  => $period['start'],
						'cycle_end'    => $period['end'],
						'amount'       => $fee && null !== $fee['fee'] ? $fee['fee'] : null,
						'currency'     => $fee && '' !== $fee['currency'] ? $fee['currency'] : self::CURRENCY,
						'payments'     => array(),
					)
				);
				++$made;
			}
		}

		return $made;
	}

	/**
	 * Row id of a project's cycle.
	 *
	 * @param string $project_id Project id.
	 * @param string $cycle_key  Period key.
	 * @return string
	 */
	public static function row_id( $project_id, $cycle_key ) {
		return 'bl_' . md5( $project_id . '|' . $cycle_key );
	}

	/**
	 * Total paid on a row.
	 *
	 * @param array $row Billing row.
	 * @return float
	 */
	public static function paid( array $row ) {
		$sum = 0.0;
		foreach ( (array) ( $row['payments'] ?? array() ) as $payment ) {
			$sum += (float) ( $payment['amount'] ?? 0 );
		}

		return round( $sum, 2 );
	}

	/**
	 * Days the payment may take before the row is Overdue.
	 *
	 * @param string $project_id Project id.
	 * @return int
	 */
	public static function remind_days( $project_id ) {
		$fee = GRP_Store::get( 'grp_billing_fees', $project_id );

		return $fee ? max( 1, (int) $fee['remind_days'] ) : self::REMIND_DAYS;
	}

	/**
	 * The payment tag of a row. Without an amount, any payment counts as paid in full.
	 *
	 * @param array  $row         Billing row.
	 * @param int    $remind_days Days before an unpaid invoice is Overdue.
	 * @param string $today       `Y-m-d`.
	 * @return string One of the tag constants.
	 */
	public static function status( array $row, $remind_days, $today ) {
		$paid   = self::paid( $row );
		$amount = null === $row['amount'] ? 0.0 : (float) $row['amount'];

		if ( ! empty( $row['skipped'] ) ) {
			return self::SKIPPED;
		}
		if ( $paid > 0 && ( $amount <= 0 || $paid >= $amount ) ) {
			return self::PAID;
		}
		if ( empty( $row['sent_at'] ) ) {
			return (string) ( $row['cycle_end'] ?? '' ) >= $today ? self::CURRENT : self::TO_SEND;
		}
		if ( $paid > 0 ) {
			return self::PARTLY;
		}
		$days = (int) floor( ( strtotime( $today ) - strtotime( $row['sent_at'] ) ) / DAY_IN_SECONDS );

		return $days >= (int) $remind_days ? self::OVERDUE : self::WAITING;
	}
}
