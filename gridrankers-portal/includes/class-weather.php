<?php
/**
 * Today's weather for a city from Open-Meteo (SPEC.md 6.10).
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

/**
 * Looks a city up with Open-Meteo's free geocoding and forecast APIs (no account, no key).
 * Only the city name and its coordinates are sent. Coordinates are cached 30 days and the
 * forecast 1 hour per city; failures are cached 15 minutes so a slow service isn't asked
 * again on every page load.
 */
class GRP_Weather {

	const GEOCODE_URL  = 'https://geocoding-api.open-meteo.com/v1/search';
	const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

	/**
	 * WMO weather codes => [text, icon].
	 */
	const CODES = array(
		0  => array( 'Clear', 'sun' ),
		1  => array( 'Mostly sunny', 'sun' ),
		2  => array( 'Partly cloudy', 'cloud-sun' ),
		3  => array( 'Cloudy', 'cloud' ),
		45 => array( 'Fog', 'fog' ),
		48 => array( 'Fog', 'fog' ),
		51 => array( 'Drizzle', 'rain' ),
		53 => array( 'Drizzle', 'rain' ),
		55 => array( 'Drizzle', 'rain' ),
		56 => array( 'Freezing drizzle', 'rain' ),
		57 => array( 'Freezing drizzle', 'rain' ),
		61 => array( 'Light rain', 'rain' ),
		63 => array( 'Rain', 'rain' ),
		65 => array( 'Heavy rain', 'rain' ),
		66 => array( 'Freezing rain', 'rain' ),
		67 => array( 'Freezing rain', 'rain' ),
		71 => array( 'Light snow', 'snow' ),
		73 => array( 'Snow', 'snow' ),
		75 => array( 'Heavy snow', 'snow' ),
		77 => array( 'Snow', 'snow' ),
		80 => array( 'Showers', 'rain' ),
		81 => array( 'Showers', 'rain' ),
		82 => array( 'Heavy showers', 'rain' ),
		85 => array( 'Snow showers', 'snow' ),
		86 => array( 'Snow showers', 'snow' ),
		95 => array( 'Thunderstorm', 'storm' ),
		96 => array( 'Thunderstorm', 'storm' ),
		99 => array( 'Thunderstorm', 'storm' ),
	);

	/**
	 * Whether weather is on (`GRP_WEATHER` not set to false).
	 *
	 * @return bool
	 */
	public static function enabled() {
		return ! ( defined( 'GRP_WEATHER' ) && ! GRP_WEATHER );
	}

	/**
	 * Today's weather for a city, or null when unknown / unavailable.
	 *
	 * @param string $city City name, e.g. "Rangpur".
	 * @return array|null `{city, temp, max, min, code, text, icon}`.
	 */
	public static function for_city( $city ) {
		$city = trim( (string) $city );
		if ( '' === $city || ! self::enabled() ) {
			return null;
		}
		$key    = 'grp_wx_' . md5( strtolower( $city ) );
		$cached = get_transient( $key );
		if ( false !== $cached ) {
			return $cached ? $cached : null;
		}

		$place   = self::place( $city );
		$weather = $place ? self::forecast( $place ) : null;
		set_transient( $key, $weather ? $weather : 0, $weather ? HOUR_IN_SECONDS : 15 * MINUTE_IN_SECONDS );

		return $weather;
	}

	/**
	 * Coordinates of a city (cached 30 days), or null.
	 *
	 * @param string $city City.
	 * @return array|null `{name, lat, lon}`.
	 */
	private static function place( $city ) {
		$key    = 'grp_geo_' . md5( strtolower( $city ) );
		$cached = get_transient( $key );
		if ( false !== $cached ) {
			return $cached ? $cached : null;
		}
		$data  = self::get_json(
			add_query_arg(
				array(
					'name'     => rawurlencode( $city ),
					'count'    => 1,
					'language' => 'en',
					'format'   => 'json',
				),
				self::GEOCODE_URL
			)
		);
		$hit   = $data['results'][0] ?? null;
		$place = is_array( $hit ) && isset( $hit['latitude'], $hit['longitude'] )
			? array(
				'name' => (string) ( $hit['name'] ?? $city ),
				'lat'  => (float) $hit['latitude'],
				'lon'  => (float) $hit['longitude'],
			)
			: null;
		if ( null !== $data ) {
			set_transient( $key, $place ? $place : 0, $place ? 30 * DAY_IN_SECONDS : DAY_IN_SECONDS );
		}

		return $place;
	}

	/**
	 * Today's forecast for coordinates, or null.
	 *
	 * @param array $place `{name, lat, lon}`.
	 * @return array|null
	 */
	private static function forecast( array $place ) {
		$data = self::get_json(
			add_query_arg(
				array(
					'latitude'      => $place['lat'],
					'longitude'     => $place['lon'],
					'current'       => 'temperature_2m,weather_code',
					'daily'         => 'temperature_2m_max,temperature_2m_min',
					'timezone'      => 'auto',
					'forecast_days' => 1,
				),
				self::FORECAST_URL
			)
		);
		if ( ! isset( $data['current']['temperature_2m'], $data['current']['weather_code'] ) ) {
			return null;
		}
		$code               = (int) $data['current']['weather_code'];
		list( $text, $ico ) = self::CODES[ $code ] ?? array( 'Weather', 'cloud' );

		return array(
			'city' => $place['name'],
			'temp' => (int) round( (float) $data['current']['temperature_2m'] ),
			'max'  => isset( $data['daily']['temperature_2m_max'][0] ) ? (int) round( (float) $data['daily']['temperature_2m_max'][0] ) : null,
			'min'  => isset( $data['daily']['temperature_2m_min'][0] ) ? (int) round( (float) $data['daily']['temperature_2m_min'][0] ) : null,
			'code' => $code,
			'text' => $text,
			'icon' => $ico,
		);
	}

	/**
	 * GETs a URL and decodes JSON; null on any failure.
	 *
	 * @param string $url URL.
	 * @return array|null
	 */
	private static function get_json( $url ) {
		$response = wp_remote_get(
			$url,
			array(
				'timeout'    => 5,
				'user-agent' => 'GridRankers Portal/' . GRP_VERSION,
			)
		);
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}
		$data = json_decode( wp_remote_retrieve_body( $response ), true );

		return is_array( $data ) ? $data : null;
	}
}
