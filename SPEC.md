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
| Review last cycle and send feedback (6.11) | ✔ | ✔ | ✘ |
| Add a General task, or move a task between General and a project (6.13; locked while the profile is incomplete) | ✔ | ✔ | ✘ (works on the ones assigned to them) |
| Edit a project's Details: descriptions and links (6.12; locked while the profile is incomplete) | ✔ | ✔ | ✔ |
| Keyword checklist: add / rename / remove keywords, set deadlines, change the columns (6.12; locked while the profile is incomplete) | ✔ | ✔ | ✔ |
| Keyword checklist: tick a box, write the note, ask to untick a box (6.12; locked while the profile is incomplete) | ✔ | ✔ | ✔ |
| Keyword checklist: untick a box, or keep it ticked after someone asked (6.12; locked while the profile is incomplete) | ✔ | ✔ | ✔ |
| Tour someone's portal, view only (7.0) | anyone else | Team Members only | ✘ |
| Open someone's page | anyone's | Team Members' only (and their own) | their own only |
| Delete project | ✔ | ✘ | ✘ |
| Change project cycle (after first lock) | ✔ (with confirmation + reason) | ✘ | ✘ |
| Add a task (meeting or monthly) | ✔ | ✔ | ✔ |
| Edit a task after it's added | ✔ | ✔ | ✘ |
| Change meeting date / responsible people | ✔ | ✔ | ✘ |
| Delete a task (soft delete) | ✔ | ✔ | ✘ |
| Restore / delete forever (trash) | ✔ | ✔ | ✘ |
| Change status / tick progress on a task | ✔ any task | ✔ any task | only if assigned to them — an unassigned task is locked until a leader assigns someone (6.6) |
| Tick another person's share / breakdown row | ✔ | ✔ | ✘ |
| Move In progress → Not started (incl. counting down to 0) | ✔ | ✔ | ✘ (Request undo, 6.6) |
| Request undo of In progress → Not started on a task without a quantity (6.6) | — (moves it back) | — (moves it back) | ✔ own tasks, reason required |
| Answer a request to undo: Undo / Keep In progress (6.6) | ✔ | ✔ | ✘ |
| Reopen a completed task | via Review only | via Review only | ✘ |
| Review completed work (accept / revise / reject) | ✔ | ✔ | ✘ |
| Approve own work | auto-accepted | auto-accepted | ✘ |
| See Team dashboard | ✔ | ✔ | own page only |
| Manage members, roles, codes | ✔ (only Super Admin can grant `admin`) | approve new members as Member only | ✘ |
| Export / import data | ✔ | ✘ | ✘ |
| Invoices: see and keep fees, invoices sent and payments (6.14) | ✔ | ✘ (not even sent by `/sync`) | ✘ |
| Log manual work | for anyone | for anyone | for self |
| See the **Projects** tab of the Dashboard (7.0) | ✔ | ✔ | ✘ |
| Take / request day leave for self (6.10) | ✘ (no leave in the portal) | ✔ approved straight away | ✔ request (pending) |
| Approve / reject a Team Member's leave request | ✔ | ✔ | ✘ |
| Issue a day off to someone (6.10; approved day leave for them) | Team Members and Team Leaders | Team Members and other Team Leaders (not self) | ✘ |
| Cancel leave | anyone's | own + any Team Member's + a day off they issued | own pending requests only |
| See leave settlement and yearly reports | ✔ | ✘ | ✘ |
| Set days off and automatic messages | ✔ | ✘ | ✘ |
| Send / remove a notice (to everyone or chosen people) | ✔ (any) | ✔ (own) | ✘ |
| Send / remove a shout-out (to Team Members only) | ✔ (any) | ✔ (own) | ✘ |
| Ask someone to review own finished task (6.6) | ✔ | ✔ | ✘ |
| Fill in the submission form when completing work (6.6) | ✔ (required) | ✔ (required) | ✔ (required) |
| Edit a saved submission (6.6) | ✔ | ✔ | ✔ own submissions |
| Attach files (upload) / open files (6.6) | ✔ | ✔ | ✔ |
| Comment on a submission (6.6) | ✔ | ✔ | ✔ on tasks assigned to them, their own submissions and reviews asked of them |
| Delete a comment | ✔ any | ✔ own | ✔ own |
| Approve / send back a review someone asked **you** for | ✔ | ✔ | ✔ (only that task) |
| Set own profile, incl. location and date of birth | ✔ | ✔ | ✔ |
| Work on tasks while the profile is incomplete (6.10) | ✔ (reminder only) | ✘ | ✘ |

Every REST endpoint calls `GRP_Permissions::can($user, $action, $object)`. Unit-test every row above.

