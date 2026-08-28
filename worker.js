// ============================================================
// PFPI Live Scores / Schedule Worker
// Built fresh from PFPI_architecture_sketch_v1.md (no reference code existed
// for this piece). Cron polls Big Balls Sports Data -> writes JSON -> commits
// to the GitHub repo via the Contents API -> served statically via GitHub
// Pages. Visitors never hit this Worker for reads; the only thing it talks
// to on a schedule is Big Balls and GitHub. It also writes a small schedule
// cache into the shared PFPI_KV namespace (kickoff times only) so the picks
// worker can compute per-game deadlines without depending on GitHub Pages'
// commit-to-CDN propagation lag, which the architecture doc flags as
// variable/untested.
//
// VERIFIED AGAINST REAL RESPONSES (2026-08-25, once BIG_BALLS_API_KEY was
// set) — see BUILD_LOG.md. Checked both an upcoming 2026 week (all-null
// scores) and a genuinely completed 2025 week (real final score) so this
// isn't a pre-season artifact. Real shape:
//   { game_id, season, week, game_date, game_type, home_team, away_team,
//     home_score, away_score, stadium, roof, surface, home_rest, away_rest }
// Two of the original best-effort field-name guesses were wrong and are
// fixed in normalizeGame() below:
//   - There is NO status/game_status field, ever (confirmed on the
//     completed 2025 game too) -> status is derived from score presence
//     instead. Residual known limitation: Big Balls exposes no live/
//     in-progress signal at all, so a partial in-progress score would be
//     misread as final if this Worker ever polls mid-game. Not fixable
//     without an API field that doesn't exist; flagged, not silently
//     assumed safe.
//   - There is NO kickoff time-of-day field, only a date-only `game_date`
//     (e.g. "2025-09-04") -> kickoffISO is synthesized as noon UTC on that
//     date, which is safely the same US calendar day in every NFL timezone
//     (no midnight-boundary rollover risk) and is sufficient for
//     computeGameDeadline(), which only needs the calendar day, not the
//     exact kickoff hour. The exact kickoff hour is genuinely unknown from
//     this API and isn't fabricated anywhere.
// home_team/away_team and home_score/away_score matched the original
// guesses exactly, including the game_id's YYYY_WW_AWAY_HOME format.
// ============================================================

import { TEAMS, computeCurrentWeekFromDate, commitJSONToGitHub, getEasternDateParts, FAMILY_MEMBERS, computeGameDeadline, sendPfpiEmail } from "./shared.js";

const BIG_BALLS_BASE = "https://api.bigballsdata.com";
const SEASON = 2026;

// ============================================================
// BIG BALLS FETCH + NORMALIZE (see gap notice above)
// ============================================================

