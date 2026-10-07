<?php
/**
 * Tests for the Super Admin's invoice tracker (SPEC.md 6.14): rows per ended cycle, payment tags,
 * GET /billing, PUT /billing/projects/{id}, PATCH /billing/{id}, payments, and /sync privacy.
 *
 * @package GridRankers_Portal
 */

/**
 * Billing over REST; every route Super Admin only, enforced on the server.
 */
class Test_GRP_Billing extends GRP_REST_TestCase {

	public function set_up() {
		parent::set_up();
		update_option( GRP_Billing::SINCE_OPTION, '2000-01-01', false );
	}

	/**
	 * A project created four months ago, so it has ended cycles.
	 *
	 * @param string $name Project name.
	 * @return array
	 */
	private function old_project( $name = 'Acme Plumbing' ) {
		global $wpdb;

		$project = $this->project( $name, 1 );
		$created = gmdate( 'Y-m-d H:i:s', strtotime( GRP_Cycles::today() . ' -4 months' ) );
		$wpdb->update( GRP_Install::table( 'grp_projects' ), array( 'created_at' => $created ), array( 'id' => $project['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		return GRP_Store::get( 'grp_projects', $project['id'] );
	}

	/**
	 * The billing row of the project's last ended cycle.
	 *
	 * @param array $project Project.
	 * @return array
	 */
	private function last_row( array $project ) {
		GRP_Billing::ensure( GRP_Cycles::today() );
		$key = GRP_Cycles::cycle_range( $project, -1, GRP_Cycles::today() )['key'];

		return GRP_Store::get( 'grp_billing', GRP_Billing::row_id( $project['id'], $key ) );
	}

	public function test_only_the_super_admin_reaches_the_tracker() {
		$project = $this->old_project();
		$row     = $this->last_row( $project );
		$calls   = array(
			array( 'GET', '/billing', array() ),
			array( 'PUT', "/billing/projects/{$project['id']}", array( 'fee' => 500 ) ),
			array( 'PATCH', "/billing/{$row['id']}", array( 'sent' => true ) ),
			array( 'POST', "/billing/{$row['id']}/payments", array( 'amount' => 100 ) ),
			array( 'DELETE', "/billing/{$row['id']}/payments/x", array() ),
		);
		foreach ( array( 'lead', 'member' ) as $who ) {
			foreach ( $calls as $call ) {
				$this->assertStatus( 403, $this->api_as( $who, $call[0], $call[1], $call[2] ) );
			}
		}
		$this->as_nobody();
		$this->assertStatus( 401, $this->api( 'GET', '/billing' ) );

		$this->assertStatus( 200, $this->api_as( 'admin', 'GET', '/billing' ) );
		$this->assertFalse( GRP_Permissions::can( $this->team['lead'], GRP_Permissions::MANAGE_BILLING ) );
		$this->assertTrue( GRP_Permissions::can( $this->team['admin'], GRP_Permissions::MANAGE_BILLING ) );
		$this->assertNull( GRP_Store::get( 'grp_billing', $row['id'] )['sent_at'], 'refused calls changed nothing' );
	}

	public function test_rows_are_made_for_the_current_and_ended_cycles_only_once() {
		$project = $this->old_project();
		$paused  = $this->old_project( 'Paused Co' );
		GRP_Store::update( 'grp_projects', $paused['id'], array( 'state' => 'paused' ) );
		$today = GRP_Cycles::today();

		$made = GRP_Billing::ensure( $today );
		$rows = GRP_Store::find( 'grp_billing', array(), array( 'order_by' => 'cycle_end' ) );
		$this->assertSame( count( $rows ), $made );
		$this->assertGreaterThanOrEqual( 4, $made, 'four months back: at least three ended cycles and the current one' );
		$this->assertSame( array( $project['id'] ), array_values( array_unique( array_column( $rows, 'project_id' ) ) ), 'paused projects get no new rows' );
		// The current cycle is on the list from day one, tagged This cycle (no reminder yet).
		$current = array_pop( $rows );
		$this->assertSame( GRP_Cycles::cycle_range( $project, 0, $today )['key'], $current['cycle_key'] );
		$this->assertSame( GRP_Billing::CURRENT, GRP_Billing::status( $current, 3, $today ) );
		foreach ( $rows as $row ) {
			$this->assertLessThan( $today, $row['cycle_end'] );
			$this->assertSame( GRP_Billing::TO_SEND, GRP_Billing::status( $row, 3, $today ) );
			$this->assertSame( 'Acme Plumbing', $row['project_name'] );
			$this->assertNull( $row['amount'] );
			$this->assertSame( '$', $row['currency'] );
			$this->assertSame( array(), $row['payments'] );
		}
		$last = end( $rows );
		$this->assertSame( GRP_Cycles::cycle_range( $project, -1, $today )['key'], $last['cycle_key'] );
		$this->assertSame( 0, GRP_Billing::ensure( $today ), 'safe to repeat' );

		// From the day the tracker starts: the cycle that had just ended, not the older ones.
		update_option( GRP_Billing::SINCE_OPTION, $today, false );
		$other = $this->old_project( 'Bright Dental' );
		GRP_Billing::ensure( $today );
		$rows = GRP_Store::find( 'grp_billing', array( 'project_id' => $other['id'] ), array( 'order_by' => 'cycle_end' ) );
		$this->assertSame( array( $last['cycle_key'], $current['cycle_key'] ), array_column( $rows, 'cycle_key' ) );

		// A project added today still has its current cycle.
		$new = $this->project( 'New Client' );
		GRP_Billing::ensure( $today );
		$this->assertSame( array( $current['cycle_key'] ), array_column( GRP_Store::find( 'grp_billing', array( 'project_id' => $new['id'] ) ), 'cycle_key' ) );

		// The cron job does it too; a new fee is the amount of new rows.
		GRP_Store::insert(
			'grp_billing_fees',
			array(
				'id'       => $project['id'],
				'fee'      => 650,
				'currency' => '৳',
			)
		);
		GRP_Store::delete( 'grp_billing', $last['id'] );
		$summary = GRP_Cron::run( $today );
		$this->assertSame( 1, $summary['billing'] );
		$again = GRP_Store::get( 'grp_billing', $last['id'] );
		$this->assertSame( 650.0, $again['amount'] );
		$this->assertSame( '৳', $again['currency'] );
	}

	public function test_install_starts_with_the_cycle_that_just_ended() {
		delete_option( GRP_Billing::SINCE_OPTION );
		GRP_Billing::start();
		$this->assertSame( GRP_Cycles::today(), get_option( GRP_Billing::SINCE_OPTION ) );
		update_option( GRP_Billing::SINCE_OPTION, '2020-01-01', false );
		GRP_Billing::start();
		$this->assertSame( '2020-01-01', get_option( GRP_Billing::SINCE_OPTION ), 'never moved once set' );

		// Started a week ago: each project's cycle that had ended by then, and every one since.
		$since = gmdate( 'Y-m-d', strtotime( GRP_Cycles::today() . ' -7 days' ) );
		update_option( GRP_Billing::SINCE_OPTION, $since, false );
		$project = $this->old_project();
		GRP_Billing::ensure( GRP_Cycles::today() );
		$rows  = GRP_Store::find( 'grp_billing', array( 'project_id' => $project['id'] ), array( 'order_by' => 'cycle_end' ) );
		$older = array_filter(
			$rows,
			static function ( $row ) use ( $since ) {
				return $row['cycle_end'] < $since;
			}
		);
		$this->assertCount( 1, $older, 'one cycle from before the start' );
		$this->assertSame( $rows[0], reset( $older ) );
		$this->assertSame( GRP_Cycles::cycle_range( $project, 0, GRP_Cycles::today() )['key'], end( $rows )['cycle_key'] );
	}

	public function test_billing_reaches_only_the_super_admin_through_sync() {
		$project = $this->old_project();
		$row     = $this->last_row( $project );
		$this->assertStatus( 200, $this->api_as( 'admin', 'PUT', "/billing/projects/{$project['id']}", array( 'fee' => 500 ) ) );
		$since = GRP_Ids::now( time() - 5 );

		foreach ( array( 'lead', 'member' ) as $who ) {
			$sync = $this->api_as( $who, 'GET', '/sync' )->get_data();
			$this->assertSame( array(), $sync['changes']['billing'] );
			$this->assertSame( array(), $sync['changes']['billing_fees'] );
		}
		$sync = $this->api_as( 'admin', 'GET', '/sync' )->get_data();
		$this->assertContains( $row['id'], array_column( $sync['changes']['billing'], 'id' ) );
		$this->assertSame( 500.0, $sync['changes']['billing_fees'][0]['fee'] );

		// Not even the ids of deleted rows.
		GRP_Store::delete( 'grp_billing', $row['id'] );
		$lead = $this->api_as( 'lead', 'GET', '/sync', array( 'since' => $since ) )->get_data();
		$this->assertNotContains( 'billing', array_column( $lead['deletions'], 'table' ) );
		$admin = $this->api_as( 'admin', 'GET', '/sync', array( 'since' => $since ) )->get_data();
		$this->assertContains( $row['id'], array_column( $admin['deletions'], 'id' ) );

		// A full sync for the Super Admin picks up the ended cycle again.
		$this->api_as( 'admin', 'GET', '/sync' );
		$this->assertNotNull( GRP_Store::get( 'grp_billing', $row['id'] ) );
	}

	public function test_a_fee_fills_in_unsent_cycles_without_an_amount() {
		$project = $this->old_project();
		$rows    = array_column( ( $this->api_as( 'admin', 'GET', '/billing' )->get_data() )['billing'], null, 'id' );
		$ids     = array_keys( $rows );
		$this->assertGreaterThanOrEqual( 3, count( $ids ) );
		$this->api_as( 'admin', 'PATCH', "/billing/{$ids[0]}", array( 'sent' => true ) );
		$this->api_as( 'admin', 'PATCH', "/billing/{$ids[1]}", array( 'amount' => 300 ) );

		$response = $this->api_as(
			'admin',
			'PUT',
			"/billing/projects/{$project['id']}",
			array(
				'fee'         => '1,250.50',
				'currency'    => '৳',
				'remind_days' => 500,
			)
		);
		$this->assertStatus( 200, $response );
		$fee = $response->get_data();
		$this->assertSame( 1250.5, $fee['fee'] );
		$this->assertSame( '৳', $fee['currency'] );
		$this->assertSame( 90, $fee['remind_days'], 'clamped' );

		$this->assertNull( GRP_Store::get( 'grp_billing', $ids[0] )['amount'], 'an invoice already sent keeps its amount' );
		$this->assertSame( 300.0, GRP_Store::get( 'grp_billing', $ids[1] )['amount'], 'an amount set by hand stays' );
		$this->assertSame( 1250.5, GRP_Store::get( 'grp_billing', $ids[2] )['amount'] );
		$this->assertSame( '৳', GRP_Store::get( 'grp_billing', $ids[2] )['currency'] );

		// Default reminder: 3 days; no fee is fine; bad fee or unknown project refused.
		$this->assertSame( 3, $this->api_as( 'admin', 'PUT', "/billing/projects/{$project['id']}", array( 'fee' => '' ) )->get_data()['remind_days'] );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', "/billing/projects/{$project['id']}", array( 'fee' => -5 ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PUT', "/billing/projects/{$project['id']}", array( 'fee' => 'lots' ) ) );
		$this->assertStatus( 404, $this->api_as( 'admin', 'PUT', '/billing/projects/nope', array( 'fee' => 5 ) ) );
	}

	public function test_invoice_sent_ref_amount_and_not_billed() {
		$project = $this->old_project();
		$row     = $this->last_row( $project );
		$path    = "/billing/{$row['id']}";

		$sent = $this->api_as(
			'admin',
			'PATCH',
			$path,
			array(
				'sent'   => true,
				'ref'    => 'INV-1042',
				'amount' => 500,
			)
		)->get_data();
		$this->assertSame( GRP_Cycles::today(), $sent['sent_at'] );
		$this->assertSame( $this->team['admin']['id'], $sent['sent_by'] );
		$this->assertSame( 'INV-1042', $sent['ref'] );
		$this->assertSame( 500.0, $sent['amount'] );

		$dated = $this->api_as( 'admin', 'PATCH', $path, array( 'sent_at' => '2026-01-02' ) )->get_data();
		$this->assertSame( '2026-01-02', $dated['sent_at'] );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PATCH', $path, array( 'sent_at' => '2026-02-30' ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PATCH', $path, array( 'amount' => 'abc' ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'PATCH', $path, array() ) );
		$this->assertStatus( 404, $this->api_as( 'admin', 'PATCH', '/billing/nope', array( 'sent' => true ) ) );

		$unsent = $this->api_as( 'admin', 'PATCH', $path, array( 'sent' => false ) )->get_data();
		$this->assertNull( $unsent['sent_at'] );
		$this->assertNull( $unsent['sent_by'] );

		$skipped = $this->api_as(
			'admin',
			'PATCH',
			$path,
			array(
				'skipped' => true,
				'note'    => 'Free month',
			)
		)->get_data();
		$this->assertSame( 1, $skipped['skipped'] );
		$this->assertSame( 'Free month', $skipped['note'] );
		$this->assertSame( GRP_Billing::SKIPPED, GRP_Billing::status( $skipped, 3, GRP_Cycles::today() ) );
	}

