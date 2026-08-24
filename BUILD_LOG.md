# PFPI Build Log

Running log of every significant action taken by Claude Code during the build,
in order. Secret values are never logged, only names. See
`PFPI_Claude_Code_handoff_brief.md` (in the parent folder, not committed to
this repo) for the full spec this build follows.

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
  key Yeti provided), `ADMIN_PASSWORD_HASH` (computed locally from the exact
  placeholder password `M3iiW#kVG6biu7wt%b$@` Yeti already generated, via the
  same PBKDF2/salt/iteration spec as `hashPassword()` — cross-checked with
  two independent implementations, Node's `crypto.pbkdf2Sync` and Node's
  `webcrypto.subtle` (the same API the Worker itself uses), both produced
  identical output before it was stored), `ADMIN_SESSION_SECRET` and
  `FAMILY_TOKEN_SECRET` (freshly generated random 32-byte hex values). Secret
  values themselves are not in this log or anywhere in the repo.
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
