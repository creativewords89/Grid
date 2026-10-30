# GBP audit agent

Built into the Hub (hub step 25: Agents → **+ Add agent** → GBP audit agent). It does the
batches' **GBP Audit** task. Decisions behind it: [PLAN.md](../../PLAN.md) section 5, and the
planning conversation of 30 October 2026, which changed them as below.

## 1. Three stages

1. **Collect** (hub step 48, built): the profile, its posts and latest reviews, as they are
   on Google. Nothing is compared or scored.
2. **Compare** (hub step 51, built; section 5): the collected data against the batch's benchmark (GBP part).
3. **Opportunities** (last): the list of what GridRankers can fix. Not only what the
   benchmark compares: anything collected can be one, e.g. the website doesn't open, or
   the profile's website isn't the business's own domain (`business.wixsite.com`,
   `sites.google.com`, a Facebook or Linktree link).

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
| Basics | business name, claimed or not, phone, website, full address, latitude/longitude, opening hours (each day), current status (open, temporarily closed, closed forever), booking link, attributes, payment methods, last updated, "people also search for", CID, Place ID, GBP link |
| Categories & Services | primary category, additional categories, services with their descriptions (if DataForSEO gives them) |
| Description | the text and its length |
| Photos | number of photos, logo, cover photo |
| Posts | every post collected (date, text, link, image or not, button), the last post's date, posts in the last 30 and 90 days |
| Reviews (shown only: not scored, not used in outreach) | count, rating, stars 5 to 1, last review date, the latest reviews (stars, text, date, owner's reply), reply rate, unanswered 1–2★ reviews |

Removed in planning: keyword-stuffed name, service-area business, price level, place topics,
the file's phone/address compared with GBP, additional-category and service counts compared
with the benchmark (they come back in stage 2 if the team wants them).

## 5. Comparing with the benchmark (stage 2)

The collected data against the batch's benchmark (GBP part); an empty box isn't compared.

- **A benchmark number:** the lead's value ÷ the benchmark's: under 25% 🔴, 25–60% 🟠,
  60% or more ✅. Additional categories, services, photos, posts in 90 days and description
  length are scored; reviews, rating and reply % are compared and shown, never scored.
- **Right primary categories** (a new benchmark box, one a line): a primary category that
  isn't one of them is 🔴.
- **What the profile misses** (no benchmark needed): not claimed, no phone, website,
  address, hours, description, logo or cover photo, never posted: 🔴. Services without a
  description: 🟠 (🔴 when none has one), when DataForSEO gives services.
- **What DataForSEO didn't give** is never a finding: that check is left out of the score
  and listed in `unverified`.
- **Score** (100, over the checks that could be made): Basics 20 (claimed, phone, website,
  address, hours: 4 each), Categories & Services 35 (primary 15, additional categories 10,
  services 5, service descriptions 5), Description 10 (there 4, length 6), Photos 10 (count 6,
  logo 2, cover 2), Posts 25 (ever posted 10, in 90 days 15). A ratio earns its share of the
  points; a present/missing check all or nothing.
- A pasted link in a test has no batch, so no benchmark: only what the profile misses.

## 6. Result

- Status: `AUDITED` (compared, with a score), `CLOSED` (permanently closed: Basics only),
  `NOT_FOUND`, `NO_GBP_LINK` (skipped) or `FAILED` (tried again on the next run).
- Summary, e.g. "Score 70 · 2 red · 2 orange: Description length: 44 vs 600 in the
  benchmark; Posts in 90 days: 1 vs 12 in the benchmark; …".
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
