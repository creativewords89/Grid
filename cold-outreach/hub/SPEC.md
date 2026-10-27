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
- **Import** lead files (`.xlsx`) from the browser: clean, merge duplicates, give Lead IDs,
  preview, then write them to the Master Sheet.
- **Agents** screen: switch each agent on or off, set its daily limit, run time, budget and
  its own settings, press **Run now** or **Stop**.
- **Connections** screen: enter API keys and accounts (DataForSEO, Google service account,
  Master Sheet, Drive folder, PageSpeed, SMTP, Telegram) with a **Test** button each. Keys are
  encrypted and never shown again.
- **Runs** and **Overview**: what ran, what failed, what it cost, today and this month.
- **Benchmarks** (GBP, uploaded as Excel) and **Website Standards** (per niche, a form).
- **Alerts** by email and Telegram when something needs a person.
- Every permission is enforced on the server.

### Non-goals (first version)

- Running agent code inside the Hub. Agents are separate containers (section 6.2).
- Editing lead data in the Hub. The Master Sheet is where people read and edit leads.
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
| Google | Sheets and Drive APIs through the service account saved in Connections |
| Alerts | SMTP email and a Telegram bot (its own bot and group) |
| Secrets | `SECRET_KEY`, `APP_URL` and the database password in `.env`; every other key entered in the website (section 6.1) |

### Repository layout

```
cold-outreach/
  PLAN.md, CLAUDE.md, README.md
  hub/
    SPEC.md                this file
    docker-compose.yml     caddy, api, scheduler, db
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
        imports/           xlsx reading, header synonyms, cleaning, merging, Sheet writing
        benchmarks/        GBP benchmark upload, Website Standards
        alerts/            email, Telegram, daily summary
        google/            Sheets and Drive clients
        audit.py
      tests/
    frontend/src/
  agents/                  each agent, from PLAN.md build order step 2
```

## 3. Roles and permissions

