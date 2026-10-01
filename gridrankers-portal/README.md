# GridRankers Portal (WordPress plugin)

Internal team portal for GridRankers: meeting tasks, recurring monthly / weekly work, completion review
and per-person reports. See `../SPEC.md` for the full specification.

Requires PHP 8.1+, WordPress 6.4+, MySQL 8 or MariaDB 10.6+.

## Installing on Hostinger

1. Create a dedicated WordPress site on the subdomain **portal.gridrankers.com** (hPanel → Websites →
   Add website, or Auto Installer on the subdomain). Use HTTPS (hPanel → Security → SSL).
2. Sign in to WordPress as the administrator account for **GridRankers@gmail.com**.
3. Upload the plugin: Plugins → Add New → Upload Plugin → `gridrankers-portal.zip` (zip the
   `gridrankers-portal/` folder without `vendor/`, `node_modules/` and `tests/`; `app/dist/` must be
   included). Activate it.
   - Activation creates the tables, creates a page with `[gridrankers_portal]`, makes it the site's front
     page and schedules `grp_daily`. Every other front-end URL redirects to the portal; the site is
     `noindex`.
4. Open the site while signed in to WordPress: click **Set up GridRankers** to create the Super Admin
   profile linked to your WordPress account.
5. Recommended: install a two-factor authentication plugin (e.g. *Two Factor* or *Wordfence Login
   Security*) for WordPress administrators — Super Admins sign in with WordPress.
6. Add the team in the portal (Team → Team → + Add member) and set each person's code. Team Leaders and
   Members sign in with their code only; no WordPress accounts are needed.
7. Import the data from the current portal (below).

### Updates (automatic, from GitHub)

Every change merged to `main` that touches `gridrankers-portal/` is tested by GitHub Actions
(`.github/workflows/plugin.yml`: coding standards, PHPUnit, Vitest, Playwright). If everything passes, it is
published as a release on https://github.com/creativewords89/Grid/releases with `gridrankers-portal.zip` and
`update.json`. Nothing is released when a test fails.

The plugin's `Update URI` header points WordPress at those releases (`includes/class-updater.php`):

- **Plugins** shows *Update available* with *View details*. Auto-updates are always on for this plugin.
- Every hour (`grp_check_update`, run by the server cron below) the plugin checks for a newer release and runs
  WordPress's own automatic updater straight away. A merged change is usually live within about an hour.
- To get it immediately, use **Dashboard → Updates → Check again**, then update GridRankers Portal.
- Only zips from this repository's releases are accepted. Data is kept, and database changes run on their own after an update.
- To stop automatic installs (updates are still offered), add `define( 'GRP_AUTO_UPDATE', false );` to `wp-config.php`.
- To go back to an earlier version, download its `gridrankers-portal.zip` from Releases and upload it
  (Plugins → Add New → Upload → *Replace current with uploaded*). The next newer release will update it again.

Version numbers: the release workflow uses major.minor from the plugin header (`0.1`) and one more than the
last release for the patch (0.1.1, 0.1.2, …). The repository keeps `0.1.0`. To start 0.2.x, change the header
`Version` and `GRP_VERSION` to `0.2.0`. To build a zip by hand: `cd app && npm run build`, then
`bash bin/build-zip.sh 0.1.99`.

WordPress emails the site administrator after each automatic update.

### Real cron (required)

`grp_daily` is registered with WP-Cron (hourly; every task is safe to repeat). WP-Cron only runs when
someone visits, so also add a server cron in **hPanel → Advanced → Cron Jobs**:

- Type: *Custom*, every 15 minutes (`*/15 * * * *`)
- Command:

  ```
  wget -q -O - "https://portal.gridrankers.com/wp-cron.php?doing_wp_cron" >/dev/null 2>&1
  ```

Optionally add `define( 'DISABLE_WP_CRON', true );` to `wp-config.php` once the server cron is in place,
so page loads never trigger cron.

The same cron also drives the hourly update check (*Updates* above). `grp_daily` does:

- standard monthly tasks: each project whose current cycle differs from `std_cycle` gets any missing
  standard task (GBP Posts, Social Posts, Pages, Blogs, Free Backlinks, Paid Backlinks) and `std_cycle`
  is updated — a standard task deleted during a cycle stays gone until the next cycle;
- purges trash older than 30 days, expired sign-in sessions and old deletion tombstones.

### Caching (required)

