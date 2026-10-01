# GridRankers Team Portal — Build Specification (WordPress plugin)

This document is the single source of truth for rebuilding the GridRankers team portal (currently a claude.ai artifact, `site-changelog.html`) as a **WordPress plugin** hosted on Hostinger. The reference HTML file is provided alongside this spec: match its look, wording and behaviour unless this spec says otherwise.

---

## 1. Goals

- Internal portal for the GridRankers local-SEO agency (20+ staff) to track client work: meeting tasks, recurring monthly/weekly deliverables, completion review and per-person reports.
- Runs on the company's own hosting at **portal.gridrankers.com**. No third-party accounts for staff.
- **All permissions enforced on the server** (REST API + capability checks). The browser is never trusted.
- Data migrates from the current portal via a JSON export (section 10).

## 2. Architecture

| Part | Decision |
|---|---|
| Platform | Dedicated WordPress install on the subdomain `portal.gridrankers.com` (Hostinger, PHP 8.1+, MySQL 8 / MariaDB 10.6+) |
| Plugin | `gridrankers-portal/` — all logic, tables, REST API, cron, admin import screen |
| Front end | React (Vite build) single-page app bundled in the plugin, mounted on one page via shortcode `[gridrankers_portal]`. The plugin also forces that page to be the site front page and blocks the normal WP front end (no posts, no search, `noindex`). |
| API | REST namespace `gr-portal/v1`, JSON only, nonce + session-token auth |
| Storage | Custom tables prefixed `{$wpdb->prefix}grp_` (section 5). Never `wp_posts` / post meta. |
| Live updates | Client polls `GET /sync?since=<cursor>` every 10 s while visible (pause when tab hidden). Server returns changed rows since cursor. |
| Scheduled jobs | `grp_daily` action. Registered with WP-Cron **and** called by a real Hostinger cron hitting `wp-cron.php` (document both). Runs hourly-safe. |
| Files | PDF reports generated client-side (jsPDF + autotable bundled locally, no CDN) |
| Caching | Plugin sends `Cache-Control: no-store` on its page and API. README tells admin to exclude the portal page and `/wp-json/gr-portal/*` from LiteSpeed/Hostinger cache. |

### Plugin structure
```
gridrankers-portal/
  gridrankers-portal.php        bootstrap, constants, activation/deactivation hooks
  includes/
    class-install.php           dbDelta table creation + migrations (schema version option)
    class-auth.php              code login, sessions, lockouts, current-user resolution
    class-permissions.php       ALL permission rules in one place (section 3)
    class-rest-*.php            one controller per resource
    class-cycles.php            cycle/week maths (section 6.1) — pure functions, unit-tested
    class-standard-tasks.php    default monthly task set + per-cycle top-up
    class-activity.php          activity/audit logging helpers
    class-cron.php              grp_daily
    class-import.php            JSON import (section 10)
  admin/                        WP-admin screens: Import, Export, Settings
  app/                          React source (Vite); build output in app/dist
  tests/                        PHPUnit (permissions, cycles, review flow) + Playwright e2e
```

## 3. Roles and permissions

Three portal roles, stored on the team member (`role`): `admin` (Super Admin), `lead` (Team Leader), `member` (Team Member).

- **Super Admin** = the WordPress administrator account(s). The account `GridRankers@gmail.com` is the primary Super Admin. A portal team member with role `admin` must be linked to a WP user with `manage_options`; nobody else can hold `admin`.
- Team Leaders and Members sign in with a **code** (section 4).

