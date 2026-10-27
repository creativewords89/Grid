# AI Agent Cold Outreach Planning

The main plan for GridRankers' cold-outreach system: a set of AI agents that audit local
businesses (Google Business Profile, website, social media), turn the weak spots into
outreach, and hand interested leads to a person. Every agent is run from one place, the
**Agent Hub**.

This file holds the decisions that apply to the whole system. Each part has its own spec:

| Part | Spec | State |
|---|---|---|
| Agent Hub | [hub/SPEC.md](hub/SPEC.md) | Being built (step 1 done) |
| GBP audit agent | `agents/gbp-audit/SPEC.md` | Decided (section 5), spec written before its build |
| Website audit agent | `agents/website-audit/SPEC.md` | Decided (section 6), spec written before its build |
| Social media audit agent | `agents/social-audit/SPEC.md` | Data source not decided |
| Outreach agents | later | Direction agreed (section 7) |

Planning happened in Bangla in three conversations on 25–27 October 2026, merged into one.
This file is the record; where it and an older message disagree, this file wins.

---

## 1. Goals

- Audit every lead the team uploads and find the weak spots that GridRankers can fix.
- Write outreach from those weak spots, with evidence a business owner can check
  (a specific page, a specific GBP field), never a generic pitch.
- Send, follow up and answer replies with a person in control; hand interested leads over
  for WhatsApp, phone or a meeting.
- Learn from results over time, but only change strategy on real evidence.
- Run everything from one website (the Hub): files are uploaded there, agents are switched
  on and off there, and API keys are entered there.

### Non-goals (first version)

- Finding leads automatically. The team builds the lead files by hand.
- Scraping Google Maps, Facebook or Instagram. GBP data comes from DataForSEO only.
- Solving CAPTCHAs, rotating proxies or any other way around a site that blocks us.
- Ranking, backlink, search-volume or index checks.
- AI closing sales. A person does that.

## 2. The system

```
                 ┌──────────────── AGENT HUB (hub.gridrankers.com) ────────────────┐
                 │ Sign-in · Import · Agents (on/off, limits) · Runs · Connections  │
                 │ Benchmarks · Website Standards · Users · Alerts (email/Telegram)│
                 └───────┬───────────────┬───────────────┬───────────────┬─────────┘
                         ▼               ▼               ▼               ▼
                   ① GBP audit     ② Website audit  ③ Social audit  ④ Outreach agents
                         └───────────────┴───────┬───────┴───────────────┘
                              Master Google Sheet (Leads) + Google Drive (JSON, PDF)
```

- **Separate agents.** Each agent is its own Python package and Docker container, with its
  own tests and version. One breaking never stops the others.
- **One Hub.** Login, settings, secrets, schedules, runs, costs and alerts live in the Hub.
  Agents hold no secrets of their own: they get what they need from the Hub when a run starts.
- **Agents ask the Hub for work** (they poll it); the Hub never needs access to Docker.
  The Hub builds each agent's settings form from a manifest the agent sends it.
  Details: [hub/SPEC.md](hub/SPEC.md) section 6.2.
- **Server:** our own Ubuntu 24.04 server with a **US IP address**, Docker Compose.
  Code and specs live in this repository; secrets never do.
- **Language:** reports, summaries and findings in English. Code in Python (agents and Hub
  backend) and TypeScript (Hub website).

## 3. Shared rules for every agent

### 3.1 Where data lives

| Data | Lives in | Why |
|---|---|---|
| Leads and each agent's result columns | **Master Google Sheet**, Leads tab | The team reads and filters it every day |
| Full audit results | **Google Drive**: `leads/{Lead ID}/gbp.json`, `website.json`, `social.json`, older ones in `history/`; reports as PDF next to them | Too big for a cell; the next agents read them |
| Users, secrets, settings, agents, runs, costs, imports, Lead ID registry, benchmarks, Website Standards | **Hub database** (PostgreSQL) | Needs exact state and access control |
| Outreach later (emails sent, replies, opt-outs, follow-up dates, do-not-contact list) | **Hub database** | A sent email must never be sent twice; an opt-out must never be emailed again |

