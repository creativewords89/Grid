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
- **Tasks and agents:** the jobs a batch can have done (GBP Audit, Website Audit, Opportunity
  Finder, Outreach, …), each with what it needs first. Every agent does one task. A
  batch chooses its tasks and one or more agents for each; every business moves on to the next
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

- (Changed by step 25: built-in agents now run in the Hub's `agents` service; an agent of
  one's own can still be a separate container, section 6.2.)
- (Changed by step 27: every standard field of a lead can now be edited in the Hub.)
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

| Action | Owner | Admin | Viewer | Collector | Reviewer |
|---|---|---|---|---|---|
| See Overview, Runs, Agents, Batches, Benchmarks, Leads; download leads as Excel | ✔ | ✔ | ✔ | ✘ | ✘ |
| Make, rename or delete a batch; add and confirm its files | ✔ | ✔ | ✘ | ✘ | ✘ |
| Choose a batch's tasks and agents, start or pause it, change the batches' running order | ✔ | ✔ | ✘ | ✘ | ✘ |
| Change any standard field of a lead or its notes; mark Top in a city; delete a lead | ✔ | ✔ | ✘ | ✘ | ✘ |
| Switch an agent on/off, press Run now or Stop | ✔ | ✔ | ✘ | ✘ | ✘ |
| Change an agent's batches, limit, run time, budget and settings | ✔ | ✔ | ✘ | ✘ | ✘ |
| Make, change or delete a benchmark | ✔ | ✔ | ✘ | ✘ | ✘ |
| See or change Connections (keys, accounts) | ✔ | ✘ | ✘ | ✘ | ✘ |
| Change the total daily budget | ✔ | ✘ | ✘ | ✘ | ✘ |
| Add an agent, show or replace an agent's token | ✔ | ✘ | ✘ | ✘ | ✘ |
| Manage users (invite, deactivate, change role) | ✔ | ✘ | ✘ | ✘ | ✘ |
| See the History (audit log) | ✔ | ✘ | ✘ | ✘ | ✘ |
| Own profile, password, alert channels | ✔ | ✔ | ✔ | ✔ | ✔ |
| Files (step 31): hand in a lead file, see its problems, upload a revised version, delete it before it is used (Collectors: their own files only) | ✔ | ✔ | ✘ | ✔ | ✘ |
| See every file handed in on Files | ✔ | ✔ | ✔ | ✘ | ✘ |
| Add a ready file to a batch | ✔ | ✔ | ✘ | ✘ | ✘ |
| Top Review (step 32): choose each city's Top businesses in a file without errors, until every city has one | ✔ | ✔ | ✘ | ✘ | ✔ |
| Reopen a ready file for Top Review | ✔ | ✔ | ✘ | ✘ | ✘ |
| Add a niche (step 33) | ✔ | ✔ | ✘ | ✔ | ✘ |
| Rename a niche or delete an unused one | ✔ | ✔ | ✘ | ✘ | ✘ |

- There can be more than one Owner; the last active Owner can't be removed or demoted.
- A **Collector** (step 31) is the external team that collects leads: they see the **Files**
  screen only, and only the files they handed in (someone else's file is "not found"),
  and change a file only while it has errors. A **Reviewer** (step 32) sees **Top Review**
  only: never batches, the leads list or a whole file.
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
| `tasks` | the **jobs** agents do, made from their manifests: `key` (e.g. `gbp-audit`), `name` |
| `batch_tasks` | a task in a batch: `batch_id`, `task_id` (its job), `name`, `needs` (the jobs of this batch's tasks it waits for), `share` (`all` or `split`) |
| `batch_task_bots` | the agents doing it: `batch_task_id`, `agent_id`, `position` |
| `lead_bot_shares` | for a `split` task, which agent each business went to: `lead_id`, `batch_task_id`, `agent_id` |
| `imports` | `batch_id`, `file_name`, `niche`, `uploaded_by`, `status` (`preview`, `confirmed`, `failed`, `discarded`), counts, `preview` JSON, `errors` JSON, `sheet` JSON (every row of the file by tab: while waiting its cleaned values, original text and what happens to it; once confirmed only its tab, row number, Lead ID and what happened) |
| `leads` | every business: `lead_id` (`L-000123`), `batch_id` (the batch it was first imported into), `niche`, `city`, `business_name`, `level`, `gbp_link`, `emails`, the matching keys `phone_digits`, `name_address`, `website_domain`, `data` JSON (address, website, phone, WhatsApp, Facebook, Instagram, reviews, rating, notes), `extra` JSON (the file's other columns, by their header, e.g. "Operation Hour"), `results` JSON (by agent key: status, score, summary, details, benchmark id and version, when), `first_import_id`, `last_import_id` |
| `lead_files` | files agents saved for a lead (reports): `lead_id`, `agent_key`, `name`, `content_type`, `size`; the bytes are on disk at `REPORTS_DIR/<lead_id>/<id>` |
| `lists` | the **cities of a batch**, one per batch + city: `batch_id`, `city`, `niche`, `active`, `set_by_hand` (a person switched it, so the small-city rule leaves it alone), optional `daily_limit` |
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

- **Built-in agents** (step 25, the normal way): **+ Add agent** (Owner) offers the kinds the
  Hub can run (`GET /api/agents/kinds`; for now the **Demo agent**, which pretends to do a
  job; the real GBP and Website agents come next). Choose a kind, the **job it does** for a
  kind without a job of its own, and a name; its key is made from the name (`demo-gbp`,
  `demo-gbp-2`). There is no token and nothing to start on the server: the Hub's **agents
  service** (`python -m app.runner`, the `agents` service of the stack) runs every built-in
  agent, one thread each, and stops one that was deleted. Each signs in to the agent API like
  any agent, with a key worked out from `SECRET_KEY` and the agent's key
  (`hub_runner_<key>.<HMAC-SHA256>`), never shown and only valid for an agent with a kind;
  it sends its kind's manifest naming its job, then asks for work. Its card says **Connected
  · runs in the Hub** (or **Starting in the Hub…**), has no **New token** and is in the agent
  library under its job from the moment it is added.
- **An agent of its own** (advanced): **Adding an agent** (Owner): give its key (2–40 lower-case letters, digits and dashes, e.g.
  `gbp-audit`) and name; the Hub shows its **token once** (`hub_agent_…`, only a hash is
  stored). The token goes into the agent container's settings as `AGENT_TOKEN`, with
  `HUB_URL`. **New token** replaces it and stops the old one at once. A new agent starts
  **off**, with a daily limit of 100, run time 02:00 Asia/Dhaka and a $5 daily budget.
- The agents screen shows each agent as **connected** when it called the Hub in the last two
  minutes, and lists any connections its manifest needs that aren't set up yet.
- **Manifest:** when it starts, an agent sends `PUT /api/agent/v1/manifest`:
  `name`, `version`, `description`, `settings` (each with `key`, `type` of `int`, `float`,
  `text`, `bool` or `choice`, `label`, `help`, `default`, `min`/`max`, `choices`),
  `connections` it needs (Connections group ids), `task` and `task_name` (the key and name of
  the job it does, section 6.7), `result_label` (what the Leads screen calls
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
    GBP numbers, the Website Standard and the `version`), `GET /lists` (each batch's cities:
    batch id, city, niche, on or off, ready, limit; the Hub never hands out the leads of a
    city switched off or not ready) and `GET /do-not-contact/check?email=&phone=&gbp=&domain=` (`blocked` and
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
   be deleted only while it has no leads and no files. A batch chooses its tasks and agents and
   is started or paused (section 6.7).
1. **Upload** (Owner, Admin): an `.xlsx` (max 20 MB) **into a batch**; its niche is the
   batch's. Reading a large file (4,000 rows, 248 tabs) takes about 15 seconds.
2. **Reading each tab:** the header row is the first of the first five rows with two known
   headers. Header synonyms (case, spaces and punctuation ignored): GBP Link ← `MAP`, `Map URL`,
   `MAP URl`, `Maps`, `GBP`; WhatsApp ← `WA`, `WP`, `Whatsapp`; Email ← `E-mail`, `Gmail`,
   `Mail`; Reviews ← `Number of Reviews`, `Review`, `Reviews Count`; Rating ← `Average`,
   `Ratings`, `Average Ratings`; Notes ← `Comment`, `Issue 1–3` (joined). Other columns (such
   as "Operation Hour") are kept with the lead under their header (`extra`): listed in the
   preview, shown on the Leads screen and in the Excel download. No City (column or cell) → the tab name. A row with only a
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
5. **Top** (the best businesses of a city: never audited or contacted) is **chosen in the
   Hub** (item 9), never from a file (step 17): a `Level` column is kept like any other
   column and changes nobody's Top, and the preview says so. Top leads put their email(s),
   phone and GBP link on the do-not-contact list (reason `top`); losing Top removes those
   entries.
6. **Preview** (nothing written but the import): businesses, new, already known in this
   batch (updated), already in another batch,
   duplicates merged, Top, cities, without a GBP link, without a website, rows skipped, emails
   that look wrong, with up to 25 examples of each, plus new lists, other columns and empty
   tabs. A waiting preview reopens when the screen is opened again. Below the counts the
   preview shows **the file itself, tab by tab** like Excel: a bar with every tab and its
   rows (empty tabs greyed, plus "All tabs"); a tab opens a table of its rows, 100 a page,
   with every column in the file's order (Business name, MAP, Address, City, Website, Phone,
   WA, Facebook, Instagram, Email, Reviews, Average, Level, Notes, then the other columns).
   Cells show the cleaned value; a cell the Hub changed shows the original text when pointed
   at; emails that look wrong are marked. Each row says what happens to it: **new**,
   **updated** (already in this batch), **in another batch**, **merged** (one business with
   other rows), **Top**, or **skipped** (no name and no GBP link); the table can be narrowed
   to one of these.
7. **Confirm** saves everything in one transaction: Lead IDs continue from the highest one
   saved (`L-000001` …), one import at a time; each lead's row is kept with it (a value from
   the file replaces the saved one; an empty cell never blanks it); the lists and the
   do-not-contact list are updated; the file's other columns are kept with the lead the same
   way. Once confirmed, the import keeps its counts (new and updated) and, for each row, its
   tab, row number, Lead ID and what happened; opening a past file shows it tab by tab as
   above with each lead's values as the Hub has them now (a deleted lead says so). Files saved
   before this (step 14) show their counts only.
8. **Cities** (one per batch + city) are created by confirmed imports and shown on the
   batch's **Cities** tab with their businesses and Top counts, a search and **All on** /
   **All off**; Owners and Admins switch a city on or off. A city switched off **in a batch**
   is left alone in that batch only: its leads are not handed to agents (section 6.7). A city
   name opens the batch's Leads tab for that city, with a bar saying so, **← Back to
   Cities** (to the same tab, page and search) and **Show all leads**. (Step 15 moved the old City + Niche lists
   into each batch that has leads there, keeping on or off.)
   **Ready and Not ready** (step 20): a city is **Ready** once at least one Top is chosen in
   it in that batch, and **Not ready** until then; taking its last Top off makes it Not ready
   again. The server works this out from the Top leads (nothing to store). Agents only get
   the leads of a city that is Ready **and** switched on; the switch stays for pausing a
   city. The tabs are **Ready**, **Not ready** and **Small cities (under 10)**, each with its
   count; cities with 10 or more businesses are on Ready or Not ready, and the Small cities
   tab says Ready or Not ready for each. Marking a Top in a Not ready city moves it to Ready
   (the tabs load again on **← Back to Cities**). All on / All off works on the tab shown.
   The **Not ready** tab has no switch and no All on / All off: each city says **Needs a
   Top** (step 21); its on/off is kept and applies once it is Ready.
   **Added from** (step 22): each city shows the file it first came with (name and date):
   the oldest file that brought one of its businesses into the batch, worked out from each
   lead's first file, so deleting that file moves the city to the next one. The cities of
   the batch's latest file have a **New** label, and a **From file** list (All files or one
   file) narrows every tab and its count to the cities that file brought.
   **Small cities:** a city with **fewer than 10 businesses** in the batch is switched off by
   the Hub and listed apart, on the **Small cities (under 10)** tab. Unmuted by hand, it
   still needs a Top to be worked on.
   The Hub decides this again after every saved or deleted file (a small city that grows to 10
   is switched on), but never for a city a person switched on or off by hand (`set_by_hand`):
   an Owner or Admin can unmute a small city one by one. All on / All off works on the tab
   shown. Each tab shows **20 cities a page** with Previous / Next (a search narrows them
   first). (Step 16: cities that were off stay off as if set by hand; the others follow the
   rule.)
9. **A batch's Leads tab** (everyone): 100 leads a page; a search (name, Lead ID, city,
   email, phone, website, GBP link), city, Top and website; sort by Lead ID, newest,
   name, city, rating or reviews (highest first) or an agent's score (best first).
   The Leads tab only **shows** Top (its column and filter); Top is chosen in a city.
   **Choosing Top** (step 19): on the **Cities** tab, open a city; on its leads Owners and
   Admins tick leads (a box on each row, and one for the whole page) and press **Mark as
   Top** or **Remove Top** (at most 500 at a time; one History entry with the count). The
   server refuses a request whose leads are not all in that city of that batch. From then on agents don't get them (section 6.7); results agents
   saved before stay. The table shows **every field of the lead
   file side by side**, like the Excel file: Lead ID, Business name, GBP link, Address, City,
   Website, Phone, WhatsApp, Email(s), Facebook, Instagram, Reviews, Rating, Level, Notes,
   the file's other columns and Batch, then each agent's score and status; it scrolls sideways with the business name kept
   in view, and links (GBP, website, Facebook, Instagram) open in a new tab.
   The batch page and this table use the **whole width of the screen**: the filters sit in
   one row, the table scrolls inside itself with its header row kept in view.
   **Download Excel** gives the leads on screen (same filters, up to 50,000), every column
   including each agent's status, score, summary and when; every text cell is stored as text,
   so a value starting with `=` never runs as a formula.
10. **One lead** shows its row, each agent's result and the files agents saved (always
   downloaded, never shown in the page). Owners and Admins change **every standard field**
   (step 27: Business name, GBP link, Address, City, Website, Phone, WhatsApp, Email(s),
   Facebook, Instagram, Reviews, Rating) and its notes (only the fields changed are sent; in
   History, with the old and new value; a new city is added to the batch's cities), or delete
   it. Lead Check runs again on every save. It shows whether it is
   Top but cannot change it (step 19); Top keeps its email, phone and GBP link on the
   do-not-contact list, removing Top takes them off (its files
   go too; its do-not-contact entries stay, so a Top business imported again is still never
   contacted).
11. **Deleting a file** (Owners and Admins), from the batch's past files, **only while the
   batch isn't running** (not started or paused; the server refuses it otherwise, "Pause the
   batch first"). A saved file goes with the leads it brought in first (their agents'
   results and files too); leads that came from an earlier file and were only updated by it
   stay. Do-not-contact entries stay. Before deleting, the Hub says how many leads go and how
   many stay; History records who deleted which file and how many leads went. A waiting
   preview is discarded as before (also while running: it added nothing).
