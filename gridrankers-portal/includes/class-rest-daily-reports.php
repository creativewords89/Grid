<?php
/**
 * REST: /daily-reports.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Daily reports (SPEC.md 6.18): Team Leaders and Team Members write what they did each working day;
 * the Super Admin reads everyone's, a Team Leader Team Members' and other Team Leaders', a Team Member
 * only their own. Not sent by /sync: every read goes through these routes.
 */
class GRP_REST_Daily_Reports extends GRP_REST_Controller {

	const TABLE = 'grp_daily_reports';

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/daily-reports/me', WP_REST_Server::READABLE, 'me' );
		self::route( '/daily-reports/team', WP_REST_Server::READABLE, 'team' );
		self::route( '/daily-reports/remind', WP_REST_Server::CREATABLE, 'remind' );
		self::route( '/daily-reports', WP_REST_Server::READABLE, 'person' );
		self::route( '/daily-reports/(?P<day>\d{4}-\d{2}-\d{2})', 'PUT', 'save' );
	}

	/**
	 * Approved leave rows.
	 *
	 * @return array[]
	 */
	private static function leaves() {
		return GRP_Store::find( 'grp_leave', array( 'status' => 'approved' ) );
	}

	/**
	 * A report as the app sees it: its row plus the total minutes.
	 *
	 * @param array|null $row Report row.
	 * @return array|null
	 */
	private static function out( $row ) {
		if ( ! $row ) {
			return null;
		}
		$row['entries'] = array_values( (array) ( $row['entries'] ?? array() ) );
		$row['minutes'] = GRP_Daily_Reports::minutes( $row );

		return $row;
	}

	/**
	 * A no-store response.
	 *
	 * @param mixed $data Data.
	 * @return WP_REST_Response
	 */
	private static function respond( $data ) {
		$response = rest_ensure_response( $data );
		$response->header( 'Cache-Control', 'no-store' );

		return $response;
	}

	/**
	 * GET /daily-reports/me: the signed-in person's report state — today's report, the day whose
	 * report is missing (design DR-D) with its draft, and whether today is a day off.
	 *
	 * @return WP_REST_Response
	 */
	public static function me() {
		$actor   = self::actor();
		$today   = GRP_Cycles::today();
		$since   = GRP_Daily_Reports::since();
		$writes  = GRP_Daily_Reports::writes( $actor );
		$leaves  = self::leaves();
		$weekly  = GRP_REST_People::team_weekly();
		$off     = GRP_REST_People::days_off();
		$missing = $writes ? GRP_Daily_Reports::missing( $actor, $today, $since, $leaves, $weekly, $off ) : null;

		return self::respond(
			array(
				'today'          => $today,
				'due'            => GRP_Daily_Reports::DUE,
				'remind_from'    => GRP_Daily_Reports::REMIND_FROM,
				'writes'         => $writes,
				'out_today'      => $writes ? GRP_Daily_Reports::out_reason( $today, $actor, $leaves, $weekly, $off ) : null,
				'report'         => $writes ? self::out( GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $actor['id'], $today ) ) ) : null,
				'missing'        => $missing,
				'missing_report' => $missing ? self::out( GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $actor['id'], $missing ) ) ) : null,
			)
		);
	}

	/**
	 * GET /daily-reports?member=&month=YYYY-MM: one person's reports in a month (design DR-C). Other
	 * people's drafts are never shown — only sent reports.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function person( WP_REST_Request $request ) {
		$actor  = self::actor();
		$id     = '' !== (string) $request['member'] ? (string) $request['member'] : (string) $actor['id'];
		$person = GRP_Store::get( 'grp_members', $id );
		if ( ! $person ) {
			return self::not_found();
		}
		if ( ! self::can(
			GRP_Permissions::VIEW_DAILY_REPORT,
			array(
				'member_id' => $person['id'],
				'role'      => $person['role'],
			)
		) ) {
			return self::forbidden( __( 'You can’t read this person’s reports.', 'gridrankers-portal' ) );
		}
		$month = (string) $request['month'];
		if ( ! preg_match( '/^\d{4}-(0[1-9]|1[0-2])$/', $month ) ) {
			$month = substr( GRP_Cycles::today(), 0, 7 );
		}
		$own  = (string) $person['id'] === (string) $actor['id'];
		$rows = GRP_Store::find(
			self::TABLE,
			array(
				'member_id' => $person['id'],
				'day >='    => $month . '-01',
				'day <='    => $month . '-31',
			),
			array( 'order_by' => 'day' )
		);
		$out  = array();
		foreach ( $rows as $row ) {
			if ( $own || ! empty( $row['sent_at'] ) ) {
				$out[] = self::out( $row );
			}
		}

		return self::respond(
			array(
				'member_id' => $person['id'],
				'month'     => $month,
				'reports'   => $out,
			)
		);
	}

	/**
	 * GET /daily-reports/team?day=: everyone's report for a day (design DR-B) — the people the
	 * actor may read, each with their state and sent report. Managers only.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function team( WP_REST_Request $request ) {
		if ( ! self::can( GRP_Permissions::VIEW_TEAM_REPORTS ) ) {
			return self::forbidden( __( 'Only Team Leaders and the Super Admin see the team’s reports.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		$day   = self::date( $request['day'] ?? '', 'day' );
		if ( is_wp_error( $day ) ) {
			return $day;
		}
		$day     = $day ? $day : $today;
		$since   = GRP_Daily_Reports::since();
		$leaves  = self::leaves();
		$weekly  = GRP_REST_People::team_weekly();
		$off     = GRP_REST_People::days_off();
		$reports = array();
		foreach ( GRP_Store::find( self::TABLE, array( 'day' => $day ) ) as $row ) {
			$reports[ (string) $row['member_id'] ] = $row;
		}

		$people = array();
		foreach ( GRP_Store::find( 'grp_members', array( 'active' => 1 ), array( 'order_by' => 'name' ) ) as $member ) {
			if ( ! GRP_Daily_Reports::writes( $member ) || ! self::can(
				GRP_Permissions::VIEW_DAILY_REPORT,
				array(
					'member_id' => $member['id'],
					'role'      => $member['role'],
				)
			) ) {
				continue;
			}
			$report   = $reports[ (string) $member['id'] ] ?? null;
			$sent     = $report && ! empty( $report['sent_at'] ) ? $report : null;
			$people[] = array(
				'member_id' => $member['id'],
				'state'     => GRP_Daily_Reports::state( $member, $day, $today, $since, $report, $leaves, $weekly, $off ),
				'report'    => self::out( $sent ),
			);
		}

		return self::respond(
			array(
				'day'    => $day,
				'today'  => $today,
				'people' => $people,
			)
		);
	}

	/**
	 * PUT /daily-reports/{day} `{entries, blocking?, tomorrow?, send?}`: saves the actor's own report
	 * (drafts save as they type); `send` sends it. Today's report can be changed until midnight; a past
	 * working day's only while it hasn't been sent (it is then marked late).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function save( WP_REST_Request $request ) {
		$actor = self::actor();
		if ( ! self::can( GRP_Permissions::WRITE_DAILY_REPORT, array( 'member_id' => $actor['id'] ) ) ) {
			return self::forbidden( __( 'The Super Admin doesn’t write daily reports.', 'gridrankers-portal' ) );
		}
		$day = self::date( $request['day'], 'day' );
		if ( is_wp_error( $day ) || null === $day ) {
			return is_wp_error( $day ) ? $day : self::invalid( __( 'Invalid day.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		if ( $day > $today ) {
			return self::invalid( __( 'You can’t write a report for a day that hasn’t come yet.', 'gridrankers-portal' ) );
		}
		if ( $day < GRP_People::add_days( $today, -GRP_Daily_Reports::BACK_DAYS ) ) {
			return self::invalid( __( 'That day is too long ago to report.', 'gridrankers-portal' ) );
		}
		$id       = GRP_Daily_Reports::row_id( $actor['id'], $day );
		$existing = GRP_Store::get( self::TABLE, $id );
		if ( $existing && ! empty( $existing['sent_at'] ) && $day < $today ) {
			return self::conflict( __( 'That report was sent and can’t be changed any more.', 'gridrankers-portal' ), 'grp_report_locked' );
		}

		$entries = self::entries( $request['entries'] ?? array() );
		if ( is_wp_error( $entries ) ) {
			return $entries;
		}
		$send = ! empty( $request['send'] ) || ( $existing && ! empty( $existing['sent_at'] ) );
		if ( $send && ! $entries ) {
			return self::invalid( __( 'Add at least one thing you did.', 'gridrankers-portal' ), 'grp_report_empty' );
		}

		$fields = array(
			'entries'  => $entries,
			'blocking' => self::textarea( $request['blocking'] ?? '', 2000 ),
			'tomorrow' => self::textarea( $request['tomorrow'] ?? '', 2000 ),
		);
		if ( $send && ( ! $existing || empty( $existing['sent_at'] ) ) ) {
			$fields['sent_at'] = gmdate( 'Y-m-d H:i:s' );
			$fields['late']    = $day < $today ? 1 : 0;
		}

		$row = $existing
			? GRP_Store::update( self::TABLE, $id, $fields )
			: GRP_Store::insert(
				self::TABLE,
				array(
					'id'        => $id,
					'member_id' => $actor['id'],
					'day'       => $day,
				) + $fields
			);

		return self::respond( self::out( $row ) );
	}

	/**
	 * Clean entries: `[{id?, title, details?, project?, minutes, files?, links?}]`.
	 *
	 * @param mixed $raw Raw entries.
	 * @return array|WP_Error
	 */
	private static function entries( $raw ) {
		$raw = is_array( $raw ) ? array_values( $raw ) : array();
		if ( count( $raw ) > GRP_Daily_Reports::MAX_ENTRIES ) {
			return self::invalid( __( 'That’s too many entries for one day.', 'gridrankers-portal' ) );
		}
		$out   = array();
		$total = 0;
		foreach ( $raw as $item ) {
			$item  = (array) $item;
			$title = self::text( $item['title'] ?? '', 200 );
			if ( '' === $title ) {
				return self::invalid( __( 'Write what you did.', 'gridrankers-portal' ) );
			}
			$minutes = is_numeric( $item['minutes'] ?? null ) ? (int) $item['minutes'] : 0;
			if ( $minutes < 1 || $minutes > GRP_Daily_Reports::MAX_MINUTES ) {
				/* translators: %s: what the person did. */
				return self::invalid( sprintf( __( 'Add the time spent on “%s”.', 'gridrankers-portal' ), $title ) );
			}
			$total  += $minutes;
			$project = (string) ( $item['project'] ?? '' );
			if ( '' !== $project && ! in_array( $project, GRP_Daily_Reports::OTHER_PROJECTS, true ) && ! GRP_Store::get( 'grp_projects', $project ) ) {
				return self::invalid( __( 'That project doesn’t exist any more. Pick another.', 'gridrankers-portal' ) );
			}
			$files = self::attached_files( $item['files'] ?? array() );
			if ( is_wp_error( $files ) ) {
				return $files;
			}
			$links = self::links( $item['links'] ?? array() );
			if ( is_wp_error( $links ) ) {
				return $links;
			}
			$id    = preg_replace( '/[^\w-]/', '', (string) ( $item['id'] ?? '' ) );
			$out[] = array(
				'id'      => '' !== $id ? substr( $id, 0, 40 ) : GRP_Ids::ulid(),
				'title'   => $title,
				'details' => self::textarea( $item['details'] ?? '', 2000 ),
				'project' => $project,
				'minutes' => $minutes,
				'files'   => $files,
				'links'   => $links,
			);
		}
		if ( $total > GRP_Daily_Reports::MAX_MINUTES ) {
			return self::invalid( __( 'The times add up to more than 24 hours.', 'gridrankers-portal' ) );
		}

		return $out;
	}

	/**
	 * Clean links: `[{url, name?}]`, http(s) only.
	 *
	 * @param mixed $raw Raw links.
	 * @return array|WP_Error
	 */
	private static function links( $raw ) {
		$raw = is_array( $raw ) ? array_values( $raw ) : array();
		if ( count( $raw ) > GRP_Daily_Reports::MAX_LINKS ) {
			return self::invalid( __( 'Add at most 10 links.', 'gridrankers-portal' ) );
		}
		$out = array();
		foreach ( $raw as $link ) {
			$link = (array) $link;
			$url  = self::url( $link['url'] ?? '' );
			if ( is_wp_error( $url ) ) {
				return $url;
			}
			if ( '' === $url ) {
				continue;
			}
			$name  = self::text( $link['name'] ?? '', 120 );
			$out[] = array(
				'url'  => $url,
				'name' => '' !== $name ? $name : (string) wp_parse_url( $url, PHP_URL_HOST ),
			);
		}

		return $out;
	}

	/**
	 * POST /daily-reports/remind `{member_id, day?}`: a private notice asking that person to send
	 * their report (design DR-B, Remind). Managers, for people whose reports they read.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function remind( WP_REST_Request $request ) {
		$person = GRP_Store::get( 'grp_members', (string) $request['member_id'] );
		if ( ! $person || ! (int) $person['active'] ) {
			return self::not_found();
		}
		if ( ! self::can(
			GRP_Permissions::REMIND_DAILY_REPORT,
			array(
				'member_id' => $person['id'],
				'role'      => $person['role'],
			)
		) ) {
			return self::forbidden( __( 'You can’t remind this person.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		$day   = self::date( $request['day'] ?? '', 'day' );
		if ( is_wp_error( $day ) ) {
			return $day;
		}
		$day    = $day ? $day : $today;
		$report = GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $person['id'], $day ) );
		if ( $report && ! empty( $report['sent_at'] ) ) {
			return self::conflict( __( 'They have already sent that report.', 'gridrankers-portal' ) );
		}
		$when = $day === $today ? __( 'today', 'gridrankers-portal' ) : wp_date( 'D, M j', strtotime( $day . ' 12:00:00 UTC' ) );
		$post = GRP_Store::insert(
			'grp_posts',
			array(
				'kind'       => 'notice',
				'title'      => __( 'Please send your daily report', 'gridrankers-portal' ),
				/* translators: %s: "today" or a date. */
				'body'       => sprintf( __( 'Please send your daily report for %s.', 'gridrankers-portal' ), $when ),
				'to_members' => array( (string) $person['id'] ),
				'to_member'  => (string) $person['id'],
				'show_until' => GRP_People::add_days( $today, 1 ),
				'pinned'     => 0,
				'created_by' => self::actor()['id'],
			)
		);

		return new WP_REST_Response( $post, 201 );
	}
}
