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
| See the **Projects** tab of the Dashboard (7.0) | ✔ | ✔ | ✘ |
| Take / request day leave for self (6.10) | ✘ (no leave in the portal) | ✔ approved straight away | ✔ request (pending) |
| Approve / reject a Team Member's leave request | ✔ | ✔ | ✘ |
| Cancel leave | anyone's | own + any Team Member's | own pending requests only |
| See leave settlement and yearly reports | ✔ | ✘ | ✘ |
| Set days off and automatic messages | ✔ | ✘ | ✘ |
| Send / remove a notice (to everyone or chosen people) | ✔ (any) | ✔ (own) | ✘ |
| Send / remove a shout-out (to Team Members only) | ✔ (any) | ✔ (own) | ✘ |
| Ask someone to review own finished task (6.6) | ✔ | ✔ | ✘ |
| Approve / send back a review someone asked **you** for | ✔ | ✔ | ✔ (only that task) |
| Set own profile, incl. location and date of birth | ✔ | ✔ | ✔ |
| Work on tasks while the profile is incomplete (6.10) | ✔ (reminder only) | ✘ | ✘ |

Every REST endpoint calls `GRP_Permissions::can($user, $action, $object)`. Unit-test every row above.

**Profile lock** (*new*): while a Team Leader's or Team Member's required profile (6.10) is incomplete, every task action is refused (add / edit / delete a task, change status, tick progress, review, ask for or answer a review, log work, skip a period) with `grp_profile_incomplete` and the missing fields. Viewing, leave and editing their own profile still work.

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
| `grp_projects` | id, name UNIQUE, state ENUM(active,paused,inactive), cycle_day TINYINT 1–28, cycle_set TINYINT, cycle_changes JSON, cycle_log JSON, std_cycle VARCHAR (last cycle key the standard tasks were checked) |
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
- Super Admin / Team Leader completions are `review.state='accepted', auto=1` by default. Their **Mark as done** dialog offers **Done — no review needed** (default) or **Ask someone to review it**: pick anyone (Super Admin, a Team Leader or a Team Member) and add an optional note → `review {state:'pending', submittedBy, submittedAt, reviewer: memberId, note}`. Only that person (plus the Super Admin) can then **Approve** (= Accept) or **Send back** (= Revise, note required), even when they are a Team Member. *Not in the reference portal.*
- Reviewers see pending work in **Needs your approval** on My day (7.0) and in the task Details, with Accept / Revise / Reject:
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
  - The Super Admin can cancel anyone's leave; a Team Leader can cancel a Team Member's leave and their own.
  - Taking more than the month's day is allowed (the dialog warns "N days over, deducted from {Month}'s salary").