12. **Find a business** (everyone), at the top of the Batches screen: the search of item 9
   over every batch; each result names its batch and opens the lead, or its batch's Leads
   tab.
13. **Lead Check** (steps 26 and 27): every lead file is checked against the standard
   (`app/imports/check.py`). **Per tab** (warnings): a standard column missing, a column given
   twice, rows whose City isn't the tab's name. **Per lead**, on its current values: an
   **error** (🔴) is wrong data in a field (a phone number, email or link in the Address; a
   Facebook, Instagram or Google Maps link, or no link, as the Website; letters or not 10
   digits in the Phone; WhatsApp not Yes or empty (it says whether the Phone number has
   WhatsApp; "No" is a problem too: empty means no WhatsApp, and its one-click fix empties
   it); WhatsApp Yes without a phone; no address, or an address that doesn't name the City
   column's city (a town around it doesn't count); a GBP link that isn't Google Maps; a link or a
   phone number as the business name; numbers in the City; a Facebook column that isn't
   Facebook and the same for Instagram; Reviews not a count; Rating not a number or
   outside 0–5; Reviews and Rating swapped; Reviews written in thousands, such as 1.4k: the
   Hub never changes it, the file is fixed (1400) and added again; 1204 and 1,204 are fine); a **warning** (🟠) is missing or doubtful data (no GBP link, a
   made-up email). An empty phone and a long business name are normal. When the rules change, a migration clears the
   saved checks so every lead is checked again under the new rules. The **preview** shows errors and warnings by tab and marks each wrong cell; saving
   a file checks its leads. **A file with an error is held**: while any lead it brought or
   updated in its batch has an error, agents get **none** of that file's leads (section 6.7).
   As soon as a file is saved the team is told (alert `lead_check`, email and Telegram): held
   with its errors by city, or clear. Each saved file in **Past imports** says **✅ Clear** or
   **🔴 N leads · held** and opens its **report**: by city, the tabs' column problems, every
   problem with its lead (which opens to fix it), **Errors only**, **Download problems to
   fix**, **Upload fixes** and **Check again** (`/imports/{id}/check.xlsx` still gives one row
   per problem). **Fix files** (step 28): **Download problems to fix** (in the report: that
   file's leads; on the Leads tab: the batch's) gives every lead with a problem (errors and
   warnings) as Excel, one tab per city, Lead ID first, then the standard columns and Notes,
   and a Problems column; each wrong cell is red (error) or yellow (warning) with a note
   saying what is wrong, filters on, the header frozen, every cell stored as text. Fixed
   offline, it is uploaded back with **Upload fixes** (Owners and Admins,
   `POST /batches/{id}/fixes`): rows are matched by **Lead ID** within the batch; each column
   of the file changes its field and **an empty cell clears it**; other columns are left
   alone, the Problems column is ignored. First the Hub shows what would change (each lead,
   field, old → new value), errors before → after, how many files stay held, the rows left
   out (no Lead ID: new businesses go in a lead file; a Lead ID of another batch or none; a
   Lead ID twice) and the values refused (no name or city, a bad email); **nothing is saved**
   until **Save N changes**. Saving goes through the same rules as the lead window (step 27),
   checks each lead again (a file whose last error is fixed is released) and records each
   lead's changes in History. Top is never changed by a fix file. **Filters:** the Cities tab has a
   **Problems** column and **All cities / With problems / With errors**; the Leads table has a
   **Check** column, wrong cells outlined, and a **Problems** filter (any, errors only, or one
   kind). A lead says when its file is held and lists its problems; a problem with a clear fix
   (a link in the wrong column, Reviews and Rating swapped, a phone, email or link in the
   address) has a **one-click fix** that is only applied when pressed. Leads saved before Lead
   Check are checked the first time their batch is looked at.

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