The Sheet may show an `Outreach Status` column for reading only.

### 3.2 Master Sheet, Leads tab

- **Columns the Hub writes on import:** `Lead ID, City, Niche, Level, Business Name, GBP Link,
  Address, Website, Phone, WhatsApp, Facebook, Instagram, Email, Reviews, Rating, Notes`.
- **Columns each agent owns** (5 per agent): `GBP …`, `WEB …`, `SOC …` followed by
  `Status, Score, Summary, JSON, Audited At`. The Website agent also writes `WEB Report`
  (open decision 3).
- Agents find **rows by Lead ID** and **columns by header name**, never by position, so
  sorting or moving columns breaks nothing.
- An agent only ever writes its own columns. Nobody's input columns are changed by an agent.

### 3.3 Lead files the team uploads

- The team uploads `.xlsx` files in the Hub (**Import** screen). The template is the current
  one: one tab per city, columns `Business name, MAP, Address, City, Website, Phone, WA,
  Facebook, Instagram, Email, Reviews, Average`, plus an optional `Level` column.
- **One Niche per file**, chosen when uploading (for example Cleaning, Construction).
- The Hub accepts the header spellings already in use (`Map URL`, `MAP URl`, `Whatsapp`,
  `WP`, `E-mail`, `Gmail`, `Number of Reviews`, `Ratings`, `Average Ratings` …), takes the
  city from the tab name when there is no City column, trims spaces and line breaks, and
  removes `utm_` tracking from website links.
- **Duplicates** (same GBP link or same phone) become **one lead**; every different email is
  kept on it. A re-import updates the existing lead instead of adding a row.
- Before anything is written the Hub shows a **preview** (new, updated, duplicates merged,
  rows without a GBP link, empty tabs), and the person confirms.
- `Reviews` and `Average` from the file are kept for reference only; audits use fresh data.
- Full rules: [hub/SPEC.md](hub/SPEC.md) section 6.4.

### 3.4 Level

| Level | Audited | Outreach |
|---|---|---|
| `Top` | **No** (neither GBP nor website) | **Never** |
| empty | Yes | Yes |

- `Top` means the business is already at the top of its market; we will not contact it.
  The team marks it in the `Level` column of the lead file.
- "Never" is a hard rule: Top leads never enter the outreach list, and their email, phone and
  GBP link go on the do-not-contact list so a duplicate row can't slip through.
- **Franchises are outreached like everyone else.** Detecting them automatically could drop
  good leads by mistake. The Website agent only reuses domain-wide checks (speed, HTTPS)
  across leads sharing a domain, and records how many leads share it.

### 3.5 Benchmarks

Benchmarks are **uploaded by the team**, not computed from Top businesses.

- **GBP Benchmark**: an Excel file, one row per City + Niche (Hub screen **Benchmarks**).
  Columns: `City, Niche, Additional categories, Services, Photos, Posts (90 days),
  Description length, Reviews, Rating, Review reply %, Reference businesses`.
  Every value column is optional; an empty cell means "don't compare this".
- **Website Standard**: one per Niche, entered in a Hub form and versioned
  (`cleaning-v1`): must-have services with synonyms, service and location page depth,
  supporting pages, blog posts per month, blog topics (topical map), mobile LCP.
- No benchmark for a City + Niche → comparison checks are skipped and the rest is scored out
  of 100. No Website Standard for a Niche → status `NO_STANDARD`, no website audit.

### 3.6 JSON envelope (every agent)

```json
{
  "schema_version": 1,
  "agent": "gbp",
  "lead_id": "L-000123",
  "audited_at": "2026-10-25T10:30:00Z",
  "input": {},
  "data": {},
  "findings": [
    {"code": "GBP_NO_RECENT_POSTS", "severity": "high", "message": "…", "url": null,
     "value": 47, "benchmark": 9, "top_profiles": []}
  ],
  "score": 62,
  "coverage": "full",
  "discovered": {"website": "https://…", "facebook": "https://…", "emails": []},
  "raw": {}
}
```