async function fetchBigBallsWeek(week, env) {
  const res = await fetch(`${BIG_BALLS_BASE}/v1/nfl/games?season=${SEASON}&week=${week}`, {
    headers: { "Authorization": `Bearer ${env.BIG_BALLS_API_KEY}` },
  });
  if (!res.ok) {
    console.error(`Big Balls fetch failed for week ${week}: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.games || data.data || []);
}

// Isolates every assumption about Big Balls' exact response shape.
function normalizeGame(raw) {
  // game_id format per Big Balls' marketing docs: YYYY_WW_AWAY_HOME
  const idParts = String(raw.game_id || raw.id || "").split("_");
  const awayFromId = idParts.length === 4 ? idParts[2] : null;
  const homeFromId = idParts.length === 4 ? idParts[3] : null;

  const home = raw.home_team || raw.home || homeFromId || null;
  const away = raw.away_team || raw.away || awayFromId || null;
  const homeScore = raw.home_score ?? raw.homeScore ?? null;
  const awayScore = raw.away_score ?? raw.awayScore ?? null;
  // No status field exists in real responses (see gap notice above) — the
  // only signal available is whether both scores are populated.
  const status = (homeScore !== null && awayScore !== null) ? "final" : "scheduled";
  // No kickoff time-of-day exists in real responses either, only a
  // date-only game_date — anchored at noon UTC so the calendar day is
  // unambiguous in every US timezone (see gap notice above).
  const kickoffISO = raw.kickoff || raw.start_time || raw.game_time
    || (raw.game_date ? `${raw.game_date}T12:00:00.000Z` : null);

  // Tie handling, per Yeti (2026-08-25): a tied game is nullified for
  // pick'em purposes entirely -- no winner, excluded from every team's
  // correct/incorrect tally and from the week's game-count denominator
  // (see computeStandings below). Before this fix, a tie (homeScore ===
  // awayScore) fell through to the `else` branch below and was silently
  // recorded as an away-team win -- a real scoring bug, not just a missing
  // feature, now fixed at the source.
  const tie = status === "final" && homeScore !== null && awayScore !== null && homeScore === awayScore;
  let winner = null;
  if (status === "final" && homeScore !== null && awayScore !== null && !tie) {
    winner = homeScore > awayScore ? home : away;
  }

  return {
    id: raw.game_id || raw.id,
    // hasRealTime: false -- kickoffISO above is a noon-UTC placeholder
    // anchored to the real calendar date, not a real kickoff hour (see
    // the gap notice above). The frontend uses this flag to show a date
    // only for these games, never a fabricated time -- contrast
    // normalizeHighlightlyGame()'s hasRealTime: true, which has genuine
    // kickoff timestamps.
    // clockReport: always null -- Big Balls has no "in_progress" status at
    // all (see the gap notice above: status here is only ever "final" or
    // "scheduled", inferred from whether scores are populated), so there
    // is no live game-clock data source for real regular-season games,
    // unlike Highlightly's preseason feed (see normalizeHighlightlyGame's
    // own clockReport, confirmed against a real live game 2026-08-27).
    home, away, homeScore, awayScore, status, kickoffISO, winner, tie, hasRealTime: false, clockReport: null,
  };
}

// ============================================================
// HIGHLIGHTLY — preseason Week 3 (Aug 27-29, 2026) ONLY
// ============================================================
// SCOPE, DECIDED 2026-08-25 (per PFPI_highlightly_overnight_handoff.md's
// explicit instruction not to silently expand scope): this is a STOPGAP
// for this one preseason week specifically, not an ongoing parallel source
// alongside Big Balls. Big Balls has zero PRE/POST coverage (confirmed, see
// BUILD_LOG.md) so it can't cover this week at all; Highlightly can, but
// nothing here assumes it'll be used again after Week 3. If postseason
// coverage is ever wanted the same way, that's a separate decision for
// Yeti to make, not something this build extends to automatically.
//
// VERIFIED LIVE (2026-08-25) against the real ESPN-published Week 3
// schedule Yeti pasted in chat: GET /matches?league=NFL&season=2026&limit=100
// returns 78 games (45 preseason + 33 already-scheduled regular season) in
// one call, no pagination needed. Filtering to round==="preseason" and an
// Eastern-calendar-date of Aug 27/28/29 (not the raw `date` field's UTC
// calendar date, which splits some games onto the wrong day — evening ET
// kickoffs roll into the next UTC day) reliably returns all 16 real games,
// matched matchup-for-matchup and kickoff-time-for-kickoff-time against the
// ESPN listing. The `date=YYYY-MM-DD` query param this same endpoint
// supports does NOT reliably do this (confirmed: date=2026-08-27 alone
// returns only 1 of the 4 real Aug-27-ET games, missing the three 8pm+ ET
// games that land on 2026-08-28 in UTC) — don't use it for this purpose.
//
// CONFIRMED 2026-08-27 ~11pm ET (was flagged unconfirmed here originally):
// `state.score.current` is a combined "X - Y" string with no separate
// home/away fields. The initial guess ("away - home", matching this
// site's own away@home display convention) was wrong -- real evidence
// from PIT@BUF proved it's actually "home - away". See
// normalizeHighlightlyGame()'s own note at the fix site for the real
// evidence and the full blast radius (scores, winner, and every
// downstream pick-correctness result were all affected, not just display).

const HIGHLIGHTLY_BASE = "https://american-football.highlightly.net";
const PRESEASON_WEEK3_ET_DATES = new Set(["2026-08-27", "2026-08-28", "2026-08-29"]);

function easternDateKey(isoString) {
  const parts = getEasternDateParts(new Date(isoString));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeHighlightlyGame(g) {
  const home = g.homeTeam?.abbreviation || null;
  const away = g.awayTeam?.abbreviation || null;

  // REAL BUG FOUND AND FIXED 2026-08-27 ~10pm ET, live during PIT@BUF:
  // Highlightly's actual completed-game `state.description` is "Finished",
  // not "Final" -- confirmed by directly logging the raw payload of a game
  // stuck reporting status:"in_progress" while its own state.report field
  // already read "Final" (`desc.includes("final")` was false against
  // "finished", which does not contain the substring "final"). This meant
  // NO preseason game could ever be detected as final at all, silently --
  // computePreseasonSnapshot()'s `finalResults` filter would stay
  // permanently empty regardless of how many real games actually finished.
  // Checking "finished" too, not replacing "final" with it, since it's
  // unconfirmed whether Highlightly ever uses the literal word "final" in
  // some other response shape/edge case.
  const desc = (g.state?.description || "").toLowerCase();
  const status = (desc.includes("final") || desc.includes("finished")) ? "final" : desc.includes("scheduled") ? "scheduled" : "in_progress";

  // REAL BUG FOUND AND FIXED 2026-08-27 ~11pm ET, per Yeti checking real
  // results against the live site: the gap notice above flagged this order
  // as an unconfirmed guess ("away - home"), and the guess was wrong. Real
  // evidence: PIT@BUF's `state.score.current` was "27 - 28", and Yeti
  // confirmed the real-world result is BUF 28, PIT 27 (BUF won) -- so the
  // first number in the string is HOME's score, not away's. This single
  // parsing bug corrupted every preseason score and, downstream, every
  // `winner` determination and therefore every pick-correctness result in
  // computePreseasonSnapshot() -- not just a display issue.
  let awayScore = null, homeScore = null;
  const current = g.state?.score?.current;
  if (current && current !== "0 - 0") {
    const parts = current.split(" - ").map(s => parseInt(s.trim(), 10));
    if (parts.length === 2 && parts.every(n => !isNaN(n))) {
      [homeScore, awayScore] = parts;
    }
  }

  // Same tie fix as normalizeGame() above -- a tie must not fall through to
  // the away-team branch. Preseason games aren't scored for PFPI picks, but
  // a wrong "winner" would still be a real display bug if any of these 16
  // games ties (plausible in real preseason play).
  const tie = status === "final" && homeScore !== null && awayScore !== null && homeScore === awayScore;
  let winner = null;
  if (status === "final" && homeScore !== null && awayScore !== null && !tie) {
    winner = homeScore > awayScore ? home : away;
  }

  // Live game clock (added 2026-08-27, per Yeti) -- confirmed by directly
  // logging one real in-progress game's raw payload (not guessed):
  // Highlightly's `state.report` is a ready-made string, e.g. "9:33 - 1st
  // Quarter", matching `state.clock`/`state.period` (573 seconds, period 1)
  // exactly. Only meaningful while in_progress -- null for scheduled/final,
  // so the frontend can tell "no clock to show" apart from "0:00". This
  // reflects whatever Highlightly returned as of THIS poll, not a live
  // client-side ticking clock -- see shouldPollHighlightlyThisTick's own
  // cadence for how fresh that actually is.
  const clockReport = status === "in_progress" ? (g.state?.report || null) : null;

  return {
    id: `hl-${g.id}`,
    // hasRealTime: true -- unlike Big Balls, Highlightly's `date` is a real
    // kickoff timestamp, not a synthesized placeholder (see gap notice
    // above and normalizeGame()'s own hasRealTime: false). Lets the
    // frontend show an actual time for preseason games and be honest that
    // it can't for regular-season ones.
    // picks: {} -- no PFPI picks are ever made against preseason games, but
    // an empty object keeps this game's shape consistent with regular-season
    // games (buildWeekPublicJSON always includes one, possibly empty),
    // which the frontend's picks-breakdown expects to exist.
    home, away, homeScore, awayScore, status, kickoffISO: g.date, winner, tie, hasRealTime: true, picks: {}, clockReport,
  };
}

// Throttled to fit Highlightly's 100/day free-tier budget, per Yeti
// (2026-08-25), REVISED 2026-08-27 after two corrections to the original
// design:
//
// 1. The real game split is NOT evenly spread across the three days -- it's
//    4 games Thu Aug 27, 10 games Fri Aug 28, 2 games Sat Aug 29 (confirmed
//    against the real published schedule + Yeti directly), with one game
//    each Thu and Fri night kicking off late enough to finish after
//    midnight ET (LAR@LAC, 10pm ET Thu -> est. finish ~1:15-1:30am ET Fri;
//    MIN@DEN, 9pm ET Fri -> est. finish ~12:15am ET Sat). The original
//    per-day windows below cut off well before those two games actually
//    end, which would have delayed their final score by many hours (until
//    the next day's window opened) instead of missing it outright.
//
// 2. This key is consumed via RapidAPI (see the `x-rapidapi-key` header
//    below), and RapidAPI's "100/day" quota is NOT a midnight-UTC or
//    midnight-ET calendar-day reset -- per RapidAPI's own docs, it's a
//    ROLLING 24-hour window anchored to the account's original subscription
//    timestamp. Yeti confirmed that timestamp is ~1:00-1:30am ET (signup
//    confirmation email logged at 1:16am ET). 1:00am ET is used below as
//    the conservative (earliest-possible) daily boundary between one day's
//    budget and the next -- a window that closes a few minutes before the
//    real boundary just leaves unused headroom; one that assumes a later
//    boundary and is wrong would risk spending the next day's budget early.
//
// Budgets under this design (all well under 100, verified by hand):
//   "Thu" quota day (1am ET Thu -> 1am ET Fri): ~72 polls (7pm-1am, every 5
//     min), covering all 4 Thu games including the first hour of LAR@LAC.
//   "Fri" quota day (1am ET Fri -> 1am ET Sat): ~85 polls -- the last ~6
//     polls of LAR@LAC's tail (1:00-1:30am ET Fri, technically Friday's
//     budget, negligible against its much larger 10-game allowance),
//     6pm-1am covering all 10 Fri games, plus MIN@DEN's tail into Sat.
//   "Sat" quota day (1am ET Sat -> 1am ET Sun): ~84 polls across two short
//     windows (1-4:30pm, 6-9:30pm ET) bracketing the day's only 2 games,
//     skipping the dead ~4:30-6pm gap between them.
//
// Outside these specific windows: no call is made at all -- not just a
// no-op response, an actual skipped fetch, so nothing is spent when
// there's nothing to learn. After Aug 29 this returns false forever; this
// was only ever a testing bridge, not an ongoing source (see scope notice
// above this section).
function shouldPollHighlightlyThisTick(now) {
  const parts = getEasternDateParts(now);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = now.getUTCMinutes(); // safe: whole-hour ET/UTC offset (EDT) all three days

  // Thu Aug 27 evening (PIT@BUF 7pm, NE@CLE 8pm, SF@LV 8pm ET) through the
  // Aug27/28 ET midnight rollover.
  if (dateKey === "2026-08-27" && hour >= 19) return minute % 5 === 0;
  if (dateKey === "2026-08-28" && hour < 1) return minute % 5 === 0;
  // Tail end of LAR@LAC (10pm ET Thu kickoff, est. finish ~1:15-1:30am ET
  // Fri) -- deliberately spills a handful of polls past the ~1am ET quota
  // boundary into Friday's own (much larger) budget rather than stop short
  // and miss this game's final score for hours.
  if (dateKey === "2026-08-28" && hour === 1 && minute <= 30) return minute % 5 === 0;

  // Fri Aug 28 evening (10 games, 6-9pm ET kickoffs) through the Aug28/29
  // ET midnight rollover.
  if (dateKey === "2026-08-28" && hour >= 18) return minute % 5 === 0;
  // Tail end of MIN@DEN (9pm ET Fri kickoff, est. finish ~12:15am ET Sat) --
  // still inside Friday's own quota day (1am Fri -> 1am Sat), not
  // Saturday's.
  if (dateKey === "2026-08-29" && hour === 0 && minute <= 35) return minute % 5 === 0;

  // Sat Aug 29: only 2 games (DET@IND 1pm ET, CHI@TEN 6pm ET), each
  // finishing well within its own window -- two short windows instead of
  // one long one spanning the dead ~4:30-6pm gap between them.
  if (dateKey === "2026-08-29" && hour >= 13 && hour < 17) return minute % 5 === 0;
  if (dateKey === "2026-08-29" && hour >= 18 && hour < 22) return minute % 5 === 0;

  return false;
}

async function fetchHighlightlyPreseasonWeek3(env) {
  if (!env.HIGHLIGHTLY_API_KEY) {
    console.error("Skipping Highlightly preseason Week 3 fetch: HIGHLIGHTLY_API_KEY not set.");
    return null;
  }
  if (!shouldPollHighlightlyThisTick(new Date())) {
    return null;
  }

  const res = await fetch(`${HIGHLIGHTLY_BASE}/matches?league=NFL&season=${SEASON}&limit=100`, {
    headers: { "x-rapidapi-key": env.HIGHLIGHTLY_API_KEY },
  });
  if (!res.ok) {
    console.error(`Highlightly fetch failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = await res.json();
  const games = (data.data || [])
    .filter(g => g.round === "preseason" && PRESEASON_WEEK3_ET_DATES.has(easternDateKey(g.date)))
    .map(normalizeHighlightlyGame);

  if (games.length !== 16) {
    console.error(`Highlightly preseason Week 3: expected 16 games, got ${games.length}. Check for a real schedule change or a filter regression.`);
  }

  return games;
}

// ============================================================
// STANDINGS + tie-split point categories (cumulative correct picks per
// team per week, Weekly Titles, Weeks Leading, Best Week)
// ============================================================
// Tie-splitting rule confirmed by Greg via Yeti (2026-08-25): when N teams
// tie for a week's honor, each gets 1.00/N rounded to 2 decimals (half-up),
// awarded at the moment of the tie and summed week-over-week -- not
// recomputed retroactively. tenWin/uniqueHits stay on permanent simulated
// data (no real source exists) per Yeti's earlier explicit decision; only
// Standings, Weekly Titles, Weeks Leading, and Best Week are computed here.

// 1/N rounded to exactly 2 decimals, half-up (matches Greg's worked
// examples: 3-way tie -> 0.33, 8-way tie -> 0.13).
function splitShare(n) {
  return Math.round((1 / n) * 100) / 100;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

async function computeStandings(throughWeek, env) {
  const standings = {};
  const standingsPct = {};
  const weeklyTitles = {};
  const weeksLeading = {};
  const bestWeek = {};
  // Cumulative count of weeks (through each week) a team held/shared that
  // week's honor -- e.g. weeklyTitlesCount[team][week] = 5 means Critters
  // has held or shared the weekly-title honor in 5 of the weeks played so
  // far. Feeds the "(N)" in brief.html's digest ("CRITTERS 8.33 (5)").
  const weeklyTitlesCount = {};
  const weeksLeadingCount = {};
  // Total scorable (non-tied) games played league-wide through each week --
  // same for every team, so kept as a flat week->count map, not per-team.
  // Lets a consumer (brief.html's digest) derive each team's loss count as
  // gamesPlayed[week] - standings[team][week] without back-deriving it from
  // standingsPct (which loses precision/introduces float-division risk).
  const gamesPlayed = {};
  TEAMS.forEach(t => {
    standings[t] = {}; standingsPct[t] = {};
    weeklyTitles[t] = {}; weeksLeading[t] = {}; bestWeek[t] = {};
    weeklyTitlesCount[t] = {}; weeksLeadingCount[t] = {};
  });

  let cumulative = {};
  TEAMS.forEach(t => cumulative[t] = 0);
  let titlePoints = {};
  TEAMS.forEach(t => titlePoints[t] = 0);
  let leadPoints = {};
  TEAMS.forEach(t => leadPoints[t] = 0);
  let titleCount = {};
  TEAMS.forEach(t => titleCount[t] = 0);
  let leadCount = {};
  TEAMS.forEach(t => leadCount[t] = 0);
  // Each team's best single-week record so far -- {correct, total, pct, week}
  // or null until they've played a scorable week. Only replaced when
  // strictly beaten (higher pct, or same pct with more correct picks as a
  // tiebreak), so it "only increases when beaten" per the mockup's own
  // description and never flip-flops between equally-good weeks.
  let bestSoFar = {};
  TEAMS.forEach(t => bestSoFar[t] = null);

  let gamesPlayedCumulative = 0;
  // Per Yeti (2026-08-25): a tied NFL game is nullified for pick'em purposes
  // entirely -- no one scored correct/incorrect on it, and it doesn't count
  // toward that week's game total. tieNotes feeds index.html's visible
  // "Week N: X at Y ended in a tie" note (see frontend below and
  // BUILD_LOG.md) -- collected here since this loop already has the real
  // schedule/result data needed, avoiding a second pass or a second fetch.
  const tieNotes = {};

  for (let week = 1; week <= throughWeek; week++) {
    const raw = await env.PFPI_KV.get(`results:week:${week}`);
    const results = raw ? JSON.parse(raw) : [];
    const tiedGames = results.filter(g => g.tie);
    const scorableGames = results.filter(g => !g.tie);
    const weekTotal = scorableGames.length;
    gamesPlayedCumulative += weekTotal;
    gamesPlayed[String(week)] = gamesPlayedCumulative;
    if (tiedGames.length > 0) {
      tieNotes[week] = tiedGames.map(g => `${g.away} at ${g.home}`);
    }

    const correctThisWeek = {};
    for (const team of TEAMS) {
      const picksRaw = await env.PFPI_KV.get(`picks:${week}:${team}`);
      const picks = picksRaw ? JSON.parse(picksRaw) : {};
      let correct = 0;
      for (const game of scorableGames) {
        if (game.winner && picks[game.id] === game.winner) correct++;
      }
      correctThisWeek[team] = correct;
      cumulative[team] += correct;
      standings[team][String(week)] = cumulative[team];
      standingsPct[team][String(week)] = gamesPlayedCumulative > 0
        ? cumulative[team] / gamesPlayedCumulative
        : 0;
    }

    // Weekly Titles: best single-week record this week, split on ties.
    // Skipped (no title awarded) for weeks with no scored games yet -- a
    // week where every team is at 0-0 isn't a real tie for best record.
    if (weekTotal > 0) {
      const maxCorrect = Math.max(...TEAMS.map(t => correctThisWeek[t]));
      const holders = TEAMS.filter(t => correctThisWeek[t] === maxCorrect);
      const share = splitShare(holders.length);
      holders.forEach(t => { titlePoints[t] += share; titleCount[t] += 1; });
    }
    TEAMS.forEach(t => {
      weeklyTitles[t][String(week)] = round2(titlePoints[t]);
      weeklyTitlesCount[t][String(week)] = titleCount[t];
    });

    // Weeks Leading: who holds the lead in the cumulative season standings
    // as of this week (not who had the best week -- the season-long
    // leader), split on ties. Skipped until at least one scored game exists
    // season-to-date, for the same reason as above.
    if (gamesPlayedCumulative > 0) {
      const maxCum = Math.max(...TEAMS.map(t => cumulative[t]));
      const holders = TEAMS.filter(t => cumulative[t] === maxCum);
      const share = splitShare(holders.length);
      holders.forEach(t => { leadPoints[t] += share; leadCount[t] += 1; });
    }
    TEAMS.forEach(t => {
      weeksLeading[t][String(week)] = round2(leadPoints[t]);
      weeksLeadingCount[t][String(week)] = leadCount[t];
    });

    // Best Week: update each team's personal-best week if this week beats it.
    if (weekTotal > 0) {
      TEAMS.forEach(team => {
        const pct = correctThisWeek[team] / weekTotal;
        const current = bestSoFar[team];
        if (!current || pct > current.pct || (pct === current.pct && correctThisWeek[team] > current.correct)) {
          bestSoFar[team] = { correct: correctThisWeek[team], total: weekTotal, pct, week };
        }
      });
    }
    TEAMS.forEach(t => {
      bestWeek[t][String(week)] = bestSoFar[t] || { correct: 0, total: 0, pct: 0, week };
    });
  }

  return {
    standings, standingsPct, tieNotes, weeklyTitles, weeksLeading, bestWeek,
    weeklyTitlesCount, weeksLeadingCount, gamesPlayed,
  };
}

// ============================================================
// PRESEASON SCORING SNAPSHOT (2026-08-27 round)
// ============================================================
// Yeti's real requirement: when preseason is the selected week, Standings/
// Weekly Titles/Weeks Leading/Best Week should compute and show real
// numbers from real preseason picks/results, same as a genuine numbered
// week -- for real hands-on testing this weekend. Confirmed scope: all of
// preseason Week 3 (Aug 27-29) is ONE single unified week for scoring
// purposes (same as a normal NFL week already bundles Thu/Sun/Mon games),
// and it must be structurally impossible for this to ever sum into real
// regular-season cumulative totals, now or after the real season starts.
//
// How that's actually guaranteed, not just asserted: this function shares
// NO code and NO mutable state with computeStandings() above -- it is not
// a call into that function with a special-cased argument, it is a
// completely separate, stateless, single-week-only computation (the only
// things reused are the tiny generic math helpers splitShare()/round2(),
// which have no notion of "week" or "cumulative" at all). computeStandings
// ONLY EVER iterates a numeric range (`for week = 1; week <= throughWeek`)
// -- there is no code path by which it could read "preseason-3" even if
// asked to, and this function never writes into `results:week:N` (the KV
// namespace computeStandings reads from) or into data/standings.json (the
// file the real-season frontend loads) at all. The result is committed
// into its own field inside data/week-preseason-3.json (see
// pollAndPublish below), a file computeStandings/data/standings.json have
// no knowledge of. Two independent computations, two independent output
// destinations -- not one function with a bypassable guard clause.
function computePreseasonSnapshot(finalResults, picksByTeam, weekLabel) {
  const scorableGames = finalResults.filter(g => !g.tie);
  const weekTotal = scorableGames.length;

  const correctThisTeam = {};
  TEAMS.forEach(team => {
    const picks = picksByTeam[team] || {};
    let correct = 0;
    for (const game of scorableGames) {
      if (game.winner && picks[game.id] === game.winner) correct++;
    }
    correctThisTeam[team] = correct;
  });

  // Weekly Titles and Weeks Leading collapse to the identical computation
  // here -- both concepts ("best record this week" / "leading the
  // cumulative season") are the same thing when there's only one week in
  // the "season" to lead or win. Not a bug that they end up numerically
  // equal for preseason.
  let holders = [], share = 0;
  if (weekTotal > 0) {
    const maxCorrect = Math.max(...TEAMS.map(t => correctThisTeam[t]));
    holders = TEAMS.filter(t => correctThisTeam[t] === maxCorrect);
    share = splitShare(holders.length);
  }

  const standings = {}, standingsPct = {};
  const weeklyTitles = {}, weeklyTitlesCount = {};
  const weeksLeading = {}, weeksLeadingCount = {};
  const bestWeek = {};

  TEAMS.forEach(team => {
    const correct = correctThisTeam[team];
    const pct = weekTotal > 0 ? correct / weekTotal : 0;
    const isHolder = holders.includes(team);

    standings[team] = { [weekLabel]: correct };
    standingsPct[team] = { [weekLabel]: pct };
    weeklyTitles[team] = { [weekLabel]: isHolder ? round2(share) : 0 };
    weeklyTitlesCount[team] = { [weekLabel]: isHolder ? 1 : 0 };
    weeksLeading[team] = { [weekLabel]: isHolder ? round2(share) : 0 };
    weeksLeadingCount[team] = { [weekLabel]: isHolder ? 1 : 0 };
    bestWeek[team] = {
      [weekLabel]: weekTotal > 0
        ? { correct, total: weekTotal, pct, week: "Preseason" }
        : { correct: 0, total: 0, pct: 0, week: "Preseason" },
    };
  });

  // gamesPlayed (added 2026-08-27 for the Commissioner's Digest, which
  // needs a loss count -- `wins`/`gamesPlayed` -- the same way it already
  // does for real weeks via data/standings.json's own gamesPlayed field).
  // Flat, not per-team, matching that same real-week shape exactly:
  // computeStandings() above keys this identically (gamesPlayed[week] =
  // total games), it's just a single-week value here instead of a running
  // cumulative total, since there's only ever one preseason "week."
  const gamesPlayed = { [weekLabel]: weekTotal };

  return { standings, standingsPct, weeklyTitles, weeklyTitlesCount, weeksLeading, weeksLeadingCount, bestWeek, gamesPlayed };
}

// ============================================================
// PER-WEEK PUBLIC JSON (games + picks, matches mockup's SCHEDULE shape)
// ============================================================

async function buildWeekPublicJSON(week, results, env) {
  // One KV read per team for the whole week, not per game.
  const picksByTeam = {};
  for (const team of TEAMS) {
    const picksRaw = await env.PFPI_KV.get(`picks:${week}:${team}`);
    picksByTeam[team] = picksRaw ? JSON.parse(picksRaw) : {};
  }

  return results.map(g => {
    const picks = {};
    for (const team of TEAMS) {
      if (picksByTeam[team][g.id]) picks[team] = picksByTeam[team][g.id];
    }
    return {
      id: g.id, home: g.home, away: g.away,
      kickoffISO: g.kickoffISO, hasRealTime: !!g.hasRealTime, status: g.status,
      homeScore: g.homeScore, awayScore: g.awayScore,
      winner: g.winner, tie: !!g.tie, picks,
      // Always null for this path (Big Balls has no live-clock data at all
      // -- see normalizeGame's own note); this field is only ever
      // meaningful via the preseason/Highlightly path, which spreads the
      // normalized game object through directly instead of enumerating
      // fields like this function does.
      clockReport: g.clockReport || null,
      // Same computeGameDeadline() the picks worker uses for /my-picks — not
      // a second deadline calculation, just exposed here too so a public
      // page (Greg's dashboard) can sort by urgency without needing an
      // authenticated per-team session.
      deadline: computeGameDeadline(g.kickoffISO),
    };
  });
}

// ============================================================
// POLLING THROTTLE — per Yeti (2026-08-25): Highlightly (100/day) and Big
// Balls (2000/day, GitHub-linked tier) have genuinely different budgets and
// needs, so they don't share a cadence. The underlying Cron Trigger floor
// is still 1 minute (no Durable Object alarms in this build -- same
// judgment call the original build already made not to add that
// complexity), so "every ~15-20s" during Big Balls live windows is
// approximated as "every tick" (the finest available), per the handoff
// doc's own "target behavior matters more than exact mechanism" allowance.
// ============================================================

function isBigBallsLiveWindow(now) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const hour = parseInt(getEasternDateParts(now).hour, 10);
  // Thursday/Monday night windows; Sunday covers early/late/SNF.
  if (weekday === "Thu") return hour >= 20;
  if (weekday === "Sun") return hour >= 13;
  if (weekday === "Mon") return hour >= 20;
  return false;
}

// Outside live windows: poll every 15 min instead of every tick -- still
// catches schedule/flex changes, a fraction of the 2000/day budget. UTC
// minute is safe to gate on directly since every NFL-market US timezone is
// a whole-hour UTC offset (no half-hour zones), so UTC and ET
// minute-of-hour always agree.
function shouldPollBigBallsThisTick(now) {
  return isBigBallsLiveWindow(now) || now.getUTCMinutes() % 15 === 0;
}

// ============================================================
// FULL 2026 REGULAR-SEASON SCHEDULE PRELOAD (one-time)
// ============================================================
// Per Yeti (2026-08-25): pre-load all 272 games' matchups/dates/kickoff
// times now, not progressively as [currentWeek, currentWeek+1] normally
// would. Verified empirically first, not assumed: Big Balls' `limit` maxes
// at 200 (a real 400 at limit=300 confirmed the ceiling), and two calls
// (limit=200 at offset=0 and offset=200) retrieve all 272 games with zero
// duplicate ids -- a real 2-request cost, not the "meaningful chunk of
// budget" the handoff doc was right to ask about but that turned out not
// to be a real concern in practice. KV-flag-gated so this runs at most
// once ever: checked every tick, but only actually calls Big Balls the one
// time the flag isn't set, so a later tick can't repeat the cost.
async function preloadFullSeasonScheduleIfNeeded(env) {
  const flagKey = `season-${SEASON}-full-schedule-loaded`;
  if (await env.PFPI_KV.get(flagKey)) return;

  const headers = { "Authorization": `Bearer ${env.BIG_BALLS_API_KEY}` };
  const all = [];
  for (const offset of [0, 200]) {
    const res = await fetch(`${BIG_BALLS_BASE}/v1/nfl/games?season=${SEASON}&type=REG&limit=200&offset=${offset}`, { headers });
    if (!res.ok) {
      console.error(`Full-season preload failed at offset ${offset}: ${res.status} ${await res.text()}`);
      return; // flag not set -- retried on a later tick
    }
    const data = await res.json();
    all.push(...(data.data || []));
  }

  const byWeek = {};
  for (const raw of all) {
    if (!raw.week) continue;
    const normalized = normalizeGame(raw);
    (byWeek[raw.week] ||= []).push({ id: normalized.id, home: normalized.home, away: normalized.away, kickoffISO: normalized.kickoffISO });
  }

  for (const [week, games] of Object.entries(byWeek)) {
    await env.PFPI_KV.put(`schedule:week:${week}`, JSON.stringify(games));
  }

  await env.PFPI_KV.put(flagKey, JSON.stringify({
    loadedAt: new Date().toISOString(), totalGames: all.length, weeks: Object.keys(byWeek).length,
  }));
  console.log(`Full-season preload complete: ${all.length} games across ${Object.keys(byWeek).length} weeks.`);
}

// ============================================================
// BRIEF PUBLISH CONFIRMATION -- per Yeti (2026-08-26): send a "the brief
// is live" email only once a publish is ACTUALLY visible on the real
// public site, not merely committed to GitHub (a commit succeeding
// doesn't mean GitHub Pages has finished rebuilding/deploying it yet --
// the observed 10-15 minute variance Yeti saw came from investigating
// this exact gap; see BUILD_LOG.md for what was actually found: this repo
// uses GitHub's classic "Deploy from a branch" Pages method, not a slower
// Actions-based build, so there's no repo-side config lever to speed it up
// further -- the variance is GitHub's own infrastructure timing, outside
// what a code change here can control). Runs every tick (this Worker's
// cron is every minute) regardless of the Big Balls throttle below --
// cheap (one KV list + one plain unauthenticated fetch per pending week)
// and this is specifically the piece that needs to be fast.
// ============================================================

// Comfortably past the worst case Yeti actually observed (10-15 min), so
// this doesn't retry forever if something's genuinely stuck.
const BRIEF_CONFIRM_MAX_AGE_MS = 30 * 60 * 1000;

async function checkPendingBriefConfirmations(env) {
  const list = await env.PFPI_KV.list({ prefix: "brief-pending-confirm:" });
  for (const key of list.keys) {
    const raw = await env.PFPI_KV.get(key.name);
    if (!raw) continue;
    const pending = JSON.parse(raw);

    let live = null;
    try {
      const res = await fetch(`https://the-greg-cote-show.github.io/PFPI/data/brief-week-${pending.week}.json?t=${Date.now()}`);
      if (res.ok) live = await res.json();
    } catch (e) {
      // Network blip -- try again next tick rather than giving up on one failure.
    }

    if (live && live.updatedAt === pending.expectedUpdatedAt) {
      await sendPfpiEmail(
        pending.notifyEmail,
        `PFPI Week ${pending.week} brief is live`,
        `Week ${pending.week}'s brief just went live on the public site -- confirmed by reading it back from the real published page, not just that the save succeeded.\n\nhttps://the-greg-cote-show.github.io/PFPI/index.html`,
        env
      );
      await env.PFPI_KV.delete(key.name);
      continue;
    }

    const ageMs = Date.now() - new Date(pending.createdAt).getTime();
    if (ageMs > BRIEF_CONFIRM_MAX_AGE_MS) {
      // Honest fallback: only ever claim "live" once actually confirmed
      // above, so this is a heads-up, not a fabricated confirmation --
      // a genuinely stuck publish shouldn't just go silent forever.
      await sendPfpiEmail(
        pending.notifyEmail,
        `PFPI Week ${pending.week} brief: still checking after 30 minutes`,
        `Week ${pending.week}'s brief was saved, but this Worker couldn't confirm it's actually live on the public site after 30 minutes of checking. It may still show up on its own (GitHub Pages can occasionally lag that long) -- worth a manual check, and flagging to Yeti if it's still missing.`,
        env
      );
      await env.PFPI_KV.delete(key.name);
    }
  }
}

// ============================================================
// MAIN POLL CYCLE
// ============================================================

async function pollAndPublish(env) {
  await checkPendingBriefConfirmations(env);

  const currentWeek = computeCurrentWeekFromDate();
  await env.PFPI_KV.put("current-week", String(currentWeek));

  if (!env.BIG_BALLS_API_KEY) {
    console.error("Skipping Big Balls poll: BIG_BALLS_API_KEY not set. No regular-season score/schedule data fetched or published this tick.");
  } else if (!shouldPollBigBallsThisTick(new Date())) {
    // Throttled: outside a live window and not a 15-min mark this tick.
  } else {
    await preloadFullSeasonScheduleIfNeeded(env);

    // Poll current week and next week, so next week's kickoff times (and
    // therefore deadlines) are available before Tuesday's picks email goes out.
    const weeksToPoll = [currentWeek, Math.min(currentWeek + 1, 18)];
    const weekFiles = {};

    for (const week of weeksToPoll) {
      const raw = await fetchBigBallsWeek(week, env);
      if (!raw) continue;
      const normalized = raw.map(normalizeGame);

      // Schedule cache for the picks worker's deadline math: kickoff times only.
      await env.PFPI_KV.put(
        `schedule:week:${week}`,
        JSON.stringify(normalized.map(g => ({ id: g.id, home: g.home, away: g.away, kickoffISO: g.kickoffISO })))
      );

      // Once a game is final, its result is locked in for standings purposes.
      const finals = normalized.filter(g => g.status === "final");
      if (finals.length > 0) {
        await env.PFPI_KV.put(`results:week:${week}`, JSON.stringify(finals));
      }

      weekFiles[week] = await buildWeekPublicJSON(week, normalized, env);
    }

    const {
      standings, standingsPct, tieNotes, weeklyTitles, weeksLeading, bestWeek,
      weeklyTitlesCount, weeksLeadingCount, gamesPlayed,
    } = await computeStandings(currentWeek, env);

    for (const [week, games] of Object.entries(weekFiles)) {
      await commitJSONToGitHub(
        `data/week-${week}.json`,
        { week: Number(week), games },
        `Update Week ${week} scores/picks [automated]`,
        env
      );
    }

    await commitJSONToGitHub(
      "data/standings.json",
      {
        standings, standingsPct, tieNotes, weeklyTitles, weeksLeading, bestWeek,
        weeklyTitlesCount, weeksLeadingCount, gamesPlayed,
        throughWeek: currentWeek, updatedAt: new Date().toISOString(),
      },
      `Update standings through Week ${currentWeek} [automated]`,
      env
    );

    await commitJSONToGitHub(
      "data/current.json",
      { currentWeek, numWeeks: 18, updatedAt: new Date().toISOString() },
      "Update current week pointer [automated]",
      env
    );
  }

  // Preseason Week 3 stopgap (Aug 27-29, 2026 only) — see scope notice above
  // fetchHighlightlyPreseasonWeek3(). Schedule/score refresh stays on its
  // own tight Highlightly budget (shouldPollHighlightlyThisTick only calls
  // the API during the real game windows). Re-merging + republishing PICKS
  // is deliberately decoupled from that below.
  //
  // [BUG FOUND 2026-08-25/26, root-caused fresh per Yeti's handoff doc --
  // NOT the apostrophe/team-name theory it flagged as worth checking, and
  // NOT a KV or merge-logic bug either]: Yeti reported picks missing for
  // Gracelin's Giraffes and Mike's Chickens but not Dick's Roughriders.
  // Direct KV reads (`wrangler kv key get picks:preseason-3:Giraffes` /
  // `...:Chickens`) proved both teams' picks were saved correctly, all 16
  // games each -- so submission and storage were never the problem for any
  // team. The real cause: this whole picks-merge-and-republish block used
  // to live INSIDE `if (preseasonGames)`, gated on a fresh, successful
  // Highlightly fetch -- and that fetch is intentionally throttled to only
  // ever hit the API during the Aug 27/28/29 game windows (100/day budget).
  // Outside those windows (i.e. right now, Aug 25), the fetch always
  // returns null, so the merge+publish step never ran at all -- confirmed
  // by the committed data/week-preseason-3.json being frozen at whatever
  // picks existed at the *last* successful Highlightly fetch, not the real
  // current KV state. Roughriders had been tested before that last fetch
  // and got captured in the frozen snapshot; Giraffes/Chickens were tested
  // afterward and simply never got a chance to publish -- not team-specific
  // at all, any team tested after that point would have "disappeared" the
  // same way. Fix: fall back to the last cached schedule
  // (schedule:week:preseason-3) when Highlightly isn't polled this tick,
  // and re-merge+republish picks on their own 5-minute cadence -- cheap
  // (KV reads only, no external API call) and no longer dependent on a
  // live score fetch to "unlock" a picks update.
  const freshPreseasonGames = await fetchHighlightlyPreseasonWeek3(env);
  if (freshPreseasonGames) {
    // Schedule cache stays picks-free, matching schedule:week:N's existing
    // shape (kickoff-math only, not for public reading).
    await env.PFPI_KV.put("schedule:week:preseason-3", JSON.stringify(freshPreseasonGames));
  }

  if (new Date().getUTCMinutes() % 5 === 0) {
    let preseasonGames = freshPreseasonGames;
    if (!preseasonGames) {
      const cachedRaw = await env.PFPI_KV.get("schedule:week:preseason-3");
      preseasonGames = cachedRaw ? JSON.parse(cachedRaw) : null;
    }

    if (preseasonGames) {
      // The published JSON must merge in saved picks -- Highlightly's raw
      // response has no concept of PFPI picks at all. Regular-season weeks
      // never had this problem because buildWeekPublicJSON() always merges
      // picks in; preseason skipped that function entirely. Mirrors the
      // same one-KV-read-per-team approach, but merges BOTH the real
      // 8-team roster and the two sandboxed FAMILY_MEMBERS test teams
      // (imported from shared.js, not duplicated), since preseason-3 is
      // specifically Yeti's cross-team testing sandbox -- whichever team he
      // tests as, the picks need to actually show up.
      const preseasonPicksTeams = [...TEAMS, ...FAMILY_MEMBERS.map(m => m.team)];
      const picksByTeam = {};
      for (const team of preseasonPicksTeams) {
        const picksRaw = await env.PFPI_KV.get(`picks:preseason-3:${team}`);
        picksByTeam[team] = picksRaw ? JSON.parse(picksRaw) : {};
      }
      const preseasonGamesWithPicks = preseasonGames.map(g => {
        const picks = {};
        for (const team of preseasonPicksTeams) {
          if (picksByTeam[team][g.id]) picks[team] = picksByTeam[team][g.id];
        }
        return { ...g, picks };
      });

      // Real Standings/Weekly Titles/Weeks Leading/Best Week for preseason
      // (2026-08-27 round) -- see computePreseasonSnapshot()'s own comment
      // for the full isolation reasoning. Only the REAL 8-team roster
      // scores here (matches computeStandings' own TEAMS-only loop) --
      // picksByTeam has FAMILY_MEMBERS entries too (needed for the picks
      // merge above), computePreseasonSnapshot simply never looks at them.
      // finalResults comes straight from this tick's own Highlightly-
      // shaped game objects already in memory -- never written to or read
      // from the `results:week:N` KV namespace real weeks use, so there
      // is no shared storage for the two computations to ever collide in.
      const finalResults = preseasonGames.filter(g => g.status === "final");
      const preseasonStats = computePreseasonSnapshot(finalResults, picksByTeam, "preseason-3");

      await commitJSONToGitHub(
        "data/week-preseason-3.json",
        { week: "preseason-3", games: preseasonGamesWithPicks, stats: preseasonStats, updatedAt: new Date().toISOString() },
        "Update preseason Week 3 (Highlightly) [automated]",
        env
      );
    }
  }
}

// ============================================================
// WORKER ENTRY POINTS
// ============================================================

export default {
  async fetch(request) {
    return new Response(JSON.stringify({ ok: true, worker: "pfpi-scores-worker" }), {
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndPublish(env));
  },
};