### 6.7 Tasks, agents and the batch pipeline

- Every **agent** does **one job**, named by its manifest (`task`, its own key when left
  out, and `task_name`, e.g. "GBP Audit"). The Hub keeps the list of jobs (`tasks`): the
  **built-in jobs** (step 24), in this order, GBP Audit (`gbp-audit`), Website Audit
  (`website-audit`), Social Audit (`social-audit`), Opportunity Finder (`opportunity`), Email
  Writer (`email-writer`), Sending and Follow-up (`sending`) and Reply (`reply`), are there
  before any agent connects; a manifest naming another job adds it. There is no screen for
  them. A manifest naming another job moves the
  agent to it; batches that had it on a task of the old job lose it there.
- **The standard steps** (step 24): a batch with no tasks offers **Use the standard steps**,
  which adds GBP Audit and Website Audit side by side, then Opportunity Finder (needing both),
  then Email Writer (needing Opportunity Finder); one with some of them offers **Add the
  missing standard steps** (tasks already there are kept). A task without an agent of its job
  says **No agent does this job yet** with a link to Agents; the agent library lists agents
  only, under their job, and says **No agents yet** with that link when there are none.
- **A batch's tasks** (its **Tasks** tab, step 18): Owners and Admins press **+ Add a task**
  and choose its **job** (any job, with or without an agent yet: step 24), its **name** (the job's name unless
  changed) and what it **needs first**: other tasks of this batch, so the order can differ
  from batch to batch. A batch has a job once. A task can't need itself or make a circle, and
  can be removed only when no other task in the batch needs it; its name and needs can be
  changed. Each task gets **one or more agents** of its job only (from the agent library,
  grouped by job, by dragging or **Add**, or **+ Add another agent**). Tasks are shown in
  **steps** worked out from what they need (step 1: tasks needing only the lead file; next:
  tasks needing those …); tasks in one step run side by side.