The portal is live data: it must never be cached. The plugin sends `Cache-Control: no-store` on the portal
page and on every `/wp-json/gr-portal/*` response, but server caches must also skip them:

- **LiteSpeed Cache plugin** → Cache → Excludes → *Do Not Cache URIs*: add
  ```
  ^/$
  /wp-json/gr-portal/
  ```
  and in *Do Not Cache Cookies* add `grp_session`.
- **Hostinger Cache Manager** (hPanel → Website → Cache Manager): turn automatic cache off for this site,
  or add the same URL exclusions there and purge the cache after updating the plugin.
- Do not put the portal behind a CDN page cache (Hostinger CDN: exclude the same paths, or turn it off).

### Backups

Rely on Hostinger's daily backups and download a JSON export regularly
(**Team → Settings → Export all data** in the portal, or **GridRankers → Export** in WordPress).

## Importing from the current portal

1. In the current portal: **Team → Settings → Export all data** (JSON file).
2. In WordPress: **GridRankers → Import**, choose the file and keep **Dry run** ticked. Check the counts.
3. Run it again with Dry run unticked. Importing is idempotent (rows are matched by their original ids).
4. Link the old Super Admin to a WordPress administrator (the import lists any it found).

Old sign-in codes keep working: they are checked against the legacy `sha256(salt:code)` hash and
re-hashed with `password_hash()` on first sign-in. Old Super Admin codes are not used; Super Admins
sign in with WordPress. The old `admin` and `gdrive` settings documents and `visitors` are not imported.

**GridRankers → Export** (or `GET /wp-json/gr-portal/v1/export`) downloads the same format, which can be
imported again.

## Development

```sh
composer install          # PHPUnit, WordPress test suite, WordPress core, WPCS
composer lint             # WordPress coding standards
composer test             # PHPUnit
```

The tests need an **empty, dedicated** MySQL/MariaDB database (the WordPress test suite drops every table in it).
Connection settings come from environment variables, defaulting to `root@localhost` / `wordpress_test`:

```sh
WP_TESTS_DB_NAME=wordpress_test WP_TESTS_DB_USER=root WP_TESTS_DB_PASSWORD= WP_TESTS_DB_HOST=localhost composer test
```

### Front end (React app)

The portal is a React app in `app/`, built with Vite into `app/dist/` (committed, so the plugin
installs without Node).

```sh
cd app
npm install
npm test                  # Vitest
npm run build             # writes app/dist (commit it)
node extract-styles.mjs   # re-copy the reference stylesheet into src/styles/portal.css
```

Fonts (Bricolage Grotesque, Instrument Sans) and jsPDF / AutoTable for the PDF report are bundled;
nothing loads from a CDN.

### End-to-end tests (Playwright)

`app/e2e/` drives the real portal in Chromium: the completion review round trip (member completes →
Super Admin asks for a revision → member completes again → Super Admin accepts), a member being unable
to edit or delete (in the UI and through the API), cycle switching and a cycle change, the import /
export round trip from WP-admin, the Dashboard (adding, moving, deleting and restoring projects;
per-project Recent Activities) and weekly tasks following the project cycle.

Each run builds a throwaway WordPress site from `vendor/roots/wordpress-no-content` (so run
`composer install` first) with a fresh database `grp_e2e`, seeds a team (`app/e2e/site/install.php`) and
serves it with `php -S` on port 8090. It needs a local MySQL/MariaDB the `mysql` client can reach.

```sh
cd app
npm run build             # the tests use app/dist
npm run e2e               # E2E_DB_USER / E2E_DB_PASS / E2E_DB_HOST / E2E_PORT / E2E_DIR to override
CHROMIUM_PATH=/path/to/chrome npm run e2e   # use an installed Chromium instead of Playwright's
```

### Schema versioning

`GRP_Install::DB_VERSION` is the schema version; the installed version is stored in the `grp_db_version` option.
Tables are created on activation and upgraded on `plugins_loaded` whenever the stored version is older.
To change the schema: edit `GRP_Install::get_schema()`, add any data migration to `GRP_Install::migrations()`
keyed by the new version, and bump `DB_VERSION`.

### Cycle fixtures

`tests/fixtures/cycles.json` is produced by running the reference portal's own cycle functions
(extracted from `../site-changelog.html`) at fixed dates. Both the PHP and the JS ports are tested
against it. Regenerate after changing the cases:

```sh
TZ=UTC node tests/fixtures/generate-cycles.mjs
```
