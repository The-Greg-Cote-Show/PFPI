# PFPI Build Log

## 🔗 READY TEST LINK — picks.html redesign (2026-08-25)

**https://the-greg-cote-show.github.io/PFPI/picks.html?token=pfpi-preseason3-test**

Real token, already seeded in KV, valid now — no need to generate one
yourself. Points at "Gentry's Neanderbrows" against the real, live
preseason Week 3 schedule (16 real games, real kickoff times, real
per-game deadlines already computed). One pick (PIT, in the first
Thursday game) is already saved from my own verification pass, on purpose
— left in so you immediately see the pre-selected/pre-filled behavior
working the moment you open the link, not stripped out. Everything else
is untouched for you to click through fresh.

Running log of every significant action taken by Claude Code during the build,
in order. Secret values are never logged, only names. See
`PFPI_Claude_Code_handoff_brief.md` (in the parent folder, not committed to
this repo) for the full spec this build follows.

## 2026-08-25 — live-testing feedback: preseason picks fix, single-submit-email redesign, admin correction form

Yeti tested `picks.html` live (real browser, both desktop and mobile) against
the real preseason Week 3 schedule and reported back three things. All three
are now **done, deployed, committed, and pushed** (worker version
`e6f4c83`'s commit; picks-worker.js deploy Version ID `fbdac9fd` for the
correction form, `46f59067` for the picks-merge fix):

1. **"The picks aren't translating to the live site"** — real bug, root
   cause found: `worker.js`'s preseason publish step (`pollAndPublish()`)
   was overwriting `data/week-preseason-3.json` with Highlightly's raw
   response every poll, which has no concept of PFPI picks at all — the
   regular-season path merges saved KV picks into the public JSON but the
   preseason path never did. Fixed by merging saved
   `picks:preseason-3:${team}` KV data (both the real 8-team roster and the
   two sandboxed `FAMILY_MEMBERS` test teams) into each game before
   publishing. **Verified live** via the one-time manual-bypass technique
   (forced `shouldPollHighlightlyThisTick` to fire once outside its normal
   window, confirmed `"picks": {"Roughriders": "BUF", "Gentry's
   Neanderbrows": "PIT"}` landed correctly on a real game, then reverted the
   bypass).

2. **"An email is sent to the admin for every pick someone makes. That's not
   good."** — redesigned into a save/notify split. `POST /submit-picks`
   (fires on every pick-button click) now only saves, silently, no email.
   New `POST /confirm-picks` fires exactly once when the visitor clicks the
   new Submit button on `picks.html`, and sends ONE email listing the
   visitor's full current picks, tagging only picks that changed since the
   last notified submission with `(Updated)` — brand-new picks show
   plainly, per Yeti's exact spec ("New picks should just show what the
   pick was"). Tracked via a `notified-picks:${week}:${team}` KV snapshot.
   Submit button has the exact note text Yeti specified above it: "Picks
   will be sent to the commissioner. If a mistake was noticed after the
   deadline, please contact the commissioner and email yeti@yetiblanc.com
   for edit approval." **Verified live.**

3. **"We'll need a way for me as the admin to send a correction form. That
   will be much better than me making the changes."** — new admin.html
   panel ("Send correction form"), team/week/gameId inputs, calls new
   `POST /admin/send-correction-email`. Generates a 24h-TTL token
   (`generateCorrectionToken`) carrying a `correctionGameId` that unlocks
   exactly that one game past its deadline — every other game on the token
   stays locked normally (`handleGetPicks`/`handleSubmitPicks` both check
   `g.id === correctionGameId`). `picks.html` shows a banner when a
   correction link is in use, so whoever's using it knows only one game is
   unlocked. Per Yeti's answer when asked who this should be able to email
   ("Only ever to yourself (Recommended for now)") — it always sends to
   `ADMIN_EMAIL` (`yeti@yetiblanc.com`), never a request-supplied recipient;
   revisit this once real family emails are onboarded. **Deployed and
   pushed; not yet exercised live end-to-end** — next step if you want full
   confidence is to actually trigger one from admin.html and confirm the
   email arrives and the named game genuinely unlocks past its deadline
   while everything else on that link stays locked.

**Still open / known, not touched this pass:** real weekly picks emails to
family members are still blocked by the unverified `thegregcoteshow.com`
Resend sending domain — needs actual DNS verification on your end, not a
workaround. Yeti also mentioned "a couple of tweaks" to `picks.html`'s
appearance on live testing but hadn't specified what yet as of this entry.

## Start here: what's live vs. what needs you

**2026-08-25, ~10:30 AM ET — explicit status check on both handoffs tonight,
requested by Yeti in plain terms (done-and-verified / done-but-untested /
not-done, no vague summaries). Copied here verbatim as the authoritative
current status; superseded only by a later dated entry, not by anything
above this block:**

*Polling throttle / preload:*
1. `[triggers]` fix committed and pushed — **done and verified** (`8779add`).
2. Highlightly throttled to Aug 27/28/29 only — **done and verified that it
   stays off** (7 real hours of zero calls confirmed via git history between
   the throttle deploy and a deliberate one-time manual bypass). **The
   actual in-window 3-min/5-min cadence is unverified** — can't be tested
   until Thursday.
3. Big Balls throttled to "~15-20 sec live / less otherwise" — **not done
   as literally specified, a deliberate substitute already flagged below**:
   every cron tick (1-min floor, no Durable Object alarms added) during
   live windows, every 15 min otherwise. **The 15-min "otherwise" half is
   verified** (real commits at 09:30/09:45/10:00/10:15 ET, exactly 15 min
   apart). **The every-tick "live window" half is unverified** — no live
   window has occurred yet.
4. Full 18-week/272-game preload — **done and verified**:
   `{"loadedAt":"2026-08-25T06:30:23.673Z","totalGames":272,"weeks":18}`.

*Four changes:*
5. Weekly deadline email lists real per-day deadlines — **done but
   unverified end-to-end**. Logic unit-tested and passing; never fired live
   (gated behind Tuesday 7am ET, which had already passed today before this
   was built — next real firing is next Tuesday).
6. Submission notification email — **done and verified live** (real test
   submission, 200 response, clean `wrangler tail` with zero errors).
   Placeholder used: `GREG_EMAIL` = `ADMIN_EMAIL` = `yeti@yetiblanc.com`
   (already-set placeholder, not invented here). Confirmed no email sent to
   any real, uninvolved address — a dedup guard prevents double-sending
   while both addresses are identical.
7. Brief publisher reopened for all weeks — **done and verified live**
   (real login, dropdown genuinely lists Week 1-18). Single boolean flag,
   no structural change — see the reminder immediately below this block.
8. Tie nullification — **scoring math done and verified** (isolated unit
   test proves both the fix and the denominator exclusion). **Frontend note
   built but unverified live** — no real tie exists yet (season hasn't
   started); not faked for testing, per explicit instruction.

**Judgment calls/blockers worth knowing even though marked done:** item 3
above never hit its literal spec, by necessity, not oversight. The
`[triggers]` bug reversed a deliberate original-build decision that had
never been tested against a real redeploy. A real crash (undefined `picks`
on preseason games) shipped and was caught only by live browser testing,
not code review — worth remembering that review alone isn't sufficient
for this codebase's JS.

**REMINDER — TEMPORARY TESTING FLAG LIVE:** `brief.html`'s
`TESTING_ALLOW_ALL_WEEKS` is currently `true`, so the brief publisher's week
selector allows any week 1-18, not just the current week. **Revert this to
`false` before real weekly use begins** — see the 2026-08-25 "four changes"
entry below. Easy to miss since nothing else calls this out; flagging it
here too on purpose.

**CRON TRIGGERS: the earlier "confirmed live in the dashboard" note below
was real but incomplete — a plain `wrangler deploy` was later found to
silently CLEAR that same dashboard-set trigger.** Fixed properly by moving
`[triggers]` into `wrangler.toml`/`wrangler-scores.toml` directly (deploys
now actively maintain the schedule instead of just not touching it) — see
the dedicated 2026-08-25 entry below for the full A/B proof and root cause.
Both Workers are now genuinely, durably live: 15+ real automated commits
observed on `main` across multiple consecutive cron ticks after the fix.

**HIGHLIGHTLY PRESEASON WEEK 3 — PASS, 16/16 real games verified.** All 16
real games for Aug 27-29, 2026 (4 on the 27th, 10 on the 28th, 2 on the
29th, per the ESPN schedule Yeti pasted directly in chat) were retrieved
from Highlightly's API and matched matchup-for-matchup and kickoff-time-
for-kickoff-time against that real schedule — not "it seems to work," an
actual 16-for-16 count-and-content comparison. See the 2026-08-25
Highlightly entry below for the full detail, including a real coverage
bug in the naive query approach that had to be diagnosed and worked around
before this passed (a UTC-vs-Eastern date-bucketing issue, not a genuine
data gap — full explanation below).

**Working right now:** repo public at github.com/The-Greg-Cote-Show/PFPI, both
Workers deployed with cron triggers actually running (confirmed live in the
Cloudflare dashboard 2026-08-25, not just configured), GitHub Pages serving
`index.html` / `picks.html` / `admin.html` / `brief.html`. **The site is now
genuinely 2026-scoped** — the 2025 simulation that used to be the default
view is archived (`archive/2025-simulation.html`), and the live site shows
real 2026 data where it exists and honest empty states where it doesn't
(expected right now, season hasn't started). Admin login (self-service reset,
brute-force lockout + alert email) and Greg's Brief publisher (own
independent login, same protections, admin correction path in `admin.html`)
are both live and tested against the real deployed Worker.

**Two things still need you:**
1. **DNS** — add a CNAME record `pfpi` -> `the-greg-cote-show.github.io` (same
   pattern as `cotecup`). Nothing at `pfpi.thegregcoteshow.com` will load
   until this is done.
2. **Resend domain** — verify `thegregcoteshow.com` at resend.com/domains.
   Until then the Worker can't send picks emails to anyone. (Admin/Greg
   account emails — login reset links, brute-force alerts — work today via
   Resend's default sender regardless, since those always go to a fixed
   internal address; see the 2026-08-24 entries.)

**Done as of 2026-08-25:** `BIG_BALLS_API_KEY`, `GITHUB_PAT`, and
`HIGHLIGHTLY_API_KEY` are all set (the last two on both Workers where
needed — see the cron and Highlightly entries below for why); cron
triggers are confirmed live in the dashboard for both (picks-worker
hourly, scores-worker every minute — neither had ever actually been
added, despite being flagged since the original build); the 2025->2026
switchover is done; the Big Balls preseason/postseason API was tested and
found to return zero PRE- or POST-type games ever, on any season (a
permanent dataset characteristic, not a timing gap); Highlightly was
wired in as a scoped stopgap specifically for preseason Week 3
(Aug 27-29, 2026) and verified 16/16 against the real schedule — see
above and below.

Full detail, reasoning, and exact commands for each are in the log below, in
the order they came up.

---

## 2026-08-24

- **[ASKED]** Prompted Yeti for the Resend API key before doing anything else,
  per the brief's hard rule. Yeti provided it in-session (not unattended
  tonight after all — this is a live session).
- **[LOCAL]** Created local working directory `PFPI/` (sibling to the brief
  and reference docs, so those reference-only files don't get committed to
  the public repo) and ran `git init`.
- **[GITHUB]** Created repo `The-Greg-Cote-Show/PFPI`, public, via `gh repo
  create`.
- **[CLOUDFLARE]** Created KV namespace `PFPI_KV` (id
  `3b5cd856fa7b40908601404f46b95456`), shared by both Workers.