- **How the agents of one task share the work** (chosen per task in the batch):
  - **Every agent checks every business** (`all`): each agent does every lead, e.g. two GBP
    audits whose results are compared. The task is done for a lead when every one of its
    agents finished it.
  - **Split the businesses** (`split`): each lead goes to one agent, in turn, the first time a
    agent asks for it (kept in `lead_bot_shares`), e.g. two outreach emails tried on half the
    leads each. A lead goes to another agent when its agent is removed from the task before
    finishing it. The task is done for a lead when its agent finished it.
- **Per business:** a lead is **ready** for an agent when its city is switched on in the
  batch, the agent hasn't finished it, each task
  it needs is done for that lead, and (for `split`) the lead is the agent's. **Finished** means
  the agent's result has outcome `done` or `skipped` and was made against the batch's current
  benchmark version; a `failed` result is tried again on the next run. Top leads are never
  handed to an agent, and neither are the leads of a city that is **not ready** (no Top
  chosen in it in that batch, step 20) nor the leads of a file **Lead Check holds** (a lead of
  it has an error, step 26). So the Opportunity Finder starts on the first business both audits
  finished while the audits go on with the rest.
- **Start and Pause:** a new batch is **not started**. Owners and Admins **Start** it once it
  has a benchmark and at least one task with an agent; a running batch can be **Paused**, which
  agents then skip (a lead being worked on is finished). Tasks and agents can be changed at any
  time, also while running.
