<?php
/**
 * Bare page for the portal: no theme header, footer or sidebars.
 *
 * @package GridRankers_Portal
 */

defined( 'ABSPATH' ) || exit;

$grp_content = do_shortcode( '[' . GRP_Frontend::SHORTCODE . ']' );
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<link rel="icon" href="data:,">
	<title><?php echo esc_html( get_bloginfo( 'name' ) ? get_bloginfo( 'name' ) : 'GridRankers' ); ?></title>
	<?php wp_head(); ?>
</head>
<body class="grp-portal">
	<?php echo $grp_content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- built by GRP_Frontend::shortcode() from constant markup. ?>
	<?php wp_footer(); ?>
</body>
</html>
