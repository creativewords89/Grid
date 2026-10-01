# GridRankers Portal (WordPress plugin)

See `../SPEC.md` for the full specification. Requires PHP 8.1+ and WordPress 6.4+.

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

## Schema versioning

`GRP_Install::DB_VERSION` is the schema version; the installed version is stored in the `grp_db_version` option.
Tables are created on activation and upgraded on `plugins_loaded` whenever the stored version is older.
To change the schema: edit `GRP_Install::get_schema()`, add any data migration to `GRP_Install::migrations()`
keyed by the new version, and bump `DB_VERSION`.

## Cycle fixtures

`tests/fixtures/cycles.json` is produced by running the reference portal's own cycle functions
(extracted from `../site-changelog.html`) at fixed dates. Regenerate after changing the cases:

```sh
TZ=UTC node tests/fixtures/generate-cycles.mjs
```

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