- **Running order:** on the Batches screen Owners and Admins move batches up or down; when
  two running batches use the same agent it works on the higher one first.
- **Progress** of each agent in a batch: leads finished, failed, ready, still waiting for the
  tasks before it, and the average score; an agent that is off or has never connected is
  marked so.
- **Results:** the batch's **Results** tab shows one agent at a time: counts by outcome and
  score band (under 40, 40–69, 70 and over), then its leads with status, score, summary and
  when, filtered by outcome and score band, 100 a page; a lead opens the lead window
  (section 6.4 item 10) with every agent's result and files. **All results** opens the Leads
  screen for the batch, which has a column per agent and the Excel download.
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
   niche has none), each with its status, agents and progress, and up and down buttons for the
   running order, and **Find a business** (section 6.4 item 12) above them. A batch (its own
   address, `/batches?batch=<id>&tab=<tab>`) opens to **Start**/**Pause** and tabs:
   **Tasks** (laid out as the chosen A+B design: the batch's name, niche, benchmark, businesses
   and Top with its state and Start/Pause above underlined tabs; the agent library grouped by
   job, with **Find an agent**, each agent with its one-line description and "In use";
   **Tasks on this batch** starting with the lead files, the steps with each task's agents
   and progress, an empty task as a drop zone with **Choose an agent**, and **+ Add a task to
   this batch**; an agent can be dragged from the library or chosen), **Leads** (section
   6.4 item 9, with the lead window of item 10), **Cities** (item 8), **Results** (section
   6.7) and **Files and settings** (its benchmark choice, rename, delete when empty, **Add a
   lead file**, the preview and its past files, each with **Delete**, item 11).
   (Step 23: the tabs are **Tasks**, **Cities**, **Results**, **Lead files** and **Settings**.
   **Lead files** holds two views, **Leads** (the table above, the file's rows as the Hub
   keeps them) and **Files** (**Add a lead file**, the preview and the past files, each with
   **Delete**); **Settings** holds the benchmark choice, rename and delete when empty. A
   city's leads opened from Cities stay under **Cities**. Addresses keep `tab=leads`,
   `tab=files` and add `tab=settings`.)
   There is no setup guide box on the Tasks tab (taken off after step 18); how to add
   and start an agent is on Agents.
   `/import` opens Batches.
5. Tasks have **no menu item**: they are made in each batch's Tasks tab (step 18).
6. Leads have **no menu item** of their own: they are in their batch (step 15).
   `/leads?batch=<id>` opens that batch's Leads tab.
7. **Agents:** one card per agent: on/off switch, **Does:** its job, **Used in:** the batches
   and tasks it is on (running ones first),
   (or a warning when none), last run, next run, today's cost, Run now, Stop; **Settings**
   opens the form: limits and the manifest's settings. A card says where the agent is in its
   setup (waiting for its first connection, connected, not in a running batch, ready), and
   one that never connected explains how to start it. When an agent is added (or its token
   replaced) the window with the token also shows the command that starts it on the server
   with that token (`docker run … --network agent-hub -e HUB_URL=http://api:8000 -e
   AGENT_TOKEN=…`), for the demo agent and for a real agent's image.
   The screens call them **agents** everywhere (never "bots").
8. **Runs:** filter by agent and status; each run's counts, cost, stop reason and failures.
9. **Connections** (Owner), **Users** (Owner), **History** (Owner: who did what, newest
   first, filtered by area; a connection change only says "(changed)"), **Profile**.
10. **Files** (step 31, after Batches; a Collector's only screen, whatever the address):
    **Hand in a lead file** (niche, from those of the benchmarks and batches, and the .xlsx);
    the files with niche, businesses, who handed it in, its Lead Check (Needs fixing 🔴 n,
    Ready, Being added, Used) and the batch it is in ("Used in Batch 01 · date · by Olivia"),
    filtered by status; a file opens to its problems by tab, row and column, **Download
    problems to fix** (the file itself, each wrong cell red or yellow with a note and a first
    **Lead Check** tab listing them), **Upload revised version** (a new version, checked
    again; the marks of the downloaded copy are taken out) and **Delete** (before it is used).
    Owners and Admins also have a **Batches** panel: a ready file is dragged onto a batch of
    its niche (or **Add to batch** in the file), which opens that batch with the file's
    preview to confirm. A file handed in again with the same leads says so ("Same leads as
    …, used in Batch 01").
    (Step 32: the states are 🔴 **Needs fixing**, 🟡 **Needs Top** (no error: the
    Collectors are done, the file is waiting for Top Review; only Owners and Admins delete
    it), ✅ **Ready** (no error and every city with 10 businesses or more has a Top; Owners
    and Admins can **Reopen for Top Review**), **Being added** and **Used**. Only a Ready
    file is added to a batch.)
11. **Top Review** (step 32; a Reviewer's only screen, also for Owners and Admins): the
    files waiting for their Top, each with how many of its cities have one, and the done
    ones (**Done ✓**, not opened again). A file opens to its cities (Ready, Needs a Top,
    or Off · under 10); a city opens to its businesses with every column and a Top tick
    box each, saved with **Save the Top of <city>**.
    (Step 33 on **Files**: the niche is chosen from the **Niches** list, or added with
    **+ New niche…** ("Did you mean …?" for a spelling close to a known one); Owners and
    Admins have **Niches** to rename or delete them. **Upload and check** shows
    **Uploading n%**, then the file is listed as **Checking n%** while the server checks
    it, going on after a reload or offline. A file opens on its own page (Files / name)
    with its businesses as the batch's Leads tab shows them: a toolbar (search, City,
    Problems, Sort), the count and pages, Tab · Row, the Check badge and every column, each
    wrong cell marked with what is wrong; only to look at.)

## 8. REST API (`/api`, JSON)

`/health`, `/setup`, `/auth/*`, `/me`, `/users`, `/connections` (+ `/{group}/test`),
`/agents` (+ `/{key}/enabled`, `/{key}/run`, `/{key}/stop`, `/{key}/token`), `/runs`,
`/overview`, `/budget`, `/benchmarks` (+ `/{id}`), `/batches` (+ `/{id}`, `/order`,
`/{id}/start`, `/{id}/pause`, `/{id}/tasks` (+ `/{task_id}`, `/{task_id}/bots`,
`/{task_id}/bots/{key}`), `/{id}/progress`, `/{id}/results`), `/tasks` (the jobs and their
agents), `/imports`
(upload into a batch → preview, `?batch_id=`, `/{id}/confirm`, `/{id}/discard`, `/{id}/sheet`,
`DELETE /{id}` and `/{id}/deletion` (what would go)), `/niches`, `/leads` (+ `/export`,
`/{lead_id}`, `/{lead_id}/files/{id}`), `/batches/{id}/cities` (+ `PUT` all on or off),
`/lists/{id}`, `/alerts`, `/submissions` (the Files screen: `POST` to hand in, `/niches`,
`/{id}`, `/{id}/version`, `/{id}/marked.xlsx`, `/{id}/use`, `/{id}/reopen`, `DELETE /{id}`),
`/review/files` (Top Review: `/{id}`, `/{id}/cities/{city}` and `PUT` its Tops),
`/submissions/{id}/leads` (the file's businesses), `/niches` (`POST` to add, `/all`,
`PATCH` and `DELETE /{id}`),
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

1. **Cities** (a batch's cities on or off, and a per-city limit) live in the Hub.
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
13. **Agents made clear and the full Leads table** (asked for after step 12): one word,
    "agent", on every screen; the setup guide on a batch's Tasks and agents tab; each agent's
    setup state and start command; the Leads table with every field of the lead file side by
    side; the Lists moved from Batches to Leads. **Tests:** the guide's steps tick as the
    setup goes on, the token window's command holds the token, every field is a column,
    Lists only on Leads, e2e through the guide.
14. **The lead file tab by tab** (asked for after step 13): the preview shows every row of
    the file by tab, with every column, the original text of changed cells and what happens
    to each row; the file's other columns are kept with the lead (`extra`), on the Leads
    screen and in the Excel download; a past file opens tab by tab from the saved leads.
    **Tests:** tabs and rows in the file's order, statuses (new, updated, in another batch,
    merged, Top, skipped), original text, other columns saved and not blanked, a confirmed
    file's view from the leads (also a deleted one), filters and pages, rights, e2e.
15. **Leads in their batch, cities per batch, deleting files** (asked for after step 14):
    the Leads menu item goes and each batch gets **Leads** and **Cities** tabs; the batch
    page uses the whole screen width with header rows kept in view; cities switched on or
    off per batch (migration of the City + Niche lists) and the Hub hands out no leads of a
    city switched off; deleting a saved file with the leads it brought in first, only while
    the batch isn't running; **Find a business** over every batch on the Batches screen.
    **Tests:** cities per batch and the migration, readiness skips cities switched off, file
    deletion (running refused, which leads go and stay, do-not-contact kept, History), rights,
    the batch page's address and tabs, e2e.
16. **Small cities muted** (asked for after step 15): cities with fewer than 10 businesses in
    a batch are switched off by the Hub and shown on their own tab; a person can unmute one,
    and the Hub then leaves it alone; 20 cities a page. **Tests:** the rule after saving and deleting files, a
    city growing to 10, set-by-hand cities untouched, the tabs and their counts, the
    migration.
17. **Top chosen in the Hub** (asked for after step 16): ticking leads on the batch's Leads
    tab and marking or unmarking them Top together; sorting by rating and reviews; files
    never change Top (a Level column is kept as another column). **Tests:** marking and
    unmarking with do-not-contact, rights, the 500 limit, sorting with odd values, a file
    with a Level column changing nobody's Top, agents not getting Top leads.
18. **Tasks made in the batch** (asked for after step 17): the Tasks menu item goes; jobs
    come from the agents' manifests (`task_name`); a batch's Tasks tab adds a task by job,
    name and what it needs first in that batch; agents only on tasks of their job; the
    Agents screen says what each agent does and where it is used. Migration `0015` moves
    each job's needs into the batches that use it. **Tests:** adding, renaming and changing
    a task's needs in one batch without touching another, circles and missing needs refused,
    readiness from the batch's needs, the migration, rights, e2e.
19. **Top chosen only in a city** (asked for after step 18): the batch's Leads tab shows Top
    but has no boxes or Mark as Top; a city opened from the Cities tab has them; the lead
    window no longer changes Top. `POST /leads/top` takes the batch and the city, and every
    lead must be in that city of that batch; `PATCH /leads/{id}` no longer takes `level`.
    **Tests:** marking in a city, leads of another city or batch refused, the lead window
    refused, rights, the Leads tab without boxes, the city with them.
20. **Ready and Not ready cities** (asked for after step 19): the Cities tab's tabs become
    Ready, Not ready and Small cities (under 10); a city is Ready once a Top is chosen in it
    in that batch and agents only get the leads of a Ready city that is switched on; taking
    the last Top off makes it Not ready; an unmuted small city needs a Top too. No migration:
    readiness is worked out from the Top leads, so cities of running batches without a Top
    stop being worked on. `GET /batches/{id}/cities` and the agents' `GET /lists` say
    `ready`; All on / All off takes the tab (`small`, `ready`). **Tests:** not ready until a
    Top, ready after, not ready again, a small city unmuted without a Top, All off on one
    tab only, a ready city switched off, the tabs and their counts, e2e.
21. **No switch on Not ready cities** (asked for after step 20): the Not ready tab shows
    **Needs a Top** in place of the switch and hides All on / All off and the Set column;
    the Ready and Small cities tabs keep theirs. **Tests:** the Not ready tab without a
    switch or All on.
22. **The file a city came with** (asked for after step 21): the Cities tab shows each
    city's first file and date, **New** on the latest file's cities and a **From file**
    filter. `GET /batches/{id}/cities` says `added_from` (file id, name, confirmed) and
    `new`. No migration: worked out from `leads.first_import_id`. **Tests:** two files, the
    latest one's cities new, deleting the first file moving its city to the second, the
    filter and its counts, e2e.
23. **Leads with the lead files** (asked for after step 22): the batch's tabs become Tasks,
    Cities, Results, Lead files (views Leads and Files) and Settings; a city's leads stay
    under Cities. **Tests:** the tabs and views, old addresses, a city's leads under Cities,
    settings on their own tab, e2e.
24. **Built-in jobs and the standard steps** (asked for after step 23): the jobs are known
    before any agent connects; **Use the standard steps** / **Add the missing standard
    steps** (`POST /batches/{id}/tasks/standard`); a task without an agent links to Agents;
    the library lists agents only; the lead file form no longer says a Level column makes a
    business Top. **Tests:** the built-in jobs in order without agents, a manifest joining one,
    the standard steps added once and kept, rights, the Tasks tab before any agent.
25. **Agents run in the Hub** (asked for after step 24, "nothing typed in the terminal"):
    the `agents` service and `python -m app.runner`; built-in kinds (`app/builtin`, the Demo
    agent first); **+ Add agent** by kind, job and name, no token; the runner's signed key;
    migration `0016` (`agents.kind`); an agent of one's own still possible. **Tests:** the
    kinds, adding one (key from the name, its job at once, no token, refused New token),
    rights, the runner key only for a built-in agent and not forgeable, the runner taking a
    run through a batch, the Agents screen, e2e with the runner.
26. **Lead Check** (asked for after step 25): the checks per tab and per lead, the preview's
    check, a file held while a lead of it has an error, the alert when a file is saved, the
    report and its Excel, Check again, the Problems filters on Cities and Leads. Migration
    `0017` (`leads.check`). **Tests:** every rule, warnings never holding, a held file
    holding all its leads until fixed, a clean file not held by another, the report, the
    Excel, the alert, the filters, e2e.
27. **Fixing leads in the Hub** (built with step 26): every standard field editable, a lead
    moved to a new city, one-click fixes, Lead Check again on save. **Tests:** editing every
    field, Top not editable, rights, fixes, a fix clearing a held file.
28. **Fix files** (asked for after step 27): **Download problems to fix** (per file and per
    batch) with red and yellow cells and notes, **Upload fixes** matched by Lead ID with a
    preview before saving, empty cells clearing; the lead window and fix files share one set
    of rules (`app/leads/edit.py`). Also: WhatsApp is **Yes or empty** ("No", a phone number
    or anything else is an error; "No" has a one-click fix that empties it; Yes without a
    phone is a warning), and migration `0018` clears saved checks so every lead is checked
    again. **Tests:** the file's tabs, colours and notes, a round trip clearing a held file,
    a preview saving nothing, rows left out, a refused value, a file without Lead ID,
    rights, the WhatsApp rule.
29. **Lead Check corrections** (asked for after step 28): an empty phone and a long name are
    normal; (reviews as 1.4k: see below); WhatsApp Yes without a phone, an
    empty address and an address that doesn't name the City column's city are errors.
    Migration `0019` clears saved checks. (Changed right after: reviews written as 1.4k are
    an **error**, never converted by the Hub; migration `0020` clears saved checks again.)
    The preview checks each business as it will be
    saved (its rows merged first, so an empty cell filled from another row isn't an error)
    and counts it once. **Tests:** each corrected rule, sorting by 1.4k, merged rows.
30. **The Leads tab redesigned** (asked for after step 29): one toolbar (a search that
    applies as you type, compact City, Top, Website, Problems and Sort, a **Download** menu
    with Excel and problems to fix, **Upload fixes**); a summary line with the count, the
    filters that are on as chips that take them off, the Top hint as ⓘ, and the pages
    (‹ Page n of N ›, also under the table); a Check badge per lead (✓ OK, 🔴 n, 🟠 n), zebra
    rows, addresses on at most two lines and long values cut with the full text on hover.
31. **Files and Collectors** (asked for after step 30): the external team that collects
    leads signs in as a **Collector** (a new role, invited on Users) and sees only **Files**
    and their own files, enforced on the server. A file handed in (table `submissions`:
    the file, its niche, who, version, Lead Check's counts and every problem with its tab,
    row, column and value, and a fingerprint of its leads) is checked at once like a preview
    (each business once, rows merged); it is **ready** with no error. The marked file is the
    file itself with red/yellow cells and notes and a first Lead Check tab; a revised version
    replaces it and is checked again. An Owner or Admin adds a ready file to a batch of the
    same niche: this makes the batch's import (its preview waits there, the normal confirm
    or discard). The file is **being added** while that preview waits, **used** once it is
    saved (then it can't be revised, deleted or added again, and shows the batch, date and
    who); discarded or deleted in the batch, it is free again. Leads handed in again (the
    same fingerprint) show a warning, and can't be added once the first file is used.
    Migration `0021` adds the `collector` role and `submissions`. **Tests:** every
    permission row for the four roles, a Collector refused everywhere but Files and others'
    files, the check by tab and row, the marked file and its marks taken out, versions,
    niche match, used once, same leads, delete rules; vitest for the menu and the Files
    screen; e2e: a Collector invited, hands in a file, the Owner drags it onto the batch.
32. **Top Review and Reviewers** (asked for after step 31): Top is chosen in the file
    before it goes into a batch. Once a file has no error the Collectors are done (it can't
    be revised, and only Owners and Admins delete it) and it **Needs Top**. A **Reviewer**
    (a new role: Top Review only, enforced on the server) chooses each city's Top
    businesses, one city at a time; a city with fewer than 10 businesses in the file is off
    and needs none. A city's Tops are saved together (`submissions.tops`: city → the first
    row of each business); when every city that is on has a Top the file is **Ready** and
    locked (`topped_at`): Reviewers can't open or change it any more, Owners and Admins can
    reopen it (its Tops kept). Only a Ready file is added to a batch; its Tops are Top
    there on confirm (so their cities are Ready, and never contacted). Files of step 31
    without Tops need Top. Migration `0022`. **Tests:** every permission row for five
    roles, a Reviewer refused everywhere but Top Review, files with errors not shown, city
    by city with the off city and businesses of another city refused, the lock and reopen,
    the Tops being Top in the batch, a file of small cities ready at once; vitest for the
    menus and Top Review; e2e: a Reviewer invited chooses the Top and the file is ready.
33. **Niches, checks in the background and the file's table** (asked for after step 32):
    a **Niches** list (table `niches`, started from those in use): Owners, Admins and
    Collectors add one (the same name in other letters is the known one; a close spelling
    asks "Did you mean …?" first); Owners and Admins rename one (its files, batches,
    benchmarks, imports, leads and lists follow) or delete one nothing uses. Benchmarks and
    the Files screen choose from it. Handing in a file (or a revised version) only stores
    it, with the upload's progress shown; the scheduler's **file checker** (every 2 s, in
    its own thread) checks it, saving its progress (reading the tabs 0–60 %, the
    businesses 60–100 %) and taking over a check whose claim went stale (2 minutes, after a
    restart); a version handed in during a check is the one kept. A file that can't be read
    is **failed**, with why. Each business is kept for the Files table (`leads`):
    `/submissions/{id}/leads` filters by search, city and problems, sorts and pages it.
    Migration `0023` (files already handed in are checked again). **Tests:** progress,
    the stale claim, a version during a check, the table's filters, who adds and manages
    niches, close spellings, renaming that carries everything, deleting only unused ones;
    vitest for uploading, a new niche and the file's table; e2e: checked after a reload.
    (Corrected after step 33: the table's Problems filter is **All**, **Problems** (errors
    and warnings), **Errors**, **Warnings** and **OK**, each with its count. **Download
    problems to fix** fetches the file and says why when it can't; a workbook the Hub can
    read but not mark in place is made again from what it read: a tab per tab, the row each
    business was on, every standard column and the same marks.)
34. **A handed-in file's fix file** (asked for after step 33): **Download problems to fix**
    on Files gives the same file as a batch's (step 28): a tab per city, only the
    businesses with a problem, the columns **Row · Business name · GBP link · Address ·
    City · Website · Phone · WhatsApp · Email · Facebook · Instagram · Reviews · Rating ·
    Notes · Problems · Delete** (Row is the tab and row the business is on, "Tulsa · 14",
    as there is no Lead ID before a batch), each wrong cell red or yellow with a note, the
    header and first two columns frozen and a filter. **Upload fixes** takes it back: each
    row found by its Row, every column changing its value (an empty cell clears it), Delete
    = Yes taking the business out of the file; what would change (and what is taken out,
    and rows that don't match) is shown first, then **Save**. Saved, the file is made again
    from its businesses with the fixes (a tab per tab, the standard columns and its other
    columns) as a new version, checked again. Only while the file has errors, by whoever
    may revise it. **Upload revised version** stays, for a whole new file. **Tests:** the
    fix file, preview then save, Delete, rows that don't match, who may, the other columns
    kept; vitest for the dialog.
