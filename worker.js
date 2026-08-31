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

import { TEAMS, TEAM_SHORT, computeCurrentWeekFromDate, commitJSONToGitHub, getEasternDateParts, FAMILY_MEMBERS, computeGameDeadline, sendPfpiEmail } from "./shared.js";

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

async function fetchHighlightlyPreseasonWeek3(env, force) {
  if (!env.HIGHLIGHTLY_API_KEY) {
    console.error("Skipping Highlightly preseason Week 3 fetch: HIGHLIGHTLY_API_KEY not set.");
    return null;
  }
  // `force` (added 2026-08-28 for the admin manual-poll-trigger button)
  // bypasses the window/cadence throttle entirely -- an explicit manual
  // click is a deliberate, informed use of one API call, not the
  // automatic cron that the 100/day budget is actually protecting.
  if (!force && !shouldPollHighlightlyThisTick(new Date())) {
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
  // Unique Hits + 10-Win Weeks, added 2026-08-28 per Yeti -- extends the
  // same real, incremental-per-poll computation preseason already got
  // (see computePreseasonSnapshot() below) to the actual regular season.
  // Both are cumulative running totals through each week, same shape as
  // weeklyTitles/weeksLeading above -- computed fresh every call from
  // week 1 through throughWeek, so there's no persisted counter that could
  // ever double-count across polls.
  let uniqueHitsCum = {}, uniqueOppsCum = {};
  TEAMS.forEach(t => { uniqueHitsCum[t] = 0; uniqueOppsCum[t] = 0; });
  let tenWinWeeksCum = {};
  TEAMS.forEach(t => tenWinWeeksCum[t] = 0);
  const uniqueHits = {}, tenWinWeeks = {};
  TEAMS.forEach(t => { uniqueHits[t] = {}; tenWinWeeks[t] = {}; });
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
      tieNotes[week] = tiedGames.map(g => `${g.away} @ ${g.home}`);
    }

    const correctThisWeek = {};
    // Kept per-team this week (not discarded after computing `correct`)
    // specifically for the Unique Hits pass below, which needs to compare
    // every team's pick on the same game side-by-side -- a per-team-only
    // loop can't answer "did anyone else pick this."
    const picksThisWeek = {};
    for (const team of TEAMS) {
      const picksRaw = await env.PFPI_KV.get(`picks:${week}:${team}`);
      const picks = picksRaw ? JSON.parse(picksRaw) : {};
      picksThisWeek[team] = picks;
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

    // Unique Hits: a pick is "unique" for a game if, among the TEAMS that
    // actually picked that game, exactly one team chose that side -- a
    // "hit" if that side also won. Definition confirmed against the
    // original framework doc and Yeti's own real preseason test case
    // before this was ever written (see BUILD_LOG.md, 2026-08-28). Updates
    // as games go final within a week, same as everything else here --
    // scorableGames only ever contains games KV already has a final result
    // for.
    scorableGames.forEach(game => {
      const pickCounts = {};
      TEAMS.forEach(team => {
        const pick = picksThisWeek[team][game.id];
        if (pick) pickCounts[pick] = (pickCounts[pick] || 0) + 1;
      });
      TEAMS.forEach(team => {
        const pick = picksThisWeek[team][game.id];
        if (pick && pickCounts[pick] === 1) {
          uniqueOppsCum[team]++;
          if (game.winner && pick === game.winner) uniqueHitsCum[team]++;
        }
      });
    });
    TEAMS.forEach(t => {
      uniqueHits[t][String(week)] = { hits: uniqueHitsCum[t], opps: uniqueOppsCum[t] };
    });

    // 10-Win Weeks: a week counts the moment a team's running correct
    // count for THAT week reaches 10, even before the week is fully
    // decided (per Yeti: "as soon as someone wins their 10th game in that
    // week, it should reflect right away") -- correctThisWeek[team] is
    // already whatever's true as of this poll's KV data, partial or not.
    TEAMS.forEach(t => {
      if (correctThisWeek[t] >= 10) tenWinWeeksCum[t]++;
      tenWinWeeks[t][String(week)] = tenWinWeeksCum[t];
    });

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
    weeklyTitlesCount, weeksLeadingCount, gamesPlayed, uniqueHits, tenWinWeeks,
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
  const tiedGames = finalResults.filter(g => g.tie);
  const scorableGames = finalResults.filter(g => !g.tie);
  const weekTotal = scorableGames.length;

  // tieNotes, added 2026-08-31 after Yeti caught preseason Week 3 showing
  // "X / 15" with no visible explanation of why (the 16th game, KC @ SEA,
  // was a real 9-9 tie -- correctly excluded per the existing tie-handling
  // rule, see normalizeGame()'s own comment, but silently so, since this
  // function never computed tieNotes the way computeStandings() already
  // does for real weeks). Same shape as computeStandings()'s tieNotes
  // (`{weekKey: ["AWAY @ HOME", ...]}`) so index.html's existing
  // `realDataFor("tieNotes", week)` routing works for preseason with no
  // frontend special-casing beyond what standings/weeklyTitles/etc. already
  // get.
  const tieNotes = {};
  if (tiedGames.length > 0) {
    tieNotes[weekLabel] = tiedGames.map(g => `${g.away} @ ${g.home}`);
  }

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

  // Unique Hits, added 2026-08-27 per Yeti -- previously "permanently out
  // of scope" (no real data source existed, see BUILD_LOG.md's many
  // earlier entries), reversed specifically for preseason once real picks
  // + real results made it genuinely computable, and confirmed against
  // Yeti's own deliberately-set-up test case before writing any of this
  // (Giraffes picked CLE over NE, alone, and CLE won -- expected exactly
  // one hit; verified by hand against real KV picks data first). Per the
  // original framework doc's own definition (archive/pfpi_mockup_v3.html):
  // "Hits-to-opportunities on picks nobody else made." A pick is "unique"
  // for a game if, among the TEAMS that actually picked that game, exactly
  // one team chose that side -- it's a "hit" if that side also won. Only
  // compares real-roster TEAMS against each other (not FAMILY_MEMBERS --
  // this is a competitive-roster stat, matching every other category
  // here), and only counts games that were actually decided
  // (scorableGames, same tie-exclusion as every other stat above).
  //
  // UPDATE 2026-08-28: this same definition is now ALSO computed for real
  // regular-season weeks in computeStandings() above, per Yeti ("Unique
  // Hits must extend through the regular season, updating after every
  // game"). The two computations are separate code (this function is
  // still single-unified-week-only, computeStandings() is still the
  // cumulative-across-18-weeks one) -- kept that way deliberately, same
  // isolation-by-construction principle as every other preseason stat
  // here, not a shared helper the two could ever drift apart from
  // silently.
  const uniqueHits = {}, uniqueOpportunities = {};
  TEAMS.forEach(team => { uniqueHits[team] = 0; uniqueOpportunities[team] = 0; });
  scorableGames.forEach(game => {
    const pickCounts = {};
    TEAMS.forEach(team => {
      const pick = (picksByTeam[team] || {})[game.id];
      if (pick) pickCounts[pick] = (pickCounts[pick] || 0) + 1;
    });
    TEAMS.forEach(team => {
      const pick = (picksByTeam[team] || {})[game.id];
      if (pick && pickCounts[pick] === 1) {
        uniqueOpportunities[team]++;
        if (game.winner && pick === game.winner) uniqueHits[team]++;
      }
    });
  });
  const uniqueHitsStat = {};
  TEAMS.forEach(team => {
    uniqueHitsStat[team] = { [weekLabel]: { hits: uniqueHits[team], opps: uniqueOpportunities[team] } };
  });

  // 10-Win Weeks, added 2026-08-28 alongside the regular-season version in
  // computeStandings() -- for consistency, since preseason is meant as a
  // full dress rehearsal of every category, not just some of them. Only
  // one "week" exists here, so this is just 1 or 0 per team (10+ correct
  // in the unified preseason week, or not) rather than a running count
  // across weeks.
  const tenWinWeeksStat = {};
  TEAMS.forEach(team => {
    tenWinWeeksStat[team] = { [weekLabel]: correctThisTeam[team] >= 10 ? 1 : 0 };
  });

  return {
    standings, standingsPct, weeklyTitles, weeklyTitlesCount, weeksLeading, weeksLeadingCount, bestWeek, gamesPlayed,
    uniqueHits: uniqueHitsStat, tenWinWeeks: tenWinWeeksStat, tieNotes,
  };
}

// ============================================================
// WEEKLY DIGEST -- server-side generation, persistence, and email
// (2026-08-31, per Yeti). Ported from admin.html's/brief.html's own
// client-side digest builder (buildStandingsBlock/buildPointBlock/etc, all
// pure string-formatting functions with no DOM dependency) so a digest can
// be generated automatically the moment a week's last game goes final,
// without needing anyone to have the admin page open. This is the ONE
// place that logic now lives -- admin.html/brief.html's Weekly Digest tab
// no longer builds its own text, it just displays what this produces (see
// GET /admin/digest below).
//
// Frozen-snapshot-by-default, per Yeti's explicit call: a digest is
// generated once (when the week completes) and never silently changes
// after that, even if a stat is later corrected -- what got emailed is
// what stays in the archive. A manual "Recompute" action (POST
// /admin/digest-recompute) exists for the real case where a correction
// needs to be reflected; it OVERWRITES the current `digest:{week}` key but
// also appends to `digest-version:{week}:{timestamp}` first, mirroring
// the exact versioning convention picks-worker.js's brief-version:{week}:
// {timestamp} already uses -- a recompute is a new, visible commissioner-
// facing action, not a silent edit, so its own history is kept the same
// way admin edits to Greg's brief already are.
// ============================================================
const SEASON_YEAR = 2026;
const GREG_EMAIL = "yeti@yetiblanc.com"; // same placeholder as picks-worker.js's GREG_EMAIL -- change together when Greg's real address is onboarded.

// Same formatting rule as index.html/admin.html/brief.html's own fmtPct
// (duplicated intentionally -- it's a formatting helper, not scoring
// logic, and this is a separate file with no shared frontend module).
function fmtPct(v) {
  const s = v.toFixed(3);
  return s === "1.000" ? "1.000" : s.replace(/^0/, "");
}

function buildStandingsBlock(st, week, isFinal, titleOverride) {
  const wKey = String(week);
  const gp = (st.gamesPlayed && st.gamesPlayed[wKey]) || 0;
  const rows = TEAMS.map(t => {
    const wins = st.standings[t][wKey];
    return { team: t, wins, losses: gp - wins, pct: st.standingsPct[t][wKey] };
  });
  rows.sort((a, b) => b.wins - a.wins);
  const leaderWins = rows.length ? rows[0].wins : 0;

  const lines = [];
  lines.push(titleOverride || (isFinal ? `PFPI OFFICIAL FINAL ${SEASON_YEAR} STANDINGS` : `PFPI WEEK ${week} STANDINGS`));
  lines.push(`Team`.padEnd(32) + (isFinal ? "Final Season" : "Season").padEnd(13) + "GB");
  rows.forEach(r => {
    const name = (TEAM_SHORT[r.team] || r.team).padEnd(32);
    const record = `${r.wins}-${r.losses}`;
    const pct = fmtPct(r.pct);
    const gb = r.wins === leaderWins ? "--" : String(leaderWins - r.wins);
    lines.push(`${name}${record}   ${pct}${gb.padStart(6)}`);
  });
  return lines.join("\n");
}

function buildTieNoteBlock(st, week) {
  const wKey = String(week);
  const ties = (st.tieNotes && st.tieNotes[wKey]) || [];
  if (ties.length === 0) return null;
  const n = ties.length;
  const gameWord = n === 1 ? "game" : "games";
  const verb = n === 1 ? "is" : "are";
  return `${n} ${gameWord} ended in a tie and ${verb} omitted from this week's scoring (${ties.join(", ")}).`;
}

function buildPointBlock(label, dataObj, countObj, week) {
  const wKey = String(week);
  const entries = TEAMS.map(t => ({ team: t, value: dataObj[t][wKey], count: countObj[t][wKey] }));

  entries.sort((a, b) => b.value - a.value);
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last[0].value === e.value) last.push(e);
    else groups.push([e]);
  }

  const text = groups.map(group => {
    const tied = group.length > 1;
    return group.map(e => {
      const valStr = e.value.toFixed(2);
      return tied ? `${e.team} ${valStr}` : `${e.team} ${valStr} (${e.count})`;
    }).join(" & ");
  }).join(", ");

  return `${label}: ${text}.`;
}