| Action | Owner | Admin | Viewer |
|---|---|---|---|
| See Overview, Runs, Agents, Imports, Benchmarks, Website Standards | ✔ | ✔ | ✔ |
| Upload and confirm an import | ✔ | ✔ | ✘ |
| Switch an agent on/off, press Run now or Stop | ✔ | ✔ | ✘ |
| Change an agent's limit, run time, budget and settings | ✔ | ✔ | ✘ |
| Upload benchmarks, create or edit a Website Standard draft | ✔ | ✔ | ✘ |
| Lock (publish) a Website Standard version | ✔ | ✘ | ✘ |
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
| `agents` | `key` (e.g. `gbp-audit`), `name`, `enabled`, `token_hash`, `manifest` JSON, `manifest_version`, `config` JSON (the values set in the Hub), `daily_limit`, `run_time`, `time_zone`, `daily_budget_usd`, `last_seen_at` |
| `runs` | `agent_id`, `trigger` (`schedule`/`manual`), `status` (`queued`, `running`, `succeeded`, `failed`, `stopped`, `timed_out`), `queued_at`, `started_at`, `finished_at`, `heartbeat_at`, counts `done`/`failed`/`skipped`, `cost_usd`, `stop_reason`, `summary` JSON, `requested_by` |
| `imports` | `file_name`, `niche`, `uploaded_by`, `status` (`preview`, `confirmed`, `failed`, `discarded`), counts, `preview` JSON, `errors` JSON |
| `leads` | the Lead ID registry: `lead_id` (`L-000123`), `niche`, `city`, `business_name`, `level`, `gbp_link`, `phone_digits`, `website_domain`, `emails`, `first_import_id`, `last_import_id`. The full row lives in the Sheet. |
| `lists` | one per City + Niche: `active`, optional `daily_limit` |
| `gbp_benchmarks` | one per City + Niche: the columns of PLAN.md 3.5, `reference_businesses`, `import_id` |
| `website_standards` | `niche`, `version`, `status` (`draft`/`locked`), `standard` JSON, `locked_by`, `locked_at` |
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
  | Google (Sheets and Drive) | service account key file (uploaded), Master Sheet link, Drive folder link | gets a token, opens the Sheet (lists the Leads tab's columns, or says the first import will create it), creates and deletes a file in the folder |
  | PageSpeed Insights | API key | scores example.com on mobile |
  | Email (SMTP) | server, port, username and password (optional), From | sends a test message to the Owner |
  | Telegram alerts | bot token, alerts group (optional) | checks the bot; when no group is set, finds the latest group the bot has seen and saves it; sends a test message there |

- Values are checked before saving (port number, email address, Sheet and folder links, a
  service account key file, a numeric group id) and refused with a reason under the field.
- Stored in `settings.connections`, each value encrypted with Fernet using a key derived from
  `SECRET_KEY`. **Write-only:** secrets (and the key file) are never returned, only whether
  they are set and their last four characters. History records "changed" or "removed".
  Test results and errors never repeat a key, password or token.
- If `SECRET_KEY` changes, stored values can't be read and show as "enter it again".
- Google's service accounts have no storage of their own, so the Drive folder should be in a
  Shared Drive with the service account as a member; the Test explains this when it happens.
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
  `connections` it needs (Connections group ids), `sheet_columns` it owns, and an estimated
  `cost_per_item_usd`. A manifest with unknown fields or connections, or a default outside its
  own limits, is refused. The Hub builds the agent's settings form from it; values set in the
  Hub are checked against it (type, limits, choices) and an unset value uses the default.
  Values for settings a newer manifest dropped are kept but not used.
- **Agent API** (token in `Authorization: Bearer`), all under `/api/agent/v1`:
  - `GET /next-run`: when a run is queued and the agent is on, the Hub marks it `running` and
    returns the run id, the trigger, the agent's settings, its daily limit and **only the
    connections its manifest declared** (from step 5, also the budget left). Otherwise `204`;
    `409` until the manifest was sent. Agents poll every 30 s.
  - `POST /runs/{id}/progress`: counts and cost so far; the reply says `continue` or `stop`
    (agent switched off; from step 5 also Stop pressed and budgets used up). This is also the
    heartbeat.
  - `POST /runs/{id}/finish`: final counts, cost, `stop_reason`, failures summary.
  - Reference data: `GET /lists` (City + Niche, on or off, limit), `GET /benchmarks?niche=&city=`,
    `GET /website-standards/{niche}` (latest locked, `404` when none) and
    `GET /do-not-contact/check?email=&phone=&gbp=&domain=` (`blocked` and why).
- An agent can only see and change its own runs (another agent's run id is a `404`). Secrets
  are never logged on either side.
- **Run now** (Owners and Admins) queues a manual run. It is refused while the agent is off,
  before it has ever connected, or while it already has a run waiting or in progress. A
  database rule keeps it to one queued or running run per agent even if two clicks race.
- `agents/demo/agent.py` is a demo agent (Python standard library only) that pretends to work
  through items, for trying the switches, settings and Run now.

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

### 6.4 Import

1. **Upload** (Owner, Admin): an `.xlsx` (max 20 MB) and its **Niche** (typed, or picked from the
   niches already used; a different case uses the existing spelling). Reading a large file
   (4,000 rows, 248 tabs) takes about 15 seconds.
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
   Top wins.
5. **Level:** `Top` (any case) from the optional `Level` column. A file without a Level column
   never changes anyone's Level. Top leads put their email(s), phone and GBP link on the
   do-not-contact list (reason `top`); losing Top removes those entries.
6. **Preview** (nothing written but the import): businesses, new, already known (updated),
   duplicates merged, Top, cities, without a GBP link, without a website, rows skipped, emails
   that look wrong, with up to 25 examples of each, plus new lists, ignored columns and empty
   tabs. A waiting preview reopens when the screen is opened again.
7. **Confirm** (needs the Google connection): Lead IDs continue from the highest one saved
   (`L-000001` …), one import at a time; the registry, lists and do-not-contact list are updated;
   the Leads tab is written. A new Sheet gets a Leads tab with the header row; missing headers
   are added at the end. Rows are found by Lead ID and columns by header name; new leads are
   appended, known ones updated in place, **only the import's columns**, and an empty value
   never blanks a filled cell. Every value is written as plain text (`RAW`), so a cell starting
   with `=` can't become a formula. Writes are batched (500 ranges, 2,000 rows a call) and
   retried after Google's "too many requests". If the Sheet can't be written, nothing is saved
   and the same Lead IDs are used on the next try. Once confirmed, the import keeps only its
   counts.
8. **Lists** (one per City + Niche) are created by confirmed imports and shown on the Import
   screen with their businesses and Top counts; Owners and Admins switch a list on or off.

### 6.5 Benchmarks and Website Standards

- **GBP Benchmark file** (Owners and Admins): an `.xlsx` (max 5 MB), any sheet whose header row
  (within the first five rows) has City and Niche. Columns: Additional categories, Services,
  Photos, Posts (90 days), Description length, Reviews, Rating (0–5), Review reply % ("85%" or
  0.85), Reference businesses; other columns are listed and ignored. **Check the file** shows
  the rows, the rows that replace an existing City + Niche (case ignored), and every problem by
  row (not a number, out of range, City or Niche missing, a pair twice). **Save** works only on
  a file without problems. An empty cell means "don't compare this". A benchmark can be deleted.
- **Website Standard** (one per niche): services (name, other names, must-have or not);
  service pages (words, sections, FAQ, price, own photos, reviews, call to action, service
  area); location pages (words, city in title, local content, local photos, all services
  linked, local reviews, map, city FAQ, call to action, most text shared with another location
  page); supporting pages; blog posts a month and topics; mobile LCP target. Owners and Admins
  edit **one draft** per niche (starting from the version in use); an **Owner locks** it as the
  next version (`cleaning-v2`), which needs at least one must-have service. Older versions stay
  readable. Agents only ever see the latest locked version; a niche without one is
  `NO_STANDARD`.

### 6.6 Alerts

| Event | Who | Channel |
|---|---|---|
| A run failed, or the agent stopped answering (timed out) | Owners and Admins | email + Telegram group |
| A run stopped because a budget was used up | Owners and Admins | email + Telegram group |
| More than 20% of a run's items failed (at least 5 items) | Owners and Admins | email + Telegram group |
| The DataForSEO balance is under the threshold (default $10; checked once a day) | Owners | email + Telegram group |
| A connection's Test that used to pass now fails | Owners | email + Telegram group |
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

## 7. Screens

1. **Sign in**, **Create the Owner account**, **Accept invite**, **Reset password**.
2. **Overview:** today's and this month's cost against budgets; each agent's last run,
   status and next run; leads by list and how many each agent has done.
3. **Import:** upload box with the Niche picker; the preview; past imports with counts.
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
9. **Deployment and hardening:** production Compose, Caddyfile, backups and a restore test,
   `ops/deploy.md`, Playwright e2e (sign in → connections → import → agent run → runs).