	public function test_payments_add_up_and_can_be_removed() {
		$project = $this->old_project();
		$row     = $this->last_row( $project );
		$path    = "/billing/{$row['id']}/payments";
		$this->api_as(
			'admin',
			'PATCH',
			"/billing/{$row['id']}",
			array(
				'sent'   => true,
				'amount' => 800,
			)
		);

		$this->assertStatus( 400, $this->api_as( 'admin', 'POST', $path, array( 'amount' => 0 ) ) );
		$this->assertStatus( 400, $this->api_as( 'admin', 'POST', $path, array() ) );
		$this->assertStatus(
			400,
			$this->api_as(
				'admin',
				'POST',
				$path,
				array(
					'amount' => 10,
					'date'   => 'soon',
				)
			)
		);

		$first = $this->api_as(
			'admin',
			'POST',
			$path,
			array(
				'amount' => 400,
				'date'   => '2026-10-01',
				'method' => 'bKash',
				'ref'    => 'TX-77',
			)
		);
		$this->assertStatus( 201, $first );
		$payment = $first->get_data()['payments'][0];
		$this->assertSame( 400, (int) $payment['amount'] );
		$this->assertSame( '2026-10-01', $payment['date'] );
		$this->assertSame( 'bKash', $payment['method'] );
		$this->assertSame( 'TX-77', $payment['ref'] );
		$this->assertSame( $this->team['admin']['id'], $payment['by'] );
		$this->assertSame( GRP_Billing::PARTLY, GRP_Billing::status( $first->get_data(), 3, GRP_Cycles::today() ) );

		$second = $this->api_as( 'admin', 'POST', $path, array( 'amount' => 400 ) )->get_data();
		$this->assertSame( 800.0, GRP_Billing::paid( $second ) );
		$this->assertSame( GRP_Cycles::today(), $second['payments'][1]['date'], 'today by default' );
		$this->assertSame( GRP_Billing::PAID, GRP_Billing::status( $second, 3, GRP_Cycles::today() ) );

		$this->assertStatus( 404, $this->api_as( 'admin', 'DELETE', "$path/nope" ) );
		$left = $this->api_as( 'admin', 'DELETE', "$path/{$payment['id']}" )->get_data();
		$this->assertCount( 1, $left['payments'] );
		$this->assertSame( 400.0, GRP_Billing::paid( $left ) );
	}