function buildTenWinBlock(st, week) {
  const wKey = String(week);
  const entries = TEAMS.map(t => ({ team: t, value: (st.tenWinWeeks[t] && st.tenWinWeeks[t][wKey]) || 0 }));
  entries.sort((a, b) => b.value - a.value);
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last[0].value === e.value) last.push(e);
    else groups.push([e]);
  }
  const text = groups.map(group => group.map(e => `${e.team} ${e.value}`).join(" & ")).join(", ");
  return `10-Win Weeks: ${text}.`;
}

function buildUniqueHitsBlock(st, week) {
  const wKey = String(week);
  const entries = TEAMS.map(t => (st.uniqueHits[t] && st.uniqueHits[t][wKey]) || { hits: 0, opps: 0 });
  const named = TEAMS.map((t, i) => ({ team: t, ...entries[i] }));
  named.sort((a, b) => b.hits - a.hits || b.opps - a.opps);
  const text = named.map(e => `${e.team} ${e.hits}-${e.opps}`).join(", ");
  return `Unique Hits: ${text}.`;
}

function buildBestWeekBlock(st, week) {
  const wKey = String(week);
  const entries = TEAMS
    .map(t => ({ team: t, ...st.bestWeek[t][wKey] }))
    .filter(e => e.total > 0);

  if (entries.length === 0) return "Best Week: No weeks decided yet.";

  const maxPct = Math.max(...entries.map(e => e.pct));
  const holders = entries.filter(e => e.pct === maxPct);
  const text = holders
    .map(e => `${e.team} ${fmtPct(e.pct)} (${e.correct}-${e.total - e.correct}/${typeof e.week === "number" ? "W" + e.week : e.week})`)
    .join(" & ");
  return `Best Week: ${text}.`;
}

