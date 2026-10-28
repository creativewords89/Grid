# GridRankers Agent Hub — Build Specification

The single source of truth for the **Agent Hub**: the website at **hub.gridrankers.com** from
which the team runs every cold-outreach agent. The system-wide plan, shared rules and agent
decisions are in [../PLAN.md](../PLAN.md); this file covers the Hub only.

The Hub shares no code, database or login with the GridRankers portal (`/SPEC.md`) or the
Answer Engine (`/answer-engine`). It reuses the Answer Engine's proven patterns (FastAPI,
SQLAlchemy, React, Caddy, encrypted write-only keys) by copying, not importing.

---

## 1. Goals

- One sign-in for the team; roles decide what each person can do (section 3).
- **Batches:** make a batch (a name, one niche, one benchmark), then add lead files (`.xlsx`)
  to it from the browser: clean, merge duplicates, give Lead IDs, preview, then save them in
  the Hub.
- **Leads:** every business in one place, like a spreadsheet: search, filter, sort, open one
  to see what the agents found, change a few fields, and download what is shown as Excel. No
  Google Sheet or Drive is used.
- **Tasks and bots:** the jobs a batch can have done (GBP Audit, Website Audit, Opportunity
  Finder, Outreach, …), each with what it needs first. Every agent (bot) does one task. A
  batch chooses its tasks and one or more bots for each; every business moves on to the next
  task as soon as the tasks it needs are done for it (section 6.7).
- **Agents** screen: switch each agent on or off, set its daily limit, run time, budget and its
  own settings, press **Run now** or **Stop**.
- **Connections** screen: enter API keys and accounts (DataForSEO, PageSpeed, SMTP,
  Telegram) with a **Test** button each. Keys are
  encrypted and never shown again.
- **Runs** and **Overview**: what ran, what failed, what it cost, today and this month.
- **Benchmarks:** named sets per niche ("Cleaning Benchmark 1") with the GBP numbers and the
  Website Standard, in a form; not tied to a city.
- **Alerts** by email and Telegram when something needs a person.
- Every permission is enforced on the server.

### Non-goals (first version)

- Running agent code inside the Hub. Agents are separate containers (section 6.2).
- Editing every field of a lead in the Hub: a new file updates the rest (section 6.4).
- Self sign-up. People join by invite only.

## 2. Architecture

| Part | Decision |
|---|---|
| Server | Our Ubuntu 24.04 server (US IP), Docker Compose |
| Web server | **Caddy**: HTTPS for `hub.gridrankers.com`, serves the React build, proxies `/api/*` |
| Backend | **Python 3.12 + FastAPI**, Pydantic v2, SQLAlchemy 2 + Alembic |
| Scheduler | Same codebase, separate container (`scheduler`): decides when runs are due, marks stale runs, sends alerts and the daily summary |
| Database | **PostgreSQL 16**, the master copy of everything the Hub owns |
| Front end | **React + Vite + TypeScript**, bundled, no external CDNs |
| Leads and reports | In the database (each lead's row and the agents' results) and, for files agents save, on disk (`REPORTS_DIR`); both backed up nightly. No Google Sheet or Drive. |
| Alerts | SMTP email and a Telegram bot (its own bot and group) |
| Secrets | `SECRET_KEY`, `APP_URL` and the database password in `.env`; every other key entered in the website (section 6.1) |

### Repository layout

```
cold-outreach/
  PLAN.md, CLAUDE.md, README.md
  hub/
    SPEC.md                this file
    docker-compose.yml     caddy, api, scheduler, db, backup
    docker-compose.shared.yml  on the same server as the Answer Engine
    ops/                   deploy.md, backup and restore scripts
    e2e/                   Playwright tests
    .env.example
    caddy/                 Caddyfile + Dockerfile (builds the React app, serves it)
    backend/
      app/
        main.py, config.py, scheduler.py
        api/               one router per area
        db/                models, session, alembic/
        auth/              passwords, sessions, invites, lockout
        permissions.py     ALL rules of section 3, one function: can(user, action)
        connections.py     encrypted keys, Test buttons
        agents/            registry, manifests, agent API, tokens
        runs/              scheduling, budgets, stale runs
        imports/           xlsx reading, header synonyms, cleaning, merging
        leads/             files agents save for leads (reports)
        benchmarks/        the benchmark's shape (GBP numbers, Website Standard)
        alerts/            email, Telegram, daily summary
        audit.py
      tests/
    frontend/src/
  agents/                  each agent, from PLAN.md build order step 2
```

## 3. Roles and permissions

