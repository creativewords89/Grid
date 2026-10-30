# GBP audit agent

Built into the Hub (hub step 25: Agents → **+ Add agent** → GBP audit agent). It does the
batches' **GBP Audit** task. Decisions behind it: [PLAN.md](../../PLAN.md) section 5, and the
planning conversation of 30 October 2026, which changed them as below.

## 1. What it does

1. **Collect** (hub step 48, built): the profile, its posts and latest reviews, as they are
   on Google.
2. **Compare** (hub step 51, built; section 5): the collected data against the batch's
   benchmark (GBP part): findings and a score. This is the **audited result**, and where the
   GBP audit agent stops.

Opportunities and email copy are **not** this agent's job (decided 30 October 2026): a
separate **Opportunity Finder** agent (the batches' Opportunity Finder task, after GBP Audit
and later Website Audit) turns the audited results into opportunities for the email
campaign, with an AI API, using only the findings it is given. Anything collected can feed
it, not only what the benchmark compares, e.g. the website doesn't open, or the profile's
website isn't the business's own domain (`business.wixsite.com`, `sites.google.com`, a
Facebook or Linktree link). It is planned separately, later.

The Basics collected (name, phone, website, address, hours) are the business's
**standard**: the Website agent later compares the website's details with them. Nothing is
compared with the lead file.

## 2. Finding the profile

- The lead's **GBP link** (MAP column) names the profile: `cid=` / `ludocid=`, the second
  half of a `0x…:0x…` feature id (the CID in hex), or a Place ID. A short link
  (`share.google`, `maps.app.goo.gl`, `goo.gl`, `g.page`, `g.co`) is followed to its target
  first.
- DataForSEO is asked by `cid:…` (or `place_id:…`), so the right profile is audited.
- A link without an ID: the profile is looked up by **name and address**; it is the lead's
  only with the same phone or most of the lead's name in the profile's name. Otherwise
  `NOT_FOUND`.
- No GBP link: `NO_GBP_LINK` (skipped). Top leads are never audited.

## 3. DataForSEO

- Standard queue, United States (location 2840), English: **Business Info**, **Updates**
  (the latest *Posts to collect*, 20 by default; charged per 10) and **Reviews** (the latest
  *Reviews to collect*, 50 by default, newest first). About $0.01 a lead. The Standard
  queue can take half an hour or more for posts and reviews: a **test** (hub step 50) always
  uses DataForSEO's high priority (results in minutes, about twice the cost), and runs do
  when *Faster DataForSEO queue* is on.
- A lead whose profile is found shows `PROFILE_FOUND` ("waiting for its posts and reviews")
  until its result is saved; it isn't finished, so a run that ends first tries it again.
- Tasks are posted at once (100 per request, each tagged with its Lead ID) and fetched until
  ready, at most *Longest wait* (60 minutes by default); a lead not ready by then is tried
  again on the next run. The agent reports to the Hub while it waits, so Stop and the budget
  stop it.
- Posts and reviews are asked only for profiles found and not permanently closed.
- The key is the Connections screen's DataForSEO login and password; without it a run fails
  at once.

## 4. What is collected

Nothing missing is ever a problem: what DataForSEO doesn't give is `null` and listed in
`unknown` ("unable to verify").

| Part | Collected |
|---|---|
| Basics | business name, claimed or not, phone, website, full address, latitude/longitude, opening hours (each day), current status (open, temporarily closed, closed forever), attributes, CID, Place ID |
| Categories | primary category, additional categories ("None on the profile" when it has none) |
| Description | the text and its length |
| Photos | number of photos, logo, cover photo |
| Posts | every post collected (date, text, link, image or not, button), the last post's date, posts in the last 30 and 90 days |
| Reviews (shown only: not scored, not used in outreach) | count, rating, stars 5 to 1, last review date, the latest reviews (stars, text, date, owner's reply), reply rate, unanswered 1–2★ reviews |

Removed in planning: keyword-stuffed name, service-area business, price level, place topics,
the file's phone/address compared with GBP. Removed after the first real reports (30 October
2026): **GBP services** (DataForSEO doesn't give them reliably; the team dropped the idea),
and booking link, payment methods, last updated and "people also search for", which
DataForSEO didn't give. The Website Standard's services are a different thing and stay.

## 5. Comparing with the benchmark (stage 2)

The collected data against the batch's benchmark (GBP part); an empty box isn't compared.

- **A benchmark number:** the lead's value ÷ the benchmark's: under 25% 🔴, 25–60% 🟠,
  60% or more ✅. Additional categories, photos, posts in 90 days and description length
  are scored; reviews, rating and reply % are compared and shown, never scored.
- **Right primary categories** (a new benchmark box, one a line): a primary category that
  isn't one of them is 🔴.
- **What the profile misses** (no benchmark needed): not claimed, no phone, website,
  address, hours, description, logo or cover photo, never posted: 🔴.
- **The description, checked by Claude** (hub step 52): with the Anthropic key from
  Connections and the agent's *Claude model for the description* (Claude Opus 5.5 by
  default, about $0.01 a lead; Claude Haiku 5.5, about $0.0003). Claude says whether the
  description names the business (without "LLC" …), its primary category (close wording
  counts), its city, and which of the benchmark's Website Standard **must-have services**
  (with their other names), quoting the description's own words; a yes whose words aren't
  in the description is a no. Not every service is needed: **at least 3** (the benchmark's
  *Must-have services named in the description*, or all when fewer) is ✅, 1–2 🟠, none
  🔴. Brand or category missing: 🔴; city missing: 🟠, shown, not scored. Without a
  description, a key or a usable answer these checks are unable to verify. Structured
  output (JSON schema), low effort; on Opus, refusals fall back server-side.
- **What DataForSEO didn't give** is never a finding: that check is left out of the score
  and listed in `unverified`.
- **Score** (100, over the checks that could be made): Basics 20 (claimed, phone, website,
  address, hours: 4 each), Categories 35 (primary 20, additional categories 15),
  Description 10 (there 2, length 2, business name 2, category 2, main services 2), Photos 10 (count 6,
  logo 2, cover 2), Posts 25 (ever posted 10, in 90 days 15). A ratio earns its share of the
  points; a present/missing check all or nothing.
- A pasted link in a test has no batch, so no benchmark: only what the profile misses.

## 6. Result

- Status: `AUDITED` (compared, with a score), `CLOSED` (permanently closed: Basics only),
  `NOT_FOUND`, `NO_GBP_LINK` (skipped) or `FAILED` (tried again on the next run).
- Summary: only the score and the counts, e.g. "Score 70 · 2 red · 2 orange"; the
  findings say the rest.
- The result keeps the benchmark's id and version, so a new version of the benchmark has
  the lead checked again.
- `details`: the JSON envelope (PLAN.md section 3.6) with `benchmark`, `data` as above,
  `findings` (red and orange first, each with its part, code, value, benchmark and whether
  it is scored), `score` and `unverified`; the latest reviews and all but 5 posts only in
  the file.
- `gbp.json`: the full envelope, listed with the lead.

## 7. Settings

Leads per run (50), Posts to collect (20), Reviews to collect (50), Faster DataForSEO queue
(off), Longest wait for
DataForSEO (60 minutes). Daily limit and budget are the Hub's (Agents screen).
