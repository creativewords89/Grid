# Instructions for Claude Code — Answer Engine

- Read `answer-engine/SPEC.md` before every task. It is the source of truth for this folder.
- This is a separate product from the WordPress portal: never change `gridrankers-portal/`, the root `SPEC.md` or `site-changelog.html` while working here.
- Do ONE build step from SPEC.md section 15 per task. Never start the next step unprompted.
- Enforce every permission rule (SPEC.md section 3) on the server, with pytest tests.
- Parameterised SQL only (SQLAlchemy). Escape all output. No external CDNs.
- Python 3.12 (ruff, mypy strict), TypeScript (eslint, prettier). Run all checks before committing.
- End each task with: what you built, how to test it, anything unfinished.
