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

	/** Title of the notice Remind sends (also how a reminder is recognised). */
	const REMIND_TITLE = 'Please send your daily report';

	/**
	 * Registers routes.
	 */
	public static function register_routes() {
		self::route( '/daily-reports/me', WP_REST_Server::READABLE, 'me' );
		self::route( '/daily-reports/team', WP_REST_Server::READABLE, 'team' );
		self::route( '/daily-reports/remind', WP_REST_Server::CREATABLE, 'remind' );
		self::route( '/daily-reports', WP_REST_Server::READABLE, 'person' );
		self::route( '/daily-reports/(?P<day>\d{4}-\d{2}-\d{2})', 'PUT', 'save' );
		self::route( '/daily-reports/(?P<day>\d{4}-\d{2}-\d{2})/change', WP_REST_Server::CREATABLE, 'ask_change' );
		self::route( '/report-changes/(?P<id>[\w-]+)', WP_REST_Server::EDITABLE, 'decide_change' );
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
				'day <='    => gmdate( 'Y-m-t', strtotime( $month . '-01 UTC' ) ),
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
			$report = $reports[ (string) $member['id'] ] ?? null;
			$sent   = $report && ! empty( $report['sent_at'] ) ? $report : null;
			$state  = GRP_Daily_Reports::state( $member, $day, $today, $since, $report, $leaves, $weekly, $off );
			$pay    = GRP_Store::get( 'grp_pay', (string) $member['id'] );
			$row    = array(
				'member_id'   => $member['id'],
				'state'       => $state,
				'report'      => self::out( $sent ),
				// Their working day (hours only, never pay), for "5h 30m of 8h".
				'day_minutes' => $pay ? (int) $pay['day_minutes'] : null,
			);
			if ( 'not_sent' === $state ) {
				$row['missed']      = GRP_Daily_Reports::missed_in_a_row( $member, $day, $since, self::sent_days( $member['id'], $day ), $leaves, $weekly, $off );
				$row['reminded_at'] = self::reminded_at( $member['id'], $day );
			}
			$people[] = $row;
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
		// Tracked time (SPEC.md 6.21) stays tracked: its minutes follow the timer, not what was typed.
		$entries = GRP_Time_Entries::keep_tracked( $entries, array_values( (array) ( $existing['entries'] ?? array() ) ), $actor['id'], $day );
		$send    = ! empty( $request['send'] ) || ( $existing && ! empty( $existing['sent_at'] ) );
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
	 * Days (`Y-m-d` => true) a person sent a report, in the BACK_DAYS before `$day` and on it.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d`.
	 * @return array<string, bool>
	 */
	private static function sent_days( $member_id, $day ) {
		$days = array();
		foreach ( GRP_Store::find(
			self::TABLE,
			array(
				'member_id' => $member_id,
				'day >='    => GRP_People::add_days( $day, -GRP_Daily_Reports::BACK_DAYS ),
				'day <='    => $day,
			)
		) as $row ) {
			if ( ! empty( $row['sent_at'] ) ) {
				$days[ (string) $row['day'] ] = true;
			}
		}

		return $days;
	}

	/**
	 * When someone was last reminded to send their report for a day (UTC), or null.
	 *
	 * @param string $member_id Person.
	 * @param string $day       `Y-m-d` (site time).
	 * @return string|null
	 */
	private static function reminded_at( $member_id, $day ) {
		$last = null;
		foreach ( GRP_Store::find(
			'grp_posts',
			array(
				'kind'          => 'notice',
				'to_member'     => (string) $member_id,
				'created_at >=' => get_gmt_from_date( $day . ' 00:00:00' ),
			)
		) as $post ) {
			if ( self::REMIND_TITLE === (string) $post['title'] && ( null === $last || $post['created_at'] > $last ) ) {
				$last = (string) $post['created_at'];
			}
		}

		return $last;
	}

	/**
	 * POST /daily-reports/remind `{member_id, day?}`: a private notice asking that person to send
	 * their report (design DR-B, Remind). Or `{member_ids: [], day?, tell_leads?}` (design TR-G1,
	 * Remind all): one notice each to everyone listed who still owes that report (anyone who sent
	 * it or was off is skipped), and with `tell_leads` a notice to the Team Leaders naming them.
	 * Managers, for people whose reports they read.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function remind( WP_REST_Request $request ) {
		$bulk = is_array( $request['member_ids'] );
		$ids  = $bulk ? array_values( array_unique( array_map( 'strval', $request['member_ids'] ) ) ) : array( (string) $request['member_id'] );
		if ( ! $ids ) {
			return self::invalid( __( 'Choose who to remind.', 'gridrankers-portal' ) );
		}
		$today = GRP_Cycles::today();
		$day   = self::date( $request['day'] ?? '', 'day' );
		if ( is_wp_error( $day ) ) {
			return $day;
		}
		$day    = $day ? $day : $today;
		$leaves = self::leaves();
		$weekly = GRP_REST_People::team_weekly();
		$off    = GRP_REST_People::days_off();

		$people = array();
		foreach ( $ids as $id ) {
			$person = GRP_Store::get( 'grp_members', $id );
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
			$report = GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $person['id'], $day ) );
			if ( $report && ! empty( $report['sent_at'] ) ) {
				if ( ! $bulk ) {
					return self::conflict( __( 'They have already sent that report.', 'gridrankers-portal' ) );
				}
				continue;
			}
			if ( $bulk && GRP_Daily_Reports::out_reason( $day, $person, $leaves, $weekly, $off ) ) {
				continue;
			}
			$people[] = $person;
		}

		$actor = self::actor();
		$when  = $day === $today ? __( 'today', 'gridrankers-portal' ) : wp_date( 'D, M j', strtotime( $day . ' 12:00:00 UTC' ) );
		$posts = array();
		foreach ( $people as $person ) {
			$posts[] = GRP_Store::insert(
				'grp_posts',
				array(
					'kind'       => 'notice',
					'title'      => self::REMIND_TITLE,
					/* translators: %s: "today" or a date. */
					'body'       => sprintf( __( 'Please send your daily report for %s.', 'gridrankers-portal' ), $when ),
					'to_members' => array( (string) $person['id'] ),
					'to_member'  => (string) $person['id'],
					'show_until' => GRP_People::add_days( $today, 1 ),
					'pinned'     => 0,
					'created_by' => $actor['id'],
				)
			);
		}
		if ( ! $bulk ) {
			return new WP_REST_Response( $posts[0], 201 );
		}

		$reminded = array_map(
			static function ( $p ) {
				return (string) $p['id'];
			},
			$people
		);
		if ( $people && ! empty( $request['tell_leads'] ) ) {
			$leads = array();
			foreach ( GRP_Store::find( 'grp_members', array( 'active' => 1 ) ) as $member ) {
				$id = (string) $member['id'];
				if ( GRP_Permissions::ROLE_LEAD === GRP_Permissions::effective_role( $member ) && $id !== (string) $actor['id'] && ! in_array( $id, $reminded, true ) ) {
					$leads[] = $id;
				}
			}
			if ( $leads ) {
				$names = implode(
					', ',
					array_map(
						static function ( $p ) {
							return $p['name'];
						},
						$people
					)
				);
				GRP_Store::insert(
					'grp_posts',
					array(
						'kind'       => 'notice',
						'title'      => __( 'Daily reports not sent', 'gridrankers-portal' ),
						/* translators: 1: "today" or a date, 2: names, 3: who reminded them. */
						'body'       => sprintf( __( 'Not sent for %1$s: %2$s. %3$s reminded them.', 'gridrankers-portal' ), $when, $names, $actor['name'] ),
						'to_members' => $leads,
						'to_member'  => $leads[0],
						'show_until' => GRP_People::add_days( $today, 1 ),
						'pinned'     => 0,
						'created_by' => $actor['id'],
					)
				);
			}
		}

		return new WP_REST_Response(
			array(
				'reminded' => $reminded,
				'skipped'  => array_values( array_diff( $ids, $reminded ) ),
			),
			201
		);
	}

	/**
	 * Whether a person's salary for the month of `$day` is marked paid (then its reports stay as they are).
	 *
	 * @param string $member_id Member id.
	 * @param string $day       `Y-m-d`.
	 * @return bool
	 */
	private static function month_paid( $member_id, $day ) {
		$slip = GRP_Store::get( 'grp_payslips', GRP_Pay::slip_id( $member_id, substr( $day, 0, 7 ) ) );

		return $slip && ! empty( $slip['paid_at'] );
	}

	/**
	 * POST /daily-reports/{day}/change `{entries: {entryId: minutes}, reason}` (design RC-1): asks to
	 * change the time of one's own sent report from an earlier day. One waiting request per report;
	 * Team Leaders (for Team Members) and the Super Admin decide. Not once that month's salary is paid.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function ask_change( WP_REST_Request $request ) {
		$actor = self::actor();
		if ( ! self::can( GRP_Permissions::ASK_REPORT_CHANGE, array( 'member_id' => $actor['id'] ) ) ) {
			return self::forbidden( __( 'You can only ask to change your own reports.', 'gridrankers-portal' ) );
		}
		$day    = (string) $request['day'];
		$report = GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $actor['id'], $day ) );
		if ( ! $report || empty( $report['sent_at'] ) ) {
			return self::not_found();
		}
		if ( $day >= GRP_Cycles::today() ) {
			return self::conflict( __( 'Today’s report can still be changed — edit it instead.', 'gridrankers-portal' ), 'grp_report_open' );
		}
		if ( self::month_paid( $actor['id'], $day ) ) {
			return self::conflict( __( 'That month’s salary is paid, so its reports can’t be changed.', 'gridrankers-portal' ), 'grp_month_paid' );
		}
		if ( GRP_Store::find(
			'grp_report_changes',
			array(
				'member_id' => $actor['id'],
				'day'       => $day,
				'status'    => 'pending',
			)
		) ) {
			return self::conflict( __( 'A change to this report is already waiting.', 'gridrankers-portal' ), 'grp_change_waiting' );
		}
		$reason = self::textarea( $request['reason'] ?? '', 500 );
		if ( '' === $reason ) {
			return self::invalid( __( 'Say why the time was wrong.', 'gridrankers-portal' ), 'grp_change_reason' );
		}

		$asked = (array) ( $request['entries'] ?? array() );
		$lines = array();
		$from  = 0;
		$to    = 0;
		foreach ( array_values( (array) $report['entries'] ) as $entry ) {
			$was = (int) $entry['minutes'];
			$now = array_key_exists( $entry['id'], $asked ) ? $asked[ $entry['id'] ] : $was;
			if ( ! is_numeric( $now ) || (int) $now < 1 || (int) $now > GRP_Daily_Reports::MAX_MINUTES ) {
				/* translators: %s: what they did. */
				return self::invalid( sprintf( __( 'Add the time spent on “%s”.', 'gridrankers-portal' ), $entry['title'] ) );
			}
			$from += $was;
			$to   += (int) $now;
			if ( (int) $now !== $was ) {
				$lines[] = array(
					'id'    => $entry['id'],
					'title' => $entry['title'],
					'from'  => $was,
					'to'    => (int) $now,
				);
			}
		}
		if ( ! $lines ) {
			return self::invalid( __( 'Change at least one time.', 'gridrankers-portal' ), 'grp_change_none' );
		}
		if ( $to > GRP_Daily_Reports::MAX_MINUTES ) {
			return self::invalid( __( 'A day has at most 24 hours.', 'gridrankers-portal' ) );
		}

		$row = GRP_Store::transaction(
			static function () use ( $actor, $day, $lines, $from, $to, $reason ) {
				$row = GRP_Store::insert(
					'grp_report_changes',
					array(
						'member_id'    => $actor['id'],
						'member_role'  => GRP_Permissions::effective_role( $actor ),
						'day'          => $day,
						'entries'      => $lines,
						'from_minutes' => $from,
						'to_minutes'   => $to,
						'reason'       => $reason,
						'status'       => 'pending',
						'created_by'   => $actor['id'],
					)
				);
				GRP_Activity::audit( 'add', 'report_change', $row, $actor, "$day: " . GRP_Daily_Reports::hours( $from ) . ' → ' . GRP_Daily_Reports::hours( $to ) );
				return $row;
			}
		);

		return new WP_REST_Response( $row, 201 );
	}

	/**
	 * PATCH /report-changes/{id} `{action: approve|reject|cancel, message?}`. Approving puts the new
	 * times on the report and recalculates a payslip not yet paid; the person may cancel while it waits.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function decide_change( WP_REST_Request $request ) {
		$actor  = self::actor();
		$change = GRP_Store::get( 'grp_report_changes', (string) $request['id'] );
		if ( ! $change ) {
			return self::not_found();
		}
		$action = (string) $request['action'];
		if ( ! in_array( $action, array( 'approve', 'reject', 'cancel' ), true ) ) {
			return self::invalid( __( 'Approve, reject or cancel.', 'gridrankers-portal' ) );
		}
		$own = (string) $change['member_id'] === (string) $actor['id'];
		if ( 'cancel' === $action ? ! $own : ! self::can(
			GRP_Permissions::DECIDE_REPORT_CHANGE,
			array(
				'member_id' => $change['member_id'],
				'role'      => $change['member_role'],
			)
		) ) {
			return self::forbidden( 'cancel' === $action ? __( 'Only the person who asked can cancel it.', 'gridrankers-portal' ) : __( 'You can’t decide this change.', 'gridrankers-portal' ) );
		}
		if ( 'pending' !== $change['status'] ) {
			return self::conflict( __( 'That change was already answered.', 'gridrankers-portal' ), 'grp_change_decided' );
		}
		$report = GRP_Store::get( self::TABLE, GRP_Daily_Reports::row_id( $change['member_id'], $change['day'] ) );
		if ( 'approve' === $action ) {
			if ( self::month_paid( $change['member_id'], $change['day'] ) ) {
				return self::conflict( __( 'That month’s salary is paid, so its reports can’t be changed.', 'gridrankers-portal' ), 'grp_month_paid' );
			}
			if ( ! $report ) {
				return self::conflict( __( 'That report is gone.', 'gridrankers-portal' ), 'grp_change_stale' );
			}
		}
		$message = self::textarea( $request['message'] ?? '', 500 );

		$saved = GRP_Store::transaction(
			static function () use ( $action, $change, $report, $actor, $message ) {
				if ( 'approve' === $action ) {
					$to      = array_column( (array) $change['entries'], 'to', 'id' );
					$entries = array_map(
						static function ( $entry ) use ( $to ) {
							if ( isset( $to[ $entry['id'] ] ) ) {
								$entry['minutes'] = (int) $to[ $entry['id'] ];
							}
							return $entry;
						},
						array_values( (array) $report['entries'] )
					);
					GRP_Store::update( self::TABLE, $report['id'], array( 'entries' => $entries ) );
					self::rebill( $change['member_id'], substr( $change['day'], 0, 7 ) );
				}
				$status = array(
					'approve' => 'approved',
					'reject'  => 'rejected',
					'cancel'  => 'cancelled',
				)[ $action ];
				$saved  = GRP_Store::update(
					'grp_report_changes',
					$change['id'],
					array(
						'status'     => $status,
						'decided_by' => $actor['id'],
						'decided_at' => GRP_Ids::now(),
						'message'    => '' !== $message ? $message : null,
					)
				);
				GRP_Activity::audit( 'edit', 'report_change', $saved, $actor, ucfirst( $status ) . ': ' . $change['day'] );
				return $saved;
			}
		);

		return rest_ensure_response( $saved );
	}

	/**
	 * Recalculates a payslip that is made but not paid yet, after a report's time changed.
	 *
	 * @param string $member_id Member id.
	 * @param string $month     `YYYY-MM`.
	 */
	private static function rebill( $member_id, $month ) {
		$slip   = GRP_Store::get( 'grp_payslips', GRP_Pay::slip_id( $member_id, $month ) );
		$member = GRP_Store::get( 'grp_members', $member_id );
		$pay    = GRP_Store::get( 'grp_pay', $member_id );
		if ( ! $slip || ! empty( $slip['paid_at'] ) || ! $member || ! $pay ) {
			return;
		}
		$sum = GRP_Pay::month_of( $member, $pay, $month, GRP_Cycles::today() );
		GRP_Store::update(
			'grp_payslips',
			$slip['id'],
			array(
				'worked'    => $sum['worked'],
				'extra'     => $sum['extra'],
				'extra_pay' => $sum['extra_pay'],
				'total'     => $sum['total'],
			)
		);
	}
}
