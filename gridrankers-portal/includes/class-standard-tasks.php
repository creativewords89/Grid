<?php
/**
 * GridRankers' standard monthly tasks (SPEC.md section 6.8).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Every project has the six standard monthly tasks. New projects get them on creation;
 * grp_daily tops them up once per cycle (a standard task deleted during a cycle stays
 * gone until the next one).
 */
class GRP_Standard_Tasks {

	/**
	 * Title => breakdown rows (quantities start at 1 per type).
	 */
	const TASKS = array(
		'GBP Posts'      => array(),
		'Social Posts'   => array(),
		'Pages'          => array( 'Service Pages', 'Location Pages' ),
		'Blogs'          => array(),
		'Free Backlinks' => array( 'Citations', 'Cloud Stack', 'Google Stack', 'Batch GEO', 'Map Citation / Map Pin', 'Driving Direction', 'Profile Backlinks', 'Web 2.0', 'Brand Mentions', 'PDF / Image / Video Submission', 'Directory Submission' ),
		'Paid Backlinks' => array( 'Guest Post', 'Memberships (e.g. Chamber of Commerce)', 'Press Release' ),
	);

	/**
	 * Lower-case, dash-separated slug (reference stdId).
	 *
	 * @param string $text Text.
	 * @return string
	 */
	public static function slug( $text ) {
		return trim( (string) preg_replace( '/[^a-z0-9]+/', '-', strtolower( $text ) ), '-' );
	}

	/**
	 * Deterministic id of a project's standard task: `std_{projectId}_{slug}`.
	 *
	 * @param string $project_id Project id.
	 * @param string $title      Task title.
	 * @return string
	 */
	public static function task_id( $project_id, $title ) {
		return 'std_' . $project_id . '_' . self::slug( $title );
	}

	/**
	 * Adds any missing standard task to a project (matched by title, case-insensitive).
	 *
	 * @param array $project Project row.
	 * @return int Number of tasks added.
	 */
	public static function add_missing( array $project ) {
		$have = array();
		foreach ( GRP_Store::find( 'grp_monthly_tasks', array( 'project_id' => $project['id'] ) ) as $task ) {
			$have[ strtolower( $task['title'] ) ] = true;
		}

		$added = 0;
		foreach ( self::TASKS as $title => $types ) {
			$id = self::task_id( $project['id'], $title );
			if ( isset( $have[ strtolower( $title ) ] ) || GRP_Store::get( 'grp_monthly_tasks', $id ) ) {
				continue;
			}
			$parts = array();
			foreach ( array_values( $types ) as $j => $name ) {
				$parts[] = array(
					'id'     => 'p' . $j . '_' . self::slug( $name ),
					'name'   => $name,
					'n'      => 1,
					'people' => array(),
				);
			}
			GRP_Store::insert(
				'grp_monthly_tasks',
				array(
					'id'         => $id,
					'project_id' => $project['id'],
					'title'      => $title,
					'notes'      => '',
					'freq'       => 'monthly',
					'due_mode'   => 'monthly',
					'target'     => $parts ? count( $parts ) : 1,
					'assignees'  => array(),
					'team'       => 1,
					'parts'      => $parts ? $parts : null,
					'std'        => 1,
				)
			);
			++$added;
		}

		return $added;
	}

	/**
	 * Tops up a project once per cycle: when its current cycle key differs from
	 * `std_cycle`, add missing standard tasks and record the key.
	 *
	 * @param array  $project Project row.
	 * @param string $today   `Y-m-d`.
	 * @return int Number of tasks added (0 when already checked this cycle).
	 */
	public static function ensure( array $project, $today ) {
		$key = GRP_Cycles::cycle_range( $project, 0, $today )['key'];
		if ( $key === $project['std_cycle'] ) {
			return 0;
		}

		$added = self::add_missing( $project );
		GRP_Store::update( 'grp_projects', $project['id'], array( 'std_cycle' => $key ) );

		return $added;
	}
}