| Action | Super Admin | Team Leader | Team Member |
|---|---|---|---|
| See all projects / tasks | ✔ | ✔ | ✔ |
| Add a project | ✔ | ✔ | ✘ |
| Move project Active/Paused/Inactive | ✔ | ✔ | ✘ |
| Delete project | ✔ | ✘ | ✘ |
| Change project cycle (after first lock) | ✔ (with confirmation + reason) | ✘ | ✘ |
| Add a task (meeting or monthly) | ✔ | ✔ | ✔ |
| Edit a task after it's added | ✔ | ✔ | ✘ |
| Change meeting date / responsible people | ✔ | ✔ | ✘ |
| Delete a task (soft delete) | ✔ | ✔ | ✘ |
| Restore / delete forever (trash) | ✔ | ✔ | ✘ |
| Change status / tick progress on a task | if assigned or unassigned | if assigned or unassigned + any task | only if assigned to them (or task unassigned) |
| Tick another person's share / breakdown row | ✔ | ✔ | ✘ |
| Move In progress → To fix / Not started (incl. counting down to 0) | ✔ | ✔ | ✘ |
| Reopen a completed task | via Review only | via Review only | ✘ |
| Review completed work (accept / revise / reject) | ✔ | ✔ | ✘ |
| Approve own work | auto-accepted | auto-accepted | ✘ |
| See Team dashboard / everyone's pages | ✔ | ✔ | own page only |
| Manage members, roles, codes | ✔ (only Super Admin can grant `admin`) | approve new members as Member only | ✘ |
| Export / import data | ✔ | ✘ | ✘ |
| Log manual work | for anyone | for anyone | for self |

Every REST endpoint calls `GRP_Permissions::can($user, $action, $object)`. Unit-test every row above.

## 4. Authentication

### 4.1 Super Admin
- Normal WordPress login (email + password). Recommend a 2FA plugin (README).
- When a logged-in WP admin opens the portal, they are mapped to their linked team member (`wp_user_id`). If none exists, show "Set up GridRankers" to create one.

### 4.2 Staff: code login
- Sign-in screen: GridRankers logo, "Sign in to continue", one field **Your code**, button **Sign in**. Link "Forgot your code?" → message "Ask your Super Admin to set a new code (Team → Settings → Set code)".
- Codes are set by Super Admin (any role) or Team Leader (members only): min 6 characters, unique across the team, "Generate" creates 8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
- Storage: `password_hash()` (bcrypt/argon2). **Migration compatibility:** imported members have `code_salt` + `code_hash = sha256(salt + ":" + code)` (hex). On successful login with a legacy hash, verify with `hash('sha256', $salt.':'.$code)` and immediately rehash with `password_hash()`; clear the salt.
- Lockout: 5 failed attempts per IP+member → 15-minute lock. Generic error "That code doesn't match anyone."
- Session: random 32-byte token in `grp_sessions` (hashed), HttpOnly + Secure + SameSite=Lax cookie, **30-day** expiry (Super Admin may use WP session). Sign out deletes the token. "Set code" for a person revokes all their sessions.
- Nothing in the portal (sidebar, projects, names) renders before sign-in. API returns 401 for everything except `/auth/*`.

## 5. Data model (MySQL)

All tables: `id` CHAR(26) ULID (or keep imported string ids, VARCHAR(64)), `created_at`, `updated_at` (DATETIME UTC), soft delete where noted. JSON columns use MySQL JSON type.