function buildDigestText(st, week, isFinal, titleOverride) {
  const parts = [
    buildStandingsBlock(st, week, isFinal, titleOverride),
    buildTieNoteBlock(st, week),
    buildPointBlock("Weeks Leading", st.weeksLeading, st.weeksLeadingCount, week),
    buildPointBlock("Weekly Titles", st.weeklyTitles, st.weeklyTitlesCount, week),
    buildTenWinBlock(st, week),
    buildUniqueHitsBlock(st, week),
    buildBestWeekBlock(st, week),
  ].filter(Boolean);
  return parts.join("\n\n");
}

// Generates, persists (current + versioned history), and emails a digest.
// Called both by the automatic completion-triggered path in
// pollAndPublish() and by the manual recompute endpoint -- the only
// difference between them is `source` and whatever triggered the call, the
// storage/email behavior is identical either way.
async function generateAndStoreDigest(env, weekKey, st, isFinal, titleOverride, source) {
  const text = buildDigestText(st, weekKey, isFinal, titleOverride);
  const generatedAt = new Date().toISOString();
  const entry = { text, generatedAt, source };
  await env.PFPI_KV.put(`digest:${weekKey}`, JSON.stringify(entry));
  await env.PFPI_KV.put(`digest-version:${weekKey}:${Date.now()}`, JSON.stringify(entry));

  const label = weekKey === "preseason-3" ? "Preseason" : `Week ${weekKey}`;
  await sendPfpiEmail(
    GREG_EMAIL,
    `PFPI Weekly Digest -- ${label} Ready`,
    `Dear PFPI Commissioner,\n\nYour Weekly Digest for ${label} has been generated and is ready for your report whenever you are ready.`,
    env
  );
  return entry;
}

// Freshly recomputes the stats snapshot for a week, for the manual
// recompute endpoint (the automatic path in pollAndPublish() already has
// a freshly-computed snapshot in hand and doesn't need this).
async function computeDigestStatsForWeek(week, env) {
  if (week === "preseason-3") {
    const cachedRaw = await env.PFPI_KV.get("schedule:week:preseason-3");
    const preseasonGames = cachedRaw ? JSON.parse(cachedRaw) : [];
    const preseasonPicksTeams = [...TEAMS, ...FAMILY_MEMBERS.map(m => m.team)];
    const picksByTeam = {};
    for (const team of preseasonPicksTeams) {
      const picksRaw = await env.PFPI_KV.get(`picks:preseason-3:${team}`);
      picksByTeam[team] = picksRaw ? JSON.parse(picksRaw) : {};
    }
    const finalResults = preseasonGames.filter(g => g.status === "final");
    return {
      st: computePreseasonSnapshot(finalResults, picksByTeam, "preseason-3"),
      isFinal: false,
      titleOverride: "PFPI PRESEASON STANDINGS (Week 3, unified)",
    };
  }
  const weekNum = parseInt(week, 10);
  const st = await computeStandings(weekNum, env);
  return { st, isFinal: weekNum === 18, titleOverride: null };
}

async function handleDigestGet(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }
  const url = new URL(request.url);
  const week = url.searchParams.get("week");
  if (!week) return jsonResponse({ error: "Missing week." }, 400, request);
  const raw = await env.PFPI_KV.get(`digest:${week}`);
  return jsonResponse({ digest: raw ? JSON.parse(raw) : null }, 200, request);
}

async function handleDigestWeeks(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }
  const list = await env.PFPI_KV.list({ prefix: "digest:" });
  const weeks = list.keys.map(k => k.name.slice("digest:".length));
  return jsonResponse({ weeks }, 200, request);
}