| Action | Owner | Admin | Viewer |
|---|---|---|---|
| See Overview, Runs, Agents, Batches, Benchmarks, Leads; download leads as Excel | ✔ | ✔ | ✔ |
| Make, rename or delete a batch; add and confirm its files | ✔ | ✔ | ✘ |
| Choose a batch's tasks and bots, start or pause it, change the batches' running order | ✔ | ✔ | ✘ |
| Make, change or delete a task | ✔ | ✔ | ✘ |
| Change a lead's email, phone, website, Top mark or notes; delete a lead | ✔ | ✔ | ✘ |
| Switch an agent on/off, press Run now or Stop | ✔ | ✔ | ✘ |
| Change an agent's batches, limit, run time, budget and settings | ✔ | ✔ | ✘ |
| Make, change or delete a benchmark | ✔ | ✔ | ✘ |
| See or change Connections (keys, accounts) | ✔ | ✘ | ✘ |
| Change the total daily budget | ✔ | ✘ | ✘ |
| Add an agent, show or replace an agent's token | ✔ | ✘ | ✘ |
| Manage users (invite, deactivate, change role) | ✔ | ✘ | ✘ |
| See the History (audit log) | ✔ | ✘ | ✘ |
| Own profile, password, alert channels | ✔ | ✔ | ✔ |

- There can be more than one Owner; the last active Owner can't be removed or demoted.
- Every endpoint calls `permissions.can(user, action)`. **pytest covers every row**, for each
  role allowed and refused.
- Agents are not users: they authenticate with their own token and can only reach the agent
  API (section 6.2).

## 4. Authentication

As in the Answer Engine (its SPEC sections 4 and 13.6):

- Email and password (Argon2id; at least 10 characters, not a common password, not the
  email). Sessions: a random token, stored hashed, in an `HttpOnly`, `Secure`, `SameSite=Lax`
  cookie; 14 days, extended at most once a day while in use. CSRF token on every write.
- Lockout: 5 failed sign-ins in a row for an email + IP lock that pair for 15 minutes; at most
  10 sign-in attempts a minute per IP. Unknown email and wrong password get the same answer.
- Invites by email (link valid 7 days, works once); while email isn't set up, the Owner sees
  the link to pass on.
- Forgot/reset password by email (link valid 1 hour, works once, signs out every device).
- Deactivating someone signs them out at once; the last active Owner can't be removed or
  demoted. Changing your own password signs out your other devices.
- **First run:** while no account exists the site shows **Create the Owner account**, which
  needs the setup code (12 characters, HMAC of `SECRET_KEY`, printed by
  `python -m app.cli setup-code` and in the API log at start-up). Once any account exists the
  page is gone.

## 5. Data model (PostgreSQL)