| Table | Key columns |
|---|---|
| `grp_members` | id, name, role ENUM(admin,lead,member), color, photo (media id/url), title, email, phone, address, drive_url, notes, code_hash, code_salt (legacy), code_set_at, wp_user_id NULL, active TINYINT |
| `grp_sessions` | id, member_id, token_hash, expires_at, ip, user_agent |
| `grp_projects` | id, name UNIQUE, state ENUM(active,paused,inactive), cycle_day TINYINT 1–28, cycle_set TINYINT, cycle_changes JSON, cycle_log JSON, std_cycle VARCHAR (last cycle key the standard tasks were checked) |
| `grp_meeting_tasks` | id, project_id, title, notes, url, priority ENUM(urgent,high,normal,low), status ENUM(todo,doing,done), meeting_date DATE, done_at, target INT (quantity, default 1), assignees JSON `[{id,n}]`, team TINYINT, progress JSON `{memberId: count}`, deadline JSON (6.3), review JSON (6.6), completion JSON (6.6), created_by |
| `grp_monthly_tasks` | id, project_id, title, notes, freq ENUM(monthly,weekly), due_mode ENUM(none,weekly,date,dates,monthly), due_day, due_from_day, target INT, assignees JSON, team TINYINT, parts JSON `[{id,name,n,people:[{id,n}]}]`, std TINYINT (standard task), created_by |
| `grp_cycle_records` | id = `{taskId}__{periodKey}` (weekly: periodKey = `YYYY-MM-wN`), task_id, project_id, period_key, week TINYINT NULL, count, status ENUM(todo,doing,done,skipped), by_person JSON `{memberId: n}`, parts JSON `{partId: n, "partId|memberId": n}`, review JSON, completion JSON, done_at, cleared_by NULL |
| `grp_activity` | id, member_id, date DATE, at DATETIME, kind ENUM(auto,manual), source ENUM(board,monthly,manual), project_id NULL, title, detail, qty, minutes NULL, notes, ref_key (for undo) |
| `grp_audit` | id, kind (add, edit, status, progress, done, assign, delete, restore, review, project, cycle), type (items, monthly, client, team), doc_id, project_id, title, detail, changes JSON `[{field,label,from,to}]`, by_member, by_role, at |
| `grp_trash` | id, type, doc_id, data JSON (full row), title, project_id, deleted_at, deleted_by — purge after 30 days |
| `grp_dismissals` | member_id, key, at — per-person dismissed notifications |
| `grp_requests` | access requests (only if a public request flow is wanted; otherwise skip) |
| `grp_settings` | key, value JSON (e.g. `workweek`) |

## 6. Domain logic

### 6.1 Project cycles
- Each project has `cycle_day` (1–28). A cycle runs from day D of one month to the day before D of the next month. Day 1 = calendar months.
- First time a cycle day is chosen, it locks (`cycle_set=1`). After that only Super Admin can change it, with a reason; changes are stored in `cycle_changes` as `{from: 'YYYY-MM-DD', day, prevDay, mode: merge|due|waived, reason, by, at}` and appended to `cycle_log`.
  - `merge`: the short gap before the new start day is merged into the following cycle.
  - `due` / `waived`: the gap becomes a "transition" period where monthly tasks are due or waived.
- Period key: `YYYY-MM` of the cycle start (transition: `T` + start date). Port `periodsOf()` / `cycleRange()` from the reference file exactly and unit-test against it (generate fixtures by running the reference in Node).
- The **project cycle bar** (Meeting Minutes and Monthly Tasks share the same position): "Project cycle 🔒 Starts day N · Change · History" and "‹ Current cycle ›" (labels: Current / Previous / Next cycle / N cycles ago / ahead).

### 6.2 Weeks
- Weekly tasks follow the **project cycle**, not the calendar month: weeks are counted from the cycle's start day. W1 = cycle days 1–7, W2 = 8–14, W3 = 15–21, W4 = 22 to the cycle end (the last week takes the leftover days). A period has `max(1, floor(days / 7))` weeks: a normal cycle has 4, a short transition period fewer (e.g. 14 days → 2 weeks), a merged longer period more. Example, cycle day 15: W1 Oct 15–21, W2 Oct 22–28, W3 Oct 29–Nov 4, W4 Nov 5–14. Projects with cycle day 1 get the same weeks as calendar months.
- Weekly period key `{cycle key}-wN` (e.g. `2026-10-w1`; transition `T2026-10-01-w2`). Schema 3 converts records stored under the old calendar-week keys to the cycle week containing that calendar week's first day.
- **Two-week periods** (bi-weekly tasks): pairs of cycle weeks — weeks 1–2 and weeks 3–4 in a normal cycle; a period has `max(1, floor(weeks / 2))` of them, the last taking a leftover week (5 weeks → 1–2, 3–5). Labelled by the weeks they cover ("Weeks 3–4", short "W3–4"). Period key `{cycle key}-hN`. Example, cycle day 15: Oct 15–28 and Oct 29–Nov 14.
- Weekly and bi-weekly tasks run in transition periods too (they are not waived).
- Monthly Tasks has a week bar when the Weekly or Bi-weekly filter is on: "Week N of M" / "Weeks 1–2 of M" · dates · x/y done · ‹ ›.
- *Change from the reference portal, which used calendar-month weeks for every project.*

