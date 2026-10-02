<?php
/**
 * Base class for REST API tests: team fixtures and authenticated requests.
 *
 * @package GridRankers_Portal
 */

/**
 * Creates a Super Admin (linked WP administrator), a Team Leader and two Team Members,
 * and dispatches portal requests as any of them.
 */
abstract class GRP_REST_TestCase extends WP_UnitTestCase {

	/**
	 * Members keyed by handle: admin, lead, member, other.
	 *
	 * @var array<string, array>
	 */
	protected $team = array();

	/**
	 * Session tokens of code-login members.
	 *
	 * @var array<string, string>
	 */
	private $tokens = array();

	/**
	 * A complete required profile (SPEC.md 6.10): without it task work is locked.
	 */
	const FULL_PROFILE = array(
		'location'   => 'Rangpur',
		'birthday'   => '01-15',
		'birth_year' => 1990,
		'phone'      => '+8801700000000',
		'photo'      => 'https://example.com/photo.png',
	);

	public function set_up() {
		parent::set_up();

		global $wp_rest_server;
		$wp_rest_server = new WP_REST_Server(); // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		do_action( 'rest_api_init', $wp_rest_server );

		$wp_admin = self::factory()->user->create( array( 'role' => 'administrator' ) );

		$this->team = array(
			'admin'  => $this->add_member( 'Ada Admin', 'admin', $wp_admin ),
			'lead'   => $this->add_member( 'Lee Lead', 'lead' ),
			'member' => $this->add_member( 'Max Member', 'member' ),
			'other'  => $this->add_member( 'Olu Other', 'member' ),
		);

		foreach ( array( 'lead', 'member', 'other' ) as $handle ) {
			$code = strtoupper( $handle ) . 'CODE1';
			GRP_Auth::set_code( $this->team[ $handle ]['id'], $code );
			$this->tokens[ $handle ] = GRP_Auth::login( $code, '127.0.0.1' )['token'];
		}

		$this->as_nobody();
	}

	public function tear_down() {
		global $wp_rest_server;
		$wp_rest_server = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited

		GRP_Auth::reset();
		unset( $_COOKIE[ GRP_Auth::COOKIE ] );

		parent::tear_down();
	}

	/**
	 * Inserts a member row.
	 *
	 * @param string   $name       Name.
	 * @param string   $role       Role.
	 * @param int|null $wp_user_id Linked WP user.
	 * @return array
	 */
	protected function add_member( $name, $role, $wp_user_id = null ) {
		return GRP_Store::insert(
			'grp_members',
			array(
				'name'       => $name,
				'role'       => $role,
				'wp_user_id' => $wp_user_id,
				'active'     => 1,
			) + self::FULL_PROFILE
		);
	}

	/**
	 * Acts as a team member for the following requests.
	 *
	 * @param string $handle admin, lead, member or other.
	 */
	protected function act_as( $handle ) {
		GRP_Auth::reset();
		unset( $_COOKIE[ GRP_Auth::COOKIE ] );
		wp_set_current_user( 0 );

		if ( 'admin' === $handle ) {
			wp_set_current_user( (int) $this->team['admin']['wp_user_id'] );
		} else {
			$_COOKIE[ GRP_Auth::COOKIE ] = $this->tokens[ $handle ];
		}
	}

	/**
	 * Signed out.
	 */
	protected function as_nobody() {
		GRP_Auth::reset();
		unset( $_COOKIE[ GRP_Auth::COOKIE ] );
		wp_set_current_user( 0 );
	}

	/**
	 * Dispatches a request with a valid nonce.
	 *
	 * @param string $method HTTP method.
	 * @param string $path   Path after the namespace.
	 * @param array  $params Params (JSON body).
	 * @return WP_REST_Response
	 */
	protected function api( $method, $path, array $params = array() ) {
		$request = new WP_REST_Request( $method, '/gr-portal/v1' . $path );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		if ( 'GET' === $method ) {
			$request->set_query_params( $params );
		} else {
			$request->set_header( 'Content-Type', 'application/json' );
			$request->set_body( wp_json_encode( $params ) );
		}

		return rest_get_server()->dispatch( $request );
	}

	/**
	 * Dispatches as a member and returns the response.
	 *
	 * @param string $handle Member handle.
	 * @param string $method HTTP method.
	 * @param string $path   Path.
	 * @param array  $params Params.
	 * @return WP_REST_Response
	 */
	protected function api_as( $handle, $method, $path, array $params = array() ) {
		$this->act_as( $handle );

		return $this->api( $method, $path, $params );
	}

	/**
	 * Asserts a response status, showing the body on failure.
	 *
	 * @param int              $expected Status.
	 * @param WP_REST_Response $response Response.
	 */
	protected function assertStatus( $expected, $response ) {
		$this->assertSame( $expected, $response->get_status(), wp_json_encode( $response->get_data() ) );
	}

	/**
	 * Creates a project as the admin.
	 *
	 * @param string $name      Name.
	 * @param int    $cycle_day Cycle day.
	 * @return array
	 */
	protected function project( $name = 'Acme Plumbing', $cycle_day = 1 ) {
		$response = $this->api_as(
			'admin',
			'POST',
			'/projects',
			array(
				'name'      => $name,
				'cycle_day' => $cycle_day,
			)
		);
		$this->assertStatus( 201, $response );

		return $response->get_data();
	}

	/**
	 * Audit rows for a document.
	 *
	 * @param string $doc_id Doc id.
	 * @return array[]
	 */
	protected function audit_for( $doc_id ) {
		return GRP_Store::find( 'grp_audit', array( 'doc_id' => $doc_id ), array( 'order_by' => 'at' ) );
	}

	/**
	 * Activity credited under a ref key prefix.
	 *
	 * @param string $member_id Member.
	 * @return array[]
	 */
	protected function credits( $member_id ) {
		return GRP_Store::find( 'grp_activity', array( 'member_id' => $member_id ) );
	}
}
