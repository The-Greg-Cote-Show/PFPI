# Preseason 2026 archive (Preseason Week 3)

Archived 2026-09-03 (overnight session), before Part 3 of that night's
task cleared preseason picks/scoring/UI from the live site ahead of
real Week 1. See `BUILD_LOG.md`'s "PowerPoint conversion, cron-drift
investigation, preseason archive & teardown" entry for full context.

This is the complete, real state of PFPI's preseason testing round
("preseason-3" internally) — Yeti's cross-team sandbox used to prove
out the site before the real 2026 regular season, covering the actual
16-game NFL preseason Week 3 slate (Aug 27–29, 2026). It is **not**
part of the real regular season and was retired from the live site
after this archive was built and verified.

## What's here

- **`data/week-preseason-3.json`** — the exact JSON that was live on
  the public site (`data/week-preseason-3.json` in the repo root) at
  archive time: all 16 games, final scores, every team's merged picks,
  and the computed preseason standings snapshot.
- **`data/brief-week-preseason-3.json`** — the Commissioner's Report
  content that was live for preseason (test/placeholder text only —
  Greg never wrote a real preseason recap; see caveat below).
- **`kv/`** — every `preseason-3`-scoped key pulled directly from the
  live `PFPI_KV` Cloudflare KV namespace (`3b5cd856fa7b40908601404f46b95456`),
  one file per key, `:` replaced with `_` in filenames since Windows
  paths can't contain colons. Grouped by original key prefix:
  - `picks_preseason-3_<Team>.json` (×8) — each real family team's raw
    saved picks, exactly as a visitor's own clicks left them, keyed by
    game id. (`Gentry's Neanderbrows`, the sandboxed test-team persona
    used for that week's dev/testing, is not a real family team and
    has no separate picks key of its own — see `token_pfpi-preseason3-test.json`.)
  - `notified-picks_preseason-3_<Team>.json` (×8) — the "last notified"
    snapshot each team's Submit-picks confirmation email was generated
    from (used to decide which picks get an "(Updated)" tag on a
    resubmit).
  - `digest_preseason-3.json` — the final auto-generated Weekly Digest
    text for preseason.
  - `digest-version_preseason-3_<timestamp>.json` (×2) — digest
    revision history.
  - `brief-version_preseason-3_<timestamp>.json` (×5) — Commissioner's
    Report revision history (all test/placeholder text, matching the
    live file's own content — Greg was testing the publish flow itself,
    not writing a real preseason recap).
  - `override-log_preseason-3_<timestamp>.json` (×6) — admin manual
    score-override actions taken during preseason testing.
  - `schedule_week_preseason-3.json` — the cached 16-game schedule
    (matchups, kickoff times) used for deadline math.
  - `token_pfpi-preseason3-test.json` — the one active test token,
    resolving to `{"team":"Gentry's Neanderbrows","week":"preseason-3"}`.
    This is the same link used in `training-deck/`'s screenshots.

32 KV keys total, all confirmed real `preseason-3`-scoped data — this
was every single key anywhere in the namespace whose name contained
"preseason" (checked against a full `wrangler kv key list` dump, not
just an assumed prefix), so nothing preseason-related was missed and
nothing else was swept in by mistake.

## Verification performed before anything was deleted

- Every one of the 34 JSON files above (32 KV + 2 published data files)
  parses as valid JSON — none are empty, truncated, or corrupted.
- `data/week-preseason-3.json` here is byte-identical to the file that
  was live in the repo/public site at archive time.
- Cross-checked every real team's raw KV picks
  (`picks_preseason-3_<Team>.json`) against what the published merged
  JSON actually showed for that team: **all 66 individual picks across
  all 8 real teams matched exactly** (Chickens 2/2, Critters 15/15,
  Ferraris 2/2, Giraffes 15/15, Llamas 2/2, Lobos 16/16, Maniacs 2/2,
  Roughriders 2/2) — confirming the archive reflects the real, live
  state, not stale or partial data.

## Known caveat (not an archive gap — a pre-existing content fact)

The Commissioner's Report content for preseason
(`data/brief-week-preseason-3.json` and the matching `brief-version_*`
files) is test/placeholder text Greg used to test the publish flow
("Preseason Testing Is finished. Thatkindathing"), not a real written
recap. This was already flagged in `BUILD_LOG.md` during the training-
slideshow session — noting it again here since it's archived as-is
(real, accurate to what was actually live) rather than replaced with
anything more polished.