- **Monthly settlement** (computed from approved leave, never stored): per person per calendar month, taken = approved leave days in that month. 0 → **1 day paid** with that month's salary; 1 → even; more → **taken − 1 days deducted**. Nothing carries over; each month starts again at 1. The **year-end report** only counts, per person: day leave, sick leave, total, and the company days off in the year.
- **Who's out today**: everyone else whose day off is today (weekly, own, event, seasonal) or who has approved leave today, with "Day off" / "On leave" and when they are back (the next date that is neither). Never shows day vs sick leave or a reason. The box never lists everyone: up to 8 faces then "+N", and the counts "N on leave · N day off"; **See all N** opens a list pop-up: title with the count and a close ✕, a search field, the filter All / On leave / Day off (only when people are out for both reasons), one row per person (photo, name, "Back tomorrow" / "Back {day date}", Day off / On leave tag), 10 per page, and a footer with "N people" (or "1–10 of N" with ‹ › page buttons) and Close. The Notices and Needs-your-approval "View all" pop-ups use the same frame. When the whole team is off (an event or seasonal day off today, or nobody else is in) it shows one line: "Everyone is off today · {name} · back on {date}".
- **Birthdays**: everyone sets their date of birth in their own Settings (7.6); everyone sees the day and month, only managers and the person see the year. On the day, that person sees the birthday message and everyone else sees "Today is {name}'s birthday."
- **Automatic messages** (Super Admin edits the texts; `{name}` = full name): **birthday**, **signed in on a day off** (shown when today is the person's day off), **leave approved** (used when the approver types no message).
- **Notices** (*replaces the shout-out box and the announcement strips*): Super Admin and Team Leaders send a **Notice** to **everyone** (kind `announcement`) or to **chosen people** (kind `notice`), or a **Shout-out** to chosen Team Members (kind `shoutout`); optional title, message, **show for** 7 days / 30 days / until removed (`show_until`). A notice to chosen people is private: only they, its author and the Super Admin receive it (enforced in `/sync` and `/posts`). Shout-outs are seen by everyone for 30 days. Recipients get a bell item.
- **Required profile**: full name, **location** (city), **date of birth** (day, month, year), **phone number** and **photo**. Missing fields show a red strip on My day — "Finish your profile to keep working. Missing: …" with **Complete profile** — and, for Team Leaders and Team Members, lock task work (section 3, Profile lock): My projects shows "Your tasks are waiting … Complete profile". The Super Admin only gets the reminder.
- **Weather**: the date row shows today's weather for the person's city ("☀ 31° Sunny in Rangpur · 31° / 24°"). The server asks **Open-Meteo** (free, no account): the city name to its geocoding API (cached 30 days), the coordinates to its forecast API (cached 1 hour per city). Nothing about the person is sent. No city, or the service unreachable → just the date. `GRP_WEATHER` set to false turns it off.

## 7. Screens (match the reference file)

### 7.0 Dashboard (everyone)
*Not in the reference portal.* The landing page after sign-in, and what **GridRankers** in the sidebar opens. Design reference: the "Employee dashboard" boards H–U of the design canvas. No statistics (days worked, percentages) anywhere on it.

**Top bar** (everyone): "Good morning / afternoon / evening, {full name}" (before 12:00 / until 17:00 / after), today's date, the **bell** (6.9), user chip and Sign out. **Above them**, a coloured **message band** across the top edge of the header card, in the message's colour (amber day off, pink birthday, green approved / review asked, red rejected / profile), showing **one message at a time** with "1 of N ‹ ›" to step through the rest; each has its button (Dismiss / Thanks / Review now / Complete profile; dismissing is per person, 6.9). The messages, in order: the profile reminder (6.10, first), the day-off message (6.10), birthday ("Happy birthday, {name}!" for that person — button Thanks — and "Today is {name}'s birthday. Wish them a happy birthday!" for everyone else), leave approved / rejected with the approver's message, "{name} asked you to review '{task}'" with **Review now**. Announcements are in the Notices box. No messages → no band, just the greeting row. Under the greeting: the date and the weather (6.10).

**Tabs** (Super Admin, Team Leader only): **My day · Projects** (with the number of attention items), and on the right **Send notice**. Team Members have no tabs: they only have My day.

**My day** — two columns that start and end level (the stretching box fills the gap):
- **Left: My projects.** Every project in which this person has open work: meeting tasks assigned to them and not done, and recurring tasks of the current period where they are responsible and their share is not done (unassigned work is not listed: every project has unassigned standard tasks, and it would bury their own work). Most urgent first: red edge = something overdue or urgent; amber = something due within the next 3 days; then by the next deadline; projects with no deadline last. Each project box: name, "N tasks", one flag ("Overdue", "Urgent", "Due today", "Due in 3 days", "Due Oct 8", "Next due Oct 20"), up to 2 tasks (checkbox look, title · kind, due chip), "+N more tasks" (expands in place). Filter chips **All · Urgent · Overdue · Due this week** with counts. **5 projects per page** with "Showing 1–5 of 8 projects" and ‹ Previous · 1 · 2 · Next ›. Click a task → its Details; click the project name → its Meeting Minutes. Empty: green tick, **You're all caught up**, "No open tasks. New tasks assigned to you will show here, most urgent first."
- **Right column:**
  1. **Notices** (everyone, 6.10; stretches): newest first, the 3 latest as cards — the sender (for a shout-out also "→ {who it praises}"; a notice names only the sender, the tag says who it is for), a tag (To you · Everyone · Shout-out, gold with a star), optional title, message, when — and **View all N**. Empty: **No notices yet**.
  2. **Who's out today** (everyone, 6.10): faces + counts, **See all N**; "Everyone is in today." / "Everyone is off today".
  3. Team Leader / Super Admin: **Needs your approval** — the newest items as small cards, with **View all N**: leave requests from Team Members (type, dates, days, "within October's 1 day" or "2 days over, deducted" in red; **Approve** / **Reject**, optional message), finished work waiting for review (6.6: **Approve** / **Send back**), and reviews someone asked them for. Empty: tick, **Nothing waiting for you**, "Leave requests and finished tasks to check will show here."
  4. **Day leave** (Team Member, Team Leader; not the Super Admin): "**N** day left in {Month}" (1 − leave taken this month, never below 0), **My leave** link (member page), and **Request day leave** (Team Member) or **Take day leave** with "Your leave is approved straight away." (Team Leader). The dialog: Type (Day leave / Sick leave), From, To, Reason (optional); it shows the days counted (days off not counted) and, when over, "This request is N days over. Settled at the end of {Month}: N days deducted from {Month}'s salary." After approval the box shows "Approved: 19–21 Oct."

**Projects** (Super Admin, Team Leader):
- **Needs attention** across all active projects: one row per item — project, task, reason chip, person, **Open** — with chips **All · Overdue · Due soon · To review · Unassigned** and counts. Overdue = 6.3 / missed recurring periods; Due soon = due within 3 days; To review = pending review; Unassigned = open tasks with nobody responsible.
- **All projects** below it: project search and **+ New project** (name, cycle start day — optional, locks it as 6.1 — and status); status tabs **Active · Paused · Inactive · All** with counts (opens on Active); one card per project (click → Meeting Minutes): name; "Day N · X days left" (or "No cycle start day yet", plus the status when not active); this cycle's monthly progress (done / total, with a bar); open meeting tasks; one attention line ("2 urgent · 1 overdue · 1 to review" in red, or "On track" in green); "⋯" menu: Move to Active / Paused / Inactive, **Delete project** (Super Admin only; its tasks go to the trash with it). Deleted projects are in **Team → Settings → Deleted projects** (7.5).

**Send notice** dialog: Kind (**Notice** · **Shout-out ★**), To (**Everyone** · **Choose people**; shout-outs: chosen Team Members only), Title (optional), Message, Show for (7 days · 30 days · Until I remove it).

### 7.1 Layout
- Left sidebar (design A, no search): the **GR** mark with **GridRankers** / Team portal and a **My day** link (both → Dashboard, 7.0), then the projects for quick switching, each with a coloured initials badge, its name on one line (full name on hover) and its open-task count only when it has open work (red when something is urgent). **Active projects** are always open; **Paused** and **Inactive projects** are folded (with their count) until opened, and open by themselves while one of their projects is on screen. A project is highlighted only on its own screens. At the bottom: the live sync status with a green dot. No "Add a project", no drag & drop, no move or delete buttons: those live on the Dashboard.
- Top bar on a project's screens (the Dashboard has its own, 7.0): project title (+ "(paused)/(inactive)"), task search, tabs **Meeting Minutes · Monthly Tasks · Recent Activities**, user chip (avatar → Team area; admin/lead → Team dashboard, member → own page), Sign out.

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
Opened from the **Team** button on My day, next to Send notice (leaders and the Super Admin).
Tabs **Dashboard · Activity · Team · Leave · Settings**, Daily/Weekly/Monthly period selector.
- Dashboard: notifications (6.9), greeting with counts (done / assigned / unassigned), Workload (open tasks per person), completed-tasks chart (per day; per person in Daily view), team list.
- Activity: completed + logged work grouped by day, person filter, Copy report.
- Team: member cards (open, urgent, done this period, projects), search, + Add member.
- Leave (*new*): everyone's leave, newest first — person, type, dates, days, status, decided by, message — with filters (person, status, month) and Approve / Reject / Cancel per the rules in 6.10. Super Admin only: **Monthly settlement** (pick a month: per person taken, then "1 day paid" / "Even" / "N days deducted") and **Year-end report** (per person: Day leave · Sick leave · Company days off · Total), both with **Download CSV** and **Print**.
- Settings: Members & access table (role, contact, open tasks, sign-in status, **Set code**, Open, Remove), **Deleted projects** (Restore — brings back the tasks deleted with it — / Delete forever; kept 30 days), Export all data. Super Admin only (*new*): **Days off** (team weekly day off as weekday chips; a person's own weekly day off; list of event and seasonal days off with **+ Add day off** and remove) and **Automatic messages** (birthday, signed in on a day off, leave approved).

### 7.6 Member page (own page for members; any member for admin/lead)
**Your own page** (everyone; the name chip opens it): the top bar reads **My page** (no project name, search or project tabs; the Team area reads **Team**), "← My day", a profile header (photo, name, role, job title, city, phone, birthday day and month), then tabs **My leave · Calendar · Settings · Recent Activities**, opening on My leave (no My leave for the Super Admin, whose page opens on Calendar). No dashboard or task list here: they are on My day.
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
| GET/POST/PATCH/DELETE `/projects[/id]` | projects; PATCH `/projects/id/state`, POST `/projects/id/cycle` |
| GET/POST/PATCH/DELETE `/meeting-tasks[/id]` | tasks; POST `/meeting-tasks/id/status`, `/progress` `{memberId,delta}` |
| GET/POST/PATCH/DELETE `/monthly-tasks[/id]` | tasks |
| POST `/records/tick` `{taskId, periodKey, partId?, memberId?, delta}` · POST `/records/status` | recurring progress |
| POST `/review` `{kind: item|record, id, action: accept|revision|reject, note}` | review |
| POST `/review/request` `{kind, id, reviewer, note}` | ask someone to review own finished task (6.6) |
| GET/POST `/leave` · PATCH `/leave/id` `{action: approve|reject|cancel, message}` | day leave (6.10) |
| GET `/leave/report?month=YYYY-MM` · `?year=YYYY` (Super Admin) | monthly settlement / year-end counts |
| GET/POST/DELETE `/days-off[/id]` · PUT `/days-off/weekly` `{weekdays, member?}` (Super Admin) | days off |
| GET/POST/DELETE `/posts[/id]` `{kind: announcement|notice|shoutout, to?: [ids], title?, body, show_until?}` | notices, shout-outs |
| GET `/weather` | today's weather for the signed-in person's city (6.10) |
| PUT `/settings/messages` (Super Admin) | automatic messages |
| GET/POST/DELETE `/activity` | logged work |
| GET `/audit?project=&from=&to=` | Recent Activities |
| GET `/trash` · POST `/trash/id/restore` · DELETE `/trash/id` | trash |
| GET/POST/PATCH/DELETE `/members[/id]` · POST `/members/id/code` | team |
| POST `/notifications/dismiss` | dismissals |
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

**0.1.8 (one change at a time, released together):**

22. Who's out "See all" pop-up cleaned up (6.10) — padded frame, search with icon, filter only when needed, larger rows, footer; same frame for the Notices and approvals "View all". Playwright: See all lists everyone out and search narrows it.

23. Messages on top (7.0, design C): the message band across the top of the header card, one at a time with "1 of N ‹ ›". Playwright: one message shows at a time and the others are reached with ›.

24. Your own page (7.6): the name chip opens your page — profile header and My leave · Calendar · Settings · Recent Activities; Team button on My day for leaders and the Super Admin; no project highlighted off project screens; greetings and messages use the full name. Playwright: the chip opens your page with those tabs and no project is highlighted; a leader reaches the team area from Team.

25. Sidebar redesign (7.1, design A): GR mark, My day, project badges, counts only when there is work, Active always open, Paused / Inactive folded. Playwright: folded groups open on click and the project opens.

26. My projects gets **+ Log work** (7.0): custom work for yourself (the existing Add manual task dialog; Team Members only for themselves, section 3). Notice cards name only the sender; shout-outs still say who they praise. Playwright: a member logs work from My day; a private notice card shows the sender and the To you tag only.

27. Monthly tasks for active projects only (6.8): no standard tasks for new paused / inactive projects, `grp_daily` skips them, their monthly tasks reach nobody; moving to Active tops up at once. **Tests:** PHPUnit (new paused / inactive project, cron skip, top-up on Active, stop after pausing), Vitest (assigned and missed work skip non-active projects), Playwright (paused card shows "Start when active", 0/6 after Move to Active).

**Definition of done:** all tests pass, an imported export shows the same projects/tasks/progress as the current portal, and a Team Member account can do everything in section 3 that is ✔ for members and nothing that is ✘ (verified by API tests, not just hidden buttons).
