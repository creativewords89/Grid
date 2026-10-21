<?php
/**
 * Tests for pay (SPEC.md 6.19): the salary maths, setting up pay (and the lock until it is set),
 * who sees whose salary, the pay sheet, billing day and marking salaries paid.
 *
 * @package GridRankers_Portal
 */

/**
 * Pay over REST; every rule enforced on the server.
 */
class Test_GRP_Pay extends GRP_REST_TestCase {

	public function set_up() {
		parent::set_up();
		// No weekly day off, so every day is a working day whatever today is.
		GRP_REST_People::set_setting( GRP_REST_People::WEEKLY_KEY, array( 'days' => array() ) );
		update_option( GRP_Daily_Reports::SINCE_OPTION, '2000-01-01', false );
		update_option( GRP_Pay::SINCE_OPTION, '2000-01', false );
	}

	/**
	 * Moves everyone's pay setup back two months, so last month is billed for them.
	 */
	private function backdate_pay() {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( 'UPDATE %i SET created_at = %s', GRP_Install::table( 'grp_pay' ), gmdate( 'Y-m-d H:i:s', strtotime( '-70 days' ) ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * A valid pay setup.
	 *
	 * @param array $extra Fields to override.
	 * @return array
	 */
	private function pay( array $extra = array() ) {
		return $extra + array(
			'day_minutes'    => 480,
			'salary'         => '30,000',
			'method'         => 'bank',
			'bank_name'      => 'Dutch-Bangla Bank',
			'branch'         => 'Gulshan',
			'account_name'   => 'Nia New',
			'account_number' => '1171 0100 2345 678',
			'routing'        => '090261234',
		);
	}

	/**
	 * A sent report row.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 * @param int    $minutes   Time written.
	 * @param bool   $sent      Sent or a draft.
	 * @return array
	 */
	private function report( $member_id, $day, $minutes, $sent = true ) {
		return array(
			'member_id' => $member_id,
			'day'       => $day,
			'sent_at'   => $sent ? '2026-03-01 12:00:00' : null,
			'entries'   => array(
				array(
					'title'   => 'Work',
					'minutes' => $minutes,
				),
			),
		);
	}

	public function test_rates_follow_the_salary_and_the_working_day() {
		// 8 hours, 30,000: a day 1,000, an hour 125; 4h extra is half a day, 8h a whole day.
		$this->assertEquals( 1000, GRP_Pay::day_pay( 30000 ) );
		$this->assertEquals( 125, GRP_Pay::hour_pay( 30000, 480 ) );
		$this->assertSame( 500, GRP_Pay::extra_pay( 240, 30000, 480 ) );
		$this->assertSame( 1000, GRP_Pay::extra_pay( 480, 30000, 480 ) );
		// 5 hours, 30,000: an hour 200; 5h extra is a whole day.
		$this->assertEquals( 200, GRP_Pay::hour_pay( 30000, 300 ) );
		$this->assertSame( 1000, GRP_Pay::extra_pay( 300, 30000, 300 ) );
		$this->assertSame( 813, GRP_Pay::extra_pay( 390, 30000, 480 ) );
		$this->assertSame( 1200, GRP_Pay::days_pay( 2, 18000 ) );
	}

	public function test_month_adds_extra_hours_and_settles_leave() {
		$member   = array(
			'id'         => 'm1',
			'role'       => 'member',
			'active'     => 1,
			'weekly_off' => null,
		);
		$pay      = array(
			'salary'      => 30000,
			'day_minutes' => 480,
		);
		$reports  = array(
			$this->report( 'm1', '2026-03-02', 600 ),      // 10h: 2h extra.
			$this->report( 'm1', '2026-03-03', 420 ),      // 7h: short, nothing taken off.
			$this->report( 'm1', '2026-03-04', 900, false ), // A draft never counts.
			$this->report( 'm1', '2026-03-05', 120 ),      // A day off: all of it is extra.
			$this->report( 'm2', '2026-03-06', 600 ),      // Someone else's.
		);
		$days_off = array(
			array(
				'kind'      => 'event',
				'from_date' => '2026-03-05',
				'to_date'   => '2026-03-05',
			),
		);
		$leaves   = array(
			array(
				'member_id' => 'm1',
				'status'    => 'approved',
				'type'      => 'day',
				'from_date' => '2026-03-09',
				'to_date'   => '2026-03-10',
			),
		);

		$sum  = GRP_Pay::month( $member, $pay, '2026-03', $reports, $leaves, array(), $days_off, '2026-03-20' );
		$days = array_column( $sum['days'], null, 'day' );
		$this->assertCount( 31, $sum['days'] );
		$this->assertSame( 'work', $days['2026-03-02']['kind'] );
		$this->assertSame( 120, $days['2026-03-02']['extra'] );
		$this->assertSame( 0, $days['2026-03-03']['extra'] );
		$this->assertSame( 0, $days['2026-03-04']['minutes'] );
		$this->assertSame( 'day_off', $days['2026-03-05']['kind'] );
		$this->assertSame( 120, $days['2026-03-05']['extra'] );
		$this->assertSame( 'leave', $days['2026-03-09']['kind'] );
		$this->assertSame( 'future', $days['2026-03-21']['kind'] );
		$this->assertSame( 1140, $sum['worked'] );
		$this->assertSame( 240, $sum['extra'] );
		$this->assertSame( 500, $sum['extra_pay'] );
		// 2 casual days, well inside the year's 10: nothing deducted, nothing paid out before December.
		$this->assertSame( 2, $sum['leave']['taken'] );
		$this->assertSame( 0, $sum['deducted'] );
		$this->assertSame( 0, $sum['leave_pay'] );
		$this->assertSame( 30500, $sum['total'] );

		// An intern has no leave days: both are deducted (6.10).
		$sum = GRP_Pay::month( array( 'employment' => 'intern' ) + $member, $pay, '2026-03', $reports, $leaves, array(), $days_off, '2026-03-20' );
		$this->assertSame( 2000, $sum['deducted'] );
		$this->assertSame( 28500, $sum['total'] );

		// 5 hours a day: 5h extra is a day. In December the year's unused leave is paid: 8 casual + 14 sick days.
		$pay['day_minutes'] = 300;
		$sum                = GRP_Pay::month( $member, $pay, '2026-12', array( $this->report( 'm1', '2026-12-01', 600 ) ), $leaves, array(), array(), '2026-12-31' );
		$this->assertSame( 1000, $sum['extra_pay'] );
		$this->assertSame( 22, $sum['leave']['paid'] );
		$this->assertSame( 22000, $sum['leave_pay'] );
		$this->assertSame( 53000, $sum['total'] );
		$this->assertStringContainsString( '22 unused leave days paid + 22,000', GRP_Pay::slip_line( $sum ) );
	}

	public function test_nothing_changes_until_pay_is_set_up() {
		$nia = GRP_Store::insert(
			'grp_members',
			array(
				'name'   => 'Nia New',
				'role'   => 'member',
				'active' => 1,
			) + self::FULL_PROFILE
		);
		GRP_Auth::set_code( $nia['id'], 'NIACODE11' );
		$this->tokens['nia'] = GRP_Auth::login( 'NIACODE11', '127.0.0.1' )['token'];
		$today               = GRP_Cycles::today();
		$entry               = array(
			'entries' => array(
				array(
					'title'   => 'Audit',
					'minutes' => 60,
				),
			),
		);

		$me = $this->api_as( 'nia', 'GET', '/pay/me' );
		$this->assertStatus( 200, $me );
		$this->assertTrue( $me->get_data()['needed'] );
		$locked = $this->api_as( 'nia', 'PUT', "/daily-reports/{$today}", $entry );
		$this->assertStatus( 403, $locked );
		$this->assertSame( 'grp_pay_needed', $locked->as_error()->get_error_code() );
		$this->assertStatus( 403, $this->api_as( 'nia', 'POST', '/projects', array( 'name' => 'Nope' ) ) );

		// Every field is checked.
		$this->assertSame( 'grp_pay_hours', $this->api_as( 'nia', 'PUT', '/pay/me', $this->pay( array( 'day_minutes' => 30 ) ) )->as_error()->get_error_code() );
		$this->assertSame( 'grp_pay_salary', $this->api_as( 'nia', 'PUT', '/pay/me', $this->pay( array( 'salary' => 'a lot' ) ) )->as_error()->get_error_code() );
		$this->assertSame( 'grp_pay_method', $this->api_as( 'nia', 'PUT', '/pay/me', $this->pay( array( 'method' => 'cash' ) ) )->as_error()->get_error_code() );
		$this->assertSame( 'grp_pay_account', $this->api_as( 'nia', 'PUT', '/pay/me', $this->pay( array( 'bank_name' => '' ) ) )->as_error()->get_error_code() );
		$this->assertSame(
			'grp_pay_account',
			$this->api_as(
				'nia',
				'PUT',
				'/pay/me',
				$this->pay(
					array(
						'method'         => 'bkash',
						'account_number' => '12345',
					)
				)
			)->as_error()->get_error_code()
		);

		$saved = $this->api_as(
			'nia',
			'PUT',
			'/pay/me',
			$this->pay(
				array(
					'method'         => 'bkash',
					'account_number' => '017 1234 5678',
				)
			)
		);
		$this->assertStatus( 200, $saved );
		$this->assertSame( 30000, $saved->get_data()['salary'] );
		$this->assertSame( '01712345678', $saved->get_data()['account_number'] );
		$this->assertSame( '', $saved->get_data()['bank_name'] );
		$this->assertFalse( $this->api_as( 'nia', 'GET', '/pay/me' )->get_data()['needed'] );
		$this->assertStatus( 200, $this->api_as( 'nia', 'PUT', "/daily-reports/{$today}", $entry ) );
	}

	public function test_the_super_admin_has_no_salary() {
		$me = $this->api_as( 'admin', 'GET', '/pay/me' );
		$this->assertFalse( $me->get_data()['earns'] );
		$this->assertFalse( $me->get_data()['needed'] );
		$this->assertStatus( 403, $this->api_as( 'admin', 'PUT', '/pay/me', $this->pay() ) );
	}

	public function test_only_you_and_the_super_admin_see_your_salary() {
		$member = $this->team['member']['id'];
		$own    = $this->api_as( 'member', 'GET', '/salary' );
		$this->assertStatus( 200, $own );
		$this->assertSame( 30000, $own->get_data()['summary']['salary'] );
		$this->assertSame( 125.0, (float) $own->get_data()['summary']['hour_pay'] );
		$this->assertStatus( 403, $this->api_as( 'other', 'GET', '/salary', array( 'member' => $member ) ) );
		$this->assertStatus( 403, $this->api_as( 'lead', 'GET', '/salary', array( 'member' => $member ) ) );
		$this->assertStatus( 200, $this->api_as( 'admin', 'GET', '/salary', array( 'member' => $member ) ) );
		$this->assertStatus( 400, $this->api_as( 'member', 'GET', '/salary', array( 'month' => '2026-13' ) ) );

		// The pay sheet, with everyone's payment details, is the Super Admin's alone.
		$this->assertStatus( 403, $this->api_as( 'lead', 'GET', '/salary/sheet' ) );
		$sheet = $this->api_as( 'admin', 'GET', '/salary/sheet' );
		$this->assertStatus( 200, $sheet );
		$rows = array_column( $sheet->get_data()['rows'], null, 'member_id' );
		$this->assertCount( 3, $rows );
		$this->assertSame( '1171 0100 2345 678', $rows[ $member ]['pay']['account_number'] );
		$this->assertArrayNotHasKey( 'days', $rows[ $member ]['summary'] );

		// Pay never travels with /sync.
		$sync = wp_json_encode( $this->api_as( 'lead', 'GET', '/sync' )->get_data() );
		$this->assertStringNotContainsString( '2345 678', $sync );
	}

	public function test_billing_day_makes_payslips_and_tells_everyone_once() {
		$this->backdate_pay();
		$today  = GRP_Cycles::today();
		$month  = GRP_Pay::previous_month( $today );
		$member = $this->team['member']['id'];
		GRP_Store::insert( 'grp_daily_reports', array( 'id' => GRP_Daily_Reports::row_id( $member, $month . '-10' ) ) + $this->report( $member, $month . '-10', 600 ) );

		$this->assertSame( 3, GRP_Pay::bill( $today ) );
		$this->assertSame( 0, GRP_Pay::bill( $today ) );

		$slip = GRP_Store::get( 'grp_payslips', GRP_Pay::slip_id( $member, $month ) );
		$this->assertSame( 120, $slip['extra'] );
		$this->assertSame( 250, $slip['extra_pay'] );
		// December's payslip also pays the year's 24 unused leave days (6.10).
		$total = 30250 + ( '12' === substr( $month, 5, 2 ) ? 24000 : 0 );
		$this->assertSame( $total, $slip['total'] );
		$this->assertSame( 'Dutch-Bangla Bank •••• 5678', $slip['account'] );

		$posts = GRP_Store::find( 'grp_posts', array( 'kind' => 'notice' ) );
		$this->assertCount( 4, $posts );
		$mine = array_values(
			array_filter(
				$posts,
				static function ( $p ) use ( $member ) {
					return array( $member ) === $p['to_members'];
				}
			)
		);
		$this->assertCount( 1, $mine );
		$this->assertStringContainsString( '2h extra + 250', $mine[0]['body'] );
		$this->assertStringContainsString( 'total ' . number_format( $total ) . ' BDT', $mine[0]['body'] );
		$sheet = array_values(
			array_filter(
				$posts,
				static function ( $p ) {
					return 0 === strpos( (string) $p['title'], 'Billing day' );
				}
			)
		);
		$this->assertCount( 1, $sheet );
		$this->assertSame( array( $this->team['admin']['id'] ), $sheet[0]['to_members'] );

		// Their payslips are theirs.
		$this->assertCount( 1, $this->api_as( 'member', 'GET', '/pay/me' )->get_data()['slips'] );
		$this->assertSame( $slip['id'], $this->api_as( 'member', 'GET', '/salary', array( 'month' => $month ) )->get_data()['slip']['id'] );
	}

	public function test_a_month_is_billed_only_after_pay_started_and_for_people_set_up_by_then() {
		$today = GRP_Cycles::today();
		update_option( GRP_Pay::SINCE_OPTION, substr( $today, 0, 7 ), false );
		$this->backdate_pay();
		$this->assertSame( 0, GRP_Pay::bill( $today ) );

		update_option( GRP_Pay::SINCE_OPTION, '2000-01', false );
		global $wpdb;
		$wpdb->update( GRP_Install::table( 'grp_pay' ), array( 'created_at' => GRP_Ids::now() ), array( 'id' => $this->team['other']['id'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$this->assertSame( 2, GRP_Pay::bill( $today ) );
		$this->assertNull( GRP_Store::get( 'grp_payslips', GRP_Pay::slip_id( $this->team['other']['id'], GRP_Pay::previous_month( $today ) ) ) );
	}

	public function test_the_super_admin_marks_salaries_paid() {
		$this->backdate_pay();
		$today  = GRP_Cycles::today();
		$month  = GRP_Pay::previous_month( $today );
		$member = $this->team['member']['id'];
		$body   = array(
			'month'      => $month,
			'member_ids' => array( $member ),
		);

		// Not billed yet.
		$this->assertStatus( 409, $this->api_as( 'admin', 'POST', '/salary/paid', $body ) );
		GRP_Pay::bill( $today );
		$this->assertStatus( 403, $this->api_as( 'lead', 'POST', '/salary/paid', $body ) );
		$this->assertStatus( 403, $this->api_as( 'member', 'POST', '/salary/paid', $body ) );
		$paid = $this->api_as( 'admin', 'POST', '/salary/paid', $body );
		$this->assertStatus( 200, $paid );
		$this->assertNotEmpty( $paid->get_data()[0]['paid_at'] );
		$this->assertSame( $this->team['admin']['id'], $paid->get_data()[0]['paid_by'] );

		$undo = $this->api_as( 'admin', 'POST', '/salary/paid', $body + array( 'paid' => false ) );
		$this->assertNull( $undo->get_data()[0]['paid_at'] );
	}
}
