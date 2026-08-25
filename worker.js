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

import { TEAMS, computeCurrentWeekFromDate, commitJSONToGitHub, getEasternDateParts, FAMILY_MEMBERS, computeGameDeadline } from "./shared.js";

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
    home, away, homeScore, awayScore, status, kickoffISO, winner, tie, hasRealTime: false,
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
// UNCONFIRMED, flagged not guessed: `state.score.current` is a combined
// "X - Y" string with no separate home/away fields, and every game is
// still 0-0/"Scheduled" as of this writing (games haven't kicked off yet).
// Assumed "away - home" order below, matching this site's own away@home
// convention elsewhere — genuinely unverified against a real score. Isolated
// entirely in normalizeHighlightlyGame() so it's a one-function fix once
// any of these games actually finishes (very soon — Aug 27).

const HIGHLIGHTLY_BASE = "https://american-football.highlightly.net";
const PRESEASON_WEEK3_ET_DATES = new Set(["2026-08-27", "2026-08-28", "2026-08-29"]);

function easternDateKey(isoString) {
  const parts = getEasternDateParts(new Date(isoString));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeHighlightlyGame(g) {
  const home = g.homeTeam?.abbreviation || null;
  const away = g.awayTeam?.abbreviation || null;

  const desc = (g.state?.description || "").toLowerCase();
  const status = desc.includes("final") ? "final" : desc.includes("scheduled") ? "scheduled" : "in_progress";

  // UNCONFIRMED order — see gap notice above.
  let awayScore = null, homeScore = null;
  const current = g.state?.score?.current;
  if (current && current !== "0 - 0") {
    const parts = current.split(" - ").map(s => parseInt(s.trim(), 10));
    if (parts.length === 2 && parts.every(n => !isNaN(n))) {
      [awayScore, homeScore] = parts;
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
    home, away, homeScore, awayScore, status, kickoffISO: g.date, winner, tie, hasRealTime: true, picks: {},
  };
}

// Throttled to fit Highlightly's 100/day free-tier budget, per Yeti
// (2026-08-25) — poll only within each real game day's window, at an
// interval chosen so that day's window alone stays comfortably under 100
// (each day's budget resets independently, so this is per-day, not summed
// across all three): Aug 27/28 (~4hr windows) every 3 min -> 80 polls;
// Aug 29 (~8hr window) every 5 min -> 96 polls, exactly as specified.
// Outside these specific dates/hours: no call is made at all -- not just a
// no-op response, an actual skipped fetch, so nothing is spent when
// there's nothing to learn. After Aug 29 this returns false forever; this
// was only ever a testing bridge, not an ongoing source (see scope notice
// above this section).
function shouldPollHighlightlyThisTick(now) {
  const parts = getEasternDateParts(now);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = now.getUTCMinutes(); // safe: whole-hour ET/UTC offset, see notice above
  if (dateKey === "2026-08-27") return hour >= 19 && hour < 23 && minute % 3 === 0;
  if (dateKey === "2026-08-28") return hour >= 18 && hour < 22 && minute % 3 === 0;
  if (dateKey === "2026-08-29") return hour >= 13 && hour < 21 && minute % 5 === 0;
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
// MAIN POLL CYCLE
// ============================================================

async function pollAndPublish(env) {
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
  // fetchHighlightlyPreseasonWeek3(). Independent of the Big Balls block
  // above: this runs every poll tick regardless, guarded only by its own
  // HIGHLIGHTLY_API_KEY check, so it keeps updating with live scores through
  // Aug 27-29 on the same cron cadence as everything else.
  const preseasonGames = await fetchHighlightlyPreseasonWeek3(env);
  if (preseasonGames) {
    // Schedule cache stays picks-free, matching schedule:week:N's existing
    // shape (kickoff-math only, not for public reading).
    await env.PFPI_KV.put("schedule:week:preseason-3", JSON.stringify(preseasonGames));

    // [BUG FIX 2026-08-25, found by Yeti actually testing picks against
    // preseason] The published JSON was never merging in saved picks --
    // every poll simply overwrote it with Highlightly's raw response,
    // which has no concept of PFPI picks at all. Regular-season weeks
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

    await commitJSONToGitHub(
      "data/week-preseason-3.json",
      { week: "preseason-3", games: preseasonGamesWithPicks, updatedAt: new Date().toISOString() },
      "Update preseason Week 3 (Highlightly) [automated]",
      env
    );
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