- `data` differs per agent; everything else is the same, so later agents read all files
  the same way.
- `discovered` is how agents help each other: the GBP agent records the website it found;
  the Website agent records social links, emails, phones and the CMS.

### 3.7 Evidence rules

- Every finding carries its evidence: the value, the benchmark, the page URL where relevant,
  and the audit date.
- **Missing data is never a problem.** If a source doesn't return something, the check is
  "unable to verify", is left out of the score, and is never mentioned in a report or email.
- Statuses are explicit (`NO_WEBSITE`, `BLOCKED`, `NO_STANDARD` …) so a failed audit is never
  mistaken for a weak business.

## 4. Agent order and daily runs

1. GBP audit (needs DataForSEO).
2. Website audit (uses `gbp.json` for the website fallback and the GBP match).
3. Social audit.
4. Outreach agents.

Each agent runs daily at the time, limit and budget set in the Hub, skips leads audited
within its re-audit window, and stops when its own budget or the Hub's total daily budget is
used up.

## 5. GBP audit agent (decided)

- **Data:** DataForSEO only, Standard queue: Business Info, Updates (posts), Reviews (latest
  50). About **$0.01 per profile**. No manual GBP data. No AI cost.
- **Skips** leads with Level `Top`.
- **Score (100):**

  | Part | Points | Checks |
  |---|---|---|
  | Basics | 20 | claimed, phone, website, hours, full address (not for service-area businesses), keyword-stuffed name; Sheet phone/address differ from GBP |
  | Categories | 15 | primary matches the Niche, number of additional categories, vs benchmark |
  | Description | 10 | missing, under 250 characters, no city, no niche keyword, vs benchmark |
  | Services | 20 | none, fewer than 5, no descriptions, vs benchmark |
  | Photos | 10 | under 10, no logo or cover, vs benchmark |
  | Posts | 25 | never posted, last post over 30 days ago, under 4 in 90 days, no image or button, vs benchmark |

- **Reviews** (count, rating, recent reviews, reply rate, unanswered 1–2★): collected and shown
  in a Reviews section of the report, **not scored and not used in outreach**. A Hub switch
  "Use reviews in outreach" (off) can allow it later. Q&A is not checked.
- **Benchmark comparison:** lead ÷ benchmark under 25% → 🔴, 25–60% → 🟠, 60%+ → ✅.
  Reference business names from the benchmark file may appear in findings, not in the Summary.
- **Output:** `GBP Status, Score, Summary, JSON, Audited At`; `gbp.json` in Drive;
  `discovered.website` for the Website agent.

## 6. Website audit agent (decided)

- **Compares only against the Niche Standard.** (Top/benchmark businesses are a GBP matter.)
- **Website to audit:** the Sheet's Website; if empty, the GBP website.

  | Sheet Website | GBP website | Result |
  |---|---|---|
  | empty | none | `NO_WEBSITE`: the strongest hook; no score |
  | empty | present | audit the GBP website; never say "no website" |
  | Facebook, Linktree, Yelp … | – | `NOT_OWN_SITE`: strong hook |
  | present | – | normal audit |

  Building a website is part of GridRankers' SEO service, so the offer is the SEO package
  including the website.
- **Own crawler, cost about $0:** `httpx`, `selectolax`, Playwright only for JavaScript-heavy
  sites and the screenshot, `extruct` for schema. US-IP server, no proxy (support stays in the
  code, switched off in the Hub).
- **Which pages:** first classify every URL from the sitemap, menu and footer (service,
  location, supporting, blog, other) without opening them. Then open: the homepage; service
  pages (all up to 10, otherwise a random 8–10); location pages (same rule); the Contact page
  only if phone, address or hours aren't on the homepage. Supporting pages and blog posts
  are never opened. **At most 22 pages.** 100 sites in about 15–20 minutes.