- **[CODE]** Wrote `wrangler.toml` (picks worker, name `pfpi-picks-worker`)
  and `wrangler-scores.toml` (scores worker, name `pfpi-scores-worker`).
  Deliberately left `[triggers]` out of both, per the brief's explicit
  instruction that cron timing lives only in the Cloudflare dashboard
  Triggers tab (confirmed this matches Cote Cup's actual `wrangler.toml`,
  which also has no `[triggers]` block). **Action still needed from Yeti:**
  add cron triggers in the dashboard for both Workers once deployed:
  - `pfpi-picks-worker`: `0 * * * *` (hourly; the Worker's own guard only
    actually sends email once it's genuinely Tuesday 7am America/New_York)
  - `pfpi-scores-worker`: `* * * * *` (every minute; cheap no-op ticks are
    fine on the free plan, and the 1-minute Workers Cron floor is what the
    architecture doc calls out as the fallback if Durable Object alarms
    aren't used — used judgment per the brief and didn't add DO alarm
    complexity for a family site where sub-minute precision isn't needed)
- **[CODE]** Wrote `shared.js` — constants/helpers (`TEAMS`,
  `SEASON_START_ET`, ET date math, `computeGameDeadline`,
  `computeCurrentWeekFromDate`) shared by both Workers via ES module import,
  so the two can't drift on things like the current-week formula the way two
  independent copies could.
- **[CODE]** Wrote `picks-worker.js`, adapted from
  `pfpi_picks_worker_framework.js`. Core logic (token model, per-game DST-safe
  deadline math, PBKDF2 admin auth) preserved as-is, not rewritten. Added on
  top of the framework: a `GET /my-picks` endpoint (the framework only
  specced write endpoints; a frontend needs a read endpoint to render the
  picks form) and CORS handling (frontend is served from GitHub Pages, a
  different origin than this Worker).
- **[CODE]** Wrote `worker.js` (scores/schedule worker) from scratch per
  `PFPI_architecture_sketch_v1.md` — no reference code existed for this piece.
  Cron polls Big Balls Sports Data, writes `data/week-N.json`,
  `data/standings.json`, `data/current.json` to the repo via GitHub's Contents
  API, and also writes a minimal kickoff-time-only schedule cache into
  `PFPI_KV` so the picks worker can compute deadlines without depending on
  GitHub Pages' commit-to-CDN propagation lag (flagged as variable/untested
  in the architecture doc).
- **[RESEARCH]** Looked up Big Balls Sports Data's real docs
  (bigballsdata.com/nfl-api and its published openapi.json) instead of
  guessing at the API shape, since the brief specifically asked to check this
  if possible. Findings:
  - Base URL `api.bigballsdata.com`, `Authorization: Bearer <key>` auth
    confirmed against the actual OpenAPI security scheme.
  - Marketing page documents `GET /v1/nfl/games` returning "schedules +
    finals", and a `game_id` format of `YYYY_WW_AWAY_HOME` — meaning
    home/away **is** recoverable directly from the game ID. This resolves the
    checklist's "Big Balls schedule endpoint's home/away accuracy unverified"
    item: it's accurate, not a known limitation, once real data flows.
  - However, the actual published `openapi.json` does not contain any
    `/v1/nfl/*` path at all (only `/v1/nba/games` and sport-agnostic
    `/v1/matches`) — so the exact field names for score/status/kickoff time
    are NOT confirmed from authoritative docs, only inferred from the
    marketing copy and common REST sports-API conventions. Did not fabricate
    these with false confidence: isolated every such assumption inside one
    function, `normalizeGame()` in `worker.js`, with a loud comment, so it's
    a one-function fix once a real API key/response is available to verify
    against.
- **[SKIPPED — FLAGGED]** `BIG_BALLS_API_KEY` was not available tonight (not
  requested up front per the brief; the brief said flag and stub rather than
  block). `worker.js`'s poll function checks for this key and logs-and-skips
  the entire Big Balls fetch/publish step if it's missing, rather than
  fabricating placeholder score data and publishing it as if real. **Yeti:**
  once you have this key, `wrangler secret put BIG_BALLS_API_KEY --config
  wrangler-scores.toml` is all that's needed to turn polling on — but see the
  API-shape caveat above, worth a manual test request first.
- **[SKIPPED — FLAGGED]** `GITHUB_PAT` (fine-grained PAT scoped to only the
  PFPI repo, `contents:write`) is required by the architecture doc for the
  scores worker to commit JSON files, but wasn't in the brief's list of
  secrets to set. There's no API to create a fine-grained PAT — it's a manual
  GitHub web UI step (Settings > Developer settings > Fine-grained tokens),
  and using a broader token as a substitute wasn't something to decide
  silently. **Yeti:** create that token (repo: PFPI only, permission:
  Contents - Read and write), then `wrangler secret put GITHUB_PAT --config
  wrangler-scores.toml`. Until then, the scores worker still updates
  `current-week` in KV and logs-and-skips the GitHub commit step.
- **[CLOUDFLARE]** Deployed `pfpi-picks-worker` (`wrangler deploy`) ->
  `https://pfpi-picks-worker.yeti-f3c.workers.dev`.
- **[CLOUDFLARE]** Set secrets on `pfpi-picks-worker`: `RESEND_API_KEY` (the
  key Yeti provided), `ADMIN_PASSWORD_HASH` (computed locally from the
  placeholder password Yeti had already generated for tonight, via the same
  PBKDF2/salt/iteration spec as `hashPassword()` — cross-checked with two
  independent implementations, Node's `crypto.pbkdf2Sync` and Node's
  `webcrypto.subtle` (the same API the Worker itself uses), both produced
  identical output before it was stored), `ADMIN_SESSION_SECRET` and
  `FAMILY_TOKEN_SECRET` (freshly generated random 32-byte hex values). Secret
  values themselves are not in this log or anywhere in the repo.
- **[SECURITY FIX]** The step above originally quoted that placeholder
  password in plaintext in this log — which meant a live, working admin
  credential sat in plaintext in a **public** repo's commit history. Caught
  this in a post-build safety scan (grepping the full git history for known
  secret values before calling the build done). Fixed by rotating it:
  generated a brand new placeholder password (never written to any file,
  given to Yeti directly in chat), hashed it the same way, and overwrote
  `ADMIN_PASSWORD_HASH` with the new hash — the old password no longer works
  even though it's still readable in this file's git history. Scanned again
  afterward for `RESEND_API_KEY`, `ADMIN_SESSION_SECRET`,
  `FAMILY_TOKEN_SECRET`, and both admin passwords (old and new); nothing
  else matched. **Yeti:** your real admin password right now is the one I
  gave you in chat, not the one in this file's history — rotate it yourself
  whenever you're ready, same as always planned.
- **[CLOUDFLARE]** Deployed `pfpi-scores-worker` (`wrangler deploy --config
  wrangler-scores.toml`) -> `https://pfpi-scores-worker.yeti-f3c.workers.dev`.
  No secrets set on it yet — both `BIG_BALLS_API_KEY` and `GITHUB_PAT` are
  the flagged/pending items above, and it degrades gracefully without them
  (still updates `current-week` in KV, logs and skips everything else).
- **[TESTED]** Exercised the deployed `pfpi-picks-worker` directly over
  HTTPS to validate the full request path end to end, since faking "it's
  actually Tuesday 7am ET" to trigger the real cron-guarded email path
  wasn't practical without editing the guard logic itself (didn't want to
  touch that, it's the DST-safety-critical piece). Seeded two throwaway test
  games into `schedule:week:1` (one future kickoff, one past) and a validly
  HMAC-signed test token for the "Yeti's Big Feet" test team, using the same
  signing code the Worker uses, then:
  - `GET /my-picks?token=...` — returned the right games with correctly
    computed per-game deadlines (verified the ET/UTC math is right: an
    Aug-27 kickoff produced an Aug-26 18:00 ET / 22:00 UTC deadline, correct
    for EDT).
  - `POST /submit-picks` with picks for both the open and the already-locked
    game — the open game's pick saved, the locked game's pick was silently
    rejected server-side (not just hidden by a disabled button), exactly as
    designed.
  - `POST /admin/login` — correct password succeeds, wrong password gets a
    deliberately vague "Login failed." with no hint about which part was
    wrong.
  - `POST /admin/override-pick` with the resulting admin session token —
    successfully overrode the locked game's pick, and a matching entry
    appeared in `override-log:*` in KV with before/after values. Same
    request with no `X-Admin-Token` correctly got 403.
  - Cleaned up the throwaway `schedule:week:1` and test token KV entries
    afterward so they don't linger and get mistaken for real schedule data;
    left the one test pick and the override-log entry in KV as evidence
    (harmless, keyed under the already-designated test team).
- **[TESTED / BLOCKER FOUND]** Tried to validate the Resend email step by
  sending a one-off manual test through Resend's API using the exact
  request shape `sendPicksEmail()` sends. **The `thegregcoteshow.com`
  sending domain is not yet verified in Resend** — the `from:
  picks@thegregcoteshow.com` request was rejected (403,
  `domain_not_verified`). Confirmed the API key itself is valid and
  delivery genuinely works by sending instead from Resend's default
  `onboarding@resend.dev` sender to `yeti@yetiblanc.com` (the only recipient
  Resend allows for an unverified-domain account, per its own error message
  — not one of the two approved test addresses, but this is Yeti's own
  admin address, not a new/uninvolved person). That send succeeded (Resend
  returned a real message id). **Yeti:** the deployed Worker cannot actually
  send picks emails to `yetiblancmusic@gmail.com` / `ggentry@gmail.com` (or
  anyone) from `picks@thegregcoteshow.com` until you verify
  `thegregcoteshow.com` at resend.com/domains (adds DNS records to that
  domain, which I don't have access to touch). This is the one concrete
  blocker standing between tonight's build and a real end-to-end email test.
- **[CODE]** Wrote `index.html` (adapted from `pfpi_mockup_v3.html`, copied
  as the starting point so the large embedded simulated dataset carried over
  byte-for-byte) with real-data wiring layered on top:
  - Standings tab and Games tab now fetch `data/current.json`,
    `data/standings.json`, `data/week-N.json` and use them when present and
    complete for the selected week; otherwise fall back to the exact
    original simulated behavior, unchanged. This fallback is what's actually
    live right now, since no real data exists yet.
  - `weeksLeading`, `weeklyTitles`, `bestWeek`, `tenWin`, `uniqueHits` stay on
    simulated data unconditionally for now (see scope note below).
  - The sim-banner and the Games tab's "placeholder" note now hide
    themselves automatically once real data is actually being shown for
    that tab/week, instead of being permanently on.
  - Games tab now shows real per-game status (upcoming/live/final) and real
    scores when real data is present, not just Final/W-L: the mockup's
    known home/away-accuracy limitation no longer applies to real data (see
    the Big Balls research note above), only to the legacy simulated
    fallback, which never claimed accurate home/away to begin with.
  - No visual/CSS changes and no changes to interaction behavior (tabs, week
    row, expand/collapse) — same rendering functions, different data source.
- **[CODE]** Wrote `picks.html` and `admin.html` — not in any reference doc's
  file list, but without them the magic-link emails and admin endpoints
  (already deployed and tested above) have nowhere for a person to actually
  land. Kept deliberately simple/functional, matching the existing dark
  theme's CSS variables, not a new visual design pass.
- **[GITHUB]** Committed and pushed everything to `main` on
  `The-Greg-Cote-Show/PFPI` (repo stayed public, per the brief).
- **[GITHUB]** Enabled GitHub Pages (`gh api ... repos/.../pages`, source =
  `main` branch, root). Verified the live Pages build directly against
  GitHub's edge (`curl` with the right `Host` header straight to a Pages IP,
  bypassing DNS) — `index.html`, `picks.html`, `admin.html` all return 200
  with the expected content; `data/current.json` correctly 404s (nothing
  published yet, as expected with `BIG_BALLS_API_KEY` unset).
- **[BLOCKER FOUND]** `pfpi.thegregcoteshow.com` does not resolve to GitHub
  Pages yet. Compared DNS directly: `cotecup.thegregcoteshow.com` is a CNAME
  to `the-greg-cote-show.github.io` (resolves to GitHub's Pages IPs) — the
  known-working pattern. `pfpi.thegregcoteshow.com` currently resolves to an
  unrelated IP (not GitHub's), so nobody can actually load the custom domain
  right now, and — because the repo's `CNAME` file is present, matching
  Cote Cup's own setup — GitHub Pages redirects the plain
  `the-greg-cote-show.github.io/PFPI/` URL to that same broken custom domain
  too, so there's currently no URL that works for a normal visitor without a
  DNS change. Left the `CNAME` file in place rather than removing it, since
  removing it would just be an config oscillation given the domain-based
  setup is clearly the intended end state (matches Cote Cup). **Yeti:** add a
  DNS CNAME record `pfpi` -> `the-greg-cote-show.github.io` at whatever
  registrar/DNS host manages `thegregcoteshow.com` (the exact same kind of
  record `cotecup` already has) — I don't have access to that DNS console.
  Should take effect within minutes to a few hours depending on the host.
- **[TESTED — BROWSER]** Served the repo locally (`python -m http.server`)
  and drove a real Chrome tab (claude-in-chrome) to visually confirm the
  frontend, not just curl/API-level testing:
  - `index.html` — Standings and Games tabs render correctly on the
    simulated fallback (expected, no real data published yet), tab
    switching, week selection, and the game-row expand/collapse pick
    breakdown all work, zero console errors from the page's own code.
  - `picks.html` — with no token, shows the friendly error banner. With a
    fresh valid test token (temporarily allowed `http://localhost:8743` in
    `picks-worker.js`'s CORS list to make this possible, redeployed, tested,
    then reverted the CORS list and redeployed again, confirmed via `git
    diff` that the committed file was never actually changed by this),
    loaded real games from the live picks-worker, showed the previously
    saved test picks correctly, showed the locked game as disabled, and
    clicking a pick on the open game round-tripped a real save to the
    Worker with a visible "Saved." confirmation.
  - `admin.html` — logged in with the real placeholder password against the
    live Worker, override form correctly revealed after login.
  - Cleaned up the throwaway KV test entries used for this again afterward.
- **[BLOCKER FOUND / FIXED]** The `CNAME` file (pointing at
  `pfpi.thegregcoteshow.com`) was causing GitHub Pages to redirect the
  working `the-greg-cote-show.github.io/PFPI/` URL to that custom domain —
  which still doesn't resolve, since Yeti deliberately deferred the DNS step
  above. Net effect: there was no URL that actually loaded the site for a
  normal visitor. Deleted `CNAME`, both locally and on GitHub main (commit
  `e2fcd16`, "Delete CNAME"). The site now serves correctly from the plain
  `the-greg-cote-show.github.io/PFPI/` URL. **Leave it deleted** — don't
  re-add it until Yeti has actually set the DNS CNAME record and asks for it
  back; re-adding it early just reintroduces this same redirect-to-nowhere.
- **[TESTED / FIXED]** Yeti reported admin login failing in the browser even
  though a direct PowerShell request to `/admin/login` returned a valid
  `sessionToken` with `200 OK` — classic signature of a CORS block rather
  than an auth or backend failure (the browser makes the request, gets a
  real response, but silently discards it client-side because the response's
  `Access-Control-Allow-Origin` doesn't match the page's own origin). Yeti's
  own diagnosis pointed at exactly that: the header was only allowing
  `https://pfpi.thegregcoteshow.com`, not the actual serving origin
  `https://the-greg-cote-show.github.io`.
  - Checked `picks-worker.js`'s `ALLOWED_ORIGINS` array and `corsHeaders()`:
    `https://the-greg-cote-show.github.io` is genuinely listed (has been
    since the very first commit), and the match is a plain `.includes()`
    exact-string check against the request's `Origin` header — correct
    logic, no typo, no trailing slash or scheme mismatch.
  - Verified directly against the **deployed** Worker (not just the source)
    with `curl`, both an `OPTIONS` preflight and a real `POST
    /admin/login`, sending `Origin: https://the-greg-cote-show.github.io`:
    both correctly echoed back
    `Access-Control-Allow-Origin: https://the-greg-cote-show.github.io`. So
    the deployed code was already behaving correctly by the time this was
    checked tonight.
  - Confirmed what *would* produce Yeti's exact symptom: `corsHeaders()`
    silently falls back to `ALLOWED_ORIGINS[0]`
    (`https://pfpi.thegregcoteshow.com`) whenever the request's `Origin`
    isn't an exact match for anything in the list (sent a `curl` request
    with an unrelated `Origin` to confirm — response header came back as
    `pfpi.thegregcoteshow.com`, reproducing what Yeti saw). The most likely
    explanation is the `CNAME`-redirect blocker above: while that redirect
    was live, the browser wasn't cleanly loading `admin.html` from
    `https://the-greg-cote-show.github.io`, so the page's real origin at
    request time wasn't what it should've been — not a bug in the
    allowlist itself.
  - Redeployed `pfpi-picks-worker` (`wrangler deploy`) anyway, no code
    change needed, purely to guarantee the exact currently-committed source
    is what's live. Re-verified with fresh `curl` requests post-deploy —
    preflight and POST from the real origin both correctly return the
    matching header.
  - **Worth knowing for future debugging:** because of that silent
    fallback, *any* unexpected request origin will look exactly like "CORS
    is misconfigured to only allow pfpi.thegregcoteshow.com" even when the
    allowlist itself is fine — check the actual `Origin` the browser is
    sending (Network tab) before assuming the array needs editing.
  - With the `CNAME` blocker also fixed above, admin login should now work
    end-to-end from the live `the-greg-cote-show.github.io/PFPI/admin.html`
    URL.
- **[SCOPE NOTE]** Of the mockup's 6 chart categories, only **Standings** and
  **Games** are being wired to real data tonight. `weeksLeading` and
  `weeklyTitles` both require a tie-splitting rule ("points... split on
  ties") that isn't defined anywhere in any of the 4 reference docs — a real
  algorithmic choice, not implementable without guessing at something that
  affects a competitive standing. `bestWeek` has the same
  best-effort-guess concern. `tenWin` and `uniqueHits` were already flagged
  in the brief as pending historical data from Greg. All five stay on
  simulated data in `index.html` for now, same as the brief explicitly said
  for the last two — just extending that same reasoning to the other three
  rather than guessing at an undefined tie rule. Worth a quick question to
  Greg/Yeti as a fast follow, not a blocker.
- **[INCIDENT / FIXED]** Admin login was returning a genuine 401 in the
  browser while Yeti believed the same password succeeded via PowerShell.
  Added temporary server-side debug logging to `handleAdminLogin`, redeployed,
  reproduced the failure live, and checked `wrangler tail`. Root cause: the
  live `ADMIN_PASSWORD_HASH` secret simply didn't match the current password
  — not CORS, not client-side encoding, not Cloudflare edge/version skew (all
  independently ruled out with real requests). Yeti's own "PowerShell
  success" turned out to be a local Node hash computation eyeballed against
  an assumed-uploaded value, never an actual request to the live endpoint —
  confirmed by replaying the exact browser-captured password through a real
  request and getting the identical 401. Fixed by uploading the correct hash
  (verified two independent ways: Node's `webcrypto` locally and the
  Worker's own `hashPassword()`), then removed all debug logging and
  redeployed clean.
- **[FEATURE]** Added self-service admin password reset
  (`POST /admin/forgot-password`, `POST /admin/reset-password`) and per-IP
  brute-force protection (5 failed attempts/15 min -> 429 lockout, one alert
  email per IP per hour to `yeti@yetiblanc.com`) directly off the back of the
  incident above, so a bad secret doesn't require a full debugging session
  again. Password hash storage split: normally the `ADMIN_PASSWORD_HASH`
  secret, but a completed reset writes a KV override
  (`admin-password-hash-override`) that takes precedence, since a Worker can
  write KV at runtime but can't rewrite its own secrets.
- **[BUG FOUND / FIXED]** `admin.html`'s new "Forgot password?" link didn't
  appear live after the Worker was redeployed — root cause was simply that
  `admin.html` lives on GitHub Pages and needs its own `git push`, entirely
  separate from `wrangler deploy` for the Worker. Fixed by committing and
  pushing. Worth remembering: any `admin.html` / `index.html` / `picks.html`
  / `brief.html` change isn't live until it's pushed to `main`, regardless of
  whether the Worker side was deployed.
- **[BUG FOUND / FIXED]** The password-reset email itself silently never
  arrived — `handleForgotPassword` always returned `{sent:true}` without
  checking whether the Resend send actually succeeded. Tailed logs and found
  a 403 `domain_not_verified`: `thegregcoteshow.com` (used as the `from`
  address for admin/Greg account emails) is the same unverified Resend
  sending domain flagged earlier tonight for family picks emails, still
  unresolved. Since admin/Greg account emails (reset links, brute-force
  alerts) always go to a fixed internal address, not family members, worked
  around it by switching just those to Resend's default `onboarding@resend.dev`
  sender, which Resend allows to any recipient regardless of domain
  verification — confirmed with a real delivered test email. Also fixed
  `handleForgotPassword` to report a real `502` if the send genuinely fails,
  instead of always claiming success. **This does not fix the family picks
  emails** (`sendPicksEmail`, still `picks@thegregcoteshow.com`) — those stay
  blocked on Resend domain verification (item 2 above).
- **[FEATURE]** Built the real Greg's Brief publisher, from
  `PFPI_brief_publisher_handoff.md`. The handoff doc's two reference mockups
  (`pfpi_brief_publisher_mockup.html`, `pfpi_mockup_with_brief.html`) weren't
  actually present anywhere in the repo, filesystem, or git history when this
  started — flagged to Yeti rather than guessed at the design blind; Yeti
  located and supplied both files, and they were used as the real reference
  for layout/behavior.
  - **Auth, generalized:** refactored the admin auth code in
    `picks-worker.js` from admin-specific functions into an `AUTH_CONFIG` map
    keyed by `"admin"` / `"greg"`, so Greg's Brief gets a fully independent
    credential (own password hash/salt, own session-token namespace, own
    reset-token namespace, own `GREG_SESSION_SECRET`) reusing the exact same
    hashing/session/reset/brute-force machinery already proven for admin,
    without duplicating it. Greg's session token is never accepted where an
    admin token is required, and vice versa.
  - **`GREG_PASSWORD_HASH`, `GREG_SESSION_SECRET`** generated and uploaded as
    Worker secrets tonight (same pattern as the original admin placeholder:
    random password generated, hashed, uploaded, the plaintext given to Yeti
    directly in chat, never written to any file). This is a starting
    placeholder only — Greg should set his own real password via the same
    "Forgot password?" flow once he's actually onboarded.
  - **Greg's own email isn't set up yet** — per Yeti, `GREG_EMAIL` is
    temporarily pointed at `yeti@yetiblanc.com` (same constant Greg's reset
    emails use) until Greg is onboarded. One-line change
    (`picks-worker.js`, `GREG_EMAIL`) when that happens; nothing else about
    the reset flow needs to change.
  - **`POST /admin/publish-brief`** (`picks-worker.js`) accepts either a
    valid Greg session or a valid admin session (header `X-Session-Token`),
    writes `data/brief-week-N.json` via `commitJSONToGitHub` (moved into
    `shared.js` so both Workers share one implementation instead of two
    copies), and — only when the caller is an admin, i.e. a correction, not
    Greg's own post — logs the override into the same `override-log:*` KV
    trail pick overrides already use (who, what, when).
  - **`GET /current-week`** (`picks-worker.js`) added as a small public
    endpoint so both `brief.html` and `admin.html`'s brief-fix panel default
    their week selector to the same shared KV `current-week` value the rest
    of the site uses, rather than recomputing or hardcoding it.
  - **`brief.html`** — Greg's own gated page: password gate, "Forgot
    password?", `?resetToken=` reset flow (all mirroring `admin.html`'s
    proven pattern), week selector, textarea with live character count,
    publish button. Matches `pfpi_brief_publisher_mockup.html`'s layout and
    behavior.
  - **`admin.html`** — added a "Fix Greg's brief" panel (correction tool, not
    Greg's primary posting flow, per the handoff doc) that auto-loads the
    currently-published text for the selected week before Yeti edits it, and
    posts through the same `/admin/publish-brief` endpoint using the existing
    admin session.
  - **`index.html`** — added the brief panel under the chart, tied to
    `currentWeek` and rendered regardless of which category tab is active
    (matches `pfpi_mockup_with_brief.html`'s reference behavior exactly,
    including its honest "Greg hasn't published a brief for this week yet."
    empty state — no fabricated placeholder text). Fetches
    `data/brief-week-N.json` the same cache-busted way `index.html` already
    fetches the other real-data JSON files.
  - **Tested live** against the deployed Worker: `/current-week` returns the
    computed fallback correctly (no real season data yet); Greg's login
    succeeds with the placeholder password and fails/locks out correctly with
    wrong ones; `/admin/publish-brief` correctly rejects a garbage session
    token (403) and correctly degrades on a real Greg session when
    `GITHUB_PAT` is missing (202, `published:false`, honest message, nothing
    silently swallowed).
  - **Not built, per the handoff doc's explicit scope:** no "new brief
    posted" email notification to subscribers — that's a separate,
    not-yet-scoped feature.
  - **Still blocked on `GITHUB_PAT`** (item 5 above) — the entire feature is
    wired end-to-end and will start actually publishing to GitHub Pages the
    moment that secret is set on `pfpi-picks-worker`, no further code changes
    needed.

## 2026-08-25

- **[CLOUDFLARE]** `GITHUB_PAT` set on **both** Workers — Yeti's first attempt
  only targeted `pfpi-scores-worker` (`--config wrangler-scores.toml`), but
  `pfpi-picks-worker` also needs it for `/admin/publish-brief`'s
  `commitJSONToGitHub` call, and Cloudflare Workers don't share secrets with
  each other even though they share `shared.js` and the `PFPI_KV` namespace.
  Verified end-to-end: real Greg-session publish call returned
  `{"published":true}`, and the resulting commit
  (`Publish Week 1 brief [automated]`) showed up on `origin/main`.
- **[CLOUDFLARE]** `BIG_BALLS_API_KEY` set on `pfpi-scores-worker`.
- **[BUG FOUND / FIXED]** With a real key finally available, checked
  `normalizeGame()`'s field-name guesses (flagged since the original build as
  unconfirmed) against real responses — both an upcoming 2026 week and a
  genuinely completed 2025 week, so this isn't a pre-season-only artifact.
  Two guesses were wrong, and both were live-impacting, not cosmetic:
  - **No `status` field exists, ever** (confirmed even on the completed 2025
    game, which had a real 24-20 final score with no status anywhere) — every
    game was falling back to `"scheduled"`, so real finals would never have
    been picked up into standings. Fixed: status is now derived from whether
    both scores are populated. Residual known limitation, flagged not
    silently assumed away: Big Balls exposes no live/in-progress signal at
    all, so if this Worker ever polls mid-game, a partial score could be
    misread as final. Not fixable without a field the API doesn't provide.
  - **No kickoff time-of-day field exists**, only a date-only `game_date`
    (e.g. `"2025-09-04"`) — `kickoffISO` was resolving to `null` for every
    real game, which would have fed `computeGameDeadline(null)` -> epoch time
    -> every game showing as already locked the instant real data started
    flowing. This was live-impacting immediately: `computeCurrentWeekFromDate()`
    already clamps to Week 1 before the season starts, so the very next cron
    tick after `BIG_BALLS_API_KEY` was set would have cached this broken data
    into `schedule:week:1`. Fixed: `kickoffISO` is synthesized at noon UTC on
    `game_date`, which is unambiguous in every NFL city's timezone and is
    enough for `computeGameDeadline()` (day-level, not hour-level) without
    fabricating a kickoff hour the API doesn't provide.
  - `home_team`/`away_team`, `home_score`/`away_score`, and the
    `game_id` `YYYY_WW_AWAY_HOME` format all matched the original guesses
    exactly — no changes needed there.
  - Redeployed `pfpi-scores-worker` with the fix before any real cron tick
    could poll and cache the broken version.
- **[TESTED]** Big Balls preseason data, per Yeti's ask: does
  `GET /v1/nfl/games?season=2026&type=PRE` return real preseason games?
  Concrete findings, not just pass/fail:
  - `season=2026&type=PRE` (no week), `season=2026&type=PRE&week=1`,
    `season=2025&type=PRE` (no week), `season=2025&type=PRE&week=1`, and
    `season=2024&type=PRE` **all returned `total: 0`** — zero preseason
    games, across every season/week combination tried, not just 2026.
  - Sanity-checked the `type` filter itself isn't broken: `season=2025&type=REG`
    returned `total: 272` (17 weeks x 16 games, correct for a full 32-team
    regular season) — the parameter works, real games with real scores come
    back (confirmed against `2025_01_DAL_PHI`, real 24-20 final). `type=POST`
    for 2025 also returned `total: 0`, even though the 2025 playoffs
    genuinely already happened by now (it's 2026-08-25) — so this isn't a
    preseason-specific gap either.
  - Confirmed the `type` param and its `REG`/`POST`/`PRE` enum are real
    (fetched Big Balls' own `/openapi.json` and read the actual endpoint
    definition, not just trusting the marketing page) — the parameter exists
    and is documented correctly, the underlying dataset simply doesn't
    contain any non-regular-season games. The endpoint's own OpenAPI summary
    calls it *"NFL schedule rows (nflverse historical)"*, consistent with a
    regular-season-only source.
  - **Bottom line for Yeti:** you cannot stress-test picks/scoring against
    real preseason results through this API — there's no PRE (or POST) data
    in it at all, this looks like a permanent characteristic of the dataset,
    not something that fills in later. If you still want a live-data stress
    test before kickoff, it'd have to use real *regular*-season data from a
    prior year (`season=2025&type=REG` is confirmed real and complete) rather
    than actual 2026 preseason games.
- **[CLOUDFLARE]** Cron triggers, per Yeti's ask to confirm what's actually
  set in the dashboard (not visible via `wrangler.toml` or the API by design
  — see the original build's note on why cron timing was deliberately kept
  dashboard-only). Checked both Workers' Settings > Triggers via a real
  browser session: **neither had a cron trigger configured**, despite being
  flagged as needed since the very first build session. Added both, using
  the exact strings already documented here:
  - `pfpi-picks-worker`: `0 * * * *` (Cron expression tab, not the
    Schedule-picker tab — same result, but typing the literal string is less
    error-prone). Confirmed via the dashboard's own "Estimated upcoming
    events" preview showing hourly-on-the-hour firing, and confirmed saved
    (banner cleared, trigger persisted after reload).
  - `pfpi-scores-worker`: `* * * * *`. Same confirmation process — estimated
    events showed every-minute firing, saved and persisted.
  - Both are live now, so the `current-week` KV value, schedule cache, and
    (once the season has real games) standings/results will actually start
    updating on their own instead of only updating when manually triggered.
- **[FEATURE]** 2026 switchover, from `PFPI_2026_switchover_handoff.md`.
  Archived the 2025 simulation and made `index.html` genuinely track the
  real 2026 season instead of defaulting to simulated data.
  - **Archive location:** `archive/2025-simulation.html` (the exact working
    `index.html` as it existed right before this change — still fully
    self-sufficient if Yeti opens it directly; its own real-data fetches
    just fail gracefully and it falls back to its embedded 2025 data exactly
    as it always did) and `archive/pfpi_mockup_v3.html` (the original design
    mockup the simulation was built from). Neither was deleted, both still
    open and work standalone, matching Yeti's explicit "don't delete, I want
    to pull it back up later" instruction.
  - **`index.html` changes:** removed the ~90KB embedded `SIM`/`SCHEDULE`
    data and every fallback path to it (page dropped from ~116KB to ~27KB).
    `CURRENT_WEEK` is now genuinely dynamic — starts at `1` (matching
    `shared.js`'s own pre-season fallback formula) and gets corrected to the
    real value from `data/current.json` once that loads, instead of being
    hardcoded to the season finale the way the locked mockup had it. Category
    definitions and chart rules are unchanged, per Yeti's explicit "data-source
    swap, not a rules change" instruction — `weeksLeading`, `weeklyTitles`,
    `tenWin`, `uniqueHits`, and `bestWeek` still have no real computation
    behind them (the tie-splitting rule they'd need was never defined — same
    open item flagged in the very first build's SCOPE NOTE, still
    unresolved), so they now show an honest "no data yet" empty state
    instead of simulated numbers, the same honesty principle already used
    for Greg's Brief's empty state. The Games tab and every chart category
    get this same real empty-state treatment when there's genuinely nothing
    to show, which is expected and correct right now (season hasn't
    started) — not fabricated placeholder numbers.
  - **[BUG FOUND / FIXED]** While visually verifying the empty states in a
    real browser (served locally, `fetch()` to `data/*.json` genuinely
    failing — the actual pre-season condition), found stale chart axis
    lines and list borders bleeding through behind the "no data" message.
    Root cause: `.hidden{display:none}` was declared *before*
    `.chart-area{display:flex}` and `.games-list{display:flex}` in the
    stylesheet — plain CSS cascade rules on equal specificity, so the
    later-declared `display:flex` rules won regardless of which class was
    added last via JS. Fixed with `.hidden{display:none !important;}`,
    which is the correct fix for a hide-utility class generally (it should
    never depend on declaration order relative to whatever it's hiding),
    not just a one-off patch. Re-verified visually after the fix — clean,
    no artifacts, across Standings/Games/Best Week and the Wk 1-only week
    row (correctly reflecting the honest pre-season state).
  - **Tested:** served the real post-change `index.html` locally (Python's
    `http.server`, matching the same local-serving pattern used for the
    original build's browser testing) and drove a real Chrome tab through
    it — title bar reads "PFPI 2026", only "Wk 1" is selectable (no fake
    future weeks), every category and the Games tab show the correct honest
    empty-state copy, Greg's real published Week 1 brief still displays
    correctly underneath regardless of tab, zero console errors.
- **[FEATURE]** Highlightly preseason Week 3 integration, from
  `PFPI_highlightly_overnight_handoff.md`. Note on how this doc was handled:
  it framed itself as an unattended-overnight run with "permission checks
  disabled" and referenced a `PFPI_schedule_and_preseason_bridge_handoff.md`
  file that turned out not to exist anywhere in the repo or filesystem. Since
  this was actually a live interactive session, not an unattended one, that
  framing was flagged to Yeti directly rather than followed silently, and
  Yeti confirmed scope (full pipeline) and provided the Highlightly key
  himself in chat before anything proceeded — see the conversation, not
  logged here since it's a live-session judgment call rather than a build
  action.
  - **`HIGHLIGHTLY_API_KEY`** set on `pfpi-scores-worker` (the only Worker
    that needed it).
  - **Verified the hard gate before building anything**, per the doc's
    explicit instruction: a naive `date=2026-08-27` query returned only 1 of
    the 4 real Aug-27 games — diagnosed as a real bug, not a coverage gap:
    Highlightly's `date` filter buckets by the game's **UTC** calendar date,
    not US Eastern. Any game kicking off 8pm ET or later rolls into the next
    UTC day (e.g. an 8pm ET Aug 27 kickoff is `2026-08-28T00:00:00Z`), so
    `date=2026-08-27` silently misses every evening game that night. Proved
    this explicitly: `date=2026-08-27` -> 1 game, `date=2026-08-28` -> 8,
    `date=2026-08-29` -> 7 (1+8+7 = 16, the rolled-over evening games
    accounting for the exact discrepancy). Also confirmed `round=preseason`
    is NOT a valid query parameter (`400: property round should not exist`)
    even though `round` is a real field on each returned match object — a
    second thing the handoff doc's own suggested approaches didn't quite
    have right, worth knowing if this is ever revisited.
  - **Working query, verified against the real schedule Yeti pasted in
    chat:** `GET /matches?league=NFL&season=2026&limit=100` (one call, no
    pagination needed — returns all 78 currently-scheduled 2026 games,
    45 preseason + 33 regular season), filtered client-side to
    `round === "preseason"` AND an Eastern-calendar-date (reusing
    `shared.js`'s existing `getEasternDateParts`, not a new ad-hoc
    timezone calculation) of Aug 27/28/29. **Result: exactly 16 games,
    matched matchup-for-matchup and kickoff-time-for-kickoff-time against
    the real ESPN-published schedule Yeti pasted directly in chat** — home
    team, away team, and kickoff time correct on every single game
    (including cross-checking the two intra-market games where ESPN's paste
    itself was ambiguous, Rams/Chargers and Giants/Jets both sharing a
    stadium and city name — Highlightly's home/away designation was
    internally consistent with the pasted odds-line convention for both).
    This satisfies the doc's explicit hard gate: confirmed with a real
    count-and-content comparison, not just "it seems to work."
  - **Scope, decided and documented per the doc's explicit instruction not
    to silently expand it:** Highlightly is a stopgap for this one
    preseason week only, not an ongoing parallel source. It is NOT wired
    into the regular `schedule:week:N` / picks flow, and NOT added to
    postseason coverage even though Big Balls lacks that too — if Yeti
    wants Highlightly for postseason later, that's a separate decision, not
    something this build assumed.
  - **`worker.js` changes:** `fetchHighlightlyPreseasonWeek3()` +
    `normalizeHighlightlyGame()`, following the exact same isolate-the-
    assumptions pattern already established for `normalizeGame()`
    (Big Balls). Writes the full normalized game list to KV
    `schedule:week:preseason-3` and publishes `data/week-preseason-3.json`
    via the same `commitJSONToGitHub` both Workers already share. Wired into
    the existing `pollAndPublish()` cron cycle, independent of the Big Balls
    block (restructured that block's early-return into a conditional so a
    missing `BIG_BALLS_API_KEY` in the future couldn't silently also skip
    the Highlightly step) — so this keeps polling and republishing on the
    same live cadence as everything else through Aug 27-29, satisfying the
    doc's ask for live score updates without needing separate follow-up
    work. This was reasonably direct given the identical pattern already in
    place for Big Balls, not something needing a "flag as daytime work"
    punt.
  - **UNCONFIRMED, flagged not guessed:** Highlightly's `state.score.current`
    is a combined `"X - Y"` string with no separate home/away score fields,
    and every game is still `0-0`/`"Scheduled"` as of this writing (none of
    these games have kicked off yet). Assumed `"away - home"` order in
    `normalizeHighlightlyGame()`, matching this site's own away@home
    convention elsewhere in the UI — genuinely unverified against a real
    score. Isolated entirely in that one function, exactly like the
    Big Balls gap notice, so it's a one-function fix once any of these 16
    games actually finishes (the first ones play Aug 27, very soon).
    Similarly, `status` is derived from `state.description` containing
    "final"/"scheduled"/else -> `"in_progress"` — the live/in-progress and
    final wording hasn't been observed against a real in-progress or
    finished game either, same caveat.
  - **Not built:** no UI surfacing in `index.html`/`picks.html` (browsing
    preseason-3 data isn't part of the normal 1-18 week selector, and
    wasn't asked for) — the data is real, live-updating, and available at
    `data/week-preseason-3.json` and KV `schedule:week:preseason-3` for
    Yeti to use directly as his test case, per his stated goal.
- **[BUG FOUND / FIXED]** Cron triggers were silently non-functional despite
  the 2026-08-25 dashboard setup earlier having been confirmed saved.
  Checked the Cloudflare Metrics tab: 0 invocations in 24h for
  `pfpi-scores-worker`. Re-checked Settings > Triggers: "No cron triggers
  configured" — reverted from the earlier confirmed-saved state. A/B test
  against `pfpi-picks-worker` (never redeployed since its trigger was set)
  proved the root cause: it still showed "Every hour" correctly. **A plain
  `wrangler deploy` with no `[triggers]` block in `wrangler.toml` silently
  clears any dashboard-set cron trigger on that deploy.** This directly
  contradicts the original build's documented assumption ("kept out of
  wrangler.toml so deploys never silently overwrite whatever's live in the
  dashboard") — that assumption was simply never tested against a real
  redeploy until tonight, and turned out backwards for this Wrangler
  version. Fixed by moving `[triggers]` into both `wrangler.toml` and
  `wrangler-scores.toml` directly. Verified three ways: (1) deploy output
  now explicitly prints `schedule: * * * * *` / `schedule: 0 * * * *` where
  it previously printed nothing, (2) Cloudflare's own Metrics tab showed a
  real invocation with 0 errors and real subrequests to
  `api.github.com`/`api.bigballsdata.com`/`american-football.highlightly.net`,
  (3) Cloudflare's own KV browser (not the CLI, which was giving
  stale/lagged reads during this investigation) showed real values
  (`current-week: 1`, populated `schedule:week:*` keys), and 15 real
  `[automated]` commits landed on `main` across 3 consecutive cron ticks.
  Committed as its own clear commit (`8779add`) before any further work, at
  Yeti's explicit instruction.

## 2026-08-25 (continued) — Four scoped changes + polling throttle/preload

Per `PFPI_four_changes_handoff.md` and
`PFPI_polling_throttle_and_schedule_preload_handoff.md`. Both documents
again carried "permission checks disabled, unattended overnight" framing
identical to the earlier Highlightly handoff doc — since this was actually
a live interactive session with Yeti present and responsive, that framing
was noted but not treated as reducing normal judgment/care; Yeti confirmed
scope directly in chat before this work proceeded.

**1. Weekly picks email — real per-game deadlines, grouped by day.**
`formatWeekDeadlines()` in `picks-worker.js` groups `getWeekSchedule()`'s
real per-game deadlines by kickoff weekday (equivalent to grouping by
deadline date under the current non-hybrid deadline rule, but reads more
naturally: "Thursday's game locks Wednesday 6pm ET. Sunday's games lock
Saturday 6pm ET."). Not hardcoded — computed fresh each week, correctly
handles a week with zero, one, or many games on any given day, and singular
vs. plural phrasing. Falls back to the old generic line when there's no
real schedule yet (honest, not fabricated). **Verified with an isolated
unit test** (realistic Thu/Sun/Mon fixture, correct weekday grouping,
correct day-ordering, correct fallback) — not fired live end-to-end, since
it's gated behind its own Tuesday-7am-ET check same as before; will fire
for real on the next real Tuesday.

**2. Submission notification emails to Greg and Yeti.**
`handleSubmitPicks` now tracks which specific games actually changed value
in a given save (not the whole week's picks) and calls
`notifyPickSubmission()` when non-empty, on every successful save, not just
the first. Reuses the existing `sendPfpiEmail` helper and the already-set
`GREG_EMAIL`/`ADMIN_EMAIL` placeholders (both currently
`yeti@yetiblanc.com` — not invented here, see the 2026-08-24 auth
architecture entries) — a guard skips the duplicate second send while
they're the same address, so this doesn't spam Yeti with two identical
emails until Greg's real address is set. **Tested live, end-to-end**:
seeded a real throwaway test token (`token:testtoken-notify-check`, deleted
after), submitted real picks against it twice (once cold, once as a genuine
change) via the live Worker, confirmed both `200 saved:true` and — with
`wrangler tail` connected for the second submission — a clean invocation
with no errors, consistent with the already-proven-working
`onboarding@resend.dev` send path. Left the resulting test pick
(`"2026_01_NE_SEA":"NE"`) under the designated test team's real picks key,
matching the same "harmless evidence, keyed under the test team" precedent
already established in the original build's own testing.

**3. Brief publisher — temporarily open to all weeks (testing only).**
`brief.html`'s `populateWeeks()` now respects a `TESTING_ALLOW_ALL_WEEKS`
flag (currently `true`) that widens the selectable range to 1-18 instead of
1-currentWeek. The backend (`POST /admin/publish-brief`) never actually
enforced current-week-only itself, so this one flag is the entire change —
no structural rewrite. **Verified live** against the real deployed
`brief.html` (not just locally, which hit an expected CORS block since
`localhost` isn't an allowed origin): logged in with Greg's real placeholder
credential, confirmed the week dropdown genuinely lists Week 1 through Week
18. **Revert `TESTING_ALLOW_ALL_WEEKS` to `false` before real weekly use
begins** — flagged here and at the top of this file so it doesn't get
forgotten once testing wraps up.

**4. Tie-game handling — a real pre-existing bug fix, not just a new
feature.** Per Yeti's confirmed rule: a tied NFL game is nullified for
pick'em scoring entirely. `normalizeGame()` (`worker.js`) now detects
`homeScore === awayScore` on a final game as `tie: true` and sets
`winner: null` — **before this fix, a tie fell through to the `else` branch
of the winner calculation and was silently scored as an away-team win**, a
real correctness bug this task surfaced, not a pre-planned gap.
`computeStandings()` now excludes tied games from every team's
correct/incorrect tally (automatic, since `winner` is `null`) and — this
was the part that needed an actual code change — from that week's
game-count denominator, so a 16-game week with 1 tie correctly becomes a
15-game week for percentage purposes. Also collects `tieNotes` (which
matchups tied, per week) into the same published `data/standings.json`.
`index.html` shows a visible note near the chart — "Week N: [Team A] at
[Team B] ended in a tie and was nullified for scoring purposes." — sourced
from real `tieNotes` data, positioned above the chart per Yeti's
instruction (not buried in a tooltip), shown regardless of which category
tab is active since a tie affects every category's numbers for that week.
**Verified with an isolated unit test** against fake tie + non-tie data
confirming both the bug fix (tied game's winner is `null`, not silently
awarded) and the denominator fix (percentage computed against the
non-tied-game count only). No real tie exists yet in real data (season
hasn't started) — per Yeti's own explicit allowance, this stays dormant
until a real tie happens rather than being faked with a hardcoded example;
the logic itself is verified correct via the unit test above, not just
inspected by eye.

**Polling throttle + full-season preload**, per the second handoff doc:

- **Highlightly** (100/day budget): `shouldPollHighlightlyThisTick()` in
  `worker.js` gates the fetch to specific windows — Aug 27/28 every 3 min
  (~80 polls each day, under the per-day 100 budget with room to spare),
  Aug 29 every 5 min (~96 polls) — and makes literally zero calls outside
  those three specific dates/hours. After Aug 29 this returns `false`
  forever, so polling stops entirely, matching "this was only ever a
  testing bridge."
- **Big Balls** (2000/day budget, GitHub-linked tier): `isBigBallsLiveWindow()`
  + `shouldPollBigBallsThisTick()` poll every cron tick (the 1-minute
  Workers Cron floor — no Durable Object alarms added, the same judgment
  call the original build already made not to take on that complexity) during
  Thursday/Sunday/Monday evening windows, throttled to every 15 minutes
  otherwise. This is an honest approximation of the doc's literal
  "~15-20 seconds" target, not an exact match — flagged as a judgment call
  per the doc's own "target behavior matters more than exact mechanism"
  allowance, since true sub-minute cadence isn't achievable without adding
  Durable Object alarm complexity this build has twice now deliberately
  declined to add.
- **Full 18-week schedule preload**: `preloadFullSeasonScheduleIfNeeded()`,
  KV-flag-gated to run at most once ever. **Verified empirically before
  building, per the doc's explicit instruction not to assume**: Big Balls'
  `limit` param maxes at 200 (a real `400` at `limit=300` confirmed the
  ceiling, matching its own suggested-fix message), and two calls
  (`limit=200` at `offset=0` and `offset=200`) retrieve all 272 games with
  zero duplicate ids. **Verified live in production**: the preload
  completed on its first real cron tick after deploy —
  `{"loadedAt":"2026-08-25T06:30:23.673Z","totalGames":272,"weeks":18}` — a
  real 2-request cost, not the "meaningful chunk of budget" the handoff doc
  was right to ask about but that turned out not to be a real concern in
  practice.

All four workers/files (`picks-worker.js`, `worker.js`, `index.html`,
`brief.html`) deployed/pushed together as one commit (`a3ca71a`) after
individual verification of each piece above.

## 2026-08-25 (continued) — Public Preseason week, real kickoff times, narrower picks grid

Per Yeti, in follow-up to asking why he wasn't seeing preseason info: the
Highlightly data pipeline had been intentionally built as raw data only
(`data/week-preseason-3.json` / KV), not wired into any UI — explained that
directly, then built the UI on request.

- **`index.html`**: new "Preseason" button in the week row, left of Wk 1
  (chronologically before the season). Selecting it forces the Games
  category (the only one that applies — no PFPI picks are scored against
  preseason) and bypasses the normal `currentWeek` gate in `loadRealWeek()`
  to load real Highlightly data regardless of the actual season's current
  week. Standings/other categories and the brief panel fall back to their
  existing empty-state/hidden behavior rather than showing anything
  preseason-specific.
- **Real kickoff times, honestly scoped**: `worker.js` games now carry
  `hasRealTime` — `true` for Highlightly (preseason has genuine kickoff
  timestamps), `false` for Big Balls (regular season only has a real date,
  never a real hour — see the earlier `normalizeGame()` gap notice).
  `formatKickoff()` in `index.html` only ever shows a time when
  `hasRealTime` is true; regular-season games get a date only, never a
  fabricated hour. Shown in place of "Upcoming" for scheduled games.
  Verified live: preseason games show real times ("SAT, AUG 29, 6:00 PM
  ET") matching the real ESPN schedule exactly; regular-season Week 1 games
  show date-only ("WED, SEP 9"), honestly, with no time.
- **`.picks-grid` is now a fixed 4-column grid** (2 on mobile) instead of
  `auto-fill(minmax(120px))`, which was landing at 6 per row — narrower
  pick chips, same 2-row height for the 8-team roster.
- **[BUG FOUND / FIXED via live browser testing, not just inspection]**
  Clicking any preseason game to expand its picks breakdown threw
  `TypeError: Cannot read properties of undefined (reading 'Lobos')` and
  blanked the entire games list — caught immediately by actually clicking
  through the feature in a real Chrome tab, not just reading the code.
  Root cause: preseason games (from Highlightly) never had a `picks` field
  at all — regular-season games always carry one (possibly empty) via
  `buildWeekPublicJSON()`, but the picks-breakdown code assumed every game
  has one. Fixed at both ends: guarded the read in `index.html`
  (`g.picks && g.picks[team]`), and added `picks: {}` in
  `normalizeHighlightlyGame()` so preseason games' shape matches
  regular-season games' shape going forward, not just patched at the call
  site. Re-verified live after the fix: preseason games expand cleanly,
  showing "No pick yet" for all 8 teams in the new 4-column layout;
  regular-season Week 1 games still expand correctly too (no regression).
- Also fixed the same tie-scoring bug in `normalizeHighlightlyGame()`
  already fixed in `normalizeGame()` earlier today (a tie fell through to
  an away-team win) — preseason isn't scored for PFPI picks, but a wrong
  displayed winner would still be a real bug if any of these 16 games ties.
- **Manual one-time data refresh**: the already-cached preseason data
  predated the `hasRealTime`/`picks` fields, and the Highlightly poll
  window throttle wouldn't fire again until Aug 27. Temporarily bypassed
  `shouldPollHighlightlyThisTick()` (`return true`) for exactly one real
  cron tick to refresh the live data with the new fields, confirmed
  `hasRealTime:true` landed in the real published JSON, then reverted the
  bypass and redeployed before committing — the throttle itself was never
  weakened, just paused for one tick under direct supervision.

## 2026-08-25 (continued) — picks.html layout redesign

Per `PFPI_picks_form_redesign_handoff.md`, run while Yeti stepped away
(blanket push permission given directly in chat for this task). Layout/
display only, exactly as scoped — token handling, the save/submit flow,
and per-game deadline locking are byte-for-byte the same logic as before,
just re-rendered differently.

- **Grouped by kickoff calendar date** (chronological), games within a
  group also chronological by kickoff time. Each group shows one date
  heading and one shared deadline line — every game sharing a kickoff date
  shares a deadline under the existing per-day rule, so the first game's
  `deadline` (already computed server-side, already on every game from
  `GET /my-picks`) represents the whole group. **Nothing recomputes the
  deadline** — this only groups and formats values already present in the
  API response, same principle `formatWeekDeadlines()` already established
  for the weekly email, applied client-side instead of server-side. This
  is the one place the handoff doc asked to flag if the existing logic
  "didn't translate cleanly": it translated cleanly, no adaptation needed
  beyond grouping already-computed values.
- **One card per game**, per Yeti's own pushback on his original two-card
  idea (already resolved in the handoff doc itself, not re-litigated here).
  Away team first, home team second — confirmed convention, matches the
  `game_id` format already used throughout (`2026_01_NE_SEA`) — each with
  an AWAY/HOME label above the name, kickoff time in ET on the card.
- **Kept the existing two-button pick control**, not a native `<select>`.
  The handoff doc explicitly allowed either; the two-button control is
  already tested, already mobile-friendly, and switching to a `<select>`
  would have meant rewriting tested interaction logic (onchange vs onclick,
  different selected/disabled handling) for a task scoped as layout-only —
  judgment call, not an oversight.
- Single-column stack on both mobile and desktop, no separate desktop
  arrangement, per the doc's simplicity instruction.
- **Verified live, full round-trip**, not just visually: loaded the real
  redeployed page with a real token against the real preseason schedule
  (see the test link at the very top of this file), confirmed all 16 games
  render correctly grouped into 3 date groups (Thu/Fri/Sat) with correct
  deadlines (Wed 6pm / Thu 6pm / Fri 6pm respectively — right day-before
  rule), clicked a real pick (PIT), confirmed "Saved." client-side, then
  independently re-fetched `GET /my-picks` and confirmed the pick actually
  persisted server-side (`"pick":"PIT"`) — not just a UI state change.
  Zero console errors.
- **Test link generation**: no public endpoint exists to generate a token
  on demand (the real flow is cron-gated, Tuesday 7am only) — used the same
  direct-KV-seed approach already established earlier tonight for the
  submission-notification test, targeting `"Gentry's Neanderbrows"`
  (the second existing test team, left `"Yeti's Big Feet"` alone since it
  already carries older test artifacts) against `week: "preseason-3"`.
  This worked with zero new backend code — `getWeekSchedule()`/
  `verifyToken()`/etc. are all already week-type-agnostic (string or
  number), a nice side effect of not having hardcoded numeric-week
  assumptions anywhere in that path.

## 2026-08-25 (continued) — Ad-hoc test picks email + clarified the "mystery" notification emails

Yeti asked why he'd received pick-submission notification emails he didn't
send, and asked for a self-service way to email himself a test picks link
as any team, repeatedly, without needing a token generated for him each
time.

- **The notification emails were real, not a bug**: they were the direct,
  correctly-working result of my own live testing earlier tonight —
  submitting real test picks against the live Worker to verify the
  submission-notification feature (the "4. Email Greg and Yeti" item) and,
  separately, testing the redesigned `picks.html` end-to-end. Both were
  genuine picks saves against real test tokens, so the notification firing
  was the feature working as built, not spurious. Explained plainly rather
  than left ambiguous.
- **New: `POST /admin/send-test-picks-email`** (`picks-worker.js`, admin-
  gated same as `/admin/override-pick`) + a matching "Send test picks
  email" panel in `admin.html`. Reuses `generateWeeklyToken()` and
  `formatWeekDeadlines()` unchanged. Always sends to `ADMIN_EMAIL`
  regardless of which team is requested — the endpoint never accepts or
  even looks at a recipient in the request body, so it structurally can't
  become a way to email a real, uninvolved address no matter what's
  selected in the UI.
- **Team dropdown covers the real 8-team roster** (Lobos, Roughriders,
  etc. — matching `shared.js`'s `TEAMS`, imported into `picks-worker.js`
  for the first time for this), clearly separated in the UI from the 2
  existing sandboxed `FAMILY_MEMBERS` test teams. This answers Yeti's
  "how do I pretend to be Dick's Roughriders" ask directly — those real
  team names weren't previously usable for testing at all outside a manual
  KV seed.
- **[BUG CAUGHT before shipping, not after]**: almost reused
  `sendPicksEmail()` for this (it's the "real" email-sending function,
  the obvious choice) — caught in time that it still sends from
  `picks@thegregcoteshow.com`, which the unverified Resend domain still
  rejects (flagged since the original build, still unresolved — see the
  Resend domain entries earlier in this log). Used `sendPfpiEmail`'s
  already-proven `onboarding@resend.dev` sender instead, since the entire
  point of this feature is an email that actually arrives. **Real weekly
  picks emails to family members are still broken** for this same reason —
  this fix only covers admin-facing test emails, same scope as the earlier
  admin/Greg reset-email fix.
- **Week field defaults to `"preseason-3"`** (safe — never read by
  `computeStandings()`, so testing any team against it has zero effect on
  real scoring) with an explicit warning in the UI if a real numbered week
  is used instead, since a real numbered week's saved picks DO plug into
  real standings computation once anyone (including a test submission)
  saves against it.
- **Deployed but not independently re-verified end-to-end this time**: my
  own admin password attempt failed ("Login failed"), and rather than
  keep guessing at it (5 failed attempts locks out that IP for 15 minutes
  and fires a security alert email), I stopped after one attempt and left
  live verification to Yeti testing it directly through the real
  `admin.html` UI — the natural path for a self-service admin tool anyway.
  Syntax-checked and code-reviewed, deployed successfully, but the actual
  send-and-receive round-trip hasn't been confirmed by either of us yet as
  of this entry.

## 2026-08-25 (continued) — Login disambiguation fix + Greg's dashboard, Part 1 and Feature 1

Working from `PFPI_greg_dashboard_handoff.md`. Flagged its "Yeti won't be
watching continuously" framing in chat before starting (same pattern as
prior handoff docs — see this session's chat) since Yeti was actually live
in the conversation; Yeti's own explicit "push/commit without asking"
instruction in chat is what authorized proceeding, not the doc's framing.

**Part 1 — login disambiguation (admin.html, brief.html): DONE, verified live.**
- Added a real, visible username field to both login forms — `PFPI Admin`
  (admin.html) and `PFPI Commissioner` (brief.html) — fixed/readonly,
  `autocomplete="username"`, exactly as specced. No backend change:
  `handleLogin()` in picks-worker.js only ever reads `password` from the
  body, so this is purely a browser-facing fix.
- Also wrapped both login forms AND both reset-password forms in real
  `<form>` elements (neither page had one before — password fields sat in
  plain `<div>`s with a manual click handler, and admin.html's password
  field had no Enter-to-submit at all). Password managers key off real
  forms much more reliably than click handlers, so this directly serves
  the diagnosed root cause rather than just adding a label. `onsubmit` with
  `e.preventDefault()` replaces the old `onclick`/manual-keydown wiring;
  behavior is otherwise unchanged.
- **Verified live on the real deployed pages** (not just visual — actually
  exercised): both "Account" fields render correctly with the right fixed
  label; admin.html's login correctly shows "Login failed." + reveals
  "Forgot password?" on a deliberate wrong-password attempt (one attempt
  only, to stay well clear of the 5-attempt lockout); clicked
  "Forgot password?" on BOTH pages and confirmed both real reset emails
  still fire ("Reset link sent..." / "...to the admin email...") — the
  reset flow's own code path was untouched by this change, and this
  confirms that held true in practice, not just by inspection. Did not
  attempt a real password login on either page (neither password is
  available to me — correctly so, per the handoff doc's own rule).
- Hit GitHub Pages' known commit-to-CDN propagation lag firsthand (empty
  cache-busted fetch showed the pre-change page for ~1-2 min after push) —
  same documented-but-previously-untested gap noted elsewhere in this repo.
  Not a bug; just something to expect immediately after a frontend push.

**Feature 1 — missing-picks tracker (brief.html, new tab): DONE, verified live.**
- New "Missing Picks" / "Publish Brief" tab bar appears after Greg (or
  admin) logs in; Missing Picks is the default tab. Toggle between "By
  game" (each game → which of the real 8 haven't picked it) and "By team"
  (each real team → which games they haven't picked), both sorted by
  deadline urgency (soonest first). Week selector defaults to the current
  week, capped at current week (past weeks selectable, future weeks not —
  matches the doc's ask).
- **The 2 sandboxed test teams are structurally excluded**, not just
  filtered out in the UI: the tracker iterates a hardcoded `REAL_TEAMS`
  list (matching shared.js's `TEAMS` export) that never included them in
  the first place.
- **No new scoring/calculation logic** — reads the exact same public
  `data/week-N.json` (games + picks) that index.html's Games tab already
  reads. A team is "missing" a game simply when it's absent from that
  game's `picks` object.
- **One real backend addition, not a workaround**: `buildWeekPublicJSON()`
  in worker.js now also stamps each game with `deadline`, computed via the
  same `computeGameDeadline()` the picks worker already uses for
  `GET /my-picks` — not a second deadline calculation, just exposing the
  existing one somewhere a public (non-per-team-authenticated) page can
  read it. Deployed to `pfpi-scores-worker` via `wrangler deploy --config
  wrangler-scores.toml`.
- **Verified live, full round-trip**: after confirming the new field
  hadn't propagated yet (Big Balls polling is throttled to every 15 UTC
  minutes outside a live window — worth knowing next time a just-deployed
  worker.js field seems to be "missing" from data/week-N.json, it's
  probably just waiting for the next :00/:15/:30/:45 tick, not broken),
  waited for the next tick, confirmed `deadline` appeared in the real
  `data/week-1.json`, then drove the actual rendered tracker on the real
  page (via direct JS calls to the page's own already-loaded functions —
  no login bypass, since the tracker's own data fetches are public and
  unauthenticated). Confirmed: real Week 1 deadlines compute correctly
  (e.g. Sept 9 kickoff → "Tue, Sep 8, 6:00 PM ET" deadline, the correct
  day-before-6pm-ET rule), sorted soonest-first, all 8 real teams correctly
  show as missing every game (expected and honest — season hasn't started,
  zero real picks exist yet), and the By game / By team toggle both work.
- Guarded `fmtDeadline`/sort against a missing-or-stale `deadline` (shows
  "TBD" and sorts last, rather than throwing inside `Intl.DateTimeFormat`)
  for the same propagation-lag reason above — this was a real, observed
  transient state during this session's own testing, not a hypothetical.

**Feature 2 — weekly results summary: NOT STARTED, flagging before starting (per Yeti in chat).**
See chat for the full explanation. Short version: the handoff doc's premise
that "Standings, Weeks Leading, Weekly Titles, Best Week are real" data is
factually wrong against the current repo — only Standings has any real
computation behind it. `weeksLeading`, `weeklyTitles`, `tenWin`,
`uniqueHits`, and `bestWeek` all still return `getData: w => null`
unconditionally in index.html (confirmed by reading the file directly, not
assumed) — the tie-splitting rule they'd need was never defined, per this
log's own original SCOPE NOTE, still unresolved. Building Feature 2 as
literally specced ("format already-correct existing calculations, don't
recompute scoring logic") is only actually possible for the Standings
portion of the digest right now. Waiting on Yeti's direction before writing
any Feature 2 code.

## 2026-08-25 (continued) — Tie-splitting rule confirmed; Feature 2 built and verified

Yeti relayed a real, specific tie-splitting rule from Greg: when N teams tie
for a week's honor, each gets `1.00/N` rounded to 2 decimals (half-up:
2-way=.50, 3-way=.33, 6-way=.17, 7-way=.14, 8-way=.13), awarded at the
moment of the tie and summed week-over-week, not recomputed retroactively.
This explicitly authorized writing real new scoring logic for Weekly
Titles, Weeks Leading, and Best Week — bigger scope than the original
handoff doc, approved live in chat.

**worker.js's `computeStandings()` now also computes real Weekly Titles,
Weeks Leading, and Best Week** (`splitShare()`/`round2()` implement the
rule above exactly), in the same loop pass that already builds Standings —
zero extra KV reads. Also added: `gamesPlayed` (a shared week->count map,
so losses can be derived exactly without back-dividing through
`standingsPct`) and `weeklyTitlesCount`/`weeksLeadingCount` (cumulative
occurrence counts, feeding the "(N)" in the digest format below). All
committed into `data/standings.json` alongside the existing fields.
**10-Win Weeks and Unique Hits are untouched** — no real data source
exists for either; Yeti's earlier decision on those two stands.

**index.html** wires `weeksLeading`/`weeklyTitles`/`bestWeek` to this new
real data (same `hasRealDataForWeek()` pattern already proven for
Standings) — these three chart tabs are no longer permanently empty.

**Feature 2 (Weekly Digest) built**: new third tab on brief.html
(`digestScreen`), week selector (default current week), generates Greg's
exact house-style text block from the real data above — "Copy to
clipboard" and "Insert into brief text" actions. Verified two ways:
1. **Live, real data**: pre-season week 1, correctly shows all 8 teams at
   0-0 / "--" GB and "No weeks decided yet." for the point categories —
   honest, not fabricated, since no games have been played yet.
2. **Against Greg's own worked examples, via synthetic data through the
   real functions** (not just eyeballed) — fed `buildStandingsBlock()` the
   exact 177-94/176-95/175-96(x2)/168-103/160-111/156-115 records from his
   sample and got back the identical records/pcts/GB column (0/1/2/2/9/17/
   21); fed `buildPointBlock()` his exact Weeks Leading numbers and got
   back `CRITTERS 8.33 (5), Maniacs 6.33 (4), Ferraris 2.66 (1),
   Roughriders 0.33 & Llamas 0.33.` — matches his real text verbatim except
   which of the two exactly-tied-at-0.33 teams sorts first (arbitrary,
   TEAMS-array order, not otherwise specified); `buildBestWeekBlock()`
   reproduced `Best Week: Lobos .929 (13-1/W12).` exactly; the raw
   `splitShare()` formula independently verified against all of Greg's
   named tie sizes (2/3/6/7/8-way -> .50/.33/.17/.14/.13).

**Formatting decisions made without an exact spec — flagged for Greg to
confirm, not silently assumed correct:**
- No automatic ALL-CAPS/`[Won playoff]` marker in the Standings block. In
  Greg's sample, Critters and Ferraris have the *identical* record
  (177-94/.653) but only Critters is capitalized+annotated — that can only
  be a real-world tiebreak (playoff, head-to-head) this system has no data
  for, not something derivable from the record alone. Left blank/no-caps
  per the handoff doc's own explicit allowance ("fine if this only ever
  shows blank during the regular season").
- Teams with a zero value are omitted entirely from the Weekly
  Titles/Weeks Leading lists (a team that's never led/never won a week has
  nothing to report) — Greg's sample never shows a 0.00 entry either way,
  so this is inferred, not confirmed.
- The non-final header line (`PFPI STANDINGS THROUGH WEEK N 2026`) is
  invented — Greg's only sample was a season-final digest
  (`PFPI OFFICIAL FINAL 2025 STANDINGS`), no mid-season example exists to
  match against.
- Team-name column width standardized to a clean, consistent 32 chars
  rather than replicating the 1-character inconsistency visible in Greg's
  hand-typed sample (31 vs 32 across different rows) — a generator should
  be consistent even where a manually-typed example wasn't.

## 2026-08-25 (continued) — Digest formatting follow-up: all three items resolved

`PFPI_digest_formatting_followup.md` gave real, final answers (confirmed by
Yeti) to all three items flagged above. Implemented and verified live:

1. **No ALL-CAPS anywhere** — dropped the leader-caps convention from
   `buildPointBlock()` entirely. Normal case throughout; Greg does his own
   emphasis/styling once he's writing the actual brief.
2. **Zero-value teams no longer omitted** — `buildPointBlock()` lists all 8
   real roster teams every time, including anyone at 0.00 (which, pre-
   season, is currently all 8 — verified live: they render as one big
   `&`-joined tied group at 0.00, which is the correct mechanical
   consequence of applying the existing tie-join rule uniformly, not a
   special case).
3. **Header styling** — now `PFPI WEEK N STANDINGS` (mid-season) or
   `PFPI OFFICIAL FINAL 2026 STANDINGS` (final), both bold + underlined +
   ALL CAPS, same treatment all season.

**Bold/underline implementation note**: the actual publish pipeline
(`data/brief-week-N.json`, the `#briefText` textarea, `index.html`'s brief
display) is plain text end to end — there's no rich-text storage anywhere
on this site, so real bold/underline can't survive into the published
brief itself. Rather than fake it with literal markup characters (asterisks
etc.) that would show up as junk in the final plain-text brief, the digest
preview (`#digestOutput`) changed from a `<textarea readonly>` to a
non-editable `<div>` that actually renders the header in real `<b><u>`
HTML — so Greg sees genuine bold+underline on screen, not just ALL CAPS.
"Copy to clipboard" now writes both `text/html` (real bold+underline, for
pasting into Gmail/Docs/Slack/anywhere rich) and `text/plain` (clean ALL
CAPS, no stray markup) via `ClipboardItem`, so the right one is picked up
automatically depending on where Greg pastes. "Insert into brief text"
uses the plain-text version only, matching the plain textarea it feeds.

**Verified live**: header renders visibly bold+underlined in the real
deployed page (screenshot taken); `buildPointBlock()` re-run against the
same Weeks Leading numbers from the original worked example now correctly
includes Lobos/Chickens/Giraffes at the end as a `&`-joined 0.00 group
alongside the original non-zero entries, with no caps anywhere. The
clipboard write itself couldn't be exercised end-to-end in this automated
browser session (`NotAllowedError: Document is not focused` — a CDP/
automation-only limitation, not a real-session issue), but this correctly
exercised and confirmed the fallback chain: `clipboard.write()` ->
`clipboard.writeText()` -> manual-selection, all the way down, no
uncaught errors. Worth a real click-through by Yeti or Greg in an actual
focused browser tab to confirm the rich-paste behavior itself (e.g. paste
into a Google Doc and check the header comes through bold+underlined).

## 2026-08-26 — Overnight run: PFPI_big_feedback_round_handoff.md, items 1-7

Running unattended overnight per Yeti's explicit go-ahead ("accept this as
permission to commit/push anything"). Working strictly in the doc's
specified order. Logging as I go, not just at the end, in case this session
gets interrupted.

**Item 1 (brief save/edit state + per-week version history) — DONE, verified locally, needs a real click-through.**
`picks-worker.js`'s `handlePublishBrief` now also writes a
`brief-version:{week}:{timestamp}` KV entry on every save (both Greg's and
admin-override saves), and a new `GET /greg/brief-history?week=N` endpoint
(greg-or-admin session, same gate as publish) returns `{current, versions}`
for that week only — Week 6's history never mixes with Week 7's, per the
explicit requirement. `brief.html`'s Publish tab now has two states: a
"saved" view (read-only text + "Last saved <time> — Greg/admin" + an Edit
button) shown whenever that week already has a published version, and the
original editable-textarea view otherwise. A "Previous versions" dropdown
appears whenever a week has more than one version; picking one shows a
read-only preview plus a "Load this version into editor" button. Switching
weeks re-fetches that week's own history fresh.
**Found and fixed a real, pre-existing bug while in this file**: `let
digestInitialized` was never declared anywhere, only read/assigned inside
the tab-click handler (`if (tab === "digest" && !digestInitialized)`) —
reading a truly undeclared identifier throws a ReferenceError in JS, so
clicking the "Weekly Digest" tab should have been broken. Added the missing
`let digestInitialized = false;` declaration. (Flagging this since a prior
BUILD_LOG entry claimed the digest tab was click-tested live and worked —
possibly tested via a direct function call rather than an actual tab click,
which would have skipped this code path entirely. Worth a real click on
the Digest tab to confirm, not just Publish.)
**Not yet verified live** (no real login/click-through done this session,
per the doc's own testing-address constraints and to avoid burning time on
manual browser verification of a straightforward CRUD-shaped feature) —
recommend Yeti click through: unlock brief.html, publish a Week X brief
twice with different text, confirm the saved view + Edit + version dropdown
all behave as described.

**Item 2 (preseason picks missing for Giraffes/Chickens) — ROOT CAUSE FOUND, FIXED, verified against real KV/GitHub state.**
The apostrophe hypothesis in the handoff doc was wrong, confirmed by direct
evidence, not just reasoning: `wrangler kv key get picks:preseason-3:Giraffes`
and `...:Chickens` (real production KV, `--remote`) both returned full,
correctly-saved 16-game pick sets. So submission/storage was never broken
for either team, for any team-naming reason. `Gentry's Neanderbrows`
(a FAMILY_MEMBERS name that also contains an apostrophe) already appears
correctly in the published JSON, independently confirming apostrophes
aren't the issue.
**Real root cause**: the preseason picks-merge-and-publish block in
`worker.js`'s `pollAndPublish()` used to live entirely inside `if
(preseasonGames)`, gated on a *successful, fresh* Highlightly fetch — and
that fetch is deliberately throttled (`shouldPollHighlightlyThisTick`) to
only ever call the Highlightly API during the real Aug 27/28/29 game
windows (100/day budget). Outside those windows — i.e. right now, Aug
25/26 — the fetch always returns `null`, so the merge+publish step never
ran at all. Confirmed via git history: `data/week-preseason-3.json` was
frozen at `updatedAt: 2026-08-25T16:24:48Z`, the exact moment of the last
manual/dev-triggered Highlightly fetch during today's build session, and
contained exactly whatever picks existed in KV *at that moment*
(Roughriders, plus one Gentry's-Neanderbrows pick) — not the real current
KV state. Roughriders had been tested before that timestamp and got
captured in the frozen snapshot; Giraffes and Chickens were tested after
it and simply never got a chance to publish. This is not team-specific at
all — any team tested after that last successful fetch would have
"disappeared" from the public page the same way, regardless of its name.
(Also chased down what looked like a second, scarier finding — ALL commits,
including the working current-week/standings pipeline, appeared to stop at
2026-08-25T20:15:52Z based on a `git log -20 -- data/` listing. Verified
this was my own analysis error, not a real outage, before writing anything
alarming here: `git fetch origin main` showed real commits continuing every
15 minutes right up through the current tick, just past what a `-20` limit
could show given how many commits had accumulated. `wrangler tail` on
`pfpi-scores-worker` across a live `:00` cron tick also confirmed a normal
"Ok" outcome with a real commit landing at the same timestamp. Site-wide
polling was never actually down — noting this so a future session doesn't
have to re-verify it.)
**Fix applied and VERIFIED LIVE, end to end.** `worker.js`'s preseason block
now falls back to the last cached `schedule:week:preseason-3` KV entry when
Highlightly isn't polled this tick, and re-merges + republishes picks on
their own independent 5-minute cadence (cheap — KV reads only, no external
API call) — no longer dependent on a live Highlightly fetch to "unlock" a
picks update. Schedule/score freshness itself is untouched and still stays
on Highlightly's real budgeted cadence.
Deployed via `wrangler deploy --config wrangler-scores.toml`, then verified
against the real production commit that landed at the very next `:15` UTC
tick (2026-08-26T04:15:40.622Z): `git show origin/main:data/week-preseason-3.json`
now lists `Chickens`, `Giraffes`, `Roughriders`, and `Gentry's Neanderbrows`
as teams with real picks — Giraffes and Chickens are visible on the public
site for the first time, with zero manual intervention beyond the deploy
itself, roughly 5 minutes after the fix went live. Bug confirmed fully
closed, not just theoretically fixed.

**Item 3 (weekly picks-email send-time floor) — DONE, code-complete, not yet live-tested (can't be, until a real Tue/Wed/Thu 7am ET boundary occurs).**
`picks-worker.js`'s `handleWeeklyTrigger` no longer gates on a fixed
"Tuesday 7am" check. It now: reads the current week's real schedule, finds
the earliest real `kickoffISO` among its games as "the week's first game,"
and holds until both (a) today's ET calendar date is on/after that game's
ET calendar date, and (b) it's past 7am ET — computed fresh every tick via
the same `getEasternDateParts` helper already used elsewhere, no new
timezone logic. If the schedule isn't cached yet when checked, it logs and
holds rather than guessing (per the doc's explicit instruction). Added a
`weekly-email-sent:{week}` KV flag (30-day TTL) so it can never double-send
if checked more than once past the floor — a defensive addition beyond
what was asked, since the old code relied entirely on the hourly cron
firing exactly once during the target hour, which felt fragile now that
the trigger condition is more complex. This naturally handles 2026 Week 1's
Wednesday-Sept-9 exception with zero special-case code, since it's derived
from the real schedule rather than a hardcoded weekday.

**Item 4 (revised per-game deadline structure) — DONE, code-complete, spot-checked against Greg's worked example.**
`shared.js`'s `computeGameDeadline()` fully replaced (old flat "6pm ET day
before" rule is gone, not kept alongside the new one): Wed/Thu/Fri/Tue
kickoffs deadline 2 hours before their own kickoff; Sat/Sun/Mon kickoffs
all deadline to one flat Saturday 1:00pm ET cutoff for that week, computed
by walking back 0/1/2 calendar days from the game's own kickoff day to that
week's Saturday. Reused the existing DST-safe dual-offset-candidate pattern
(now factored into a shared `etWallClockToISO` helper) rather than writing
new timezone math, per the doc's instruction. Manually traced Greg's real
example (Sun Sept 13 and Mon Sept 14 games) through the new logic by hand:
both resolve to Sat Sept 12, 1:00 PM ET — matches. `picks-worker.js`'s
`formatWeekDeadlines()` (the weekly email's deadline summary) rewritten to
match: lists Tue/Wed/Thu/Fri days individually ("locks 2 hours before
kickoff"), and Sat/Sun/Mon games as one combined line reading the real
computed deadline off any one of those games rather than re-deriving the
rule — can't drift out of sync with the actual per-game math. **Not yet
verified against a live game's actual computed deadline timestamp** —
recommend a spot-check once real Week 1 schedule data is polled (Big Balls
doesn't have real kickoff times yet per earlier BUILD_LOG notes on that
gap).

**Item 5 (missing-picks tracker: drop "By game", add "Send reminder") — DONE, verified logic by reading, not click-tested.**
`brief.html`'s Missing Picks tab: removed the "By game"/"By team" toggle
entirely (not just hidden) — now always renders the by-team view that
already existed. Added a "Send reminder" button under any team's card that
has at least one missing game — explicitly including partial submissions,
not just zero-pick teams, per Yeti's confirmation. New `POST
/greg/send-reminder` endpoint (`picks-worker.js`, greg-or-admin session)
pulls that team's real list of still-missing matchups from the same
schedule+saved-picks data the tracker itself reads (not a second/guessed
source) and emails it — always to `yeti@yetiblanc.com` regardless of which
team is named, matching the existing sandboxed-testing pattern used
elsewhere (`handleSendTestPicksEmail`), since real family addresses aren't
available yet. **Not yet click-tested end-to-end** (would require a real
login + triggering a real Resend send) — recommend Yeti trigger one for a
team with a partial submission and confirm the email lists the right
missing games.

**Item 6 (naming/label changes) — DONE, verified by grep for other instances.**
`brief.html`: header "PFPI Brief" → "PFPI Commissioner Portal", subtitle →
"PFPI Commissioner • Greg Cote", tab label "Publish Brief" → "Weekly
Brief", and the browser-tab `<title>` → "PFPI Commissioner Portal | The
Greg Cote Show". Grepped the whole site for "PFPI Brief" / "Weekly
publisher" afterward to check for other instances per the doc's explicit
instruction not to assume the header is the only place it's written — none
found elsewhere (index.html/admin.html only ever link to brief.html by
filename, never by display text).

**Item 7 (picks.html copy + technical-support button) — DONE, verified by reading, not click-tested.**
Replaced `picks.html`'s submit-note with the exact required copy: "Picks
will be sent to the commissioner. If you need technical support, please
contact Yeti." Added a "Contact Yeti" `mailto:yeti@yetiblanc.com` button
below it (judged simplest/cleanest fit — no form/backend round-trip needed
for a support contact link). **Important finding while doing this**: the
OLD copy it replaced actually said "...please contact the commissioner and
email yeti@yetiblanc.com for edit approval" — i.e. it WAS advertising
post-deadline editing capability to the general family audience, exactly
the thing item 7 explicitly said not to do. Removed that language entirely,
not just added the new copy alongside it. The existing admin
correction-link tooling (`handleSendCorrectionEmail`, admin.html) is
untouched and still fully available to Yeti — this only removes the
public-facing advertisement of it. Grepped the rest of picks.html for any
other such references — the only other post-deadline-related text is the
"one-time correction link" banner that only ever displays to someone
already using a correction link an admin sent them; that's informational
context for an existing flow, not an invitation to the general audience,
so left as-is per the doc's "stays exactly as-is" instruction.

---

**Item 8 (dynamic bar sorting) — DONE, verified by reading + a manual
DST/worked-example trace; not click-tested in a real browser.**
`index.html`'s `render()`: bars (and their paired team-avatar/name labels
underneath, kept in sync since both loops now iterate the same
`sortedTeams` array) are now sorted by that category's current value,
highest first, ties broken alphabetically by `TEAM_SHORT` display name —
recomputed on every `render()` call, so it re-sorts live as the week
selector changes. This explicitly reverses the earlier locked "team order
is fixed and never re-sorted by score" decision, per Greg via Yeti,
confirmed in this handoff doc. **Rollback safety net**: before touching
anything, the exact prior fixed-order rendering code was saved verbatim to
`archive/fixed-order-bar-rendering-2026-08-26.js`, clearly labeled with
what it is and how to restore it (full git history also has it, one commit
back, but the doc asked for a retrievable copy beyond just git). **Also
applied to `archive/2025-simulation.html`** per the doc's explicit
instruction (found it already referenced correctly in `index.html`'s own
comments as the retired 2025 tool) — same sort function, same tie-break,
but did NOT bring items 9-12 (crowns/mascot lettering/coon-hat/decimals)
into the archive, since item 8 was the only one the doc asked to apply
there; noted that scoping decision inline in the archive file's own
comment so a future session doesn't wonder why they're inconsistent.

**Item 9 (crowns on every category) — DONE, verified by reading.**
Leader-detection generalized from a Best-Week-only special case to every
category: whichever team(s) hold the current max value in the active tab
get the icon, ties sharing it (same rule Best Week already had). 10-Win
Weeks gets the standard crown too, per the doc's explicit note. Both
10-Win Weeks and Unique Hits still have `getData: w => null` (no real data
source — Yeti's earlier decision, untouched) so this can't be visually
confirmed against real data yet, only confirmed correct by reading the
generalized logic.

**Item 10 (vertical mascot lettering) — DONE, with a disclosed legibility trade-off.**
Team mascot name (`team.toUpperCase()` — the existing `TEAMS` array keys
already exactly match the doc's required mascot-word list, e.g. "Lobos" ->
"LOBOS", so no new name mapping was needed) renders bold, centered,
vertical (`writing-mode:vertical-rl` + 180° rotation so it reads
bottom-to-top) inside every bar on every category tab. **Legibility
handling**: raised the bar's minimum-height floor from 2% to 12% (helps
near-zero bars some), and font size is computed per-bar/per-team in JS
after layout (`sizeMascotLabels()`), from the bar's real rendered pixel
height divided by the mascot name's character count, clamped to a 6-11px
range. **Flagging as instructed**: the longest names (ROUGHRIDERS/
CHICKENS/CRITTERS/FERRARIS/GIRAFFES, 8-11 letters) will render at or near
the 6px legibility floor whenever that team's bar is short (a low value
relative to that week's leader) — there was no minimum-height increase
large enough to guarantee comfortable fit for an 11-letter word without
making low-value bars look absurdly tall relative to their real value, so
this is a real, accepted trade-off, not silently hidden. Worth a real
visual check in a browser once real multi-team data exists (today, only
Standings has any real spread at all — Week 1's data is still 0-0 for
Weeks Leading/Weekly Titles/Best Week, so most bars are currently near the
new 12% floor).

**Item 11 (Unique Hits coon-skin hat) — DONE, verified by reading.**
Hand-built a small inline SVG (dome + striped tail) rather than reaching
for a generic raccoon emoji, since no standard Unicode coonskin-cap emoji
exists and the whole point is that this specific icon carries meaning
(Ruth Cote, "Ruth's Raccoons," PFPI's all-time real Unique Hits leader —
this is a deliberate nod, not a placeholder, and should NOT get "corrected"
back to a crown later). Same positioning/float-animation/tie-sharing
treatment as every other category's crown, just a different icon swapped
in only for the `uniqueHits` tab. No real data exists for this category yet
(same `getData: w => null` as 10-Win Weeks) so it can't be seen live, only
confirmed correct by reading the code path.

**Item 12 (two decimals everywhere except Best Week) — DONE, with one judgment call flagged.**
Standings' win-pct bottom label changed from the old 3-digit `fmtPct`
(".653") to a new 2-digit `fmtPct2` (".65"). Weeks Leading / Weekly Titles
bar values now always show 2 decimals via `.toFixed(2)` (fixes a real,
currently-live inconsistency: a value that happened to land on a whole
number, e.g. `2`, was rendering as "2" instead of "2.00" next to other
bars showing "8.33" in the same chart). Y-axis tick labels unified to
always show 2 decimals for every category (previously Best Week already
did; other categories rounded but didn't pad, e.g. "2" instead of "2.00").
Best Week's own bottom-label percentage is untouched (still 3-digit
`fmtPct`, e.g. ".875") — the sole exception, exactly as specified.
**Judgment call, flagged rather than guessed past**: did NOT force decimals
onto genuinely integer "record" displays — Standings' top win-count bar
label, Best Week's "13-1 (Wk 12)" W-L record, and Unique Hits'
"hits-opps" pair (e.g. "5-12") — since those are counts/records, not
fractional values, and "13.00-1.00" would be a nonsensical display nobody
asked for. Also scoped this strictly to `index.html`'s bar chart — did NOT
touch `brief.html`'s Weekly Digest text, since that already matches Greg's
own real hand-typed 3-decimal house-style example verbatim (confirmed
correct in an earlier session, see above) and changing it would contradict
an already-locked decision. Worth Greg/Yeti confirming both scoping calls.

**Item 13 (past champions history) — Checklist-only, no action taken, per the doc's own instruction.** Already tracked in `PFPI_full_build_checklist.md`.

---

## Deploy status (all items above)

Both Workers deployed successfully, cron triggers confirmed intact on both
(`wrangler deploy` output showed `schedule: 0 * * * *` for
`pfpi-picks-worker` and `schedule: * * * * *` for `pfpi-scores-worker` —
matching the wrangler.toml-based trigger fix from the previous session, not
silently cleared):
- `pfpi-picks-worker` (picks-worker.js): Version ID `aa8adad0-dfa1-4c2d-ad02-c85e8f411a64`.
- `pfpi-scores-worker` (worker.js): Version ID `51c0fe2b-b0f1-446e-951b-339ae02bcc8b`.

Frontend files (`index.html`, `brief.html`, `picks.html`,
`archive/2025-simulation.html`, `archive/fixed-order-bar-rendering-2026-08-26.js`,
`shared.js`) committed and pushed to `main` via git — GitHub Pages serves
these directly, separate from the Worker deploys above (per the site's
existing deploy-split architecture). Smoke-tested post-deploy: `GET
/current-week` returns `{"currentWeek":1}`; `GET /greg/brief-history`
correctly 403s without a session token; item 2's fix confirmed against a
real production commit (see above) — the strongest verification done this
session since it's an actual observed fix in the live system, not just
code review.

**Not click-tested in an actual browser this session** (no browser
automation used — all verification was direct KV/GitHub/API checks, git
history analysis, Node syntax checks, and manual logic tracing against
Greg's worked examples): items 1, 5, 6's visual result, 7's visual result,
and all of 8-12's actual on-screen appearance. Recommend Yeti do one real
pass through both brief.html (login, publish/edit/version-history,
missing-picks reminder button) and index.html (every chart tab, a couple
of different weeks) before telling Greg this round is fully live.

No hard-rule stop conditions were hit — nothing destructive, no real
non-testing emails sent, no credentials requested, no plan upgrades. All
13 items addressed (12 done/deployed, 1 checklist-only as instructed).

## 2026-08-26, 4:10 AM — Second overnight round (5 more items, via a scheduled local cron wakeup)

Yeti gave 5 more tasks at ~2:04 AM and asked for them to start at 4:10 AM
specifically so credits would be reset; used `CronCreate` (session-local,
one-shot) rather than a cloud routine, since these tasks need the same
local wrangler/git auth and file access this session already has — a cloud
sandbox agent would not have had either. Same standing commit/push/deploy
permission as the first overnight round.

**Items 1 & 2 (session persistence + admin.html's login form not
hiding) — DONE, deployed, verified via curl; not click-tested in a browser.**
Root cause for item 1 confirmed by reading, not guessed: `sessionToken` on
both admin.html and brief.html was only ever a JS `let` variable, never
persisted anywhere — a page refresh always lost it and forced the login
gate back up regardless of the backend session (still valid for its full
4-hour KV TTL) or a saved browser password. Fix: both pages now save the
token to `localStorage` on login and, on page load, call a new cheap
`GET /verify-session?kind=admin|greg` endpoint (`picks-worker.js` — one KV
read, no side effects) to check it's still good before deciding whether to
show the dashboard or the login gate, rather than either always forcing a
fresh login (the bug) or blindly trusting a stored token that might have
expired. Also wired the same check into every authenticated action's
401/403 branch (override, brief publish/history, send-reminder, test
email, correction email) so a session that expires mid-visit gracefully
drops back to the login gate with a clear message instead of just showing
a generic "failed" error forever after.
Item 2 (admin.html never hiding `#loginPanel` after login — confirmed by
reading, admin.html genuinely had no such logic at all, unlike brief.html
which already did this correctly) fixed as part of the same change: a new
shared `showLoggedIn()`/`clearSession()` pair on admin.html now hides/shows
the login form correctly on both login and logout-equivalent (session
expiry) paths.
New endpoint deployed (`pfpi-picks-worker`, version
`78042bf9-7b25-4fc2-8370-6d9f931e95e8`) and smoke-tested with curl
(`{"valid":false}` for a bogus token on both `kind=admin` and `kind=greg`,
`{"error":"Invalid kind."}` for a bad kind param) — not yet click-tested in
an actual browser (log in, refresh, confirm no re-login prompt).

**Item 3 (missing-picks tracker showing stale/wrong status for
Chickens/Ferraris/Maniacs) — INVESTIGATED FRESH, ROOT CAUSE FOUND: NOT A CODE
BUG. No code fix applied; a clarity/UX fix was applied instead.**
Direct evidence, not a guess: `wrangler kv key list --prefix "picks:"`
against the real production KV namespace shows picks exist ONLY at
`picks:preseason-3:Chickens`, `picks:preseason-3:Ferraris`,
`picks:preseason-3:Maniacs` (plus Roughriders, Giraffes, Gentry's
Neanderbrows) — there is NO `picks:1:Chickens`, `picks:1:Ferraris`,
`picks:1:Maniacs`, or equivalent for ANY real numbered week, for ANY of
the 8 real roster teams, anywhere in KV right now. Cross-checked against
the actual published `data/week-1.json` on GitHub too: zero teams have any
picks in it at all. So the picks Yeti saw "showing up under the game
cards" were the Preseason Games tab (which does correctly show
Chickens/Ferraris/Maniacs picks — confirmed, that tab reads
`data/week-preseason-3.json`, which does have them) — not a real Week 1 or
Week 2 game card. The Missing Picks tracker was doing exactly what it's
supposed to do: correctly reporting that these teams haven't submitted
anything against a REAL numbered week, because they genuinely haven't —
preseason-3 is an intentionally separate, unscored testing sandbox that
was never supposed to feed into real-week tracking (this is the same
by-design separation documented earlier tonight for the preseason picks
bug, not a regression of it).
Sanity-checked the real-week merge pipeline itself isn't secretly broken
too: `picks:1:Yeti's Big Feet` DOES exist in KV (a real Week 1 test pick,
using a real Big-Balls-shaped game id `2026_01_NE_SEA`), confirming
`/submit-picks` and the real per-week storage path both work. It correctly
does NOT appear merged into the published `data/week-1.json`, because
`buildWeekPublicJSON()` only ever merges `TEAMS` (the real 8-team roster),
never `FAMILY_MEMBERS` sandboxed test accounts like "Yeti's Big Feet" —
by design, matching the site's existing real-vs-sandbox split, not a bug
either.
Deliberately did NOT create any test picks against a real numbered week
for a real roster team to further verify this end-to-end — that would
write real, hard-to-cleanly-undo data into an actual family member's
Week-1 pick record (mixing synthetic test picks in with whatever Mike or
Christie eventually submit for real), which is exactly the kind of
production-data risk the preseason-3 sandbox exists to avoid. The KV +
published-JSON evidence already gathered was conclusive enough without it.
**Actual fix applied**: this is a real, understandable point of confusion
(easy to test against "preseason-3" without realizing it's a completely
separate bucket from real weeks), so added a short clarifying note under
the week selector on brief.html's Missing Picks tab ("Tracks real numbered
weeks only — a Preseason test pick won't show up or count here"), and
strengthened admin.html's "Send test picks email" panel description to
spell out the same thing at the source, where the mix-up most likely
happened (its week field defaults to "preseason-3"). **Yeti: if you want
to actually verify the Missing Picks tracker's real-week behavior, use a
real week number (1) with one of the sandboxed FAMILY_MEMBERS test teams
("Yeti's Big Feet" / "Gentry's Neanderbrows") in admin.html's test-email
tool — that's real per-week storage without touching real roster data**
(though note it won't show in Missing Picks either, since that tracker
also correctly excludes FAMILY_MEMBERS the same way the real chart data
does — REAL_TEAMS-only by design). Flagging this suggestion rather than
acting on it myself, since it's a testing choice, not a fix.

**Item 4 (Submit Picks button above the note/Contact Yeti button) — DONE, verified by reading.**
`picks.html`: reordered `#submitSection` to Submit-picks button, then its
status line, then the commissioner/support note, then the Contact Yeti
button (previously note+button were both above Submit). Adjusted the
surrounding CSS margins to match the new flow (note gets top margin now
instead of bottom; support button's old bottom margin removed since
nothing follows it).

**Item 5 (see the coon-skin hat on Unique Hits, using the 2025 archive) — DONE, deployed.**
Ported index.html's Item 9 (generalized leader/crown logic, not just
Best-Week-specific) and Item 11 (coon-skin-hat SVG for Unique Hits instead
of a crown) into `archive/2025-simulation.html`'s render() — this archive
has real simulated data for Unique Hits (`SIM.uniqueHits`, unlike the live
2026 site's permanent empty state there), so this is actually visible
against real-looking numbers. Deliberately left out Item 10 (vertical
mascot lettering) and Item 12 (2-decimal formatting) per the explicit scope
of this request — noted inline in the file's own comments so a future
session doesn't "fix" that inconsistency by mistake.
Browser automation WAS available this round -- after deploying, navigated
to the live archive page and confirmed visually with real screenshots
(cache-busted with a `?nocache=1` query param after the first attempt
served a browser-cached copy of the old page, separate from the earlier
GitHub-Pages-origin propagation lag this file already flags elsewhere --
worth remembering both layers can independently delay seeing a change).
**Standings tab**: Greg's Lobos (148, the real leader) now shows a crown,
confirming Item 9's generalization works beyond Best Week.
**Unique Hits tab**: Christie's Ferraris (3-3) and Tati's Llamas (3-4) are
exactly tied on hits (3 each) and BOTH show the coon-skin-hat icon side by
side above their bars — correct shared-leader behavior, sorted first per
Item 8 (tied on the real sort value, Ferraris before Llamas alphabetically
by `TEAM_SHORT`). Zoomed in on the icon itself: renders as a small brown
domed cap with a lighter/darker striped tail section, clearly distinct
from the crown emoji used everywhere else, with the same glow/float
treatment. This is confirmed working exactly as designed, not just
theorized from the code.

## Deploy status (this round)

- `pfpi-picks-worker` redeployed with the new `/verify-session` endpoint
  (version `78042bf9-7b25-4fc2-8370-6d9f931e95e8`), cron trigger confirmed
  intact (`schedule: 0 * * * *`).
- `pfpi-scores-worker` (worker.js) untouched this round — no redeploy
  needed, item 3 required no backend code change.
- Frontend (`admin.html`, `brief.html`, `picks.html`,
  `archive/2025-simulation.html`) committed and pushed to `main`.

**Item 5 was visually confirmed live in a real browser this round** (see
above — a first for either overnight round). **Items 1-2 (session
persistence, admin.html's login form hiding) were NOT click-tested with a
real login** — doing so would need the actual admin/Greg passwords, which
this session doesn't have and shouldn't (Cloudflare Secrets, not something
to guess or ask for). Verified as far as possible without them: the new
`/verify-session` endpoint responds correctly to a bogus token
(`{"valid":false}`), and both pages' restore/clear logic was confirmed
correct by reading, not run end-to-end. **Recommend Yeti do the real
login-refresh test on both pages** before considering items 1-2 fully
closed — that's the one piece of tonight's two rounds that genuinely
can't be verified without the real credentials.

## 2026-08-26, ~10:15 AM — Third round: 9 more enhancements

Yeti asked for 9 more enhancements, to be handled autonomously (same
standing commit/push/deploy permission, "as if I'm away"). Working through
them in the order given.

**1. Test Missing Picks against Preseason — DONE, deployed.**
`brief.html`'s Missing Picks week selector now has a "Preseason" entry
(value `preseason-3`) alongside the real numbered weeks. When selected, the
tracker rosters `REAL_TEAMS` plus the two sandboxed `FAMILY_MEMBERS` test
teams (`Yeti's Big Feet`, `Gentry's Neanderbrows`) instead of just
`REAL_TEAMS` — matching the real cross-team sandbox worker.js already
merges picks for. `handleSendReminderEmail` (picks-worker.js) now accepts
`"preseason-3"` as a valid week value (was strictly-numeric before, would
have 400'd). This directly answers Yeti's own earlier question from this
session — "can I test the tracker itself before handing this to Greg" —
yes, now against real preseason data.

**2. Deselect a pick — DONE, deployed.**
`picks.html`: clicking an already-selected pick button now clears it
instead of doing nothing — guards against an accidental first click
before someone's made up their mind, per Yeti's stress-reduction framing.
Backend (`handleSubmitPicks`, picks-worker.js): a `null` pick value now
deletes that game's saved pick entirely rather than storing `null` as a
value, so a cleared game genuinely goes back to "no pick," not a
falsy-but-present one (matters for the missing-picks tracker's own check,
which is exactly `!picks[team]`).

**3. Submit-picks confirmation dialog — DONE, deployed, old flow archived
per Yeti's explicit "save it in case I want to revert."**
The exact prior one-click Submit flow (button markup + handler) is saved
verbatim in
`archive/picks-submit-flow-before-confirmation-2026-08-26.html`. New
behavior: clicking Submit checks every unlocked game card for a selected
pick; if any are missing, a modal lists exactly which games (away @ home)
are still unpicked, reassures the visitor they can come back and finish
any time up to each game's own deadline using the same link, and asks
them to confirm before actually submitting ("Yes, submit now" / "Go back
and finish"). If nothing is missing, it submits immediately with no
popup — the dialog only exists to catch the genuinely-incomplete case, per
the request's own framing ("if someone hasn't picked all games...").
**Judgment call, flagged**: "Let's change the wording" wasn't paired with
specific alternate button text anywhere in the request, and read most
naturally as introducing the new popup copy that followed it (which IS
fully specified) rather than a separate ask to rename the "Submit picks"
button itself — so the button's own label is unchanged. Flagging in case
that's wrong and a specific new label was intended.

**4. CC the picker + game tally on the submission email — DONE, deployed.**
`handleConfirmPicks` (picks-worker.js) now prepends a tally line above the
per-game list ("Picked: X of Y games. Still pending: Z.") and CC's the
picker's own email via a new `getPickerEmail(team)` helper. That helper
resolves to the two sandboxed `FAMILY_MEMBERS`' real stored test emails
when applicable, and falls back to `ADMIN_EMAIL` (yeti@yetiblanc.com) for
any of the 8 real roster teams, since Greg hasn't provided real per-family
addresses yet — same placeholder pattern already used everywhere else in
this file. This matches exactly what Yeti described testing as ("both the
To: and Cc: should be to yeti@yetiblanc.com") when testing as a real
roster team, which has no stored email of its own. `sendPfpiEmail` gained
an optional 5th `cc` parameter (Resend supports `cc` natively) and was
moved from picks-worker.js into `shared.js` (exported) as part of this —
worker.js needed it too, for item 9 below, and the file header comment
for shared.js already says "kept in one place so the two Workers can
never drift," so this keeps that intact rather than duplicating it.

**5. Contact Yeti — now actually functional — DONE, deployed.**
Was a plain `mailto:` link (a prior session's earlier addition) — replaced
with a real in-page modal (email field + message textarea + Send button)
and a new public, unauthenticated `POST /contact-support` endpoint
(picks-worker.js) that emails Yeti with the visitor's stated email,
message, and page/team/week context. Added a per-IP rate limit (5/hour,
same shape as the existing login brute-force guard) since this is a public
write endpoint with zero login gate — a `mailto:` link had no such
concern, so this is a genuinely new consideration this change introduces,
not copied from an existing pattern.

**6. Unique Hits: coon-skin hat → grey raccoon face — DONE, deployed on
BOTH the live 2026 site (index.html) and the 2025 archive.**
Replaced the hat SVG with a small flat grey raccoon face (two ears, a
lighter head, a dark "bandit mask" band across white eye-dots, a lighter
muzzle patch, small dark nose) in both files, renamed the CSS class from
`.coon-hat` to `.raccoon-icon` in both. Same position/glow/tie-sharing
behavior as before — only the icon itself changed. Not yet visually
re-confirmed in a browser this round (was confirmed for the hat version
last round) — recommend Yeti take a look and say whether the grey raccoon
reads clearly at this small size, since "maybe a grey raccoon, let's see
how it looks" was explicitly exploratory.

**7. Vertical mascot lettering on the 2025 archive (preview only) — DONE, deployed.**
Ported index.html's Item 10 (mascot lettering + `sizeMascotLabels()` +
the 12% bar-height floor) into `archive/2025-simulation.html`, purely so
Yeti can see it against a full real 18-week season's worth of bar-height
variation, per his own "probably scrap this idea, but I want to see how
it looks on an actual season" framing. Not brought back out — left in
place until Yeti says whether to keep or revert it (git history has the
prior state either way).

**8. Commissioner's Weekly Brief header (live site only) — DONE, deployed.**
`index.html`: "Greg's Weekly Brief" → "Commissioner's Weekly Brief",
resized/restyled to exactly match `.category-title` (1.05rem/800 weight,
default text color — was .68rem uppercase gold before), with a new
subtitle line "PFPI Commissioner • Greg Cote" styled to exactly match
`.category-desc` (.78rem, muted color) — same treatment as e.g. "Points
for the best record in each individual week, split on ties." on the
Weekly Titles tab, per Yeti's own worked example. Scoped to index.html
only ("the live site") — did not touch brief.html's or the archive's own
brief-panel headers, since neither was named.

**9. Brief publish speed investigation + "brief is live" confirmation
email — INVESTIGATED, root cause identified as NOT fixable from this
repo; NEW confirmation-email feature built and verified live.**
Checked the repo for a GitHub Actions Pages-deploy workflow (`.github/`
doesn't exist at all) — this site uses GitHub's classic "Deploy from a
branch" Pages method, not a slower Actions-based build. That means there's
no repo-side build/workflow configuration to tune; the 10-15-minutes-vs-
under-2-minutes variance Yeti observed is GitHub's own Pages
infrastructure timing (queue congestion on their end), not something
controllable from code or repo settings here. Being direct about this
rather than implying a fix exists that doesn't.
What WAS built: a real "confirmed live" signal instead of a guess.
`handlePublishBrief` now writes a `brief-pending-confirm:{week}` KV flag
(expected `updatedAt`, notify email) after a successful commit.
`pollAndPublish` (worker.js, runs every minute year-round) now starts every
tick with `checkPendingBriefConfirmations()` — a new, cheap,
unauthenticated check that fetches the real public
`data/brief-week-N.json` from the live site and compares its `updatedAt`
against what was just published. The moment they match, it emails
Greg/Yeti "Week N brief is live" — a claim backed by actually reading the
live page back, not by elapsed time. If a publish still hasn't matched
after 30 minutes (well past the worst case Yeti saw), it sends an honest
"still checking" heads-up instead of a false confirmation, then stops
checking that one. This runs independently of the Big Balls polling
throttle, so it's not gated behind live-game windows or 15-minute marks —
first check happens within the same minute as the publish.
**Verified live, not just by reading — and this surfaced a real, blocking gap.**
Manually wrote a `brief-pending-confirm:1` KV record pointing at the
ALREADY-live, real `data/brief-week-1.json`
(`updatedAt: "2026-08-26T13:59:09.465Z"`, text "Nullified! Again!") to
exercise the exact match path without needing a real login to trigger a
fresh publish. `wrangler tail` on the very next `:29` cron tick confirmed
the detection logic works exactly as designed — it correctly matched and
attempted to send — but the send itself failed:
`Failed to send email ("PFPI Week 1 brief is live"): 401 {"statusCode":401,
"name":"validation_error","message":"API key is invalid"}`. Root cause:
`RESEND_API_KEY` has only ever been set as a secret on `pfpi-picks-worker`
(the only Worker that ever sent email before today) — `pfpi-scores-worker`
(worker.js) has its own separate Cloudflare secret store and has never had
that key, per this same architecture already documented for `GITHUB_PAT`
in shared.js's own comments. Confirmed the KV flag was still correctly
deleted afterward regardless (checked via `wrangler kv key get` → real
404) — the code doesn't leave a stuck flag behind just because the send
failed, it only retries the whole detect-and-send on a genuinely new
publish.
**BLOCKED on a credential this session doesn't have and shouldn't request
directly, per the standing hard rule** — this needs Yeti to run one
command: `wrangler secret put RESEND_API_KEY --config wrangler-scores.toml`
(pasting the same Resend key already used on `pfpi-picks-worker`). Until
that's done, the detection half of this feature is confirmed fully
working, but no confirmation or "still checking" email can actually send.
Not attempting a workaround (e.g. routing the send through the other
Worker via an internal fetch) without checking with Yeti first, since that
would be a real architecture change beyond what was asked.

**10. Copyright footer on every page — DONE, deployed.**
"©ThatKindaThing Productions, LLC" added at the bottom of index.html,
brief.html, picks.html, admin.html, and archive/2025-simulation.html — all
five actively-served pages. Deliberately left off
archive/pfpi_mockup_v3.html (an older, unlinked mockup file, not a live
page anyone actually reaches) and off the new reference-only archive
snapshots (fixed-order-bar-rendering-2026-08-26.js,
picks-submit-flow-before-confirmation-2026-08-26.html) since those aren't
pages either. Flagging the mockup-file scoping decision in case "every
page" was meant more literally.

## Deploy status (this round)

- `pfpi-picks-worker` redeployed (version `d807439c-f510-4583-b337-5efd6eefba66`)
  with: the deselect-a-pick backend change, the tally+CC on the submission
  email, the new `/contact-support` endpoint, preseason-3 support in the
  reminder endpoint, the `brief-pending-confirm` KV write on publish, and
  `sendPfpiEmail` now imported from shared.js instead of defined locally.
  Cron trigger confirmed intact (`schedule: 0 * * * *`).
- `pfpi-scores-worker` redeployed (version `12860d4f-50ae-47a8-872b-b24cacbe1cea`)
  with `checkPendingBriefConfirmations()`. Cron trigger confirmed intact
  (`schedule: * * * * *`). **Needs `RESEND_API_KEY` added as a secret
  before its email-sending half will actually work — see item 9 above.**
- Frontend (`admin.html`, `archive/2025-simulation.html`, `brief.html`,
  `index.html`, `picks.html`, plus the two new archive reference files)
  committed and pushed to `main`.

**Verified live/real this round**: item 1's preseason-3 support (code
review + the same real KV data from last round's investigation), item 9's
detection logic (real KV record against real live published data, watched
fire correctly on the actual next cron tick). **Not yet verified in an
actual browser**: items 2-8 and 10's on-screen appearance and click
behavior — recommend a real pass through picks.html (deselect, the submit
confirmation dialog, Contact Yeti) and both chart pages (raccoon icon,
mascot lettering on the archive, the brief header restyle on index.html)
before calling this round done. Item 4 (CC + tally) also can't be fully
click-tested without a real picks submission through a live token.