| Table | Holds |
|---|---|
| `users`, `sessions`, `auth_tokens`, `login_attempts` | as in the Answer Engine; `role` is `owner`, `admin` or `viewer`; `alert_email` |
| `settings` | key → JSON; `connections` values encrypted (section 6.1); `budget.daily_total_usd`; alert thresholds |
| `agents` | `key` (e.g. `gbp-audit`), `name`, `enabled`, `token_hash`, `manifest` JSON, `config` JSON (the values set in the Hub), `task_id` (the task its manifest names), `daily_limit`, `run_time`, `time_zone`, `daily_budget_usd`, `last_seen_at` |
| `runs` | `agent_id`, `trigger` (`schedule`/`manual`), `status` (`queued`, `running`, `succeeded`, `failed`, `stopped`, `timed_out`), `queued_at`, `started_at`, `finished_at`, `heartbeat_at`, counts `done`/`failed`/`skipped`, `cost_usd`, `stop_reason`, `summary` JSON, `requested_by` |
| `benchmarks` | `name` (unique, e.g. "Cleaning Benchmark 1"), `niche`, `gbp` JSON (the numbers of PLAN.md 3.5; a missing one isn't compared), `website` JSON (the Website Standard), `version` (raised by every change of either), `updated_by` |
| `batches` | `name` (unique, typed by the team), `niche`, `benchmark_id` (required; empty only for leads moved in from before batches), `status` (`not_started`, `running`, `paused`), `position` (the running order), `created_by` |
| `tasks` | `key` (e.g. `gbp-audit`), `name`, `about`, `needs` (the keys of the tasks it waits for) |
| `batch_tasks` | a task in a batch: `batch_id`, `task_id`, `share` (`all` or `split`) |
| `batch_task_bots` | the bots doing it: `batch_task_id`, `agent_id`, `position` |
| `lead_bot_shares` | for a `split` task, which bot each business went to: `lead_id`, `batch_task_id`, `agent_id` |
| `imports` | `batch_id`, `file_name`, `niche`, `uploaded_by`, `status` (`preview`, `confirmed`, `failed`, `discarded`), counts, `preview` JSON, `errors` JSON |
| `leads` | every business: `lead_id` (`L-000123`), `batch_id` (the batch it was first imported into), `niche`, `city`, `business_name`, `level`, `gbp_link`, `emails`, the matching keys `phone_digits`, `name_address`, `website_domain`, `data` JSON (address, website, phone, WhatsApp, Facebook, Instagram, reviews, rating, notes), `results` JSON (by agent key: status, score, summary, details, benchmark id and version, when), `first_import_id`, `last_import_id` |
| `lead_files` | files agents saved for a lead (reports): `lead_id`, `agent_key`, `name`, `content_type`, `size`; the bytes are on disk at `REPORTS_DIR/<lead_id>/<id>` |
| `lists` | one per City + Niche: `active`, optional `daily_limit` |
| `do_not_contact` | `kind` (`email`, `phone`, `gbp`, `domain`), `value`, `reason` (`top`, `opt_out`, `manual`), `lead_id` |
| `alerts` | what was sent, to whom, on which channel, when |
| `audit_log` | who did what (sign-ins, settings changes, connection changed/removed, imports, runs started/stopped). Never secret values. |

## 6. Domain logic

### 6.1 Connections

- **Owner only.** Everything is entered here; nothing is read from `.env`. Each group has a
  **Test** button whose last result (ok or not, message, when) is kept and shown:

  | Connection | Fields | Test |
  |---|---|---|
  | DataForSEO | API login, API password | account call; shows the balance |
  | PageSpeed Insights | API key | scores example.com on mobile |
  | Email (SMTP) | server, port, username and password (optional), From | sends a test message to the Owner |
  | Telegram alerts | bot token, alerts group (optional) | checks the bot; when no group is set, finds the latest group the bot has seen and saves it; sends a test message there |

- Values are checked before saving (port number, email address, a numeric group id) and
  refused with a reason under the field.
- Stored in `settings.connections`, each value encrypted with Fernet using a key derived from
  `SECRET_KEY`. **Write-only:** secrets are never returned, only whether
  they are set and their last four characters. History records "changed" or "removed".
  Test results and errors never repeat a key, password or token.
- If `SECRET_KEY` changes, stored values can't be read and show as "enter it again".
- There is no Google connection: leads and reports are kept in the Hub (step 11 removed the
  Sheets and Drive connection and its saved values).
- Once Email is set up, invites and password resets are sent by email instead of being shown
  to the Owner.

### 6.2 Agents

- **Adding an agent** (Owner): give its key (2–40 lower-case letters, digits and dashes, e.g.
  `gbp-audit`) and name; the Hub shows its **token once** (`hub_agent_…`, only a hash is
  stored). The token goes into the agent container's settings as `AGENT_TOKEN`, with
  `HUB_URL`. **New token** replaces it and stops the old one at once. A new agent starts
  **off**, with a daily limit of 100, run time 02:00 Asia/Dhaka and a $5 daily budget.
- The agents screen shows each agent as **connected** when it called the Hub in the last two
  minutes, and lists any connections its manifest needs that aren't set up yet.
- **Manifest:** when it starts, an agent sends `PUT /api/agent/v1/manifest`:
  `name`, `version`, `description`, `settings` (each with `key`, `type` of `int`, `float`,
  `text`, `bool` or `choice`, `label`, `help`, `default`, `min`/`max`, `choices`),
  `connections` it needs (Connections group ids), `task` (the key of the task it does,
  section 6.7), `result_label` (what the Leads screen calls
  its results, e.g. "GBP"; its name when empty), and an estimated
  `cost_per_item_usd`. A manifest with unknown fields or connections, or a default outside its
  own limits, is refused. The Hub builds the agent's settings form from it; values set in the
  Hub are checked against it (type, limits, choices) and an unset value uses the default.
  Values for settings a newer manifest dropped are kept but not used.
- **Agent API** (token in `Authorization: Bearer`), all under `/api/agent/v1`:
  - `GET /next-run`: when a run is queued and the agent is on, the Hub marks it `running` and
    returns the run id, the trigger, the agent's settings, its daily limit and **only the
    connections its manifest declared** (from step 5, also the budget left), and its
    **batches**: the running batches that chose it for their task, in the batches' running
    order (`id`, `name`, `niche`, `benchmark_id`, `benchmark_version`, `share`; batches
    without a benchmark left out). Otherwise `204`; `409` until the manifest was
    sent. Agents poll every 30 s.
  - `POST /runs/{id}/progress`: counts and cost so far; the reply says `continue` or `stop`
    (agent switched off; from step 5 also Stop pressed and budgets used up). This is also the
    heartbeat.
  - `POST /runs/{id}/finish`: final counts, cost, `stop_reason`, failures summary.
  - Leads: `GET /batches/{id}/leads` (only the leads that are **ready for this agent**,
    section 6.7: each lead's full row, the results of the tasks it waited for, and this
    agent's own last `result`, or none; `404` for a batch that doesn't use the agent),
    `PUT /leads/{lead_id}/result` (`outcome` `done`, `skipped` or `failed` (default `done`),
    `status` (the agent's own word, e.g. "OK"), `score` 0–100, `summary`,
    `details` JSON up to 200,000 characters, `benchmark_id`, `benchmark_version`; replaces
    the agent's previous result) and `POST /leads/{lead_id}/files` (a report: PDF, JSON, PNG,
    JPEG or CSV up to 20 MB, named with letters, digits, dots, dashes and underscores; the
    same name from the same agent replaces it).
  - Reference data: `GET /batches` (as in `next-run`), `GET /benchmarks/{id}` (the
    GBP numbers, the Website Standard and the `version`), `GET /lists` (City + Niche, on or
    off, limit) and `GET /do-not-contact/check?email=&phone=&gbp=&domain=` (`blocked` and
    why).
- **Batches and benchmark changes:** an agent works through its batches in order, the first
  until nothing is ready for it, then the next; with nothing left it finishes the run at once
  and waits (for new files, or for the tasks before it). It notes each lead's benchmark id and version with its result;
  when the batch's benchmark or its version has changed, it checks the lead again against
  the new one (from the data it already saved where it can, so no new provider cost).
- An agent can only see and change its own runs (another agent's run id is a `404`). Secrets
  are never logged on either side.
- **Run now** (Owners and Admins) queues a manual run. It is refused while the agent is off,
  before it has ever connected, or while it already has a run waiting or in progress. A
  database rule keeps it to one queued or running run per agent even if two clicks race.
- `agents/demo/agent.py` is a demo agent (Python standard library only) that pretends to audit
  the leads of its batches (Top leads skipped), for trying batches, switches, settings and Run
  now.

### 6.3 Scheduling, runs and budgets

- The **scheduler** checks every 30 seconds. An agent's scheduled run is **due** on a local
  day (in the agent's time zone) once its run time has passed, for **6 hours**, if it is on,
  has connected, and hasn't had a scheduled run in that window. So switching an agent on in
  the afternoon waits for the next run time, and if the Hub was down for the whole window that
  day is skipped. If a manual run is going at the run time, the scheduled one waits for it
  (within the window). Daylight saving: a run time in the spring gap (02:30 when clocks jump to
  03:00) runs an hour later; in the repeated autumn hour it runs once, the first time.
- **Run now** queues a manual run (section 6.2). Only one run per agent at a time.
- **Stop** (Owners and Admins) cancels a run that hasn't started, or tells a running agent to
  stop at its next progress report ("Stopped by … in the Hub").
- A running run with no progress report for **10 minutes**, or a queued run no agent picked up
  in **6 hours**, becomes `timed_out` with the reason.
- **Budgets:** each agent has a daily budget (whole cents) for its own local day; the Owner
  sets a **total daily budget** for all agents (default $20) and the Hub's time zone, which
  decides when "today" starts for it and the Overview. Spending is the cost agents report on
  their runs, counted by the day a run was queued. `next-run` gives the agent what is left
  today (money under both budgets, items under its daily limit) and ends a run before it
  starts when nothing can be spent. Progress replies `stop` when the next item (the
  manifest's `cost_per_item_usd`) would go over either budget.
- **Agents must report progress after every item:** the Hub can only stop an agent (Stop,
  switched off, budget) when it reports.
- **Runs** screen: every run, newest first, 50 at a time, filtered by agent and status.
  **Overview:** today's and this month's spending against the total budget, and each agent's
  on/off, connection, last run, next run and spending today.

### 6.4 Batches and import

0. **Batches** (Owners and Admins make them): a **name** typed by the team (unique, case
   ignored), **one niche** (typed or picked; a different case uses the existing spelling) and
   **one benchmark of that niche** (required). The order of work is: make a benchmark, make a
   batch with it, add files. Files can be added to a batch at any time, also to old batches.
   A batch can change to another benchmark of its niche, or be renamed, at any time; it can
   be deleted only while it has no leads and no files. A batch chooses its tasks and bots and
   is started or paused (section 6.7).
1. **Upload** (Owner, Admin): an `.xlsx` (max 20 MB) **into a batch**; its niche is the
   batch's. Reading a large file (4,000 rows, 248 tabs) takes about 15 seconds.
2. **Reading each tab:** the header row is the first of the first five rows with two known
   headers. Header synonyms (case, spaces and punctuation ignored): GBP Link ← `MAP`, `Map URL`,
   `MAP URl`, `Maps`, `GBP`; WhatsApp ← `WA`, `WP`, `Whatsapp`; Email ← `E-mail`, `Gmail`,
   `Mail`; Reviews ← `Number of Reviews`, `Review`, `Reviews Count`; Rating ← `Average`,
   `Ratings`, `Average Ratings`; Notes ← `Comment`, `Issue 1–3` (joined). Unknown columns are
   listed in the preview and ignored. No City (column or cell) → the tab name. A row with only a
   city filled in is not a business and is ignored; a row with neither a name nor a GBP link is
   skipped and listed; a tab with no businesses is listed as empty.
3. **Cleaning:** spaces and line breaks squeezed; phone compared by its last 10 digits; website
   loses its `utm_*` parameters only; emails lower-cased, split on commas, spaces, semicolons or
   slashes, `%20` decoded; anything that isn't an email is listed and left out.
4. **Same business** (within the file and against the registry): the **same GBP link**; or,
   when the two don't have **different** GBP links, the same phone, or the same name + address
   (name + city when a row has no GBP link, phone or address). So a brand with one phone number
   and a profile in each city stays one lead per profile. Merged rows pool their emails; an
   empty field is filled from the other row; when both have a value the first row's is kept;
   Top wins. **A business is in one batch only**, the one it was first imported into: found in
   a file added to another batch, it is listed as "already in another batch", stays where it
   is, and its new details (an email, a phone) are still added.
5. **Level:** `Top` (any case) from the optional `Level` column. A file without a Level column
   never changes anyone's Level. Top leads put their email(s), phone and GBP link on the
   do-not-contact list (reason `top`); losing Top removes those entries.
6. **Preview** (nothing written but the import): businesses, new, already known in this
   batch (updated), already in another batch,
   duplicates merged, Top, cities, without a GBP link, without a website, rows skipped, emails
   that look wrong, with up to 25 examples of each, plus new lists, ignored columns and empty
   tabs. A waiting preview reopens when the screen is opened again.
7. **Confirm** saves everything in one transaction: Lead IDs continue from the highest one
   saved (`L-000001` …), one import at a time; each lead's row is kept with it (a value from
   the file replaces the saved one; an empty cell never blanks it); the lists and the
   do-not-contact list are updated. Once confirmed, the import keeps only its counts (new and
   updated).
8. **Lists** (one per City + Niche) are created by confirmed imports and shown on the Batches
   screen with their businesses and Top counts; Owners and Admins switch a list on or off.
9. **The Leads screen** (everyone): 100 leads a page; filter by batch, a search (name, Lead
   ID, city, email, phone, website, GBP link), city, Top and website; sort by Lead ID, newest,
   name, city or an agent's score (best first). Each agent's score and status is a column.
   **Download Excel** gives the leads on screen (same filters, up to 50,000), every column
   including each agent's status, score, summary and when; every text cell is stored as text,
   so a value starting with `=` never runs as a formula.
10. **One lead** shows its row, each agent's result and the files agents saved (always
   downloaded, never shown in the page). Owners and Admins change its email(s), phone, website,
   Top mark and notes (in History, with the old and new value; Top keeps its email, phone and
   GBP link on the do-not-contact list, removing Top takes them off), or delete it (its files
   go too; its do-not-contact entries stay, so a Top business imported again is still never
   contacted).

### 6.5 Benchmarks

- A **benchmark** is a named set such as "Cleaning Benchmark 1" (unique name, case ignored),
  of one niche, made, changed and deleted by Owners and Admins in a form (no file upload). A
  niche can have several. It **doesn't depend on city or competition**.
- **GBP part:** additional categories, services, photos, posts in 90 days, description length
  (characters), reviews, rating (0–5), review replies (%). An empty box means "don't compare
  this". (Reviews are shown in reports, not scored: PLAN.md section 5.)
- **Website part (the Website Standard):** services (name, other names, must-have or not; at
  least one must-have); service pages (words, sections, FAQ, price, own photos, reviews, call
  to action, service area); location pages (words, city in title, local content, local
  photos, all services linked, local reviews, map, city FAQ, call to action, most text shared
  with another location page); supporting pages; blog posts a month and topics; mobile LCP
  target.
- **Copy** starts a new benchmark from an existing one. Every change of the numbers or the
  standard raises the **version** (renaming doesn't); the agents then check the leads of
  every batch that uses it again (section 6.2). A benchmark used by a batch can't be deleted.
  The editor says which batches use it.
- Moving in from before batches (migration `0009`): each niche's City + Niche benchmarks were
  averaged and joined with its latest locked (else draft) Website Standard as
  "<Niche> Benchmark 1"; leads and files went into "Batch 1 · <Niche>", with that benchmark
  when there was one (a batch without one is skipped by agents until one is chosen).

### 6.6 Alerts

| Event | Who | Channel |
|---|---|---|
| A run failed, or the agent stopped answering (timed out) | Owners and Admins | email + Telegram group |
| A run stopped because a budget was used up | Owners and Admins | email + Telegram group |
| More than 20% of a run's items failed (at least 5 items) | Owners and Admins | email + Telegram group |
| The DataForSEO balance is under the threshold (default $10; checked once a day) | Owners | email + Telegram group |
| A connection's Test that used to pass now fails | Owners | email + Telegram group |
| The nightly backup failed, or none was made for 36 hours (checked once a day) | Owners | email + Telegram group |
| Daily summary at the summary time (default 08:00, the Hub's time zone): yesterday's runs, items and spending per agent | – | Telegram group only |

- Alerts are saved where the event happens and **sent by the scheduler** (every 30 seconds), so
  an agent's report never waits on email. The same alert (same event and agent or connection)
  isn't repeated within **6 hours**.
- Email goes to every active Owner (and Admin, for the first three rows) who hasn't switched
  off **Email me alerts** on their Profile. Telegram goes to the alerts group found by the
  Telegram connection's Test.
- Owners set on the Overview: alerts to the Telegram group on or off, the daily summary on or
  off and its time, and the DataForSEO balance threshold.
- The Overview lists the last 20 alerts and whether each was emailed and sent to Telegram.

### 6.7 Tasks, bots and the batch pipeline

- A **task** is a job a batch can have done: a key (2–40 lower-case letters, digits and
  dashes), a name, a line saying what it does, and the tasks it **needs first** (none means
  it only needs the lead file). Owners and Admins make, change and delete tasks on the
  **Tasks** screen. A task can't need itself or make a circle (A needs B needs A), and can't
  be deleted while a bot does it or a batch uses it.
- Every agent (**bot**) does **one task**, named by its manifest (`task`). When the Hub has no
  task with that key yet, it makes one (named from the key, needing nothing) that Owners and
  Admins can then fill in. A manifest naming another task moves the bot to it; batches that
  had chosen it for the old task lose it there.
- **A batch's pipeline:** Owners and Admins add tasks to a batch and **one or more bots** to
  each task (bots of that task only). A task can be added only when the tasks it needs are
  in the batch, and removed only when no other task in the batch needs it. Tasks are shown
  in **steps** worked out from what they need (step 1: tasks needing only the lead file;
  next: tasks needing those …); tasks in one step run side by side.
- **How the bots of one task share the work** (chosen per task in the batch):
  - **Every bot checks every business** (`all`): each bot does every lead, e.g. two GBP
    audits whose results are compared. The task is done for a lead when every one of its
    bots finished it.
  - **Split the businesses** (`split`): each lead goes to one bot, in turn, the first time a
    bot asks for it (kept in `lead_bot_shares`), e.g. two outreach emails tried on half the
    leads each. A lead goes to another bot when its bot is removed from the task before
    finishing it. The task is done for a lead when its bot finished it.
- **Per business:** a lead is **ready** for a bot when the bot hasn't finished it, each task
  it needs is done for that lead, and (for `split`) the lead is the bot's. **Finished** means
  the bot's result has outcome `done` or `skipped` and was made against the batch's current
  benchmark version; a `failed` result is tried again on the next run. Top leads are never
  handed to a bot. So the Opportunity Finder starts on the first business both audits
  finished while the audits go on with the rest.
- **Start and Pause:** a new batch is **not started**. Owners and Admins **Start** it once it
  has a benchmark and at least one task with a bot; a running batch can be **Paused**, which
  bots then skip (a lead being worked on is finished). Tasks and bots can be changed at any
  time, also while running.
- **Running order:** on the Batches screen Owners and Admins move batches up or down; when
  two running batches use the same bot it works on the higher one first.
- **Progress** of each bot in a batch: leads finished, failed, ready, still waiting for the
  tasks before it, and the average score; a bot that is off or has never connected is
  marked so.
- **Results:** the batch's **Results** tab shows one bot at a time: counts by outcome and
  score band (under 40, 40–69, 70 and over), then its leads with status, score, summary and
  when, filtered by outcome and score band, 100 a page; a lead opens the lead window
  (section 6.4 item 10) with every bot's result and files. **All results** opens the Leads
  screen for the batch, which has a column per bot and the Excel download.
- Moving in (migration `0011`): each agent gets the task named after its key (made as above)
  and every batch it worked on gets that task with it (`all`); those batches start
  **running**, the rest **not started**; the running order follows the agents' old order,
  then the oldest batch first. Agents' own batch lists are removed.

## 7. Screens

1. **Sign in**, **Create the Owner account**, **Accept invite**, **Reset password**.
2. **Overview:** today's and this month's cost against budgets; each agent's last run,
   status and next run; recent alerts and the alert settings; leads by list and how many each
   agent has done.
3. **Benchmarks** (in the menu before Batches): the benchmarks with niche, version, the
   batches that use them and when they changed; **+ New benchmark**, Edit, Copy, Delete (when
   unused); the editor has the GBP numbers and the Website Standard.
4. **Batches:** the batches with niche, benchmark, businesses (and Top), files and agents;
   **+ New batch** (name, niche, a benchmark of that niche; a link to Benchmarks when the
   niche has none), each with its status, bots and progress, and up and down buttons for the
   running order. A batch opens to **Start**/**Pause**, its benchmark choice, rename, delete
   (when empty), **See its leads**, **Add a lead file**, the preview and its past files, and
   two tabs: **Tasks** (the bot library grouped by task on the left, which can be dragged or
   added; the steps with each task's bots, their progress, ✕ to remove, **+ Add another
   bot**, how the bots share the work, and **+ Add a task**) and **Results** (section 6.7).
   The Lists (City + Niche) with their on/off switches follow the batches. `/import` opens
   Batches.
5. **Tasks** (after Batches): every task with what it needs first, the bots that do it and
   the batches that use it; **+ New task**, Edit, Delete (when unused).
6. **Leads** (after Tasks): the table, filters, pages and **Download Excel** of section 6.4;
   a lead opens in a window with its row, the agents' results and files, and (Owners and
   Admins) its editable fields and Delete. `/leads?batch=<id>` opens one batch's leads.
7. **Agents:** one card per agent: on/off switch, its task and the running batches using it
   (or a warning when none), last run, next run, today's cost, Run now, Stop; **Settings**
   opens the form: limits and the manifest's settings.
8. **Runs:** filter by agent and status; each run's counts, cost, stop reason and failures.
9. **Connections** (Owner), **Users** (Owner), **History** (Owner: who did what, newest
   first, filtered by area; a connection change only says "(changed)"), **Profile**.

## 8. REST API (`/api`, JSON)

`/health`, `/setup`, `/auth/*`, `/me`, `/users`, `/connections` (+ `/{group}/test`),
`/agents` (+ `/{key}/enabled`, `/{key}/run`, `/{key}/stop`, `/{key}/token`), `/runs`,
`/overview`, `/budget`, `/benchmarks` (+ `/{id}`), `/batches` (+ `/{id}`, `/order`,
`/{id}/start`, `/{id}/pause`, `/{id}/tasks` (+ `/{task_id}`, `/{task_id}/bots`,
`/{task_id}/bots/{key}`), `/{id}/progress`, `/{id}/results`), `/tasks` (+ `/{id}`), `/imports`
(upload into a batch → preview, `?batch_id=`, `/{id}/confirm`, `/{id}/discard`), `/niches`,
`/leads` (+ `/export`, `/{lead_id}`, `/{lead_id}/files/{id}`), `/lists`, `/alerts`,
`/alert-settings`, `/history`, and the agent API (section 6.2). Every user endpoint checks
`permissions.can`; every write checks CSRF.

## 9. Non-functional

- Parameterised SQL only (SQLAlchemy); all output escaped; no external CDNs.
- Security headers from Caddy and the API, as in the Answer Engine.
- Uploaded files are read in memory and not kept after the import is confirmed or discarded.
- Logs are JSON lines in production (`JSON_LOGS=true`), each carrying a request id that is
  also returned in `X-Request-ID`. The access log never writes query strings, and no log
  holds keys, tokens, passwords or lead data.
- Outside services are called at fixed addresses (`config.py`).
- Files agents save for leads are stored under ids the Hub makes (never the agent's file
  name), only as PDF, JSON, PNG, JPEG or CSV, and always downloaded, never shown in the page.
- Nightly backup of the database and the reports, kept 14 days, optionally copied off the server; the scheduler
  alerts the Owners when it failed or is more than 36 hours old (section 10).

## 10. Deployment

- `hub.gridrankers.com` points to the server; Caddy gets the certificate.
- `.env` holds `APP_DOMAIN`, `APP_URL`, `SECRET_KEY`, the database password and the backup
  settings only; everything else is entered in the website.
- Services: `caddy`, `api`, `scheduler`, `db` and `backup` (`ops/backup.sh` nightly at
  `BACKUP_TIME`: a `pg_dump` checked with `pg_restore --list` and an archive of the `reports`
  volume (`REPORTS_DIR`); `last-backup.json` read by the scheduler). `ops/restore.sh`
  restores both; `ops/restore-test.sh` restores the latest backup into a scratch database
  and compares every table's row count and the number of report files (CI runs it too).
- Agents join the Hub's Docker network (`agent-hub`) and reach it at `http://api:8000`.
- **Next to the Answer Engine** (our VPS, KVM 1, US location): `docker-compose.shared.yml`
  (switched on with `COMPOSE_FILE` in `.env`) takes away the Hub Caddy's ports; it joins the
  Answer Engine's network as `agent-hub-web` and serves plain HTTP. The Answer Engine's
  Caddy, which owns ports 80 and 443, serves `hub.gridrankers.com` from
  `answer-engine/caddy/sites/hub.caddy` and is the only proxy the Hub trusts for the
  visitor's IP address (`TRUSTED_PROXIES`). Upgrade to KVM 2 when the Website agent arrives.
- Step-by-step: [ops/deploy.md](ops/deploy.md); restoring: [ops/restore.md](ops/restore.md).

## 11. Open decisions (defaults used until answered)

See [../PLAN.md](../PLAN.md) section 9. Hub-specific:

1. **Lists** (City + Niche on/off and per-list limit) live in the Hub.
2. **No Google Sheet or Drive** (step 11): leads, results and reports are kept in the Hub;
   people download Excel files from the Leads screen.

## 12. Build plan (one step per task)

1. **Skeleton:** layout, Docker Compose (caddy, api, scheduler, db), FastAPI `/api/health`,
   Alembic baseline, scheduler process, React shell, CI. **Tests:** health, migrations up/down,
   docs hidden in production, React health status.
2. **Users and sign-in:** users, sessions, invites, login, lockout, CSRF, first-run Owner with
   setup code, `permissions.py` with every row of section 3, sign-in screens, Users screen.
   **Tests:** every permission row, lockout, token expiry, last-Owner rule.
3. **Connections:** encrypted write-only keys, the Google key file upload, every Test button
   (providers faked in tests), Connections screen. **Tests:** values never returned or logged,
   Owner only, changed `SECRET_KEY`, each Test.
4. **Agents:** registry, tokens, manifest, settings form from the manifest, on/off, **Run now**
   and the run record, agent API (`next-run`, `progress`, `finish`), Agents screen, demo agent.
   **Tests:** token checks, only declared connections are handed out, one run at a time.
5. **Scheduler, runs and budgets:** due runs by time zone, Stop, stale runs, per-agent and
   total budgets, Runs screen, Overview costs. **Tests:** schedule edge cases (time zones,
   DST), budget stops, stale detection.
6. **Import:** xlsx reading, synonyms, cleaning, merging, Lead IDs, preview, confirm, writing the
   Leads tab (Sheets API faked), Lists, do-not-contact for Top. **Tests:** fixtures built from
   the real files' patterns (variant headers, missing City, multi-email duplicates, empty tabs,
   one phone with a profile per city, text that looks like a formula, a failed Sheet write).
7. **Benchmarks and Website Standards:** GBP benchmark upload, Standard drafts and locking, the
   agent reference endpoints. **Tests:** replace-by-pair, locked versions only.
8. **Alerts:** email and Telegram alerts sent by the scheduler, repeat suppression, daily
   balance check and summary, Profile switch, alert settings, recent alerts on the Overview.
   **Tests:** each event alerts the right people once.
9. **Deployment and hardening:** production Compose with the backup service, backups, a
   restore test, the backup alert, JSON logs with request ids, fixed provider addresses, the
   History screen, `ops/deploy.md`, Playwright e2e (create the Owner → Connections → Import →
   demo agent run → Runs → History) with a fake Google, in CI. **Tests:** History is Owner-only
   and holds no secrets, the key file's `token_uri` is ignored, request ids, backup alerts.
10. **Batches and named benchmarks** (asked for after step 9): benchmarks as named sets per
    niche with GBP numbers and the Website Standard, not by city, versioned on change;
    batches (name, one niche, one benchmark) that files are added to; one business in one
    batch; the Batch column in the Leads tab; agents' ordered batches and the agent API for
    them; migration of the old benchmarks, standards and leads; Benchmarks and Batches
    screens, the batch chooser in agent settings; the demo agent works on its batches.
    **Tests:** benchmark rules and versions, batch rules (benchmark of the niche, rename and
    delete only when empty), a business stays in its first batch, agents' batch order and
    skipping batches without a benchmark, the data migration, e2e through a batch.
11. **Leads kept in the Hub, no Google** (asked for after step 10): each lead's row and the
    agents' results in the database, report files on disk (`REPORTS_DIR`, backed up); the
    Leads screen (search, filters, pages, sort by score, one lead with its results and files,
    edit and delete) and its Excel download; agents read full rows and save results and files
    through the agent API; the Google connection, Sheet writing and the fake Google removed;
    batches can be renamed at any time; the demo agent saves a result per lead.
    **Tests:** filters, search, pages, Excel (text stays text), editing with do-not-contact,
    delete keeps do-not-contact, Owner/Admin/Viewer rights, agents' results and files (types,
    names, replacing, another lead's file), the migration removing the Google values, e2e
    through the Leads screen.
12. **Tasks, bots and the batch pipeline** (asked for after step 11): tasks with what they
    need first and the Tasks screen; the manifest's `task`; a batch's tasks with one or more
    bots each, shared `all` or `split`; per-business readiness in the agent API and the
    result's `outcome`; Start, Pause and the running order; each bot's progress; the batch's
    Tasks and Results tabs; the migration from the agents' batch lists; the demo agent names
    its task. **Tests:** task rules (circles, delete when unused), adding and removing tasks
    and bots (only bots of the task, needs present), readiness per business (all, split,
    failed, Top, a new benchmark version, a removed bot's leads moving on), running order and
    paused batches in `next-run`, Owner/Admin/Viewer rights, the migration, e2e through a
    batch's Tasks and Results.
