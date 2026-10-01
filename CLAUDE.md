# Instructions for Claude Code

- Read SPEC.md before every task. It is the source of truth.
- site-changelog.html is the design and behaviour reference only. Never modify it.
- Build a WordPress plugin in gridrankers-portal/ exactly as SPEC.md section 2 describes.
- Do ONE build step from SPEC.md section 11 per task. Never start the next step unprompted.
- Enforce every permission rule (SPEC.md section 3) in PHP on the server, with PHPUnit tests.
- Prepared statements for all SQL. Escape all output. No external CDNs.
- PHP 8.1+, WordPress 6.4+, WordPress coding standards.
- End each task with: what you built, how to test it, anything unfinished.
