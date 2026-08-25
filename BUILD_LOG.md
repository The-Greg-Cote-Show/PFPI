# PFPI Build Log

Running log of every significant action taken by Claude Code during the build,
in order. Secret values are never logged, only names. See
`PFPI_Claude_Code_handoff_brief.md` (in the parent folder, not committed to
this repo) for the full spec this build follows.

## Start here: what's live vs. what needs you

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