**Profile lock** (*new*): while a Team Leader's or Team Member's required profile (6.10) is incomplete, every task action is refused (add / edit / delete a task, change status, tick progress, review, ask for or answer a review, log work, skip a period, upload a file, edit a submission, comment) with `grp_profile_incomplete` and the missing fields. Viewing, leave and editing their own profile still work.

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
| `grp_members` | id, name, role ENUM(admin,lead,member), color, photo (media id/url), title, email, phone, address, drive_url, notes, code_hash, code_salt (legacy), code_set_at, wp_user_id NULL, active TINYINT, birthday CHAR(5) NULL (`MM-DD`), birth_year SMALLINT NULL (managers and self only), location VARCHAR(191) NULL (city, for the weather), weekly_off JSON NULL (own weekly day off, weekdays 0–6; NULL = the team's) |
| `grp_sessions` | id, member_id, token_hash, expires_at, ip, user_agent |
| `grp_projects` | id, name UNIQUE, state ENUM(active,paused,inactive), cycle_day TINYINT 1–28, cycle_set TINYINT, cycle_changes JSON, cycle_log JSON, std_cycle VARCHAR (last cycle key the standard tasks were checked), cycle_reviews JSON `{cycleKey: {taskId: {ok, note, to, by, at}}}` (last 3 cycles, 6.11), details JSON NULL `{sections: [{id, title, text, links: [{id, title, url, kind: sheet|doc|drive|other}]}]}` and kw_columns JSON NULL `[{id, name}]` (6.12, schema 8) |
| `grp_meeting_tasks` | id, project_id, title, notes, url, priority ENUM(urgent,high,normal,low), status ENUM(todo,doing,done), meeting_date DATE, done_at, target INT (quantity, default 1), assignees JSON `[{id,n}]`, team TINYINT, progress JSON `{memberId: count}`, deadline JSON (6.3), review JSON (6.6), completion JSON (6.6), created_by |
| `grp_monthly_tasks` | id, project_id, title, notes, freq ENUM(monthly,weekly), due_mode ENUM(none,weekly,date,dates,monthly), due_day, due_from_day, target INT, assignees JSON, team TINYINT, parts JSON `[{id,name,n,people:[{id,n}]}]`, std TINYINT (standard task), created_by |
| `grp_cycle_records` | id = `{taskId}__{periodKey}` (weekly: periodKey = `YYYY-MM-wN`), task_id, project_id, period_key, week TINYINT NULL, count, status ENUM(todo,doing,done,skipped), by_person JSON `{memberId: n}`, parts JSON `{partId: n, "partId|memberId": n}`, review JSON, completion JSON, done_at, cleared_by NULL |
| `grp_activity` | id, member_id, date DATE, at DATETIME, kind ENUM(auto,manual), source ENUM(board,monthly,manual), project_id NULL, title, detail, qty, minutes NULL, notes, ref_key (for undo) |
| `grp_audit` | id, kind (add, edit, status, progress, done, assign, delete, restore, review, project, cycle), type (items, monthly, client, team), doc_id, project_id, title, detail, changes JSON `[{field,label,from,to}]`, by_member, by_role, at |
| `grp_trash` | id, type, doc_id, data JSON (full row), title, project_id, deleted_at, deleted_by — purge after 30 days |
| `grp_dismissals` | member_id, key, at — per-person dismissed notifications |
| `grp_requests` | access requests (only if a public request flow is wanted; otherwise skip) |
| `grp_settings` | key, value JSON (e.g. `workweek`; `weekly_off` = team weekly day off `{days: [0–6]}`, default `{days: [5]}` (Friday); `messages` = `{birthday, day_off, leave_approved}` texts with `{name}`) |
| `grp_leave` | id, member_id, type ENUM(day,sick), from_date DATE, to_date DATE, days TINYINT (working days in the range, 6.10), reason, status ENUM(pending,approved,rejected,cancelled), decided_by NULL, decided_at NULL, message (approver's note), created_by — *new* |
| `grp_days_off` | id, kind ENUM(event,seasonal), name, from_date DATE, to_date DATE (= from_date for an event), created_by — whole team — *new* |
| `grp_keywords` | id, project_id, keyword VARCHAR(191), checks JSON `{columnId: {by, at}}`, note TEXT NULL, deadline DATE NULL, position INT, created_by — *new* (6.12, schema 8) |
| `grp_files` | id, name, mime, size INT, path (relative to `uploads/grp-private/`, random name), created_by — *new* (6.6, schema 10; not synced) |
| `grp_comments` | id, ref_kind ENUM(item,record), ref_id, project_id, body TEXT, files JSON `[{id, mime, name, size}]`, created_by, deleted_at NULL — *new* (6.6, schema 10; synced as `comments`) |
| `grp_billing` | id = `bl_` + md5(project, cycle key), project_id, project_name (as when made), cycle_key, cycle_start DATE, cycle_end DATE, amount DECIMAL(12,2) NULL, currency VARCHAR(8), sent_at DATE NULL, sent_by NULL, ref NULL (own invoice no. or link), skipped TINYINT (Not billed), note NULL, payments JSON `[{id, amount, date, method, ref, by, at}]` — *new* (6.14, schema 11; Super Admin only) |
| `grp_billing_fees` | id = project id, fee DECIMAL(12,2) NULL, currency VARCHAR(8), remind_days TINYINT (default 3) — *new* (6.14, schema 11; Super Admin only) |
| `grp_posts` | id, kind ENUM(announcement,shoutout,notice), title NULL, body, to_member NULL (first shout-outs), to_members JSON NULL (chosen people; NULL = everyone), pinned TINYINT, show_until DATE NULL, created_by, soft delete — *new* |

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
- Options in this order: **No deadline · Weekly · Bi-weekly · Monthly · Specific date · Range**.
- **Specific date**: one date, picked on a calendar that opens when the option is chosen (month view, Mon–Sun weeks, ‹ › months, Today, Clear). Card "Due Oct 5".
- **Range** (stored as `dates`; was "Certain dates"): the same calendar — first click the start, then the end (the days between are shaded). Card "Due Oct 12 – Oct 20 (9 days)".
- **Monthly**: automatically the **last day of the current calendar month** (locked to the month it was set). Card "Due Sep 30 · end of month".
- Overdue (end < today, not done): card red "Overdue · …"; due within 2 days: amber.

### 6.4 Monthly task deadlines (repeat every cycle)
`due_mode`: **monthly** (default, end of each cycle), **weekly** (freq weekly), **biweekly** (freq biweekly: due at the end of each two-week period of the cycle, 6.2; quantity is per 2 weeks; *not in the reference portal*), **date** ("Specific date": day N of each cycle), **dates** ("Range": days A–B of each cycle) — both picked on a grid of cycle days 1–31 (a day past the end of a short cycle falls on its last day); options in the same order as 6.3, **none** (never late during the cycle; missed only if the cycle ends undone).

### 6.5 Quantities, people and breakdowns
- **Meeting tasks**: `target` (default 1). With target > 1 and several assignees, each has a share `n` (auto even split; editing one share rebalances the others so the total never exceeds target; each ≥ 1). Each person ticks only their own share; status auto-moves: first tick → In progress, total = target → Fixed (→ review).
- **Monthly tasks — Responsible**: pick people **without numbers** (`team=1`): they share the whole task, any of them can tick, credit goes to whoever ticks.
- **Monthly tasks — Breakdown** (optional): rows `Type · Qty · Who does it`. Quantity per cycle = sum of rows (locked). "Who does it" = Whole-task team, one person, or several people with per-person quantities (shares can never exceed the row's qty; editing one rebalances the rest). When any row has people, Responsible is derived from the breakdown (read-only chips, no numbers) and `team=0`, assignees = aggregated `{id, n}`. The same holds for imported tasks (old exports may name the people only on the rows, `people` or legacy `who`); schema 12 repairs tasks already imported that way, so they reach those people's My day and they can tick them.
- Card ticking for breakdowns: each row has − / +; rows with one person: only that person (and admin/lead) can tick; rows with several people show a sub-row per person.
- Record counts: `parts[partId]` (row total) and `parts["partId|memberId"]` (person within row), `by_person[memberId]`.

### 6.6 Completion, review and status locks
- **Statuses** (*new*): meeting tasks and monthly tasks use the same three — **Not started · In progress · Completed** (stored `todo · doing · done`; Meeting Minutes said To fix / Fixed before). Team Members only move forward.
- **Submit completed work** (*new*, design SF-A): whoever completes work — clicks Completed, ticks the **last unit** of a quantity task, or saves a task as Completed — fills in the form, **Team Leaders and the Super Admin included** (the server refuses it without a note, `grp_completion_required`; Cancel leaves it as it was / one short): **What you did** (required), **Links** (up to 10 http(s)), **Files** (choose or drop; PDF, images, Word, Excel, CSV, text; 10 MB each, up to 10) and **Comment for the reviewer** (optional) → `completion {note, link (first link), links[], files[{id, mime, name, size}], comment, by, at}`. A Team Member's work then waits for review: `review {state:'pending', submittedBy, submittedAt}`.
- Team Leaders and the Super Admin choose at the bottom of the same form: **Done — no review needed** (default; `review.state='accepted', auto=1`, shown as "Completed · no review") or **Ask someone to review it** with a reviewer (anyone active but themselves) → `review {state:'pending', …, reviewer}`. Later, **Ask someone to review it** in Details still works on their own auto-accepted work: pick anyone (Super Admin, a Team Leader or a Team Member) and add an optional note → `review {state:'pending', submittedBy, submittedAt, reviewer: memberId, note}`. Only that person (plus the Super Admin) can then **Approve** (= Accept) or **Send back** (= Revise, note required), even when they are a Team Member. *Not in the reference portal.*
- **Submission in Details** (*new*, design SF-B): "Submission & review" shows who submitted and when ("· edited {when}" after a change), what was done, links as chips, files with **View** (images, PDF) / **Download**, the comment for the reviewer, the review state, and **✎ Edit submission** for the person who submitted it, Team Leaders and the Super Admin — the same form, saved in place (`edited_by`, `edited_at`; the review is unchanged), any time, also after approval. Under it, **Comments**: a thread (oldest first) with author, time, text and attached files; the people on the task, who submitted it, the reviewer, Team Leaders and the Super Admin can write (text and/or files); authors (and the Super Admin) delete their own ("Comment deleted"). Comments from others in the last 7 days reach the bell of the people on the task: who submitted it, its assignees, the reviewer and anyone who commented there ("{name} commented on “{task}”").
- **Files** are stored privately in `uploads/grp-private/YYYY/MM/` under random names, behind a deny-all `.htaccess` / `web.config`, and only sent through GET `/files/{id}` to signed-in team members (the app fetches them with its credentials). The type is checked from the content, not only the name.
- Reviewers see pending work in **Needs your approval** on My day (7.0) and in the task Details, with Accept / Revise / Reject:
  - **Accept** → accepted (no badge shown afterwards).
  - **Revise** (note required) → status In progress; quantity tasks lose one unit (from the submitter); activity credit removed for that unit.
  - **Reject** (reason required) → status To fix / Not started; all units cleared; all credit removed.
  - Accepted work can be reopened by reviewers with Request revision / Reject.
- Buttons disappear immediately after a decision (optimistic UI). The submitter sees "Revision requested / Rejected · by X · note" on their card and in "Reviews of your work" (My tasks).
- **Status locks** (server-enforced):
  - Done → anything: only via review actions.
  - In progress → Not started (or counting down to 0): Super Admin / Team Leader only.
- **Assigned first** (*new*, design TC-A): a Team Member changes status or ticks only tasks assigned to them. An unassigned task is locked for them (all three status buttons off, "🔒 Assign someone before work starts — ask a Team Leader."); the server refuses with "Nobody is assigned to this task yet — a Team Leader or Super Admin must assign it first." Team Leaders and the Super Admin work on any task.
- **Request undo** (*new*, designs ST-A / ST-B): a Team Member who moved a task without a quantity to In progress by mistake clicks **↶ Request undo** on the card and must write what the mistake was and why (at least 10 characters). Stored as `undo_request {by, at, reason}` on the meeting task or the cycle record (schema 9); the card shows only a chip (design TC-A): **↶ Undo requested** · "waiting for a Team Leader or Super Admin" for members, **↶ Undo requested · {name}** with **Review** for leaders — the reason is never on the card, Review opens it with an optional message, **Keep In progress** and **Undo**; an amber dot marks In progress while it waits; one request at a time. Every Team Leader and the Super Admin gets it in the bell ("{name} asked to undo “{task}”") and answers on the card or in **Needs your approval** ("Undo requested" · task · project · In progress → Not started · reason): **Undo** (back to Not started, as their own move) or **Keep In progress**, with an optional message; the member gets a private notice "Undo approved / Undo not approved" with it (7 days). Any other status move drops the request. Quantity tasks never ask (they count down), leaders move tasks back themselves, and Completed goes through review as before.
- Meeting Minutes are **per cycle**: a task belongs to the cycle containing its meeting date (or created date). Banner counts, status counts and cards show only the selected cycle.

### 6.7 Activity crediting and reports
- Every unit completed creates an `grp_activity` row (kind auto) credited to the person who did it, with `ref_key` so undo/revise/reject removes it. Manual "Log work" rows (project or "Other work", date, minutes, notes).
- **Missed work**: recurring periods that ended without the person's share done (skipped excluded). Port `missedWork()`.
- **PDF report** (member page → My tasks → Download PDF report) for the selected Daily/Weekly/Monthly period: header band, summary boxes (Completed, Missed, Still open, Projects), tables Completed / By project / Missed / Still open, page footer "GridRankers · name · period · Page x of y".

### 6.8 Standard monthly tasks
**Active projects only.** A paused or inactive project gets no monthly tasks automatically: a new paused / inactive project starts without the standard tasks, `grp_daily` skips it, and its existing monthly tasks do not reach anyone (not on My day, a person's tasks, calendar, missed work or notifications; the project's own Monthly Tasks screen still lists them). Moving it back to **Active** adds this cycle's missing standard tasks straight away. Its project card shows "Start when active" instead of 0/0.

Every active project (new and existing) has these six monthly tasks (Monthly deadline, unassigned, `std=1`, quantities start at 1 per type):
1. GBP Posts
2. Social Posts
3. Pages — Service Pages, Location Pages
4. Blogs
5. Free Backlinks — Citations, Cloud Stack, Google Stack, Batch GEO, Map Citation / Map Pin, Driving Direction, Profile Backlinks, Web 2.0, Brand Mentions, PDF / Image / Video Submission, Directory Submission
6. Paid Backlinks — Guest Post, Memberships (e.g. Chamber of Commerce), Press Release

`grp_daily`: for each **active** project whose current cycle key ≠ `std_cycle`, add any missing standard task (matched by title, deterministic id `std_{projectId}_{slug}`), then set `std_cycle`. New projects get them on creation. Deleted standard tasks stay gone until the next cycle.

### 6.9 Trash, audit, notifications
- Delete = soft delete into `grp_trash` (30 days) + toast "Task deleted · Undo" (9 s). Recently deleted tasks are behind the **Recently deleted** button of the project's **Recent Activities** (admin/lead), deleted projects in **Team → Settings** (Super Admin): Restore / Delete forever.
- Audit log rows for: added, changed (field-by-field), status, progress, completed, assigned, deleted, restored, review, project moves, cycle changes.
- Notifications (admin/lead Team dashboard): "Waiting for your review" (non-dismissable), plus dismissable items: unassigned urgent tasks, overdue recurring tasks, members without a code, member edits. Dismissals are per person; "sticky" items return after 7 days if unresolved.
- **Bell** (My day top bar, everyone): a list of what is new for that person — leave decisions, review requests and review results, shout-outs to them, announcements, and (admin/lead) the items above. The red number counts unread items; opening the list marks them read.

### 6.10 People: leave, days off, birthdays, announcements, shout-outs
*Not in the reference portal.* "Today" and month ends use the site time zone.
- **Days off** (set by the Super Admin in Team → Settings): the team's **weekly day off** (one or more weekdays, default Friday); a person's **own weekly day off** instead of the team's; **event** days off (one date, a name, e.g. Durga Puja) and **seasonal** days off (a date range, e.g. Eid holidays), both for the whole team. Deadlines do not move on days off. Days off never use anyone's leave.
- **Day leave**: everyone except the Super Admin gets **1 leave day per calendar month**. Day leave and sick leave (`type`) share that one day. A request covers From–To; `days` counts the dates in the range that are not the person's days off. Ranges may not overlap the person's other pending or approved leave, may start up to 30 days in the past (e.g. sick leave), and are split by calendar month when counted.
  - **Team Member**: the request is `pending`; any Team Leader or the Super Admin approves or rejects it with an optional message. The member can cancel it while pending.
  - **Team Leader**: leave is `approved` straight away (no approval step).
  - **Issue a day off** (*new*, design LV-C): a Team Leader or the Super Admin gives someone else a day off from My page → Leave (**+ Issue day off**: person, From–To, optional note). It is saved as **approved day leave** for that person (`created_by` = the issuer, `decided_by` = the issuer, the note as `message`), so it uses their 1 day and extra days are deducted like any other leave. Team Leaders issue to Team Members and other Team Leaders; the Super Admin to Team Members and Team Leaders; nobody to themselves or the Super Admin. The same date checks apply (overlap with their leave, all days off). The person gets a message on My day and in the bell: "{issuer} gave you a day off · {dates} ({N} days, day leave)" with the note. The Leave list marks the row **Issued**.
  - The Super Admin can cancel anyone's leave; a Team Leader can cancel a Team Member's leave, their own, and a day off they issued.
  - Taking more than the month's day is allowed (the dialog warns "N days over, deducted from {Month}'s salary").
- **Monthly settlement** (computed from approved leave, never stored): per person per calendar month, taken = approved leave days in that month. 0 → **1 day paid** with that month's salary; 1 → even; more → **taken − 1 days deducted**. Nothing carries over; each month starts again at 1. The **year-end report** only counts, per person: day leave, sick leave, total, and the company days off in the year.
- **Who's out today**: everyone else whose day off is today (weekly, own, event, seasonal) or who has approved leave today, with "Day off" / "On leave" and when they are back (the next date that is neither). Never shows day vs sick leave or a reason. The box never lists everyone: up to 8 faces then "+N", and the counts "N on leave · N day off"; **See all N** opens a list pop-up: title with the count and a close ✕, a search field, the filter All / On leave / Day off (only when people are out for both reasons), one row per person (photo, name, "Back tomorrow" / "Back {day date}", Day off / On leave tag), 10 per page, and a footer with "N people" (or "1–10 of N" with ‹ › page buttons) and Close. The Notices and Needs-your-approval "View all" pop-ups use the same frame. When the whole team is off (an event or seasonal day off today, or nobody else is in) it shows one line: "Everyone is off today · {name} · back on {date}".
- **Birthdays**: everyone sets their date of birth in their own Settings (7.6); everyone sees the day and month, only managers and the person see the year. On the day, that person sees the birthday message and everyone else sees "Today is {name}'s birthday."
- **Automatic messages** (Super Admin edits the texts; `{name}` = full name): **birthday**, **signed in on a day off** (shown when today is the person's day off), **leave approved** (used when the approver types no message).
- **Notices** (*replaces the shout-out box and the announcement strips*): Super Admin and Team Leaders send a **Notice** to **everyone** (kind `announcement`) or to **chosen people** (kind `notice`), or a **Shout-out** to chosen Team Members (kind `shoutout`); optional title, message, **show for** 7 days / 30 days / until removed (`show_until`). A notice to chosen people is private: only they, its author and the Super Admin receive it (enforced in `/sync` and `/posts`). Shout-outs are seen by everyone for 30 days. Recipients get a bell item.
- **Required profile**: full name, **location** (city), **date of birth** (day, month, year), **phone number** and **photo**. Missing fields show a red strip on My day — "Finish your profile to keep working. Missing: …" with **Complete profile** — and, for Team Leaders and Team Members, lock task work (section 3, Profile lock): My projects shows "Your tasks are waiting … Complete profile". The Super Admin only gets the reminder.
- **Weather**: the date row shows today's weather for the person's city ("☀ 31° Sunny in Rangpur · 31° / 24°"). The server asks **Open-Meteo** (free, no account): the city name to its geocoding API (cached 30 days), the coordinates to its forecast API (cached 1 hour per city). Nothing about the person is sent. No city, or the service unreachable → just the date. `GRP_WEATHER` set to false turns it off.

### 6.11 New cycle setup (Team Leaders and the Super Admin)
When an **active** project starts a new cycle, a Team Leader or the Super Admin must, **within 3 days** (by the end of day 3 of the cycle):
1. **Assign monthly tasks**: every monthly task of the project has someone responsible (Responsible people or a breakdown row with people). The system keeps adding the standard tasks unassigned (6.8).
2. **Review last cycle**: every monthly task that existed at the end of the previous cycle, and every **meeting task due or finished in it** (Meeting minutes), gets **Looks good** or **Send feedback** (a note, required); an open meeting task can instead be **carried over** with a new deadline (today or later; the task's deadline becomes that date, and it counts as reviewed, `{ok, carry}`). Feedback goes to the task's responsible people as a private notice "Feedback: {task}" (Notifications box and bell, shown 14 days). Stored in `grp_projects.cycle_reviews` under the previous cycle's key. A project that did not exist last cycle only has step 1.
- Applies to cycles that start on or after the day the rule was installed (setting `cycle_setup_since` `{date}`, set by schema 7), so projects part-way through a cycle are not overdue on the day of the update. Paused and inactive projects are left out.
- **Every monthly task has someone responsible**, all cycle long: a monthly task can't be added, or changed to have nobody (no Responsible people and no people on a breakdown row) — "A monthly task needs at least one person responsible." (server `grp_people_required`, and the form). Only the standard tasks the system adds (6.8) start without people. The Monthly Tasks tab shows a red line "{N} monthly tasks have nobody assigned." while any has nobody.
- **A reminder every day until done** (*new*), for Team Leaders and the Super Admin, in the **Notifications** box under the filter chips (on **All** and **To approve**, first page), above Waiting for you, and first on the **bell**: one per project and day (key `setup:{project}:{date}`) — "New cycle for {project} — 2 unassigned, 4 to review · 2 days left" (amber, days 1–3) or "{project}: new cycle setup is N days overdue — …" (red), with **Open setup**; any other day an active project has a monthly task with nobody, "{project}: N monthly tasks have nobody assigned" with **Assign people** (→ its Monthly Tasks); the Super Admin also gets one "{N} projects late on new cycle setup: …" when two or more are late. They can't be dismissed: no ✕, Mark all read and opening the bell leave them new; each goes away by itself as soon as its work is done (within one sync, ~10 s, for everyone else).
- **Reminders, nothing blocked**: days 1–3, an amber message in the band ("New cycle for {project}. Assign the monthly tasks and review last cycle by {date}.") and a **New cycle setup** box at the top of My day's left column; after day 3, red ("{project}: new cycle setup is N days overdue."), "Setup N days overdue" on the project card, and the bell. Messages are not dismissable; **Open setup** goes to the box. The Super Admin sees every late project the same way. A finished project shows **Done** until the end of day 3.
- **New cycle setup box**: one row per project — name, flag ({N} days left · due {date} / Overdue · N days / Done), the three steps with counts ("4 of 6 have people", "Review monthly tasks · 2 of 6 reviewed", "Review meeting minutes · 1 of 3 reviewed"), **Assign people** (→ the project's Monthly Tasks) and **Review last cycle** (→ dialog: each task with its people, deadline type and last cycle's done / target in green or red; Looks good / Send feedback; then **Meeting minutes** with Done / Open, Looks good / Send feedback / Carry over; one "N of M reviewed" bar).

### 6.12 Project details and keyword checklist (*new*)
- **Details** (project tab, design PD-D, laid out as PD-F): the **first section is the project's header card** — a dark blue band with the project's initials, the section title, "{project} · {status} · Cycle {start} – {end}" (no team names) and **Edit** — then its text and its links as larger chips with the type under the name (Google Sheet · Google Doc · Drive folder · Link). Then **Goals** and **Notes for the team**, always shown in that order (empty ones are dashed cards with a hint and Edit, "Nothing here yet." while the profile is incomplete; saving one adds it), then any other sections — in **two columns** across the full width (one column on narrow screens). A section's text whose lines all start with "-", "•" or "*" shows as a bullet list. A few **sections**, each a card with a title (the first defaults to **About**), a short text and its **links as chips** (Google Sheet ▦, Doc ≣, Drive folder ▲, other ↗; the kind is detected from the address and opens in a new tab). Everyone (Super Admin, Team Leaders, Team Members; not while their profile is incomplete): **Edit** (title, text, × on each chip, drag chips to reorder, Save / Cancel, Remove section), **+ Add link** on a card (paste the link — "✓ Google Sheet" — and a name; saved at once) and **+ Add a section**. Everyone opens the links. Only http(s) links; the portal stores the link, the file must be shared in Google. Limits: 12 sections, 30 links each.
- **Plan** (project tab, design KP-C): the **keyword checklist** — one row per keyword with the project's **checkbox columns** (default On-page · Content · Internal links · Backlinks; **⚙ Columns** renames, reorders, adds or removes them, 1–8; ticks stay with a column's id), a **progress** bar (ticked / columns, green when all), a **Deadline** and a **Note**.
  - Rows are grouped **This cycle** (no deadline, or a deadline up to the end of the current cycle, including late ones) · **Next cycle** (a deadline after the current cycle) · **Past** (every box ticked — the keywords already done, whatever their deadline; green marker). **Drag a row** into This or Next cycle → its deadline becomes the end of that cycle; nothing is dropped into Past: ticking the last box moves a row there and unticking one brings it back. The **Deadline** pill also has a menu: This cycle · Next cycle · Pick a date… · No deadline. Past the deadline with boxes still empty → red "· late".
  - **+ Add keywords**: one per line (paste a column from a sheet), with a deadline (This cycle / Next cycle / No deadline); blanks and repeats (any case) are skipped; up to 200 at a time. ⋯ on a row: **Rename**, **Remove**.
  - **Unticking**: everyone unticks a box by clicking it (hover: "… · click to untick"). Requests to untick made before this (`ask_untick`) still show an amber dot and wait in the leaders' **To approve** with **Untick** / **Keep ticked**; clicking such a box shows the request before unticking. Ticking a ticked box keeps who ticked it first.
  - Everyone ticks boxes (hover: "Ticked by {name} · {when}"), writes the note (saved on Enter or leaving the field), adds, renames and removes keywords, sets deadlines and changes the columns (not while their profile is incomplete). The footer counts each column and how many keywords are fully done.
- Keywords stay while their project is in the trash and are deleted with it forever. Both are in the export / import (`clients[].details`, `clients[].kwColumns`, `keywords`).

### 6.13 General tasks (*new*, designs GT-A, GT-B, GT-C)
Work that isn't part of any project (training, office, the agency's own website, reports). A General task is a meeting task with **no project** (`grp_meeting_tasks.project_id` = `''`), so it has everything a meeting task has — statuses, quantity, deadline (calendar dates: none, weekly, bi-weekly, monthly, a date or a range), people, the submission form, review, Request undo, comments, files, notifications, export / import, trash — and nothing that belongs to a project: no cycle, no New cycle setup, no Monthly / Plan / Details tabs, not in the Projects tab table.
- **Sidebar**: **General tasks** under My day, with the number of open General tasks (red when one is urgent). It opens the **General tasks** screen: a header card ("Work that isn't part of any project — …", **+ Add task** for Team Leaders and the Super Admin), tabs **Tasks · Recent Activities** (`GET /audit?general=1`), chips **All · Mine · Not started · In progress · Completed · Overdue** with counts, the task search in the top bar, and the same task cards (the card's corner says "General") with an **Add general task** card for leaders, last after the tasks (design GT-A kept). Open first (most urgent), then finished.
- **Adding / moving**: the task dialog's **Where** lists **General — not part of a project** (Team Leaders and the Super Admin) before the projects; from the General tasks screen it is already picked. Changing Where on Edit moves a task between General and a project; history, review and comments go with it (audit: "Project: General → Acme"). Team Members can't add General tasks (server: ADD_GENERAL_TASK) and work only on the ones assigned to them, like any task (6.6).
- **My day**: a person's General tasks are their own group in **My projects**, "General tasks · no project" (dark edge), sorted with the rest; "New general task: “…”" in Notifications and on the bell; reviews, approvals, undo requests and comments work as for project tasks and open the General tasks screen.
- A deleted General task is restored from the trash without a project; the export writes `clientId: ""`.

### 6.14 Invoices (*new*, Super Admin only, designs TR-A and TR-B)
Not for sending invoices: the Super Admin's own record, so no invoice is forgotten and every payment is tracked.
- **A line per project per cycle**: every **active** project has a line for its **current cycle** from day one (so the page is never empty and you can bill early), and keeps one for each ended cycle (up to the last 6), made by the hourly job, the Super Admin's full sync, or opening Invoices. The tracker starts on the day of the update (option `grp_billing_since`, schema 11): each project's cycle that had just ended then, and every one after it; nothing older, nothing from before a project was added. A waived cycle-day transition is not billed. The amount is the project's **fee** (⚙ Fees: fee, currency, **payment reminder N days after the invoice is sent, default 3**); a new fee also fills in the amount of cycles not sent yet that have none.
- **Payment tag** of a line: **Not billed** (ticked "Not billed for this cycle") · **Paid** (payments ≥ amount; with no amount, any payment) · **This cycle** (still running, invoice not sent; "· ends {date}"; no reminder, nothing owed yet) · **To send** (cycle ended, invoice not sent) · **Partly paid** (some paid, "· $X left") · **Overdue** (sent N or more days ago, nothing paid; "· N days") · **Waiting** ("· sent {date}").
- **Sidebar → Invoices** (Super Admin only; no count). Tiles: To send (names), Waiting for payment (amount left per currency), Overdue (the oldest, days), Received this month. **By project** (TR-A): one row per project — its oldest cycle that still needs something (To send, Waiting, Partly paid, Overdue), or else its latest (usually This cycle) — Last cycle, Amount, Payment tag, **Invoice sent** tick (stamps today; unticking asks first), **Payment received** tick (→ a small form: amount, the rest by default; date; method Bank · bKash · PayPal · Wise · Cash; reference; part payments add up), "+N more cycles open" when another of its cycles needs something too, and **Open ›** (the cycle in full: amount, currency, invoice sent on, invoice no. or link, Not billed + note, payments with ✕, + Record payment). Tag chips filter the rows. **Year view** (TR-B): projects down, six months across (by the month a cycle ends; ‹ › for earlier), every cell the cycle's tag (opens it), **Owed** on the right. **Export CSV** (every line; cells starting with = + - @ are quoted).
- **Reminders every day until done**, for the Super Admin, with the New cycle setup reminders (Notifications under the chips, and the bell; can't be dismissed): "{project}: send the invoice for {cycle}" (amber, from the day after the cycle ends until Invoice sent or Not billed) and "{project}: payment not received — N days since the invoice" (red, once Overdue; "$X still to come" when partly paid), with **Open invoices**. Also when no fee is set.
- **Private**: every `/billing` route is Super Admin only (MANAGE_BILLING); `/sync` sends `billing` and `billing_fees` (and their deletions) to nobody else. Not in the export yet.

## 7. Screens (match the reference file)

### 7.0 Dashboard (everyone)
*Not in the reference portal.* The landing page after sign-in, and what **GridRankers** in the sidebar opens. Design reference: the "Employee dashboard" boards H–U of the design canvas. No statistics (days worked, percentages) anywhere on it.

**Top bar** (everyone): "Good morning / afternoon / evening, {full name}" (before 12:00 / until 17:00 / after), today's date, the **bell** (6.9), user chip and Sign out. **Above them**, a coloured **message band** across the top edge of the header card, in the message's colour (amber day off, pink birthday, green approved / review asked, red rejected / profile), showing **one message at a time** with "1 of N ‹ ›" to step through the rest; each has its button (Dismiss / Thanks / Review now / Complete profile; dismissing is per person, 6.9). The messages, in order: the profile reminder (6.10, first), the day-off message (6.10), birthday ("Happy birthday, {name}!" for that person — button Thanks — and "Today is {name}'s birthday. Wish them a happy birthday!" for everyone else), leave approved / rejected with the approver's message, "{name} asked you to review '{task}'" with **Review now**. Announcements are in the Notifications box. No messages → no band, just the greeting row. Under the greeting: the date and the weather (6.10).

**Tabs** (Super Admin, Team Leader only): **My day · Projects** (with the number of active projects that need attention), and on the right **Send notice**. Team Members have no tabs: they only have My day.

**My day** — two columns that start and end level (My projects on the left and Notifications on the right stretch to fill the gap, so the last cards of both columns end on the same line):
- **Left: My projects.** Every project in which this person has open work: meeting tasks assigned to them and not done, and recurring tasks of the current period where they are responsible and their share is not done (unassigned work is not listed: every project has unassigned standard tasks, and it would bury their own work). Most urgent first: red edge = something overdue or urgent; amber = something due within the next 3 days; then by the next deadline; projects with no deadline last. Each project box: name, "N tasks", one flag ("Overdue", "Urgent", "Due today", "Due in 3 days", "Due Oct 8", "Next due Oct 20"), up to 2 tasks (checkbox look, title · kind, due chip), "+N more tasks" (expands in place). Filter chips **All · Urgent · Overdue · Due this week** with counts. **5 projects per page** with "Showing 1–5 of 8 projects" and ‹ Previous · 1 · 2 · Next ›. Click a task → its Details; click the project name → its Meeting Minutes. Empty: green tick, **You're all caught up**, "No open tasks. New tasks assigned to you will show here, most urgent first."
- **Right column:**
  1. **Notifications** (*new*, everyone, design NF-A; replaces the Notices box; stretches): a live feed of everything that matters to this person in the last 30 days, newest first — **new task for you** (a meeting task assigned to them, or a recurring task they were made responsible for, by someone else, in the last 30 days and not done), **task rejected** / **revision requested** (with the reviewer's note), **task approved** (by someone else, not auto-accepted), **review asked of you**, **comments** on submissions they are part of (6.6), for leaders **undo requests**, **leave answers** (Sick leave / Day leave approved or not approved, a day off given to them, with the message), **events** (days off from today to 2 weeks ahead) and **birthdays** today, **notices** ("{sender} → you / everyone · {title}") and **shout-outs** ("Shout-out from {sender}"). Each item: unread dot, a coloured icon, a title that reads on its own and no description ("New task: “{task}”", "Rejected: “{task}”", "Sent back: “{task}”", "Approved: “{task}”", "Sick leave approved · Oct 2", "Founders Day · Oct 6", "{sender} → you: {message}", "Shout-out from {sender}: {message}"; at most two lines), when ("5 min ago", "2 h ago", "Today 9:10", "Yesterday", "Mon, Oct 6"), and **Open task ›** on task items (opens the project's tab with the task searched). Header: **N new** and **Mark all read**; filters **All · Tasks · Leave · Messages · Events** with counts; **6 per page** with "1–6 of N ‹ ›". Read state is per person and shared with the bell (6.9, `seen:` keys). Empty: **Nothing new**.
  2. **Today** card (*new*, at the bottom): **Who's out today** (everyone, 6.10: faces + counts, **See all N**; "Everyone is in today." / "Everyone is off today") and, beside it, **Day leave** (item 4; day and sick leave) for Team Members and Team Leaders — one card, two halves (stacked on phones). The Super Admin's card has only Who's out, full width.
  3. Team Leader / Super Admin (*changed*, design NF-C): no separate box — what waits for their answer is **Waiting for you · N** at the top of Notifications (first page of **All**, up to 3 cards, then "+ N more waiting for you"), and all of it under the **To approve N** filter (amber chip, 6 per page): leave requests from Team Members (type, dates, days, "within October's 1 day" or "2 days over, deducted" in red; **Approve** / **Reject**, optional message), finished work waiting for review (6.6: **Approve** / **Send back**), reviews someone asked them for, requests to undo (**Undo** / **Keep In progress**) and to untick a keyword (**Untick** / **Keep ticked**). Each is one card as in NF-C *without descriptions* (*changed*): a coloured icon, one sentence ("{name} finished “{task}”", "{name} asked you to review “{task}”", "{name} asks for sick leave · Oct 7", "{name} asked to undo “{task}”", "{name} asked to untick {column} · {keyword}"; clicking it opens the task), when, and the buttons under it — no notes, reasons or completion text; those are on the task's page and in the answer dialog. They stay until answered and are not repeated in the feed below (no "Review asked of you" or undo items for leaders). Empty: **Nothing waiting for you**.
  4. **Day leave** (Team Member, Team Leader; not the Super Admin; the right half of the Today card): "**N** day left in {Month}" (1 − leave taken this month, never below 0), **My leave** link (member page), and **Request day leave** (Team Member) or **Take day leave** with "Your leave is approved straight away." (Team Leader). The dialog: Type (Day leave / Sick leave), From, To, Reason (optional); it shows the days counted (days off not counted) and, when over, "This request is N days over. Settled at the end of {Month}: N days deducted from {Month}'s salary." After approval the box shows "Approved: 19–21 Oct."

**Projects** (Super Admin, Team Leader):
- *Changed* (design PJ-A4): one **health table** instead of the Needs attention box and the cards. On top: project search, status chips **Active · Paused · Inactive · All** with counts (opens on Active), **+ New project** (name, cycle start day — optional, locks it as 6.1 — and status). One row per project (click → Meeting Minutes), **worst first** (red, amber, green; then by name):
  - a **dot**: red = something overdue or the new cycle setup is late; amber = something else to look at; green = nothing;
  - **Project** (name; Paused / Inactive under it);
  - **Cycle**: "Day N · X days left" with a thin bar (or "No cycle start day yet");
  - **Monthly tasks**: this cycle's done / total with a bar (green when all; "Start when active" for a paused or inactive project without them);
  - **Needs attention**: the **most urgent** item only — its title and why in its colour, behind a coloured edge ("New cycle setup · 2 days overdue", "Fix H1 · overdue 3 days", "Citations · nobody assigned", "Hot fix · urgent", "GBP post · to review") — and a quiet **+N** for the rest, which opens a small list of them all; clicking an item opens it (the task in its tab, or the New cycle setup box); nothing → "✓ On track". Order: setup late, overdue meeting tasks and missed recurring periods (longest first), setup due, monthly tasks with nobody (active projects), urgent tasks, waiting for review;
  - **Team**: faces of the active people on its monthly tasks and open meeting tasks (up to 4, then +N);
  - **⋯**: Move to Active / Paused / Inactive; Delete project (Super Admin; trash 30 days, with its tasks).
  - The **Projects** tab shows how many active projects need attention. On narrow screens a row keeps the dot, project, needs attention and ⋯.

**Send notice** dialog: Kind (**Notice** · **Shout-out ★**), To (**Everyone** · **Choose people**; shout-outs: chosen Team Members only), Title (optional), Message, Show for (7 days · 30 days · Until I remove it).

**Tour someone's portal** (view only, design VT-A): on My page → **Team**, clicking a person's photo or name, the row's **👁 Tour** button, the ⋯ menu's **Tour their portal**, or **Tour their portal** on their page starts a tour (the app asks the server first: `GET /members/{id}/tour`). You see the whole portal as they see it — their My day, their sidebar (no Invoices unless they are the Super Admin), every project tab, General tasks, their own page — and go anywhere they can go, under a dark bar pinned across the top: "Touring {name}'s portal · {role} · view only — you see what {first name} sees; nothing can be changed", with **Open {first name}'s page** (their page as you see it, with your tools; ends the tour) and **✕ Close tour** (back to your own My page → Team). Nothing can be changed: Add cards show "🔒 Not in a tour", status buttons, ticks, checkboxes, Edit / Delete and Save are greyed and a click says "View only — you're touring {name}'s portal."; Sign out, Log work, leave requests, approvals, message buttons, bell and weather are hidden; every write the app could still send is refused before it leaves the browser. The Super Admin tours anyone else; a Team Leader tours Team Members only; Team Members tour nobody (server: TOUR_MEMBER). A Team Leader opens Team Members' pages only, not other leaders' or the Super Admin's (their row has no menu); Team Members see only their own page. Reloading the page ends a tour. (Notices sent privately to them by someone else show only if the viewer could see them anyway.)

### 7.1 Layout
- Left sidebar (design A, no search): the **GR** mark with **GridRankers** / Team portal and a **My day** link (both → Dashboard, 7.0), then the projects for quick switching, each with a coloured initials badge, its name on one line (full name on hover) and its open-task count only when it has open work (red when something is urgent). **Active projects** are always open; **Paused** and **Inactive projects** are folded (with their count) until opened, and open by themselves while one of their projects is on screen. A project is highlighted only on its own screens. At the bottom: the live sync status with a green dot. No "Add a project", no drag & drop, no move or delete buttons: those live on the Dashboard.
- Top bar on a project's screens (the Dashboard has its own, 7.0): project title (+ "(paused)/(inactive)"), task search, tabs **Meeting Minutes · Monthly Tasks · Plan · Details · Recent Activities** (6.12; no task search on Plan and Details), user chip (avatar → Team area; admin/lead → Team dashboard, member → own page), Sign out.

### 7.2 Meeting Minutes
Alert banner (cycle-scoped), project cycle bar, stats (status chips, cycle dates, cycle progress, days left / ended / starts in), cards, "+ Add task" tile.
**Card** (compact): priority chip, Qty chip, meeting date; title; added / fixed / deadline chips; mini review tag; mini progress bar (qty > 1); status segment (Not started / In progress / Completed, locks per 6.6; under it one small line: ↶ Request undo, the Undo requested chip, or the 🔒 not-assigned line); footer above a thin rule: avatar stack + "N person/people" or "? Not assigned", **Details**, Edit (admin/lead), 🗑 (admin/lead).
**Task dialog**: Client, What needs to change, Details, Page URL, Priority, Status, Quantity, From meeting on, Deadline (6.3), Responsible (searchable people picker; shares when qty > 1). Members can't open Edit.
**Details window**: header (tags, status pill, title, project), info grid (meeting, added, deadline, fixed, responsible), Progress (full steppers), Details text, Page link, Submission & review (design SF-B: submission, Edit submission, comments; + reviewer actions). No history.

### 7.3 Monthly Tasks
Banner, project cycle bar, stats, filters (All / Weekly / Bi-weekly / Monthly) + week bar, cards, "+ Add monthly task".
**Deadline colours**: the card tag names the deadline option and has its own colour — Weekly teal, Bi-weekly blue, Monthly purple, Specific date amber, Range pink, No deadline grey (also in Details). A meeting task's deadline chip uses the same colour per option unless it is overdue (red) or due soon (amber).
**Card**: Monthly/Weekly/Bi-weekly chip, "Qty N per cycle/week/2 weeks"; title; due chip; W1–W4 boxes for weekly, W1–2 / W3–4 for bi-weekly; mini progress "x/n · k types"; status segment; footer as above.
**Dialog**: Client, Task, Deadline (6.4), Quantity (locked when breakdown exists), Breakdown (6.5), Responsible (people only), Details. No auto-suggestions on Task or the breakdown Type (plain text fields, browser autocomplete off).

### 7.4 Recent Activities
**Project-specific**: everything on this tab belongs to the selected project.
- Filter chips **All · Added · Completed · Reviews · Changes** (Changes = every other kind).
- A table, newest first, one row per change: **When** ("Today · 2:41 PM", "Yesterday · …", "Sep 28 · …") · **What** (coloured tag: Added, Status, Progress, Completed, Assigned, Changed, Deleted, Restored, Review, Project, Cycle change) · **Task** (+ meeting / monthly task) · **Who** (avatar + name; role on hover) · **Details** (detail and field changes "field: from → to", cut to one line, full text on hover). On narrow screens each row stacks.
- **Recently deleted (N)** button (admin/lead) opens that project's deleted meeting and monthly tasks: Restore / Delete forever.
*Change from the reference portal (a dated log, and a recently-deleted list covering every project).*
(The Recent Activities tab of a person's page, 7.5, stays across all projects: it is that person's history.)

### 7.5 Team area (admin/lead)
The team sections are tabs of **My page** for leaders and the Super Admin (7.6) — Team, Leave, Admin settings (Super Admin), Recent Activity (the Activity section below) — with the Daily/Weekly/Monthly period selector on Recent Activity. There is no separate team area, Team button or team Dashboard tab any more.
- Dashboard: notifications (6.9), greeting with counts (done / assigned / unassigned), Workload (open tasks per person), completed-tasks chart (per day; per person in Daily view), team list.
- Activity: completed + logged work grouped by day, person filter, Copy report.
- Team: Members & access (7.6).
- Leave (*new*, design LV-A): requests first.
  - **Four numbers** on top: **Waiting for you** (requests the viewer may decide, with the names), **Out today** (approved leave covering today: names and type), **Taken in {month}** (approved leave days this calendar month and how many people), and — Super Admin only, as it is settlement data — **Over the allowance** (people who took more than 1 day this month, "N day(s) deducted"). A Team Leader sees the first three.
  - **Leave requests**: one list with status chips **All · Waiting · Approved · Not approved · Cancelled** (each with its count) and a person picker (Everyone / a person). Waiting requests first (highlighted), then newest first. Each row: photo and name with the reason under it ("“Family wedding”"), a type pill (Day leave blue, Sick leave pink), dates (a waiting request that would go over the month's 1 day says "N day(s) over → deducted" in red), days, status pill, and on the right the decision: **Reject / Approve** buttons on a request the viewer may decide, otherwise "by {name}" (a Team Leader's own leave: "approved straight away") with the message and **Cancel** where allowed (6.10). Empty: "No leave yet." Footer hint as before.
  - Super Admin only: **Settlement** with a **Monthly / Year-end** switch, a ‹ month › stepper (‹ year › for Year-end), **⬇ CSV** and **Print**. Monthly: per person photo and name, **Allowance used** (a small bar of the 1-day allowance — blue used, red over — and "N of 1"), taken, and "1 day paid" / "Even" / "N days deducted"; the footer gives the rule and the totals ("2 paid · 3 even · 1 deducted"). Year-end (per person: Day leave · Sick leave · Total · Company days off) as before.
- Settings: Members & access table (role, contact, open tasks, sign-in status, **Set code**, Open, Remove), **Deleted projects** (Restore — brings back the tasks deleted with it — / Delete forever; kept 30 days), Export all data. Super Admin only (*new*): **Days off** (team weekly day off as weekday chips; a person's own weekly day off; list of event and seasonal days off with **+ Add day off** and remove) and **Automatic messages** (birthday, signed in on a day off, leave approved).

### 7.6 Member page (own page for members; any member for admin/lead)
**Your own page** (everyone; the name chip opens it): the top bar reads **My page** (no project name, search or project tabs; the Team area reads **Team**), "← My day", a profile header (photo, name, role, job title, city, phone, birthday day and month), then tabs that depend on the role. No dashboard or task list here: they are on My day.
- **Team Member**: **My leave · Calendar · Settings · Recent Activities** (their own), opening on My leave.
- **Super Admin**: **Calendar · Team · Leave · Profile settings · Admin settings · Recent Activity**, opening on Calendar. **Team Leader**: **Calendar · Team · Leave · My leave · Profile settings · Recent Activity**.
- **Team** = **Members & access** only (below) — no period bar, card search or member cards. Each row you may tour has a **👁 Tour** button; its ⋯ menu's **Tour their portal** starts a tour, view only (7.0); **Open their page** opens their page; clicking a person's photo or name does the first one available (a tour, or their page); a row you may neither tour nor open is plain text. **Leave** = everyone's leave (7.5, with a count of requests waiting). **Recent Activity** = the whole team's completed and logged work (7.5 Activity).
- **Admin settings** = one page with the sections one below the other: **Days off · Automatic messages · Deleted projects · Export data**.
- **Members & access** (on the Team tab, design A; leaders and the Super Admin): title with the counts ("7 people · 1 Super Admin · 2 Team Leaders · 4 Team Members"), search (name, title, email, phone), + Add member, filters **All · Team Leaders · Team Members · No sign-in** with counts, then one row per person — photo, name and job title · role pill · email and phone on two lines ("No contact yet") · open tasks (+ "N urgent") · sign-in dot (Can sign in / WordPress login / No sign-in yet) · **👁 Tour** (when the viewer may tour them, 7.0) · **⋯** menu with what the viewer may do (section 3): Tour their portal, Open their page; **Set sign-in code** (Super Admin: anyone but the Super Admin; Team Leader: Team Members); Super Admin only: **Change role** (Team Leader / Team Member; signs them out) and **Remove from team**.
**Someone else's page** (admin/lead, from Team): tabs **Overview · Tasks · Calendar · Leave · Recent Activities · Profile** as below.
- My dashboard: greeting + counts, next tasks, completed chart.
- My tasks: Reviews of your work; filters All / To start / In progress / Completed + Project; groups To start, In progress, Completed this period; + Log work; ⬇ Download PDF report.
- Calendar: Month / Week / Day. Monthly tasks = bar across the cycle; weekly = bar across the week; meeting deadlines per type; dated items = chips; colours: blue to do, orange urgent, green done (struck), red missed; click a day → Day view.
- Recent Activities: grouped by month, filter chips (All / Assigned / Completed / Logged work / Other changes), date column, coloured icon, tag + title, meta line, time.
- Settings: photo (cropped to 160 px), name, job title, email, phone, address, Google Drive link, notes, **location** (city) and **date of birth** (day, month, year) (*new*). Required fields (6.10) are marked, missing ones outlined in red, with "Profile N of 5 complete"; Super Admin: role + Set code + Remove.
- My leave (*new*; the Day leave box's **My leave** link opens it): this month's days left, the person's requests (type, dates, days, status, decided by, message; Cancel while pending) and past months' settlement ("1 day paid" / "Even" / "N days deducted").

## 8. REST API (namespace `gr-portal/v1`)

| Method & path | Purpose |
|---|---|
| POST `/auth/login` `{code}` · POST `/auth/logout` · GET `/auth/me` | sessions |
| GET `/sync?since=` | all changed rows across tables since cursor (+ deletions) |
| GET/POST/PATCH/DELETE `/projects[/id]` | projects; PATCH `/projects/id/state`, POST `/projects/id/cycle`, POST `/projects/id/cycle-review` `{task_id (monthly or meeting task), ok, note?, carry?}` (6.11) |
| PUT `/projects/id/details` `{sections}` · PUT `/projects/id/keyword-columns` `{columns}` · POST `/projects/id/keywords` `{keywords: [..], deadline?}` · PATCH `/keywords/id` `{check: {column, on}}` / `{ask_untick: {column, note?}}` / `{keep: {column}}` / `{note}` / `{keyword}` / `{deadline}` / `{position}` · DELETE `/keywords/id` | project details and keyword checklist (6.12) |
| GET/POST/PATCH/DELETE `/meeting-tasks[/id]` | tasks (`project_id: ''` = a General task, 6.13); POST `/meeting-tasks/id/status`, `/progress` `{memberId,delta}` |
| GET/POST/PATCH/DELETE `/monthly-tasks[/id]` | tasks |
| POST `/records/tick` `{taskId, periodKey, partId?, memberId?, delta, note?, link?}` · POST `/records/status` | recurring progress |
| POST `/meeting-tasks/id/undo` `{reason}` · POST `/meeting-tasks/id/undo/decide` `{action: undo|keep, note?}` · POST `/records/undo` `{taskId, periodKey, reason}` · POST `/records/undo/decide` `{taskId, periodKey, action, note?}` | request undo (6.6) |
| POST `/review` `{kind: item|record, id, action: accept|revision|reject, note}` | review |
| POST `/review/request` `{kind, id, reviewer, note}` | ask someone to review own finished task (6.6) |
| status / progress / tick / create as Completed take `{note, links[], files[], comment, reviewer?}` | the submission (6.6); `reviewer` for leaders only |
| PATCH `/meeting-tasks/id/submission` `{note, links, files, comment}` · PATCH `/records/submission` `{taskId, periodKey, note, links, files, comment}` | edit a submission (6.6) |
| POST `/files` (multipart `file`) → `{id, mime, name, size}` · GET `/files/id` (`?download=1`) | attach / open a file (6.6) |
| POST `/comments` `{kind: item|record, id, body, files?}` · DELETE `/comments/id` | comment on a submission (6.6) |
| GET/POST `/leave` · PATCH `/leave/id` `{action: approve|reject|cancel, message}` | day leave (6.10) |
| GET `/leave/report?month=YYYY-MM` · `?year=YYYY` (Super Admin) | monthly settlement / year-end counts |
| GET/POST/DELETE `/days-off[/id]` · PUT `/days-off/weekly` `{weekdays, member?}` (Super Admin) | days off |
| GET/POST/DELETE `/posts[/id]` `{kind: announcement|notice|shoutout, to?: [ids], title?, body, show_until?}` | notices, shout-outs |
| GET `/weather` | today's weather for the signed-in person's city (6.10) |
| PUT `/settings/messages` (Super Admin) | automatic messages |
| GET/POST/DELETE `/activity` | logged work |
| GET `/audit?project=&general=&from=&to=` | Recent Activities (`general=1`: the General tasks) |
| GET `/trash` · POST `/trash/id/restore` · DELETE `/trash/id` | trash |
| GET/POST/PATCH/DELETE `/members[/id]` · POST `/members/id/code` | team |
| POST `/notifications/dismiss` | dismissals |
| GET `/billing` · PUT `/billing/projects/id` `{fee, currency, remind_days}` · PATCH `/billing/id` `{sent?, sent_at?, amount?, currency?, ref?, skipped?, note?}` · POST `/billing/id/payments` `{amount, date?, method?, ref?}` · DELETE `/billing/id/payments/pid` | invoices (6.14, Super Admin only) |
| GET `/export` · POST `/import` (admin, nonce) | data |

All writes validate input, check permissions (section 3), write the audit row in the same transaction, and return the updated row.

`/sync` also carries the new tables. Leave privacy is enforced there: a Team Member receives their own leave rows in full and, for other people, only approved leave as `{member_id, from_date, to_date}` (enough for Who's out today) — never the type, reason or message. Team Leaders and the Super Admin receive all leave rows.

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

**My day and people features (6.10, 7.0) — released as 0.1.5 (steps 15–16, server only) and 0.1.6 (steps 17–19):**

15. Schema 5: `grp_leave`, `grp_days_off`, `grp_posts`, `grp_members.birthday` / `weekly_off`, settings `weekly_off` / `messages`; new permission rows of section 3; leave day counting, monthly settlement and Who's-out-today as pure functions. Export includes the new tables. **Tests:** every new permission row, day counting across days off and month ends, settlement 0 / 1 / over.
16. REST: `/leave` (+ report), `/days-off`, `/posts`, `/settings/messages`, `/review/request`, member birthday, `/sync` with leave privacy. **Tests:** a Team Member cannot approve leave, see other people's leave type or reason, post, or read reports; a Team Leader's leave is approved on creation; only the named reviewer (or Super Admin) can act on a review request.
17. My day (7.0): top bar with greeting, bell and strips; My projects (ordering, filters, pagination, empty state); right column per role (Who's out today, Shout-outs / Needs your approval, Day leave + leave dialog); Projects tab (Needs attention + project cards); Send shout-out and Post announcement dialogs; Mark as done → Ask someone to review it.
18. Team → Leave (list, monthly settlement, year-end report, CSV / Print) and Team → Settings → Days off + Automatic messages; member page My leave tab and Settings → birthday.
19. Playwright e2e: member requests 3 days → leader sees it in Needs your approval → approves with a message → member sees the strip and "0 days left"; leader takes leave (approved straight away, shows in Who's out today); Super Admin sets a day off → member signing in that day sees the day-off strip; birthday strip; shout-out appears for members; leader asks a member to review → member approves.

**Dashboard update (6.10, 7.0, 7.6) — released as 0.1.7 (steps 20–21):**

20. Schema 6 (`location`, `birth_year`, `grp_posts.kind` `notice` + `to_members`); profile lock in `GRP_Permissions`; `/posts` notices with private delivery; `/weather` (Open-Meteo, cached); members accept location and birth year. **Tests:** lock for leaders and members only, private notices never reach others, weather with a stubbed HTTP response.
21. App: Notices box (top of the right column) and Send notice dialog; Who's out faces + counts with See all and the everyone-off line; weather in the date row; profile strip and locked My projects; Settings with required fields. Playwright: incomplete profile is locked and unlocks once filled; a private notice reaches only its people.

**0.1.8 (one change at a time, released together) — released as 0.1.8 (steps 22–31):**

22. Who's out "See all" pop-up cleaned up (6.10) — padded frame, search with icon, filter only when needed, larger rows, footer; same frame for the Notices and approvals "View all". Playwright: See all lists everyone out and search narrows it.

23. Messages on top (7.0, design C): the message band across the top of the header card, one at a time with "1 of N ‹ ›". Playwright: one message shows at a time and the others are reached with ›.

24. Your own page (7.6): the name chip opens your page — profile header and My leave · Calendar · Settings · Recent Activities; Team button on My day for leaders and the Super Admin; no project highlighted off project screens; greetings and messages use the full name. Playwright: the chip opens your page with those tabs and no project is highlighted; a leader reaches the team area from Team.

25. Sidebar redesign (7.1, design A): GR mark, My day, project badges, counts only when there is work, Active always open, Paused / Inactive folded. Playwright: folded groups open on click and the project opens.

26. My projects gets **+ Log work** (7.0): custom work for yourself (the existing Add manual task dialog; Team Members only for themselves, section 3). Notice cards name only the sender; shout-outs still say who they praise. Playwright: a member logs work from My day; a private notice card shows the sender and the To you tag only.

27. Monthly tasks for active projects only (6.8): no standard tasks for new paused / inactive projects, `grp_daily` skips them, their monthly tasks reach nobody; moving to Active tops up at once. **Tests:** PHPUnit (new paused / inactive project, cron skip, top-up on Active, stop after pausing), Vitest (assigned and missed work skip non-active projects), Playwright (paused card shows "Start when active", 0/6 after Move to Active).

28. Deadline options **No deadline · Weekly · Bi-weekly · Monthly · Specific date · Range** (6.3, 6.4): "Certain dates" becomes Range; Specific date and Range open a calendar (meeting tasks) or a cycle-day grid (monthly tasks). Playwright: pick a date, a range of days 1–5, and a monthly range of cycle days 1–5.

29. No auto-suggestions in the monthly task dialog (7.3): Task and breakdown Type are plain text fields.

30. Deadline colours (7.3): coloured card tags per deadline option (monthly cards) and matching deadline chips (meeting cards). Playwright: a Range task shows a Range tag in its colour; a Monthly task the Monthly colour.

31. New cycle setup (6.11): schema 7 (`cycle_reviews`, `cycle_setup_since`), REVIEW_CYCLE, POST `/projects/id/cycle-review` with feedback notices; New cycle setup box, Review last cycle dialog, band messages, overdue on project cards. **Tests:** PHPUnit (managers only, stored under last cycle, feedback needs a note and reaches only the responsible people, task from another project refused, install date), Vitest (counts, due day 3, overdue, done, exemptions, band for leaders only), Playwright (leader reviews with feedback and Looks good, assigns everything → Done; member refused and receives the feedback).

32. (Released as 0.1.10.) My page for the Super Admin and Team Leaders (7.5, 7.6): the team sections become tabs of My page; Admin settings with its own menu; Team button and team Dashboard removed. Playwright: Super Admin tabs and Admin settings menu, Team → a person → back to Team; Team Leader tabs and Recent Activity; review from Needs your approval.

33. (Released as 0.1.11.) View someone's My day, view only (7.0). Vitest (who may view whom), Playwright (Super Admin views a member and a leader, nothing to act with, Back and leaving end it; a leader can view a member but not the Super Admin).

34. (Released as 0.1.12.) Team cards open that person's My day (view only); the bar gets Open {name}'s page and ← Back. Playwright updated.

35. (Released as 0.1.12.) Admin settings on one page (no left menu) and Members & access redesign (design A). Playwright: the sections on one page; search, a role filter and the ⋯ menu.

36. (Released as 0.1.12.) Members & access moves from Admin settings to the Team tab, under the cards; the ⋯ menu follows the role rules. Playwright: Admin settings without it; a leader's menu has no Change role or Remove.

37. (Released as 0.1.13.) The Team tab keeps only Members & access: the period bar (Daily / Weekly / Monthly), the card search and hint, and the member cards (with the Add member tile) go; the ⋯ menu opens someone's My day or page. Playwright: no cards or period bar on the Team tab; My day and page opened from the ⋯ menu.

38. (Released as 0.1.13.) Leave tab redesign (7.5, design LV-A): the four numbers, Leave requests with status chips and person picker, Approve / Reject buttons, the over-allowance warning, Settlement with the Monthly / Year-end switch, month stepper and allowance bar. **Tests:** Vitest (the numbers, over-allowance per request, sorting), Playwright (leader approves from the list; chips filter; Super Admin sees Over the allowance and the settlement, a leader neither).

39. (Released as 0.1.14.) Issue a day off (6.10, design LV-C): ISSUE_LEAVE permission; POST `/leave` with `member_id` and `note` for someone else (approved day leave, counted); a Team Leader may cancel a day off they issued; **+ Issue day off** dialog, **Issued** tag, the person's message. **Tests:** PHPUnit (permission matrix, issue to a member and to another leader, not to the Super Admin, members refused, overlap and all-days-off checks, counted in the settlement, the issuer cancels), Vitest (who may get one, the message), Playwright (leader issues a day off; the member sees the message; the row says Issued).

40. (Released as 0.1.14.) Team tab: a person's photo and name in Members & access open their My day (or their page when it can't be viewed). Playwright: clicking the name opens the view-only My day.

41. (Released as 0.1.14.) Project Details and keyword checklist (6.12, designs PD-D and KP-C): schema 8 (`grp_projects.details`, `kw_columns`, `grp_keywords`, synced), EDIT_PROJECT_DETAILS / MANAGE_KEYWORDS / TICK_KEYWORD, the routes in section 8, export / import, trash; Plan and Details tabs. **Tests:** PHPUnit (permission matrix, details saved and synced, link kinds, only http(s), keywords added with repeats skipped, deadlines / rename / remove for managers only, everyone ticks with who and when, profile lock, per-project columns, export round trip, deleted forever with the project), Vitest (link kinds, groups by cycle, drop deadlines, late, progress, pasted lists), Playwright (leader writes About with a Sheet and a Drive link, adds keywords, moves one by the menu and one by drag, renames a column; member opens links, ticks and writes a note, manages nothing).

42. (Released as 0.1.15.) Unticking is for Team Leaders and the Super Admin (6.12): UNTICK_KEYWORD; a Team Member asks (`ask_untick`), the request shows on the box and in Needs your approval with Untick / Keep ticked. **Tests:** PHPUnit (member untick refused, ask stored with who and reason, only on a ticked box, re-tick keeps the first ticker, keep and untick for managers only, permission matrix), Vitest (requests reach leaders only), Playwright (member asks with a reason, the box keeps its tick; leader unticks from Needs your approval).

43. (Released as 0.1.15.) One set of statuses and Request undo (6.6, designs ST-A / ST-B): Meeting Minutes renamed to Not started · In progress · Completed; schema 9 (`undo_request` on meeting tasks and cycle records); REQUEST_UNDO / DECIDE_UNDO; the routes in section 8; the answer as a private notice; the last unit of a quantity task needs the completion note from Team Members. **Tests:** PHPUnit (permission rows, reason required, one request at a time, others and quantity tasks refused, leader undoes / keeps with the notice, a status move drops it, monthly records, last unit needs the note), Vitest (requests reach leaders only), Playwright (member asks with a reason, leader undoes from Needs your approval, member gets Undo approved; last unit asks What did you complete?).

44. (Released as 0.1.16.) Details tab layout (6.12, design PD-F): header card for the first section (initials, title, project · status · cycle, Edit), larger link chips with their type, other sections in two columns, full width. Playwright: the header card shows the project line without team names and the chips their type.

45. (Released as 0.1.17.) Details: Goals and Notes for the team always shown after the header card (placeholders until filled in), bullet lists from "-" lines. Playwright: both cards there, Notes saved as a list, members see "Nothing here yet." and no Edit.

46. (Released as 0.1.18.) Task card TC-A and assigned-first (6.6, 7.2): Team Members work only on tasks assigned to them (server and card); an undo request is a chip with Review for leaders (reason off the card) and rings every Team Leader's and the Super Admin's bell. **Tests:** PHPUnit (permission rows, unassigned refused with the message, leaders still work on it), Vitest (canWorkOn, bell for leaders only), Playwright (chip without reason, unassigned locked, leader reads the reason in Review and undoes from the card).

47. (Released as 0.1.18.) Submit completed work for everyone (6.6, designs SF-A / SF-B), released together with step 46: schema 10 (`grp_files`, `grp_comments`); the submission form with links, files and a comment, required from Team Leaders and the Super Admin too, who choose no review or a reviewer; Edit submission; comments with files and the bell; UPLOAD_FILE / DOWNLOAD_FILE / EDIT_SUBMISSION / COMMENT / DELETE_COMMENT. **Tests:** PHPUnit (permission rows; leaders need the note; reviewer chosen in the form; links limits; upload type, size and content checks, random private names; download for signed-in members only; edit by the submitter or leaders, not others; comments by the people on the task and the reviewer only; delete own; records), Vitest (file helpers, who may edit / comment, comment bell), Playwright (member submits with a link, a file and a comment, edits it and comments; leader replies and asks a reviewer in the form; the bell).

48. (Released as 0.1.19.) Fix: the bell's Notifications panel opens over the cards below instead of being cut off by the header card (the header no longer clips; the message band rounds its own corners). Playwright: the lower part of the open panel is the panel itself.

49. (Released as 0.1.19.) Notifications on My day (6.10, 7.0, design NF-A): the Notices box becomes **Notifications**, one feed of new tasks, reviews, comments, undo requests, leave answers, events, birthdays, notices and shout-outs, with filters, unread dots, Mark all read and 6 per page; Who's out and Day leave share the Today card; both columns end level. **Tests:** Vitest (what reaches whom and in which order, what is left out, counts, times), Playwright (seven new tasks show as unread, pages and filters, Mark all read, Open task, the Today card, columns end level).

50. (Released as 0.1.20.) Approvals inside Notifications (7.0, design NF-C): the Needs your approval box is gone; Team Leaders and the Super Admin answer under **Waiting for you** / **To approve** in Notifications, not repeated in the feed; Today card: Who's out + Day leave for Team Leaders, Who's out only for the Super Admin. **Tests:** Vitest (leaders get no review-asked or undo items in the feed), Playwright (a sick leave request waits for the Team Leader with Approve, the box is gone for both, the Today card per role; review, leave, untick and undo answered from To approve).

51. (Released as 0.1.21.) Notifications kept simple (NF-C without descriptions): requests are an icon, one sentence, when and the buttons; feed items are a self-contained title only. Vitest: the new titles. Playwright: no descriptions in the box, requests show who and what (not the reason), Open task still works.

52. (Released as 0.1.22.) Bell = Notifications box: the bell lists the message band, what waits for a leader ("{sentence}" · Waiting for you) and every item of the Notifications feed, one entry per key, with the same read state; it refreshes with the regular sync. **Tests:** Vitest (everything in the box is on the bell, read state shared, a leave request rings a leader's bell), Playwright (a new task shows on the bell's count and list; a sick-leave request on the leader's bell).

53. (Released as 0.1.22.) Details and Plan for everyone (3, 6.12): Team Members edit the Details, manage keywords, deadlines and columns, and untick boxes, like Team Leaders and the Super Admin (all locked while the profile is incomplete); the Plan groups become **This cycle · Next cycle · Past**, Past holding the keywords with every box ticked. **Tests:** PHPUnit (permission matrix, a member edits details, adds / renames / removes keywords, sets columns, unticks and keeps; profile lock), Vitest (groups: done → Past, no deadline / late → This cycle, after this cycle → Next cycle), Playwright (member edits Goals, adds a keyword, unticks directly; ticking every box moves a row to Past and unticking brings it back).

54. (Released as 0.1.23.) New cycle setup, stricter (6.11): a reminder every day in Notifications and on the bell for Team Leaders and the Super Admin until the setup is done (no dismiss, gone when done), unassigned monthly tasks reminded any day, a Super Admin summary; monthly tasks always have someone responsible; Review last cycle covers meeting minutes, with Carry over. **Tests:** PHPUnit (no people refused on add and edit, breakdown people count, standard tasks still editable, meeting tasks reviewed with feedback to their people, carry over: open meeting tasks only, today or later, sets the deadline), Vitest (meeting tasks of a cycle, a new reminder each day, amber / red, gone when done, unassigned any day, Super Admin summary, the bell keeps them new), Playwright (setup box steps, reminder in the box and on the bell stays new, carry over, Monthly tab line, the form refuses nobody, done → reminder gone).

55. (Released as 0.1.23.) Projects tab as a health table (7.0, design PJ-A4): one row per project, worst first, with cycle, monthly progress, the most urgent thing that needs attention (+N for the rest) and the team; the Needs attention box is gone. **Tests:** Vitest (what needs attention in which order, health, the team), Playwright (row with its dot and most urgent item, +N lists them all, menu still moves and deletes).

56. (Released as 0.1.24.) Fix: the New cycle setup reminders sit under the Notifications filter chips (All and To approve), above Waiting for you, not above the chips. Playwright: the reminder comes after the chips.

57. (Released as 0.1.24.) General tasks (6.13, designs GT-A, GT-B, GT-C): meeting tasks with no project; sidebar link with a count, the General tasks screen (tabs, chips, cards, Recent Activities), Where in the task dialog (add and move), My day group, notifications, reviews and undo. **Tests:** PHPUnit (permission row, only leaders add, the person on it works on it, moved to a project and back with the audit, restored from the trash without a project), Vitest (General vs project tasks, the board's order, My day group, new-task notice and review open the General board), Playwright (leader adds from the sidebar screen, member sees it on My day and in Notifications and starts it, Recent Activities, Edit → Where moves it to a project).

58. (Released as 0.1.25.) Fix: a finished week or two-week period on a monthly card keeps its full width with "✓" on the same line (its style no longer shares a class name with the 34px weekday buttons). Playwright: the finished bi-weekly box is the same size as the open one.

59. (Released as 0.1.25.) General tasks screen: the **Add general task** card comes last, after the tasks (as on Meeting Minutes). Playwright: the last box is the Add card.

60. (Released as 0.1.25.) Fix: from the General tasks screen, clicking a project in the sidebar opens that project's Meeting Minutes (it stayed on General tasks). Playwright: General tasks → Bright Dental opens Bright Dental.

61. (Released as 0.1.26.) Fix: in Notifications, the Latest items line up on the left with the cards above (their unread dot sits in the left padding instead of taking a column). Playwright: the feed's icons are where the cards' icons are.

62. (Released as 0.1.26.) Invoices (6.14, designs TR-A and TR-B): the Super Admin's record of invoices and payments — schema 11 (`grp_billing`, `grp_billing_fees`), a line per project per ended cycle, payment tags, fees with a 3-day payment reminder by default, sidebar **Invoices** with By project and Year view, payments, CSV, and daily reminders with the setup reminders. **Tests:** PHPUnit (every route Super Admin only, lines made once from the start day, fees fill in amounts, sent / Not billed / payments, tags, `/sync` sends nothing to others), Vitest (tags, totals, latest per project, year months, CSV, reminders on the box and bell), Playwright (Team Leader has no link; reminder → Invoices; fee, Invoice sent, part payment, Paid; Year view).

63. (Released as 0.1.27.) Tour someone's portal, view only (7.0, design VT-A): the whole portal as that person sees it under a tour bar, with **✕ Close tour** back to your My page → Team; the Super Admin tours anyone else, a Team Leader Team Members only, Team Members nobody; a Team Leader opens Team Members' pages only. **Tests:** PHPUnit (TOUR_MEMBER and VIEW_MEMBER_PAGE rows, `GET /members/{id}/tour` per role), Vitest (who tours and opens whom), Playwright (Super Admin tours Max through My day, a project, Monthly Tasks, General tasks and his page, nothing changes, Close goes back to Team; tours a Team Leader; a Team Leader tours a member but has nothing for the Super Admin; a Team Member gets 403).

64. (Released as 0.1.28.) Invoices: every active project is on the list from day one with its **current cycle** (tag **This cycle · ends {date}**, no reminder, nothing owed yet; bill early by ticking Invoice sent); By project shows the cycle that needs something first. **Tests:** PHPUnit (current-cycle rows, a project added today, This cycle vs To send vs billed early), Vitest (tag, which row By project shows, no reminder), Playwright (every project listed with This cycle; after paying, the row moves on to the running cycle).

65. Fix: My day missed some people's monthly tasks — tasks imported from the old portal with their people only on the breakdown rows never listed them as responsible, so the tasks weren't on their My day and stayed locked for them. The import now takes the people from the rows, and schema 12 repairs tasks already imported. **Tests:** PHPUnit (import of a breakdown-only task, the schema 12 repair fixes only those tasks and is safe to repeat, the person may then tick it).

**Definition of done:** all tests pass, an imported export shows the same projects/tasks/progress as the current portal, and a Team Member account can do everything in section 3 that is ✔ for members and nothing that is ✘ (verified by API tests, not just hidden buttons).
