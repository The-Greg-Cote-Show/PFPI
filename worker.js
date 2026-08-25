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

import { TEAMS, computeCurrentWeekFromDate, commitJSONToGitHub } from "./shared.js";

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

  let winner = null;
  if (status === "final" && homeScore !== null && awayScore !== null) {
    winner = homeScore > awayScore ? home : away;
  }

  return {
    id: raw.game_id || raw.id,
    home, away, homeScore, awayScore, status, kickoffISO, winner,
  };
}

// ============================================================
// STANDINGS (cumulative correct picks per team per week)
// ============================================================
// Only Standings and the Games tab are wired to real data tonight.
// weeksLeading/weeklyTitles/bestWeek need a tie-splitting rule Greg hasn't
// specified anywhere in the reference docs, and tenWin/uniqueHits are
// explicitly flagged in the brief as "Greg hasn't found this yet" — all five
// stay on simulated data in index.html until that's resolved. See
// BUILD_LOG.md.

async function computeStandings(throughWeek, env) {
  const standings = {};
  const standingsPct = {};
  TEAMS.forEach(t => { standings[t] = {}; standingsPct[t] = {}; });

  let cumulative = {};
  TEAMS.forEach(t => cumulative[t] = 0);
  let gamesPlayedCumulative = 0;

  for (let week = 1; week <= throughWeek; week++) {
    const raw = await env.PFPI_KV.get(`results:week:${week}`);
    const results = raw ? JSON.parse(raw) : [];
    gamesPlayedCumulative += results.length;

    for (const team of TEAMS) {
      const picksRaw = await env.PFPI_KV.get(`picks:${week}:${team}`);
      const picks = picksRaw ? JSON.parse(picksRaw) : {};
      let correctThisWeek = 0;
      for (const game of results) {
        if (game.winner && picks[game.id] === game.winner) correctThisWeek++;
      }
      cumulative[team] += correctThisWeek;
      standings[team][String(week)] = cumulative[team];
      standingsPct[team][String(week)] = gamesPlayedCumulative > 0
        ? cumulative[team] / gamesPlayedCumulative
        : 0;
    }
  }

  return { standings, standingsPct };
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
      kickoffISO: g.kickoffISO, status: g.status,
      homeScore: g.homeScore, awayScore: g.awayScore,
      winner: g.winner, picks,
    };
  });
}

// ============================================================
// MAIN POLL CYCLE
// ============================================================

async function pollAndPublish(env) {
  const currentWeek = computeCurrentWeekFromDate();
  await env.PFPI_KV.put("current-week", String(currentWeek));

  if (!env.BIG_BALLS_API_KEY) {
    console.error("Skipping Big Balls poll: BIG_BALLS_API_KEY not set. No score/schedule data fetched or published this tick.");
    return;
  }

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

  const { standings, standingsPct } = await computeStandings(currentWeek, env);

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
    { standings, standingsPct, throughWeek: currentWeek, updatedAt: new Date().toISOString() },
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