	public function test_payment_tags() {
		$today = '2026-10-10';
		$row   = array(
			'amount'   => 500.0,
			'sent_at'  => null,
			'skipped'  => 0,
			'payments' => array(),
		);
		$this->assertSame( GRP_Billing::TO_SEND, GRP_Billing::status( $row, 3, $today ) );
		$this->assertSame( GRP_Billing::CURRENT, GRP_Billing::status( array( 'cycle_end' => '2026-10-31' ) + $row, 3, $today ), 'still running, not sent' );
		$this->assertSame( GRP_Billing::TO_SEND, GRP_Billing::status( array( 'cycle_end' => '2026-10-09' ) + $row, 3, $today ), 'ended yesterday' );
		$this->assertSame(
			GRP_Billing::WAITING,
			GRP_Billing::status(
				array(
					'cycle_end' => '2026-10-31',
					'sent_at'   => '2026-10-09',
				) + $row,
				3,
				$today
			),
			'billed early'
		);
		$this->assertSame( GRP_Billing::WAITING, GRP_Billing::status( array( 'sent_at' => '2026-10-08' ) + $row, 3, $today ) );
		$this->assertSame( GRP_Billing::OVERDUE, GRP_Billing::status( array( 'sent_at' => '2026-10-07' ) + $row, 3, $today ), 'three days after the invoice' );
		$this->assertSame( GRP_Billing::WAITING, GRP_Billing::status( array( 'sent_at' => '2026-10-07' ) + $row, 10, $today ), 'per-project reminder days' );
		$part = array( 'payments' => array( array( 'amount' => 100 ) ) );
		$this->assertSame( GRP_Billing::PARTLY, GRP_Billing::status( array( 'sent_at' => '2026-09-01' ) + $part + $row, 3, $today ) );
		$this->assertSame( GRP_Billing::PAID, GRP_Billing::status( array( 'amount' => null ) + $part + $row, 3, $today ), 'with no amount, any payment settles it' );
		$this->assertSame( GRP_Billing::TO_SEND, GRP_Billing::status( array( 'amount' => null ) + $row, 3, $today ), 'reminded even with no fee' );
		$this->assertSame( GRP_Billing::SKIPPED, GRP_Billing::status( array( 'skipped' => 1 ) + $row, 3, $today ) );
	}
}
