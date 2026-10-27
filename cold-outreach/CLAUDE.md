# Instructions for Claude Code — Cold Outreach

- Read `cold-outreach/PLAN.md` and the spec of the part you work on (`hub/SPEC.md`, later
  `agents/*/SPEC.md`) before every task. They are the source of truth for this folder.
- This is a separate product: never change `gridrankers-portal/`, `answer-engine/`, the root
  `SPEC.md` or `site-changelog.html` while working here.
- Do ONE build step per task (the spec's build plan). Never start the next step unprompted.
- Enforce every permission rule on the server, with pytest tests.
- Parameterised SQL only (SQLAlchemy). Escape all output. No external CDNs.
- Python 3.12 (ruff, mypy strict), TypeScript (eslint, prettier). Run all checks before committing.
- Never commit secrets. Keys are entered in the Hub (Connections), not in code or `.env.example`.
- End each task with: what you built, how to test it, anything unfinished.
