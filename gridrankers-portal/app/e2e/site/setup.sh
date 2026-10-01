#!/usr/bin/env bash
# Builds a throwaway WordPress site for the Playwright e2e tests:
# WordPress core from composer (vendor/roots/wordpress-no-content), the plugin symlinked in,
# a fresh database, and a seeded team. Needs php, mysql client access and `composer install`.
#
#   E2E_DIR=/tmp/grp-e2e E2E_DB=grp_e2e E2E_DB_USER=root E2E_DB_PASS= bash app/e2e/site/setup.sh
set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/../../.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/grp-e2e}"
E2E_DB="${E2E_DB:-grp_e2e}"
E2E_DB_USER="${E2E_DB_USER:-root}"
E2E_DB_PASS="${E2E_DB_PASS:-}"
E2E_DB_HOST="${E2E_DB_HOST:-localhost}"
E2E_URL="${E2E_URL:-http://127.0.0.1:8090}"

rm -rf "$E2E_DIR"
cp -r "$PLUGIN/vendor/roots/wordpress-no-content" "$E2E_DIR"
mkdir -p "$E2E_DIR/wp-content/plugins" "$E2E_DIR/wp-content/themes"
# No theme, like a fresh CI checkout: WordPress then prints type='text/javascript' on scripts, which the
# portal must still turn into a module. Also no .git, so WordPress treats the site as a normal install.
find "$E2E_DIR/wp-content/themes" -mindepth 1 -maxdepth 1 ! -name index.php -exec rm -rf {} +
rm -rf "$E2E_DIR/.git"
ln -s "$PLUGIN" "$E2E_DIR/wp-content/plugins/gridrankers-portal"

mysql -h"$E2E_DB_HOST" -u"$E2E_DB_USER" ${E2E_DB_PASS:+-p"$E2E_DB_PASS"} -e "DROP DATABASE IF EXISTS \`$E2E_DB\`; CREATE DATABASE \`$E2E_DB\`;"

cat > "$E2E_DIR/wp-config.php" <<PHP
<?php
define( 'DB_NAME', '$E2E_DB' );
define( 'DB_USER', '$E2E_DB_USER' );
define( 'DB_PASSWORD', '$E2E_DB_PASS' );
define( 'DB_HOST', '$E2E_DB_HOST' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as \$k ) { define( \$k, 'e2e-' . \$k ); }
\$table_prefix = 'wp_';
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_HOME', '$E2E_URL' );
define( 'WP_SITEURL', '$E2E_URL' );
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
PHP

E2E_DIR="$E2E_DIR" php "$PLUGIN/app/e2e/site/install.php"