### 6.3 Meeting task deadlines (`deadline` JSON)
`{type: none|weekly|biweekly|date|dates|monthly, weeks: ['YYYY-MM-DD' (Mondays)], date, from, to, month: 'YYYY-MM'}`
- **Weekly**: pick one or more Mon–Sun weeks (grid of this week + next 11). Card: "Due week of Oct 5 – Oct 11" / "Due 3 weeks · this one …".
- **Bi-weekly**: a two-week window — pick the starting Monday (this week by default); due the Sunday of the second week (`from` Monday, `to` = from + 13 days). Card "Due Oct 5 – Oct 18 · 2 weeks". *Not in the reference portal.*
- **Specific date**: one date. Card "Due Oct 5".
- **Certain dates**: From / To range. Card "Due Oct 12 – Oct 20 (9 days)".
- **Monthly**: automatically the **last day of the current calendar month** (locked to the month it was set). Card "Due Sep 30 · end of month".
- Overdue (end < today, not done): card red "Overdue · …"; due within 2 days: amber.

### 6.4 Monthly task deadlines (repeat every cycle)
`due_mode`: **monthly** (default, end of each cycle), **weekly** (freq weekly), **biweekly** (freq biweekly: due at the end of each two-week period of the cycle, 6.2; quantity is per 2 weeks; *not in the reference portal*), **date** (day N of each cycle), **dates** (days A–B of each cycle), **none** (never late during the cycle; missed only if the cycle ends undone).

