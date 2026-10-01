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