async function handleDigestRecompute(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const week = body.week;
  if (!week) return jsonResponse({ error: "Missing week." }, 400, request);

  const existingRaw = await env.PFPI_KV.get(`digest:${week}`);
  if (!existingRaw) {
    return jsonResponse({ error: "This week has no digest yet -- it can only be recomputed after it's first auto-generated (once that week's last game goes final)." }, 400, request);
  }

  const { st, isFinal, titleOverride } = await computeDigestStatsForWeek(week, env);
  const entry = await generateAndStoreDigest(env, week, st, isFinal, titleOverride, "recompute");
  return jsonResponse({ digest: entry }, 200, request);
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

// `force` (added 2026-08-28, only ever set true by the admin manual-poll-
// trigger endpoint below) bypasses every throttle gate in this function --
// Big Balls' window check, Highlightly's window check, and the 5-minute
// merge/publish gate -- so a manual click always does something real
// immediately, rather than silently no-op'ing outside the normal cadence.
async function pollAndPublish(env, force = false) {
  await checkPendingBriefConfirmations(env);

  const currentWeek = computeCurrentWeekFromDate();
  await env.PFPI_KV.put("current-week", String(currentWeek));

  if (!env.BIG_BALLS_API_KEY) {
    console.error("Skipping Big Balls poll: BIG_BALLS_API_KEY not set. No regular-season score/schedule data fetched or published this tick.");
  } else if (!force && !shouldPollBigBallsThisTick(new Date())) {
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
      weeklyTitlesCount, weeksLeadingCount, gamesPlayed, uniqueHits, tenWinWeeks,
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
        weeklyTitlesCount, weeksLeadingCount, gamesPlayed, uniqueHits, tenWinWeeks,
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

    // Weekly Digest auto-generation (2026-08-31, per Yeti): once a week's
    // games are ALL final, generate + persist + email the digest exactly
    // once -- gated on the digest:{week} KV key so it only ever fires the
    // first time a week crosses into "complete," never on a later tick.
    // Only currentWeek and currentWeek-1 can plausibly have JUST
    // transitioned into "complete" (every earlier week already crossed
    // that line by construction of time having passed), so those are the
    // only two checked each tick -- cheap, and correct regardless of which
    // week's games happen to finish on a Thursday, a Sunday, or (in the
    // playoffs, which don't schedule Monday Night Football) whatever game
    // is actually last on that week's real schedule.
    const st = { standings, standingsPct, weeklyTitles, weeklyTitlesCount, weeksLeading, weeksLeadingCount, bestWeek, gamesPlayed, uniqueHits, tenWinWeeks, tieNotes };
    for (const weekToCheck of [currentWeek - 1, currentWeek]) {
      if (weekToCheck < 1) continue;
      const weekKey = String(weekToCheck);
      const alreadyGenerated = await env.PFPI_KV.get(`digest:${weekKey}`);
      if (alreadyGenerated) continue;
      const scheduleRaw = await env.PFPI_KV.get(`schedule:week:${weekKey}`);
      const schedule = scheduleRaw ? JSON.parse(scheduleRaw) : null;
      const resultsRaw = await env.PFPI_KV.get(`results:week:${weekKey}`);
      const results = resultsRaw ? JSON.parse(resultsRaw) : [];
      if (!schedule || schedule.length === 0 || results.length < schedule.length) continue;
      await generateAndStoreDigest(env, weekKey, st, weekToCheck === 18, null, "auto");
    }
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
  const freshPreseasonGames = await fetchHighlightlyPreseasonWeek3(env, force);
  if (freshPreseasonGames) {
    // Schedule cache stays picks-free, matching schedule:week:N's existing
    // shape (kickoff-math only, not for public reading).
    await env.PFPI_KV.put("schedule:week:preseason-3", JSON.stringify(freshPreseasonGames));
  }

  if (force || new Date().getUTCMinutes() % 5 === 0) {
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
        // Added 2026-08-29, per Yeti's "unique pick" raccoon-badge request
        // (index.html) -- buildWeekPublicJSON() (regular season, above)
        // always included this via the same computeGameDeadline() call;
        // preseason skipped it entirely since nothing previously needed a
        // per-game deadline on this path. Same function, same shape, so
        // index.html's isGameLocked() works identically on both week types
        // without needing to special-case preseason.
        return { ...g, picks, deadline: computeGameDeadline(g.kickoffISO) };
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

      // Same auto-generation-once-complete rule as the real season above --
      // "complete" here means every real game on the schedule (16, tie
      // included -- a tie is still a decided/final game, it's just excluded
      // from the scoring math) has reached status:"final".
      const alreadyGeneratedPreseason = await env.PFPI_KV.get("digest:preseason-3");
      if (!alreadyGeneratedPreseason && preseasonGames.length > 0 && finalResults.length === preseasonGames.length) {
        await generateAndStoreDigest(env, "preseason-3", preseasonStats, false, "PFPI PRESEASON STANDINGS (Week 3, unified)", "auto");
      }

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
// VISITOR ANALYTICS (2026-08-29 overnight round, per Yeti's handoff)
// ============================================================
// In-house, built specifically to avoid a paid third-party subscription
// (Fathom/Plausible/etc.) while still doing real unique/repeat/traffic-
// source tracking -- unlike Cote Cup's own existing analytics (a
// completely separate site/Worker, `cotecup-worker` -- NEVER touched by
// this work; only referenced for dashboard-page style/spirit via a
// static HTML file Yeti left in his own Downloads folder, not by reading
// or deploying to Cote Cup's real infrastructure at all).
//
// TWO SEPARATE HASHES -- deliberate, not two near-duplicate functions by
// accident. Read this before changing either one:
//
// 1. dailyHash = SHA-256(IP + User-Agent + today's ET date). Used ONLY to
//    count today's unique visitors. Baking the date in makes it
//    mathematically impossible for the same value to ever repeat on a
//    different day -- this is the genuinely privacy-preserving one,
//    matching how Fathom/Plausible's own daily-reset hashing works: a
//    full reset every 24 hours, no cross-day linkage possible even in
//    principle.
//
// 2. stableHash = SHA-256(IP + User-Agent), no date. Used ONLY to detect
//    whether someone is a RETURNING visitor across days -- a repeat-visit
//    check that itself resets daily could never detect a repeat, by
//    definition, so this one structurally can't include the date.
//    HONEST TRADEOFF, stated here and on the dashboard itself, not
//    hidden anywhere: this hash is a real, if modest, step back from the
//    daily hash's privacy posture -- it persists for as long as someone's
//    IP+browser combination stays the same (realistically days to weeks
//    for most home/mobile users, not forever; changes the moment they
//    switch networks or devices). Still fully anonymous -- one-way
//    hashed, raw IP is NEVER stored anywhere, only the hash -- but
//    coarser and longer-lived than the daily hash.
//
// KNOWN, EXPECTED LIMITATION (also on the dashboard, not hidden): this
// identifies visitors by device/browser, not by person. The same person
// on their phone and then their laptop the same day shows as two
// different visitors. Every privacy-respecting analytics tool has this
// exact limitation (Fathom and Plausible included) -- not a bug specific
// to this build.
//
// SCOPE DECISION (flagged per the handoff's own instruction to flag
// judgment calls, not just make them silently): only index.html and
// picks.html feed the real "visitor" pipeline below (daily-unique dedup,
// new-vs-repeat, referrer buckets, every rollup the dashboard's headline
// numbers are built from) -- see ANALYTICS_PUBLIC_PAGES. brief.html and
// admin.html are login-gated internal tools Yeti/Greg use to run the
// site, not real audience; their hits are tracked separately as plain,
// un-deduplicated pageview counts (no hashing, no referrer bucketing --
// meaningless for a login-gated tool anyway), kept completely apart so
// Yeti's own admin testing can never quietly inflate the advertiser-
// facing numbers.
//
// CUMULATIVE ROLLUPS ARE SUMS OF DAILY UNIQUES, NOT TRUE MULTI-DAY DEDUP
// (flagged here AND on the dashboard -- this is the judgment call the
// handoff explicitly invited given overnight time constraints): the same
// real person visiting Monday, Wednesday, and Friday counts 3 times
// toward that week's cumulative total, not once. A true deduplicated
// weekly/monthly unique count needs its own aggregation across the
// stable hash over a date range -- KV has no efficient way to compute
// set-cardinality across a date range without listing and checking every
// stable-hash key seen in that window, a materially bigger feature.
// DEFERRED AS A DOCUMENTED FAST-FOLLOW, not built tonight -- see
// BUILD_LOG.md.
//
// KV IS EVENTUALLY CONSISTENT AND THESE COUNTERS AREN'T ATOMIC (real,
// honest limitation, not hidden): every counter here is read-then-write,
// so two truly simultaneous pageloads could in principle both read the
// same starting value and one increment could be lost. Acceptable for
// this site's real traffic volume; would need a different KV pattern (or
// Durable Objects) at much higher concurrency than a hobby show site
// actually sees.
// ============================================================

const ANALYTICS_PUBLIC_PAGES = new Set(["index", "picks"]);
const ANALYTICS_ALL_PAGES = new Set(["index", "picks", "brief", "admin"]);
// PFPI's own two real hostnames (github.io + the custom domain, see
// ALLOWED_ORIGINS below) -- a referrer matching either of these is
// in-site navigation, not a real external discovery source, so it gets
// its own "internal" bucket rather than being misclassified as an
// external referral or lumped into the generic "other:" catch-all.
const PFPI_OWN_HOSTS = new Set(["the-greg-cote-show.github.io", "pfpi.thegregcoteshow.com", "pfpi.me"]);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Small fixed set of named sources per the handoff, plus "other:domain"
// (not one opaque "other" bucket) so a real, unexpected source stays
// visible and actionable instead of disappearing into noise. Exact
// hostname match (after stripping a leading "www."), not endsWith --
// deliberately avoids misclassifying pfpi.thegregcoteshow.com (PFPI's
// OWN custom domain, checked first as "internal") as the separate
// "thegregcoteshow" external bucket just because it shares a parent
// domain suffix. A rare mobile-subdomain referrer (e.g. m.youtube.com)
// falls into "other:m.youtube.com" instead of "youtube" -- an honest
// miss, not a misattribution, and easy to widen later once real data
// shows it's worth it.
function classifyReferrer(referrer) {
  if (!referrer) return "direct";
  let host;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "other:unparseable";
  }
  if (PFPI_OWN_HOSTS.has(host)) return "internal";
  if (host === "twitter.com" || host === "x.com") return "twitter";
  if (host === "instagram.com") return "instagram";
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "thegregcoteshow.com") return "thegregcoteshow";
  return "other:" + host;
}

// ============================================================
// BOT FILTERING (2026-08-29, per Yeti) -- exclusion from the visitor
// counters ONLY, same spirit as `notrack` above: a flagged request still
// gets a normal page response, it just never touches the counters. This
// is NOT an access-denial mechanism.
//
// REAL, CONFIRMED PLAN CONSTRAINT (do not build around a different
// assumption): `cf.bot_management.score` (Cloudflare's granular 1-99
// bot-confidence score) is an ENTERPRISE-ONLY field. This account is not
// on that plan and this task does not authorize upgrading to it -- the
// field is simply undefined here, and no code below reads it.
//
// What's actually free on every plan and used here instead:
//   - `cf.client.bot` -- boolean, true only for bots Cloudflare has
//     already verified (major search engines, etc).
//   - `cf.verified_bot_category` -- present only alongside the above.
//   - User-Agent string heuristics -- the real workhorse, since the two
//     fields above only catch bots Cloudflare has already verified. This
//     catches well-behaved, self-identifying crawlers/bots/monitors/link-
//     preview generators. A bot that deliberately disguises its
//     User-Agent as a normal browser is NOT caught by any of this -- a
//     real, expected gap at this pricing tier, stated plainly on the
//     dashboard itself (see analytics-shared.js's methodology panel),
//     not just here in a code comment.
// ============================================================
const BOT_UA_PATTERN = /bot|crawler|spider|crawling|slurp|mediapartners|facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|vkshare|w3c_validator|pingdom|uptimerobot|statuscake|headlesschrome|phantomjs|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|java\/|libwww-perl|scrapy|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|bytespider|yandexbot|baiduspider|duckduckbot|bingpreview|applebot|googlebot|bingbot/i;

function isLikelyBot(ua, cf) {
  if (cf && cf.client && cf.client.bot === true) return true;
  if (cf && typeof cf.verified_bot_category === "string" && cf.verified_bot_category.length > 0) return true;
  if (typeof ua === "string" && BOT_UA_PATTERN.test(ua)) return true;
  return false;
}

// ============================================================
// GEO CAPTURE (2026-08-29, per Yeti) -- `request.cf.country` (ISO 3166-1
// alpha-2, e.g. "US"), `request.cf.region` (full name, e.g. "Georgia"),
// `request.cf.city` (e.g. "Miami") are free on every Cloudflare plan, no
// extra API call, same fields Cote Cup's own Worker reportedly already
// uses for this per its own project summary (referenced as a pattern
// only -- nothing here touches Cote Cup's actual repo/Worker/KV).
// Composite keys use "|" as the delimiter (not ":", already used
// elsewhere in these key names) since place names never contain it, and
// nest country first since region/city names are NOT globally unique
// (e.g. "Georgia" is both a US state and a country).
// Same per-day + all-time shape as the existing referrer buckets above.
// ============================================================
async function recordGeo(env, today, country, region, city) {
  if (!country) return; // Cloudflare didn't supply geo for this request (e.g. local/dev) -- nothing to record.
  await incrKV(env, `analytics:geo-country:${today}:${country}`);
  await incrKV(env, `analytics:geo-country-alltime:${country}`);
  if (region) {
    const regionKey = `${country}|${region}`;
    await incrKV(env, `analytics:geo-region:${today}:${regionKey}`);
    await incrKV(env, `analytics:geo-region-alltime:${regionKey}`);
    if (city) {
      const cityKey = `${country}|${region}|${city}`;
      await incrKV(env, `analytics:geo-city:${today}:${cityKey}`);
      await incrKV(env, `analytics:geo-city-alltime:${cityKey}`);
    }
  }
}

// Monday (ET) of the week containing this ET date string, as its own
// YYYY-MM-DD -- avoids real ISO-8601 week-number edge cases at year
// boundaries entirely by just using an actual calendar date as the
// rollup key instead of a week number.
function mondayOfWeekET(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - diffToMonday);
  return dt.toISOString().slice(0, 10);
}

async function incrKV(env, key, ttlSeconds) {
  const current = parseInt((await env.PFPI_KV.get(key)) || "0", 10);
  const next = current + 1;
  await env.PFPI_KV.put(key, String(next), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  return next;
}

// Runs inside ctx.waitUntil() (see the /track route below) -- the visitor
// gets an instant empty response, every KV write here happens in the
// background after the response is already gone. Note this is a
// deliberate, narrow exception to this Worker's own "visitors never hit
// this Worker" framing at the top of the file -- that principle is about
// not making visitors wait on a Worker for a READ GitHub Pages can serve
// statically; a write-only tracking beacon a visitor's own browser fires
// (and never waits on, given the instant response) doesn't conflict with
// it.
// REAL BUG FOUND AND FIXED 2026-08-28, live during verification: this
// used to take (request, env) and call `await request.json()` /
// `request.headers.get(...)` from inside the function that ctx.waitUntil()
// runs -- Cloudflare Workers actively forbids reading a request's BODY
// STREAM after its response has already been sent (confirmed via a
// temporary diagnostic log: "TypeError: Can't read from request stream
// after response has been sent"), which is exactly what a 204-first,
// log-after pattern does. Fixed by extracting everything needed (ip, ua,
// page, referrer, notrack, bot status, geo) from the real request SYNCHRONOUSLY in the
// fetch() handler below, before the response goes out, and passing only
// those plain values in here -- this function never touches the
// `request`/`env` request object at all now, only plain strings and the
// KV binding, so nothing here can ever hit that constraint again.
async function handleTrack(env, { ip, ua, page: rawPage, referrer: rawReferrer, notrack, isBot, country, region, city }) {
  const parts = getEasternDateParts(new Date());
  const today = `${parts.year}-${parts.month}-${parts.day}`;

  if (isBot === true) {
    // Excluded from every counter below, including the plain pageview
    // count -- same exclusion-not-denial treatment as `notrack`. Tracked
    // in its own separate counter purely so the dashboard can be honest
    // that filtering is happening at all, not folded into any
    // visitor-facing number.
    await incrKV(env, `analytics:bots-filtered:${today}`);
    return;
  }
  if (notrack === true) return;

  const page = ANALYTICS_ALL_PAGES.has(rawPage) ? rawPage : "other";
  const referrer = typeof rawReferrer === "string" ? rawReferrer : "";

  const month = `${parts.year}-${parts.month}`;
  const monday = mondayOfWeekET(today);

  // Every page, every pageload, no hashing -- purely informational so
  // Yeti can see admin/brief usage volume without it ever touching the
  // visitor-dedup pipeline below.
  await incrKV(env, `analytics:pageviews:${today}:${page}`);

  if (!ANALYTICS_PUBLIC_PAGES.has(page)) return;

  // Geo is recorded for real (non-bot, non-opted-out) public-page
  // pageloads only -- same population the unique-visitor pipeline below
  // covers, not admin/brief internal traffic.
  await recordGeo(env, today, country, region, city);

  const dailyHash = await sha256Hex(`${ip}|${ua}|${today}`);
  const stableHash = await sha256Hex(`${ip}|${ua}`);

  const seenKey = `analytics:seen:${today}:${dailyHash}`;
  const alreadySeenToday = await env.PFPI_KV.get(seenKey);

  if (!alreadySeenToday) {
    await env.PFPI_KV.put(seenKey, "1", { expirationTtl: 172800 }); // 2 days -- only needs to outlive "today"
    await incrKV(env, `analytics:daily-unique:${today}`);
    await incrKV(env, `analytics:weekly-unique-sum:${monday}`);
    await incrKV(env, `analytics:monthly-unique-sum:${month}`);
    await incrKV(env, `analytics:alltime-unique-sum`);

    // New vs. repeat, per the handoff's exact spec: look up the stable
    // hash's first-seen date. Doesn't exist -> new visitor, write today's
    // date (NEVER overwritten again -- this key has no TTL, it must
    // persist indefinitely to keep detecting repeats far in the future).
    // Exists and isn't today -> repeat visitor today. Exists and IS today
    // -> already handled this exact visitor today, falls through to here
    // only if alreadySeenToday somehow missed it -- a no-op either way,
    // not a double-count risk.
    const firstSeenKey = `analytics:stable-first-seen:${stableHash}`;
    const firstSeenDate = await env.PFPI_KV.get(firstSeenKey);
    if (!firstSeenDate) {
      await env.PFPI_KV.put(firstSeenKey, today);
      await incrKV(env, `analytics:new:${today}`);
      await incrKV(env, `analytics:new-weekly-sum:${monday}`);
      await incrKV(env, `analytics:new-monthly-sum:${month}`);
      await incrKV(env, `analytics:new-alltime-sum`);
    } else if (firstSeenDate !== today) {
      await incrKV(env, `analytics:repeat:${today}`);
      await incrKV(env, `analytics:repeat-weekly-sum:${monday}`);
      await incrKV(env, `analytics:repeat-monthly-sum:${month}`);
      await incrKV(env, `analytics:repeat-alltime-sum`);
    }

    const firstEventDate = await env.PFPI_KV.get("analytics:first-event-date");
    if (!firstEventDate) await env.PFPI_KV.put("analytics:first-event-date", today);
  }

  // Referrer bucket: raw pageview-level, not deduplicated -- a different
  // concept than "unique visitors" above, same distinction real tools
  // draw between "visitors" and "visits"/"sessions" by source. Labeled as
  // such on the dashboard, not presented as "unique visitors by source."
  const bucket = classifyReferrer(referrer);
  await incrKV(env, `analytics:referrer:${today}:${bucket}`);
  await incrKV(env, `analytics:referrer-alltime:${bucket}`);
}

async function handleAnalyticsData(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const now = new Date();
  const parts = getEasternDateParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const month = `${parts.year}-${parts.month}`;
  const monday = mondayOfWeekET(today);

  const [
    dailyUniqueToday, newToday, repeatToday,
    weeklyUniqueSum, newWeeklySum, repeatWeeklySum,
    monthlyUniqueSum, newMonthlySum, repeatMonthlySum,
    alltimeUniqueSum, newAlltimeSum, repeatAlltimeSum,
    firstEventDate, briefViewsToday, adminViewsToday, botsFilteredToday,
  ] = await Promise.all([
    env.PFPI_KV.get(`analytics:daily-unique:${today}`),
    env.PFPI_KV.get(`analytics:new:${today}`),
    env.PFPI_KV.get(`analytics:repeat:${today}`),
    env.PFPI_KV.get(`analytics:weekly-unique-sum:${monday}`),
    env.PFPI_KV.get(`analytics:new-weekly-sum:${monday}`),
    env.PFPI_KV.get(`analytics:repeat-weekly-sum:${monday}`),
    env.PFPI_KV.get(`analytics:monthly-unique-sum:${month}`),
    env.PFPI_KV.get(`analytics:new-monthly-sum:${month}`),
    env.PFPI_KV.get(`analytics:repeat-monthly-sum:${month}`),
    env.PFPI_KV.get(`analytics:alltime-unique-sum`),
    env.PFPI_KV.get(`analytics:new-alltime-sum`),
    env.PFPI_KV.get(`analytics:repeat-alltime-sum`),
    env.PFPI_KV.get(`analytics:first-event-date`),
    env.PFPI_KV.get(`analytics:pageviews:${today}:brief`),
    env.PFPI_KV.get(`analytics:pageviews:${today}:admin`),
    env.PFPI_KV.get(`analytics:bots-filtered:${today}`),
  ]);

  // 14-day trend, individual GETs -- bounded (42 reads total), only ever
  // runs when the dashboard itself loads (Yeti/Greg, occasionally), never
  // per visitor. Same "last 14 days" window Cote Cup's own report uses.
  const trend = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dp = getEasternDateParts(d);
    const dateKey = `${dp.year}-${dp.month}-${dp.day}`;
    const [uniq, nw, rp] = await Promise.all([
      env.PFPI_KV.get(`analytics:daily-unique:${dateKey}`),
      env.PFPI_KV.get(`analytics:new:${dateKey}`),
      env.PFPI_KV.get(`analytics:repeat:${dateKey}`),
    ]);
    trend[dateKey] = { unique: parseInt(uniq || "0", 10), new: parseInt(nw || "0", 10), repeat: parseInt(rp || "0", 10) };
  }

  // Referrer buckets, all-time -- realistically under a dozen distinct
  // buckets ever exist, so one list() plus a handful of get()s is cheap.
  const referrerList = await env.PFPI_KV.list({ prefix: "analytics:referrer-alltime:" });
  const referrers = {};
  for (const key of referrerList.keys) {
    const bucket = key.name.slice("analytics:referrer-alltime:".length);
    referrers[bucket] = parseInt((await env.PFPI_KV.get(key.name)) || "0", 10);
  }

  return jsonResponse({
    today: {
      unique: parseInt(dailyUniqueToday || "0", 10),
      new: parseInt(newToday || "0", 10),
      repeat: parseInt(repeatToday || "0", 10),
    },
    weekToDate: {
      unique: parseInt(weeklyUniqueSum || "0", 10),
      new: parseInt(newWeeklySum || "0", 10),
      repeat: parseInt(repeatWeeklySum || "0", 10),
    },
    monthToDate: {
      unique: parseInt(monthlyUniqueSum || "0", 10),
      new: parseInt(newMonthlySum || "0", 10),
      repeat: parseInt(repeatMonthlySum || "0", 10),
    },
    allTime: {
      unique: parseInt(alltimeUniqueSum || "0", 10),
      new: parseInt(newAlltimeSum || "0", 10),
      repeat: parseInt(repeatAlltimeSum || "0", 10),
    },
    trend,
    referrers,
    internalPageviewsToday: {
      brief: parseInt(briefViewsToday || "0", 10),
      admin: parseInt(adminViewsToday || "0", 10),
    },
    botsFilteredToday: parseInt(botsFilteredToday || "0", 10),
    trackingSince: firstEventDate || null,
    generatedAt: new Date().toISOString(),
  }, 200, request);
}

// ============================================================
// GEO DATA (2026-08-29, per Yeti) -- all-time country/region/city counts
// for the Locations map. Same list()-then-get()-each pattern the
// referrer-bucket code above already uses (realistically well under a
// few hundred distinct buckets ever, for a hobby show site's traffic).
// Composite region/city keys ("US|Georgia", "US|Georgia|Atlanta") are
// returned as-is; the frontend splits on "|" to build the nested
// country -> region -> city structure it needs for map drill-downs.
// ============================================================
async function handleAnalyticsGeo(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  async function listAllCounts(prefix) {
    const out = {};
    let cursor;
    do {
      const page = await env.PFPI_KV.list({ prefix, cursor });
      for (const key of page.keys) {
        out[key.name.slice(prefix.length)] = parseInt((await env.PFPI_KV.get(key.name)) || "0", 10);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  const [countries, regions, cities] = await Promise.all([
    listAllCounts("analytics:geo-country-alltime:"),
    listAllCounts("analytics:geo-region-alltime:"),
    listAllCounts("analytics:geo-city-alltime:"),
  ]);

  return jsonResponse({ countries, regions, cities, generatedAt: new Date().toISOString() }, 200, request);
}

// ============================================================
// ANALYTICS RANGE (2026-08-31, per Yeti's PDF-report handoff) -- same
// per-day KV keys the 14-day trend and geo endpoints above already read,
// just summed over an admin-chosen [start, end] range instead of a fixed
// window. Powers the sponsor-facing PDF report's date-range picker; not
// used by the live dashboard itself. Bounded to MAX_RANGE_DAYS so a typo'd
// huge range can't turn one admin click into an unbounded KV read loop --
// this only ever runs when Yeti/Greg manually generates a report, never
// per visitor, so the per-day list()+get() cost here is the same
// "cheap because it's rare" reasoning as the geo endpoint above.
// ============================================================
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function dateKeysInRange(startKey, endKey) {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const endMs = Date.UTC(ey, em - 1, ed);
  const keys = [];
  for (let cur = Date.UTC(sy, sm - 1, sd); cur <= endMs; cur += 86400000) {
    keys.push(new Date(cur).toISOString().slice(0, 10));
  }
  return keys;
}

function addCounts(target, source) {
  for (const key of Object.keys(source)) {
    target[key] = (target[key] || 0) + source[key];
  }
}

async function handleAnalyticsRange(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAnalyticsViewerSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start") || "";
  const end = url.searchParams.get("end") || "";
  if (!DATE_KEY_PATTERN.test(start) || !DATE_KEY_PATTERN.test(end) || start > end) {
    return jsonResponse({ error: "Invalid range -- start/end must be YYYY-MM-DD with start on or before end." }, 400, request);
  }
  const dateKeys = dateKeysInRange(start, end);
  if (dateKeys.length > MAX_RANGE_DAYS) {
    return jsonResponse({ error: `Range too large -- max ${MAX_RANGE_DAYS} days, requested ${dateKeys.length}.` }, 400, request);
  }

  async function listAllCounts(prefix) {
    const out = {};
    let cursor;
    do {
      const page = await env.PFPI_KV.list({ prefix, cursor });
      for (const key of page.keys) {
        out[key.name.slice(prefix.length)] = parseInt((await env.PFPI_KV.get(key.name)) || "0", 10);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  const trend = {};
  const referrers = {};
  const countries = {};
  const regions = {};
  const cities = {};
  let totalUnique = 0, totalNew = 0, totalRepeat = 0;
  let briefViews = 0, adminViews = 0, botsFiltered = 0;

  for (const dateKey of dateKeys) {
    const [uniqRaw, newRaw, repeatRaw, briefRaw, adminRaw, botsRaw, dayReferrers, dayCountries, dayRegions, dayCities] = await Promise.all([
      env.PFPI_KV.get(`analytics:daily-unique:${dateKey}`),
      env.PFPI_KV.get(`analytics:new:${dateKey}`),
      env.PFPI_KV.get(`analytics:repeat:${dateKey}`),
      env.PFPI_KV.get(`analytics:pageviews:${dateKey}:brief`),
      env.PFPI_KV.get(`analytics:pageviews:${dateKey}:admin`),
      env.PFPI_KV.get(`analytics:bots-filtered:${dateKey}`),
      listAllCounts(`analytics:referrer:${dateKey}:`),
      listAllCounts(`analytics:geo-country:${dateKey}:`),
      listAllCounts(`analytics:geo-region:${dateKey}:`),
      listAllCounts(`analytics:geo-city:${dateKey}:`),
    ]);
    const unique = parseInt(uniqRaw || "0", 10);
    const newV = parseInt(newRaw || "0", 10);
    const repeat = parseInt(repeatRaw || "0", 10);
    trend[dateKey] = { unique, new: newV, repeat };
    totalUnique += unique;
    totalNew += newV;
    totalRepeat += repeat;
    briefViews += parseInt(briefRaw || "0", 10);
    adminViews += parseInt(adminRaw || "0", 10);
    botsFiltered += parseInt(botsRaw || "0", 10);
    addCounts(referrers, dayReferrers);
    addCounts(countries, dayCountries);
    addCounts(regions, dayRegions);
    addCounts(cities, dayCities);
  }

  return jsonResponse({
    start, end, days: dateKeys.length,
    totals: { unique: totalUnique, new: totalNew, repeat: totalRepeat },
    trend,
    referrers,
    geo: { countries, regions, cities },
    internalPageviews: { brief: briefViews, admin: adminViews },
    botsFiltered,
    generatedAt: new Date().toISOString(),
  }, 200, request);
}

// ============================================================
// ADMIN MANUAL POLL TRIGGER (added 2026-08-28, per Yeti)
// ============================================================
// This Worker never had its own auth system or session store -- rather
// than build a second one, this reads the SAME `admin-session:{token}` KV
// key picks-worker.js's login flow already writes (both Workers share the
// one PFPI_KV namespace/id, see wrangler-scores.toml vs wrangler.toml).
// admin.html sends the exact session token it already holds from logging
// into pfpi-picks-worker; no new secret, no cross-Worker call needed.
const ALLOWED_ORIGINS = [
  "https://pfpi.me",
  "https://pfpi.thegregcoteshow.com",
  "https://the-greg-cote-show.github.io",
];

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

async function verifyAdminSession(token, env) {
  if (!token) return false;
  return (await env.PFPI_KV.get(`admin-session:${token}`)) === "valid";
}

// Analytics viewing (2026-08-29, per Yeti: "add the same button/view to
// the Commissioner Portal so Greg can look at the numbers as well") is
// read-only and not one of the admin-only override actions the strict
// admin/Greg session separation exists to protect (see picks-worker.js's
// AUTH_CONFIG comment -- that separation matters for things like
// /admin/override-pick, not for viewing a visitor-count dashboard).
// Accepts EITHER session namespace; still rejects anything else. Both
// `admin-session:{token}` and `greg-session:{token}` live in this same
// PFPI_KV namespace (picks-worker.js's login writes them, this Worker
// only ever reads them).
async function verifyAnalyticsViewerSession(token, env) {
  if (!token) return false;
  const [adminValid, gregValid] = await Promise.all([
    env.PFPI_KV.get(`admin-session:${token}`),
    env.PFPI_KV.get(`greg-session:${token}`),
  ]);
  return adminValid === "valid" || gregValid === "valid";
}

async function handleTriggerPoll(request, env) {
  const token = request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(token, env))) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }
  await pollAndPublish(env, true);
  return jsonResponse({ triggered: true }, 200, request);
}

// ============================================================
// WORKER ENTRY POINTS
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
    const url = new URL(request.url);
    if (url.pathname === "/admin/trigger-poll" && request.method === "POST") {
      return handleTriggerPoll(request, env);
    }
    if (url.pathname === "/track" && request.method === "POST") {
      // Everything handleTrack needs is read from the real request HERE,
      // synchronously, before the response goes out -- see handleTrack's
      // own comment for why (a real bug found live: reading the request
      // body inside ctx.waitUntil(), after the response, throws). Instant
      // empty response either way -- the visitor never waits on any KV
      // write, and a malformed body just means nothing gets logged.
      let trackBody = {};
      try { trackBody = await request.json(); } catch (e) { trackBody = {}; }
      const cf = request.cf || {};
      const ua = request.headers.get("User-Agent") || "unknown";
      const trackParams = {
        ip: request.headers.get("CF-Connecting-IP") || "0.0.0.0",
        ua,
        page: trackBody.page,
        referrer: trackBody.referrer,
        notrack: trackBody.notrack === true || url.searchParams.get("notrack") === "1",
        isBot: isLikelyBot(ua, cf),
        country: typeof cf.country === "string" ? cf.country : null,
        region: typeof cf.region === "string" ? cf.region : null,
        city: typeof cf.city === "string" ? cf.city : null,
      };
      ctx.waitUntil(handleTrack(env, trackParams));
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/admin/analytics-data" && request.method === "GET") {
      return handleAnalyticsData(request, env);
    }
    if (url.pathname === "/admin/analytics-geo" && request.method === "GET") {
      return handleAnalyticsGeo(request, env);
    }
    if (url.pathname === "/admin/analytics-range" && request.method === "GET") {
      return handleAnalyticsRange(request, env);
    }
    if (url.pathname === "/admin/digest" && request.method === "GET") {
      return handleDigestGet(request, env);
    }
    if (url.pathname === "/admin/digest-weeks" && request.method === "GET") {
      return handleDigestWeeks(request, env);
    }
    if (url.pathname === "/admin/digest-recompute" && request.method === "POST") {
      return handleDigestRecompute(request, env);
    }
    return jsonResponse({ ok: true, worker: "pfpi-scores-worker" }, 200, request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndPublish(env));
  },
};