### 6.5 Quantities, people and breakdowns
- **Meeting tasks**: `target` (default 1). With target > 1 and several assignees, each has a share `n` (auto even split; editing one share rebalances the others so the total never exceeds target; each ≥ 1). Each person ticks only their own share; status auto-moves: first tick → In progress, total = target → Fixed (→ review).
- **Monthly tasks — Responsible**: pick people **without numbers** (`team=1`): they share the whole task, any of them can tick, credit goes to whoever ticks.
- **Monthly tasks — Breakdown** (optional): rows `Type · Qty · Who does it`. Quantity per cycle = sum of rows (locked). "Who does it" = Whole-task team, one person, or several people with per-person quantities (shares can never exceed the row's qty; editing one rebalances the rest). When any row has people, Responsible is derived from the breakdown (read-only chips, no numbers) and `team=0`, assignees = aggregated `{id, n}`.
- Card ticking for breakdowns: each row has − / +; rows with one person: only that person (and admin/lead) can tick; rows with several people show a sub-row per person.
- Record counts: `parts[partId]` (row total) and `parts["partId|memberId"]` (person within row), `by_person[memberId]`.

### 6.6 Completion, review and status locks
- When a **Team Member** clicks Fixed / Completed: modal "What did you complete?" (required note, optional https link) → saved as `completion {note, link, by, at}` and `review {state:'pending', submittedBy, submittedAt}`.
- Super Admin / Team Leader completions are `review.state='accepted', auto=1` (no prompt).
- Reviewers see **"Waiting for your review"** (Dashboard top) with Accept / Revise / Reject, also in the task Details:
  - **Accept** → accepted (no badge shown afterwards).
  - **Revise** (note required) → status In progress; quantity tasks lose one unit (from the submitter); activity credit removed for that unit.
  - **Reject** (reason required) → status To fix / Not started; all units cleared; all credit removed.
  - Accepted work can be reopened by reviewers with Request revision / Reject.
- Buttons disappear immediately after a decision (optimistic UI). The submitter sees "Revision requested / Rejected · by X · note" on their card and in "Reviews of your work" (My tasks).
- **Status locks** (server-enforced):
  - Done → anything: only via review actions.
  - In progress → To fix / Not started (or counting down to 0): Super Admin / Team Leader only.
- Meeting Minutes are **per cycle**: a task belongs to the cycle containing its meeting date (or created date). Banner counts, status counts and cards show only the selected cycle.

### 6.7 Activity crediting and reports
- Every unit completed creates an `grp_activity` row (kind auto) credited to the person who did it, with `ref_key` so undo/revise/reject removes it. Manual "Log work" rows (project or "Other work", date, minutes, notes).
- **Missed work**: recurring periods that ended without the person's share done (skipped excluded). Port `missedWork()`.
- **PDF report** (member page → My tasks → Download PDF report) for the selected Daily/Weekly/Monthly period: header band, summary boxes (Completed, Missed, Still open, Projects), tables Completed / By project / Missed / Still open, page footer "GridRankers · name · period · Page x of y".

### 6.8 Standard monthly tasks
Every project (new and existing) has these six monthly tasks (Monthly deadline, unassigned, `std=1`, quantities start at 1 per type):
1. GBP Posts
2. Social Posts
3. Pages — Service Pages, Location Pages
4. Blogs
5. Free Backlinks — Citations, Cloud Stack, Google Stack, Batch GEO, Map Citation / Map Pin, Driving Direction, Profile Backlinks, Web 2.0, Brand Mentions, PDF / Image / Video Submission, Directory Submission
6. Paid Backlinks — Guest Post, Memberships (e.g. Chamber of Commerce), Press Release

`grp_daily`: for each project whose current cycle key ≠ `std_cycle`, add any missing standard task (matched by title, deterministic id `std_{projectId}_{slug}`), then set `std_cycle`. New projects get them on creation. Deleted standard tasks stay gone until the next cycle.

### 6.9 Trash, audit, notifications
- Delete = soft delete into `grp_trash` (30 days) + toast "Task deleted · Undo" (9 s). Recently deleted tasks are behind the **Recently deleted** button of the project's **Recent Activities** (admin/lead), deleted projects in **Team → Settings** (Super Admin): Restore / Delete forever.
- Audit log rows for: added, changed (field-by-field), status, progress, completed, assigned, deleted, restored, review, project moves, cycle changes.
- Notifications (admin/lead Dashboard): "Waiting for your review" (non-dismissable), plus dismissable items: unassigned urgent tasks, overdue recurring tasks, members without a code, member edits. Dismissals are per person; "sticky" items return after 7 days if unresolved.

## 7. Screens (match the reference file)

### 7.0 Dashboard (everyone)
*Not in the reference portal.* The landing page after sign-in, and what **GridRankers** in the sidebar opens.
- Project search and **+ New project** (Super Admin, Team Leader: name, cycle start day — optional, locks it as 6.1 — and status) at the top.
- Status tabs **Active · Paused · Inactive · All** with counts (underlined tab; opens on Active).
- One clean card per project (click → that project's Meeting Minutes): name; "Day N · X days left" (or "No cycle start day yet", plus the status when not active); this cycle's monthly progress (done / total, with a bar); open meeting tasks; one attention line — "2 urgent · 1 overdue · 1 to review" in red, or "On track" in green.
- "⋯" menu on each card (Super Admin, Team Leader): Move to Active / Paused / Inactive; **Delete project** (Super Admin only; its tasks go to the trash with it).
- Deleted projects are not shown here: they are in **Team → Settings → Deleted projects** (7.5).

### 7.1 Layout
- Left sidebar: **GridRankers** / Team portal (click → Dashboard, 7.0), groups **Active / Paused / Inactive projects** with counts for quick switching. No "Add a project", no drag & drop, no move or delete buttons: those live on the Dashboard.
- Top bar: project title (+ "(paused)/(inactive)"), task search, tabs **Meeting Minutes · Monthly Tasks · Recent Activities**, user chip (avatar → Team area; admin/lead → Team dashboard, member → own page), Sign out.

### 7.2 Meeting Minutes
Alert banner (cycle-scoped), project cycle bar, stats (status chips, cycle dates, cycle progress, days left / ended / starts in), cards, "+ Add task" tile.
**Card** (compact): priority chip, Qty chip, meeting date; title; added / fixed / deadline chips; mini review tag; mini progress bar (qty > 1); status segment (To fix / In progress / Fixed, locks per 6.6); footer: avatar stack + "N person/people" or "? Not assigned", **Details**, Edit (admin/lead), 🗑 (admin/lead).
**Task dialog**: Client, What needs to change, Details, Page URL, Priority, Status, Quantity, From meeting on, Deadline (6.3), Responsible (searchable people picker; shares when qty > 1). Members can't open Edit.
**Details window**: header (tags, status pill, title, project), info grid (meeting, added, deadline, fixed, responsible), Progress (full steppers), Details text, Page link, Completion & review (+ reviewer actions). No history.

### 7.3 Monthly Tasks
Banner, project cycle bar, stats, filters (All / Weekly / Bi-weekly / Monthly) + week bar, cards, "+ Add monthly task".
**Card**: Monthly/Weekly/Bi-weekly chip, "Qty N per cycle/week/2 weeks"; title; due chip; W1–W4 boxes for weekly, W1–2 / W3–4 for bi-weekly; mini progress "x/n · k types"; status segment; footer as above.
**Dialog**: Client, Task, Deadline (6.4), Quantity (locked when breakdown exists), Breakdown (6.5), Responsible (people only), Details.

### 7.4 Recent Activities
**Project-specific**: everything on this tab belongs to the selected project.
- Filter chips **All · Added · Completed · Reviews · Changes** (Changes = every other kind).
- A table, newest first, one row per change: **When** ("Today · 2:41 PM", "Yesterday · …", "Sep 28 · …") · **What** (coloured tag: Added, Status, Progress, Completed, Assigned, Changed, Deleted, Restored, Review, Project, Cycle change) · **Task** (+ meeting / monthly task) · **Who** (avatar + name; role on hover) · **Details** (detail and field changes "field: from → to", cut to one line, full text on hover). On narrow screens each row stacks.
- **Recently deleted (N)** button (admin/lead) opens that project's deleted meeting and monthly tasks: Restore / Delete forever.
*Change from the reference portal (a dated log, and a recently-deleted list covering every project).*
(The Recent Activities tab of a person's page, 7.5, stays across all projects: it is that person's history.)

### 7.5 Team area (admin/lead)
Tabs **Dashboard · Activity · Team · Settings**, Daily/Weekly/Monthly period selector.
- Dashboard: notifications (6.9), greeting with counts (done / assigned / unassigned), Workload (open tasks per person), completed-tasks chart (per day; per person in Daily view), team list.
- Activity: completed + logged work grouped by day, person filter, Copy report.
- Team: member cards (open, urgent, done this period, projects), search, + Add member.
- Settings: Members & access table (role, contact, open tasks, sign-in status, **Set code**, Open, Remove), **Deleted projects** (Restore — brings back the tasks deleted with it — / Delete forever; kept 30 days), Export all data.

### 7.6 Member page (own page for members; any member for admin/lead)
Tabs **My dashboard · My tasks · Calendar · Recent Activities · Settings**.
- My dashboard: greeting + counts, next tasks, completed chart.
- My tasks: Reviews of your work; filters All / To start / In progress / Completed + Project; groups To start, In progress, Completed this period; + Log work; ⬇ Download PDF report.
- Calendar: Month / Week / Day. Monthly tasks = bar across the cycle; weekly = bar across the week; meeting deadlines per type; dated items = chips; colours: blue to do, orange urgent, green done (struck), red missed; click a day → Day view.
- Recent Activities: grouped by month, filter chips (All / Assigned / Completed / Logged work / Other changes), date column, coloured icon, tag + title, meta line, time.
- Settings: photo (cropped to 160 px), name, job title, email, phone, address, Google Drive link, notes; Super Admin: role + Set code + Remove.

## 8. REST API (namespace `gr-portal/v1`)

| Method & path | Purpose |
|---|---|
| POST `/auth/login` `{code}` · POST `/auth/logout` · GET `/auth/me` | sessions |
| GET `/sync?since=` | all changed rows across tables since cursor (+ deletions) |
| GET/POST/PATCH/DELETE `/projects[/id]` | projects; PATCH `/projects/id/state`, POST `/projects/id/cycle` |
| GET/POST/PATCH/DELETE `/meeting-tasks[/id]` | tasks; POST `/meeting-tasks/id/status`, `/progress` `{memberId,delta}` |
| GET/POST/PATCH/DELETE `/monthly-tasks[/id]` | tasks |
| POST `/records/tick` `{taskId, periodKey, partId?, memberId?, delta}` · POST `/records/status` | recurring progress |
| POST `/review` `{kind: item|record, id, action: accept|revision|reject, note}` | review |
| GET/POST/DELETE `/activity` | logged work |
| GET `/audit?project=&from=&to=` | Recent Activities |
| GET `/trash` · POST `/trash/id/restore` · DELETE `/trash/id` | trash |
| GET/POST/PATCH/DELETE `/members[/id]` · POST `/members/id/code` | team |
| POST `/notifications/dismiss` | dismissals |
| GET `/export` · POST `/import` (admin, nonce) | data |

All writes validate input, check permissions (section 3), write the audit row in the same transaction, and return the updated row.

## 9. Non-functional

- Security: nonces on every request, prepared statements only, escape all output (React default + server sanitising), rate-limit `/auth/login`, no secrets in the front end.
- Performance: indexes on project_id, task_id, period_key, member_id, date, at. Sync payloads paginated.
- Accessibility: keyboard reachable controls, visible focus, labelled inputs, dialogs as `<dialog>` with focus trap.
- Responsive down to 380 px.
- Backups: rely on Hostinger daily backups + Export button.

## 10. Data import (from the current portal)

The current portal's **Team → Settings → Export all data** produces:
```json
{ "format": "gridrankers-portal-export", "version": 1, "exportedAt": "…",
  "data": { "clients": [], "items": [], "monthly": [], "monthlyDone": [], "team": [],
            "settings": [], "activity": [], "edits": [], "trash": [], "dismissals": [], "visitors": [] } }
```
Mapping: `clients → grp_projects` (pstate/active → state; cycleDay, cycleSet, cycleChanges, cycleLog, stdCycle), `items → grp_meeting_tasks` (whoId/assignees, target, by → progress, dueType/dueWeeks/dueDate/dueFrom/dueTo/dueMonth → deadline, review, completion), `monthly → grp_monthly_tasks` (freq, dueMode, dueDay, dueFromDay, parts, team), `monthlyDone → grp_cycle_records` (id, month → period_key, week, count, status, by, parts, review, completion), `team → grp_members` (codeSalt/codeHash legacy, accountId dropped), `activity → grp_activity`, `edits → grp_audit`, `trash → grp_trash`, `dismissals → grp_dismissals`. Timestamps may be epoch ms or ISO strings. Keep original ids. Import is idempotent (upsert by id) and shows a summary.

## 11. Build plan for Codex (one task per prompt)

1. Plugin skeleton, activation, dbDelta tables, schema versioning, settings page stub. **Tests:** activation creates tables.
2. `class-permissions.php` + PHPUnit tests for every row of section 3.
3. Auth: code login (incl. legacy sha256 verify + rehash), sessions, lockout, WP-admin mapping, logout. **Tests.**
4. `class-cycles.php`: port periodsOf/cycleRange/weeks/dueAt; fixtures generated from the reference HTML. **Tests.**
5. REST controllers for projects, meeting tasks, monthly tasks, records, review, activity, audit, trash, members, sync — each with permission checks and audit logging. **Tests.**
6. Import / export (admin screen + endpoints) using section 10. Import a real export and verify counts.
7. React app shell: sign-in screen, sidebar, top bar, tabs, polling sync, toasts, confirm dialog.
8. Meeting Minutes screen + dialog + Details + deadlines.
9. Monthly Tasks screen + dialog (deadlines, breakdown, people picker, shares) + week bar.
10. Review flow + completion modal + status locks (UI and server).
11. Recent Activities + trash + undo.
12. Team area (dashboard, notifications, activity, team, settings) and member page (tabs, calendar, activities, settings, PDF).
13. Standard tasks + `grp_daily` cron; README for Hostinger cron + cache exclusions.
14. Playwright e2e: member completes → admin revises → member re-completes → admin accepts; member cannot edit/delete; cycle switching; import round-trip.

**Definition of done:** all tests pass, an imported export shows the same projects/tasks/progress as the current portal, and a Team Member account can do everything in section 3 that is ✔ for members and nothing that is ✘ (verified by API tests, not just hidden buttons).