- **Score (100):**

  | Part | Points | What |
  |---|---|---|
  | Service pages | 35 | each must-have service: Missing / Thin / Standard / In-depth |
  | Location pages | 20 | a location page is a small homepage: city in title/H1, local content, local photos, all services linked, local reviews, map, FAQ, CTA, words, duplicate-template check |
  | Speed and access | 10 | mobile LCP and score (PageSpeed Insights); site opens, HTTPS, not blocking Google |
  | Supporting pages | 10 | FAQ, Reviews, Gallery, About, Contact, Pricing: present or missing |
  | Blog | 10 | total posts, last post, posts in each of the last 3 months, topic coverage |
  | GBP match | 15 | name/address/phone, category, services, service areas, hours, schema vs `gbp.json` |

- **Dropped on purpose:** image SEO, sitemap and robots.txt detail, broken links, duplicate
  titles, schema errors, search volume, ranking, 36-month blog chart, post quality.
- **Blocked sites:** crawler → Playwright → partial report from PageSpeed data → retry next
  day, then 3 days later → `BLOCKED_FINAL`. Unseen parts are left out of the score
  (`coverage: partial`) and the report says so.
- **Output:** English PDF report (sample: https://claude.ai/artifact/7xuNwndPhBuwxbaSNySLrn),
  "Pages we reviewed" with URLs, `pages_audited[]`, 3–5 `outreach_hooks`, 3 quick wins, mobile
  screenshot, `discovered{}`; Sheet columns `WEB Status, Score, Summary, JSON, Audited At`.
- **Statuses:** `OK, NO_WEBSITE, NOT_OWN_SITE, UNREACHABLE, PARKED, NO_STANDARD, BLOCKED,
  BLOCKED_FINAL, ERROR`.

## 7. Outreach (direction agreed, designed later)

Order after the audits: **Opportunity & scoring → Email writing → Sending and follow-up →
Reply agent → Handoff (WhatsApp/phone by a person) → Learning.**

- The Opportunity agent picks the single strongest, verified weak spot for the first email and
  keeps the others for follow-ups.
- At first a person approves every email. Auto-send for a kind of email is earned only when
  measured approval-without-edits is high.
- Hard rules that no confidence score can override: opt-outs, Top leads, approved pricing,
  no guaranteed results, no unverified claims.
- Learning collects outcomes from day one but changes strategy only on enough evidence, and
  never touches permissions, privacy, opt-out or security rules.

## 8. Build order

1. **Agent Hub** ([hub/SPEC.md](hub/SPEC.md) section 12): skeleton, sign-in, connections,
   agents, scheduler and runs, import, benchmarks, alerts, deployment.
2. **GBP audit agent**, with the shared agent library (`agents/core`: Hub client, Sheet,
   Drive, envelope).
3. **Website audit agent**, then the Niche Standard for each starting niche.
4. **Social audit agent** (after its data source is chosen).
5. **Outreach agents**, one at a time.

One build step per task; each step ends green on CI before the next starts.

## 9. Open decisions (defaults used until answered)

1. **Reference business names** in reports: shown when the benchmark file's
   `Reference businesses` column is filled; otherwise numbers only.
2. **Website Standard** is entered in a Hub form (not Excel).
3. **`WEB Report` column** (link to the PDF) is added next to the Website agent's 5 columns.
4. **Report format:** PDF in Drive. A tracked web link (who opened it) can come later.
5. **Lead capture** section (booking/quote form, tap-to-call, Google reviews on the site): not
   added for now.
6. **Starting niches:** Cleaning and Construction (the two files shared so far).
7. **Team roles:** Owner, Admin, Viewer as in [hub/SPEC.md](hub/SPEC.md) section 3; team size
   to be confirmed.
8. **Alerts:** email and a new Telegram bot and group (not the Answer Engine's reviewer group).
9. **Social audit data source:** not chosen.
10. **Prospects are in the USA** (every file so far): US anti-spam rules (CAN-SPAM) apply.
    To be confirmed before the sending agent.
11. **Email provider and sending domain:** to be chosen before the sending agent; a separate
    sending domain is recommended.
