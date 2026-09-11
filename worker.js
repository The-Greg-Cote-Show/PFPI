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

import { TEAMS, TEAM_SHORT, computeCurrentWeekFromDate, commitJSONToGitHub, getEasternDateParts, computeGameDeadline, sendPfpiEmail } from "./shared.js";

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

// Tie/winner derivation, shared between normalizeGame() (below) and
// enrichLiveScores() (see the /v1/stored/matches section further down) --
// extracted so the two can never quietly diverge on this logic. Per Yeti
// (2026-08-25): a tied game is nullified for pick'em purposes entirely --
// no winner, excluded from every team's correct/incorrect tally and from
// the week's game-count denominator (see computeStandings below).
function computeTieAndWinner(status, home, away, homeScore, awayScore) {
  const bothScored = homeScore !== null && awayScore !== null;
  const tie = status === "final" && bothScored && homeScore === awayScore;
  let winner = null;
  if (status === "final" && bothScored && !tie) {
    winner = homeScore > awayScore ? home : away;
  }
  return { tie, winner };
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
  // only signal available is whether both scores are populated. Residual
  // known limitation as of this endpoint alone: no live/in-progress
  // signal, AND (confirmed live 2026-09-10, real Week 1 NE @ SEA) can lag
  // hours behind even a genuinely FINAL result -- see enrichLiveScores
  // below, which now covers both gaps via a second Big Balls endpoint.
  const status = (homeScore !== null && awayScore !== null) ? "final" : "scheduled";
  // No kickoff time-of-day exists in real responses either, only a
  // date-only game_date — anchored at noon UTC so the calendar day is
  // unambiguous in every US timezone (see gap notice above).
  const kickoffISO = raw.kickoff || raw.start_time || raw.game_time
    || (raw.game_date ? `${raw.game_date}T12:00:00.000Z` : null);

  const { tie, winner } = computeTieAndWinner(status, home, away, homeScore, awayScore);

  return {
    id: raw.game_id || raw.id,
    // Big Balls' own real match UUID (shared verbatim with /v1/stored/
    // matches' own `id` field, confirmed live 2026-09-10) -- purely
    // internal (never present on buildWeekPublicJSON's public output
    // object below), used only to join this game against that other
    // endpoint's live/final data in enrichLiveScores.
    matchId: raw.match_id || null,
    // hasRealTime: false -- kickoffISO above is a noon-UTC placeholder
    // anchored to the real calendar date, not a real kickoff hour (see
    // the gap notice above). The frontend uses this flag to show a date
    // only for these games, never a fabricated time -- contrast
    // normalizeHighlightlyGame()'s hasRealTime: true, which has genuine
    // kickoff timestamps.
    // clockReport: always null -- neither Big Balls endpoint has a real
    // game-clock field for regular-season NFL games (only a coarse
    // status), unlike Highlightly's preseason feed (see
    // normalizeHighlightlyGame's own clockReport, confirmed against a
    // real live game 2026-08-27).
    home, away, homeScore, awayScore, status, kickoffISO, winner, tie, hasRealTime: false, clockReport: null,
  };
}

// ============================================================
// LIVE/FINAL SCORE ENRICHMENT via /v1/stored/matches (added 2026-09-10,
// per Yeti -- real bug: Week 1's real NE @ SEA game finished hours before
// PFPI's stats reflected it. Traced live, with a real diagnostic call
// against production data: /v1/nfl/games (above) was STILL returning
// null scores / "scheduled" for that exact game hours after it ended --
// not a bug in this Worker's own polling (confirmed separately: the
// 15-minute poll/commit cadence never stopped), a real gap/lag in that
// one Big Balls endpoint itself. A second, different Big Balls endpoint,
// /v1/stored/matches?sport=american_football&league=nfl&date=YYYY-MM-DD,
// tracked that same real game from "live" (with a real, populated score)
// through "finished" (real final score) the whole time -- confirmed with
// a real live test call, not assumed. Both endpoints share the exact
// same real match UUID (/v1/nfl/games' `match_id` == this endpoint's own
// `id`), so this enriches (never replaces -- /v1/nfl/games is still the
// real schedule/team-matchup source of truth) each already-normalized
// game with this endpoint's fresher status/score wherever a confident
// UUID match exists.
//
// `date` on this endpoint is UTC-anchored (confirmed live: the real ET
// game-date returned nothing; the UTC kickoff date matched) -- a
// different convention than /v1/nfl/games' own ET-anchored `game_date`,
// so this must be derived from each game's own (Highlightly-corrected,
// where available) real kickoffISO, not Big Balls' original field.
async function fetchStoredMatchesForDate(date, env) {
  const res = await fetch(
    `${BIG_BALLS_BASE}/v1/stored/matches?sport=american_football&league=nfl&date=${encodeURIComponent(date)}`,
    { headers: { "Authorization": `Bearer ${env.BIG_BALLS_API_KEY}` } }
  );
  if (!res.ok) {
    console.error(`Big Balls stored-matches fetch failed for ${date}: ${res.status} ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

// Builds a matchId -> stored-match lookup for every UTC calendar date
// among the given games' real kickoff times -- one call per unique date,
// not per game (a single Sunday slate is usually one call, not ten).
async function buildStoredMatchLookup(games, env) {
  const dates = new Set(games.map(g => new Date(g.kickoffISO).toISOString().slice(0, 10)));
  const lookup = new Map();
  for (const date of dates) {
    const matches = await fetchStoredMatchesForDate(date, env);
    matches.forEach(m => { if (m.id) lookup.set(m.id, m); });
  }
  return lookup;
}

// stored-matches' own status vocabulary, mapped onto this system's
// existing one ("scheduled"/"in_progress"/"final") -- the same values
// index.html's statusLabel/clockReport logic already branches on, so no
// frontend change is needed for this to show up correctly.
const STORED_MATCH_STATUS_MAP = { scheduled: "scheduled", live: "in_progress", finished: "final" };

// Applies stored-match enrichment to one already-normalized game.
// Confident, narrow join (matchId only, never a fuzzy team/date guess),
// and never downgrades a game this Worker has already confirmed final in
// an earlier tick (see enrichLiveScores' own comment on `knownFinalsById`
// below) -- a transient stored-matches miss on a later tick must never
// un-finalize an already-real result.
function applyStoredMatch(game, storedMatch) {
  if (!storedMatch || !storedMatch.score) return game;
  const homeScore = typeof storedMatch.score.home === "number" ? storedMatch.score.home : game.homeScore;
  const awayScore = typeof storedMatch.score.away === "number" ? storedMatch.score.away : game.awayScore;
  const mappedStatus = STORED_MATCH_STATUS_MAP[storedMatch.status];
  if (!mappedStatus) {
    console.error(`Unrecognized /v1/stored/matches status "${storedMatch.status}" for matchId ${storedMatch.id} -- keeping /v1/nfl/games' own status.`);
  }
  const status = mappedStatus || game.status;
  const { tie, winner } = computeTieAndWinner(status, game.home, game.away, homeScore, awayScore);
  return {
    ...game,
    homeScore, awayScore, status, tie, winner,
    // A real, though coarse, live-progress hint for the frontend --
    // stored-matches doesn't expose a play-by-play clock, only the
    // per-quarter linescore, which is at least real signal that a
    // "Live" game truly is in progress rather than just guessing.
    clockReport: status === "in_progress" && storedMatch.linescore ? "Live" : game.clockReport,
  };
}

// Minimum real time between fresh /v1/stored/matches calls for a given
// week's still-pending games, added 2026-09-11 per Yeti as part of the
// Sunday-budget fix (see BUILD_LOG.md): the schedule-driven live window
// above still fires this whole tick every single minute during a live
// window, and re-checking live scores at that same 1-minute cadence was
// the single largest remaining cost in the projected ~2,070-2,100
// call/day worst case for an ordinary Sunday -- over the 2,000/day cap
// from ordinary polling alone, before anything else touches the budget.
// 2 minutes keeps scores meaningfully fresh (well inside anything a
// pick'em standings page needs) while roughly halving this piece of the
// cost.
const STORED_MATCH_MIN_INTERVAL_MS = 2 * 60 * 1000;

// Top-level enrichment step, called once per week right after
// enrichKickoffTimes(). `knownFinalsById` is this week's existing
// `results:week:{week}` KV cache (already-confirmed finals from a
// PREVIOUS tick) -- a game already in there is reapplied directly,
// without spending a fresh stored-matches call on it, and specifically
// so it can never be silently dropped from this tick's own
// `results:week` write if /v1/nfl/games regresses back to "scheduled"
// (confirmed real behavior tonight) or a stored-matches call transiently
// fails. Only games that have genuinely kicked off AND aren't already
// confirmed final ever trigger a real stored-matches call -- a future
// game's correct "scheduled"/null state from /v1/nfl/games is left
// alone, and this budget-conscious scoping naturally shrinks as more
// games actually finish and get cached.
//
// `week` + `force` (added 2026-09-11) drive the STORED_MATCH_MIN_INTERVAL_MS
// throttle below: a manual/admin `force` poll always gets a fresh call,
// same as every other throttle in this file.
async function enrichLiveScores(games, knownFinalsById, env, week, force = false) {
  const now = Date.now();
  const alreadyFinal = [];
  const needsLiveCheck = [];
  const untouched = [];
  for (const g of games) {
    if (knownFinalsById.has(g.id)) {
      alreadyFinal.push(g);
    } else if (g.matchId && g.kickoffISO && now > new Date(g.kickoffISO).getTime()) {
      needsLiveCheck.push(g);
    } else {
      untouched.push(g);
    }
  }

  // Only the outcome fields come from the cache -- home/away/kickoffISO/
  // hasRealTime/matchId stay THIS tick's own fresh values (from
  // /v1/nfl/games + enrichKickoffTimes above), in case an earlier tick's
  // cached snapshot predates a later kickoff-time correction.
  const cachedResults = alreadyFinal.map(g => {
    const cached = knownFinalsById.get(g.id);
    return { ...g, homeScore: cached.homeScore, awayScore: cached.awayScore, status: cached.status, tie: cached.tie, winner: cached.winner };
  });

  let liveResults = needsLiveCheck;
  if (needsLiveCheck.length > 0) {
    const throttleKey = `stored-matches-throttle:${week}`;
    const cacheKey = `stored-matches-cache:${week}`;
    const lastCheck = Number((await env.PFPI_KV.get(throttleKey)) || 0);

    if (force || now - lastCheck >= STORED_MATCH_MIN_INTERVAL_MS) {
      const lookup = await buildStoredMatchLookup(needsLiveCheck, env);
      liveResults = needsLiveCheck.map(g => applyStoredMatch(g, lookup.get(g.matchId)));
      await env.PFPI_KV.put(throttleKey, String(now));
      await env.PFPI_KV.put(cacheKey, JSON.stringify(liveResults));
    } else {
      // Too soon since the last real stored-matches call -- reuse that
      // call's own result rather than spending another one this tick.
      // Falling back to the un-enriched game (Big Balls' own status/score)
      // instead would be a real regression for an in-progress game, since
      // that's exactly the gap enrichLiveScores exists to cover.
      const cachedRaw = await env.PFPI_KV.get(cacheKey);
      const cachedById = new Map((cachedRaw ? JSON.parse(cachedRaw) : []).map(g => [g.id, g]));
      liveResults = needsLiveCheck.map(g => cachedById.get(g.id) || g);
    }
  }

  // Recombine, preserving the original schedule order (buildWeekPublicJSON
  // downstream doesn't depend on order, but nothing else in this Worker
  // should have to reason about a resorted list either).
  const byId = new Map([...cachedResults, ...liveResults, ...untouched].map(g => [g.id, g]));
  return games.map(g => byId.get(g.id) || g);
}

// ============================================================
// HIGHLIGHTLY preseason Week 3 stopgap (Aug 27-29, 2026) RETIRED 2026-09-03
// ============================================================
// The full live-scores/picks-merge Highlightly integration that used to
// live here (normalizeHighlightlyGame, shouldPollHighlightlyThisTick,
// fetchHighlightlyPreseasonWeek3) was removed as part of retiring
// preseason -- see BUILD_LOG.md's "PowerPoint conversion, cron-drift
// investigation, preseason archive & teardown" entry. That removal is
// NOT reversed by the section directly below -- this is a new, much
// narrower use of the same provider, added the same day per Yeti's
// explicit request, for a genuinely different purpose (kickoff-time
// enrichment for the real regular season, not a preseason score feed).

// ============================================================
// HIGHLIGHTLY — real kickoff-time enrichment for the regular season
// (2026-09-03, per Yeti, after the games-ordering investigation
// surfaced a real, currently-live bug, not just a display issue)
// ============================================================
// ROOT CAUSE THIS FIXES: Big Balls supplies NO kickoff time-of-day at
// all for any regular-season game (see normalizeGame() above --
// kickoffISO is synthesized as noon UTC on the real calendar date,
// confirmed 2026-08-25 and re-confirmed 2026-09-03 against the live
// data/week-1.json and data/week-2.json: every game in both files
// shares the identical synthesized time). computeGameDeadline()
// (shared.js) subtracts 2 hours from kickoff for Tue/Wed/Thu/Fri games
// -- with a fake noon-UTC kickoff, that produced a genuinely wrong,
// live deadline: Week 1's Wednesday opener (NE @ SEA, real kickoff
// ~8:00 PM ET) was computing a 6:00 AM ET deadline, locking picks ~14
// hours before the real game. Weekend (Sat/Sun/Mon) deadlines were NOT
// affected -- computeGameDeadline() only ever uses the kickoff's
// calendar DATE for those, never its time, and the synthesized
// noon-UTC placeholder always lands on the correct real calendar day.
//
// SCOPE: kickoff-time enrichment ONLY -- Big Balls already handles real
// scores/status for the regular season correctly; this only supplies
// the one thing it structurally cannot. Polled far less often than Big
// Balls' own score polling (kickoff times don't move minute-to-minute
// the way live scores do -- a flex-schedule change is a rare, discrete,
// announced event, not something that needs checking every tick).
//
// TEAM-CODE MAPPING, VERIFIED AGAINST REAL DATA FROM BOTH PROVIDERS, not
// guessed: compared Highlightly's own 32 real team abbreviations (every
// team appears exactly once in the archived real preseason Week 3
// schedule, archive/preseason-2026/kv/schedule_week_preseason-3.json --
// a genuine 16-game, all-32-team dataset, not a partial sample) against
// Big Balls' real published codes (data/week-1.json, data/week-2.json).
// 30 of 32 matched exactly. Two confirmed mismatches: Highlightly "LAR"
// = Big Balls "LA" (Rams), Highlightly "WSH" = Big Balls "WAS"
// (Washington). Mapped below; every other code passes through
// unchanged -- not assumed safe, empirically confirmed for all 32.
//
// KNOWN, STATED LIMITATION (verify-first, not a silent assumption): the
// `/matches?...&limit=100` call below is unfiltered by week/date --
// proven to reliably cover "current + next week" for the season's early
// weeks (very little of the season has been played yet, so the current
// and next week's games are necessarily near the front of whatever
// order Highlightly returns), but NOT independently verified to still
// reliably include the right games once the season is deep into
// mid/late weeks, when far more of the season's 272 games sit ahead of
// the current week in that same unfiltered response. `enrichKickoffTimes`
// below logs a clear match-count warning every time it can't confidently
// match every game for a polled week, specifically so a real gap later
// in the season is visible in Worker logs rather than silently missed --
// if that starts showing up, the real fix is switching this fetch to
// Highlightly's `date=YYYY-MM-DD` param (confirmed to exist and work,
// see the retired preseason section's own history in BUILD_LOG.md) with
// one call per real game-day in the polled weeks, not something to
// pre-build speculatively tonight without evidence it's needed.
// ============================================================

const HIGHLIGHTLY_BASE = "https://american-football.highlightly.net";

const HIGHLIGHTLY_TO_BIGBALLS_CODE = { LAR: "LA", WSH: "WAS" };

function normalizeTeamCodeFromHighlightly(code) {
  const upper = (code || "").toUpperCase().trim();
  return HIGHLIGHTLY_TO_BIGBALLS_CODE[upper] || upper;
}

// Refetch from the real API at most this often, regardless of how often
// the surrounding Big Balls poll itself runs -- keeps this comfortably
// under Highlightly's 100/day RapidAPI budget (a fetch every 3 hours is
// 8/day on its own) even stacked with occasional admin force-triggers.
const HIGHLIGHTLY_KICKOFF_REFRESH_MS = 3 * 60 * 60 * 1000;

// REAL BUG FOUND AND FIXED same-day (2026-09-03, ~3:35 PM ET), caught by
// Yeti reporting kickoff times still weren't showing shortly after the
// first version of this deployed: the first version only returned a
// lookup Map on the ONE tick that actually refetched from Highlightly
// (every ~3 hours) and returned null every other tick -- but Big Balls'
// own normalizeGame() ALWAYS resynthesizes a fresh noon-UTC placeholder
// every single time it runs (it has no memory of a previous
// enrichment), and enrichKickoffTimes() correctly leaves a null-lookup
// tick's games untouched -- meaning the very next 15-minute Big Balls
// tick after a successful enrichment immediately overwrote it right
// back to placeholder times, and it only became briefly correct again
// once every ~3 hours. Confirmed live: `curl https://pfpi.me/data/
// week-1.json` showed hasRealTime:false again about 20 minutes after
// the first deploy's own verified-correct tick. Fix: persist the
// PARSED LOOKUP ITSELF in KV (`highlightly-kickoff:cache`), not just a
// "when did we last fetch" timestamp -- every tick now gets a usable
// lookup (freshly fetched, or the last successfully cached one) and
// enrichment is applied every single tick, not just the lucky one.
const HIGHLIGHTLY_KICKOFF_CACHE_TTL_SECONDS = 24 * 60 * 60;

async function shouldRefreshHighlightlyKickoffTimes(env) {
  const lastFetchRaw = await env.PFPI_KV.get("highlightly-kickoff:last-fetch");
  if (!lastFetchRaw) return true; // never fetched -- e.g. right after this feature's first deploy.
  return Date.now() - Number(lastFetchRaw) > HIGHLIGHTLY_KICKOFF_REFRESH_MS;
}

async function fetchHighlightlyKickoffTimesFromAPI(env) {
  const res = await fetch(`${HIGHLIGHTLY_BASE}/matches?league=NFL&season=${SEASON}&limit=100`, {
    headers: { "x-rapidapi-key": env.HIGHLIGHTLY_API_KEY },
  });
  if (!res.ok) {
    console.error(`Highlightly kickoff-time fetch failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = await res.json();
  const raw = data.data || [];
  const lookup = new Map();
  for (const g of raw) {
    const home = normalizeTeamCodeFromHighlightly(g.homeTeam && g.homeTeam.abbreviation);
    const away = normalizeTeamCodeFromHighlightly(g.awayTeam && g.awayTeam.abbreviation);
    if (!home || !away || !g.date) continue;
    lookup.set(`${away}|${home}`, g.date);
  }
  console.log(`Highlightly kickoff-time fetch: parsed ${lookup.size} usable games from ${raw.length} raw entries.`);
  return lookup;
}

// Returns a Map of "AWAY|HOME" (Big-Balls-normalized codes) -> real
// kickoff ISO timestamp for THIS tick to use, or null only if no usable
// lookup exists at all yet (never fetched successfully, or the cache has
// fully expired). On a tick that isn't due for a real refetch, this
// still returns the last successfully cached lookup from KV -- so every
// tick applies enrichment with the best data available, not just the
// tick that happened to refresh it.
async function getHighlightlyKickoffLookup(env, force) {
  if (!env.HIGHLIGHTLY_API_KEY) {
    console.error("Skipping Highlightly kickoff-time fetch: HIGHLIGHTLY_API_KEY not set.");
    return null;
  }

  if (force || (await shouldRefreshHighlightlyKickoffTimes(env))) {
    const fetched = await fetchHighlightlyKickoffTimesFromAPI(env);
    if (fetched) {
      await env.PFPI_KV.put("highlightly-kickoff:cache", JSON.stringify([...fetched]), { expirationTtl: HIGHLIGHTLY_KICKOFF_CACHE_TTL_SECONDS });
      await env.PFPI_KV.put("highlightly-kickoff:last-fetch", String(Date.now()));
      return fetched;
    }
    // Fetch failed -- fall through to whatever's still cached below
    // rather than go without real times just because this one attempt
    // failed (a network blip shouldn't revert every game to placeholder
    // times for the next 3 hours).
  }

  const cachedRaw = await env.PFPI_KV.get("highlightly-kickoff:cache");
  if (!cachedRaw) return null;
  return new Map(JSON.parse(cachedRaw));
}

// Overrides Big-Balls-normalized games' synthesized kickoffISO with a
// real Highlightly kickoff time where a confident match exists.
// Defensive, not blind trust: only overrides when (a) the team-code pair
// matches exactly -- safe within one season, since an ordered
// (away,home) pair does not repeat -- AND (b) the real kickoff falls
// within 1 calendar day (ET) of Big Balls' own synthesized date, so a
// stray bad match can't silently plant a wildly wrong deadline on the
// wrong game. Logs a match-count warning (doesn't throw) whenever it
// can't confidently match every game for this week, so a real gap is
// visible in Worker logs rather than silently missed.
function enrichKickoffTimes(games, kickoffLookup) {
  if (!kickoffLookup) return games; // no usable lookup at all yet (never fetched, or fully expired) -- keep Big Balls' placeholder times as-is.
  let matched = 0;
  const enriched = games.map(g => {
    const realISO = kickoffLookup.get(`${g.away}|${g.home}`);
    if (!realISO) return g;
    const realDay = getEasternDateParts(new Date(realISO));
    const placeholderDay = getEasternDateParts(new Date(g.kickoffISO));
    const realMidnight = new Date(`${realDay.year}-${realDay.month}-${realDay.day}T00:00:00.000Z`).getTime();
    const placeholderMidnight = new Date(`${placeholderDay.year}-${placeholderDay.month}-${placeholderDay.day}T00:00:00.000Z`).getTime();
    if (Math.abs(realMidnight - placeholderMidnight) > 24 * 60 * 60 * 1000) {
      console.error(`Highlightly kickoff-time mismatch for ${g.away}@${g.home}: real date ${realDay.year}-${realDay.month}-${realDay.day} vs. Big Balls date ${placeholderDay.year}-${placeholderDay.month}-${placeholderDay.day} -- too far apart, NOT overriding.`);
      return g;
    }
    matched++;
    return { ...g, kickoffISO: realISO, hasRealTime: true };
  });
  if (matched < games.length) {
    console.error(`Highlightly kickoff-time enrichment: matched ${matched}/${games.length} games this tick -- the rest kept Big Balls' synthesized (date-only) kickoff time.`);
  }
  return enriched;
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
// PRESEASON SCORING SNAPSHOT — RETIRED 2026-09-03
// ============================================================
// computePreseasonSnapshot() lived here: a fully separate, stateless,
// single-week-only stats computation for the preseason Week 3 sandbox,
// sharing no code or mutable state with computeStandings() above (only the
// generic splitShare()/round2() math helpers, which have no notion of
// "week" at all). Removed as part of retiring preseason from the live site
// ahead of real Week 1 -- see BUILD_LOG.md's "PowerPoint conversion,
// cron-drift investigation, preseason archive & teardown" entry for the
// archive of everything this used to compute. computeStandings() itself
// (real regular-season scoring, including tie handling) is untouched.

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
const GREG_EMAIL = "upsetbird@aol.com"; // Greg's real address (2026-09-07, per Yeti) -- kept in sync with picks-worker.js's own GREG_EMAIL, change both together. Governs the Weekly Digest "ready" email below; still subject to sendPfpiEmail's emails-live-for-everyone gate (shared.js) like every other real address.

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
    env, undefined, "commissioner"
  );
  return entry;
}

// Freshly recomputes the stats snapshot for a week, for the manual
// recompute endpoint (the automatic path in pollAndPublish() already has
// a freshly-computed snapshot in hand and doesn't need this). Used to also
// handle week === "preseason-3" via computePreseasonSnapshot() -- removed
// 2026-09-03 along with the rest of the preseason infrastructure (see
// BUILD_LOG.md); this manual-recompute endpoint is only ever reachable for
// a real numbered week now, since admin.html/brief.html's digest-week
// dropdown no longer offers "Preseason" as a selectable value.
async function computeDigestStatsForWeek(week, env) {
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

// Per-game public reveal gate (Part 2b, 2026-09-05 per Yeti): nobody should
// see anyone's picks on the public site until every real roster team has
// either locked their pick for THAT SPECIFIC game (see picks-worker.js's
// lockGameIds — the permanent, submit-triggered lock added alongside this,
// not the older per-game deadline lock) or that game's own deadline has
// passed — a genuine per-game OR, whichever happens first. Deliberately
// re-evaluated fresh on every publish tick rather than cached/one-shot:
// both inputs (deadline-passed, the locked set) are monotonic-only-forward,
// so a game can go hidden->revealed but never revealed->hidden.
async function buildWeekPublicJSON(week, results, env) {
  // One KV read per team for the whole week, not per game.
  const picksByTeam = {};
  const lockedByTeam = {};
  for (const team of TEAMS) {
    const picksRaw = await env.PFPI_KV.get(`picks:${week}:${team}`);
    picksByTeam[team] = picksRaw ? JSON.parse(picksRaw) : {};
    const lockedRaw = await env.PFPI_KV.get(`locked-picks:${week}:${team}`);
    lockedByTeam[team] = new Set(lockedRaw ? JSON.parse(lockedRaw) : []);
  }

  return results.map(g => {
    const deadline = computeGameDeadline(g.kickoffISO);
    const deadlinePassed = Date.now() > new Date(deadline).getTime();
    const allTeamsLocked = TEAMS.every(team => lockedByTeam[team].has(g.id));
    const picksRevealed = deadlinePassed || allTeamsLocked;

    // The underlying data itself is withheld here (an empty object), not
    // just hidden client-side -- so a public fetch of this JSON can never
    // return a real pick before this game's own reveal condition is met.
    const picks = {};
    if (picksRevealed) {
      for (const team of TEAMS) {
        if (picksByTeam[team][g.id]) picks[team] = picksByTeam[team][g.id];
      }
    }

    return {
      id: g.id, home: g.home, away: g.away,
      kickoffISO: g.kickoffISO, hasRealTime: !!g.hasRealTime, status: g.status,
      homeScore: g.homeScore, awayScore: g.awayScore,
      winner: g.winner, tie: !!g.tie, picks,
      // Lets a frontend tell "hidden until reveal" apart from "nobody's
      // picked this yet" -- an empty `picks` object alone is ambiguous
      // between those two real, different states.
      picksRevealed,
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
      deadline,
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
//
// REWRITTEN 2026-09-11, per Yeti — the original version hardcoded
// "live window = Thu/Sun/Mon evenings," which silently breaks for any real
// NFL schedule quirk that moves a game off its usual day: a Thanksgiving
// Thursday slate (three games starting ~12:30pm ET, not the usual 8pm TNF
// slot), a Black Friday or Christmas game landing on whatever weekday the
// holiday falls on that year, or a Week 16-18 Saturday game. None of those
// would have gotten faster-than-15-min polling under the old check, purely
// because they don't fall on "Thu/Sun/Mon." Real NFL scheduling rule (per
// Yeti): a game's kickoff can slide LATER within its originally-slated
// calendar day (flex, weather delay) but is never moved earlier than its
// own week's earliest known kickoff and never moved to a different day
// (barring a natural-disaster-class reschedule, which is a manual-override
// situation, not something this function should try to guess).
//
// So instead of a weekday name, this now derives "is today a live game
// day, and are we past its earliest kickoff" directly from the real,
// already-cached schedule (`schedule:week:{week}`, kept fresh every 15 min
// regardless of window state by the 15-min baseline tick below) — correct
// for any real day of the week a game actually lands on, and self-updating
// the moment a flex/time change lands in that cache.
// ============================================================

const LIVE_WINDOW_PREGAME_BUFFER_MS = 15 * 60 * 1000;

// Earliest real kickoff (ms since epoch) among this week's + next week's
// cached schedule whose ET calendar date matches `now`'s ET calendar date.
// Checking both weeks (same set pollAndPublish always polls) covers the
// rare case where a week boundary miscalculation would otherwise hide a
// real game happening today. Returns null if no real game is scheduled
// today at all (a genuine off day — most Tuesdays/Wednesdays).
async function getTodaysEarliestKickoffMs(env, now) {
  const todayParts = getEasternDateParts(now);
  const todayKey = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const currentWeek = computeCurrentWeekFromDate(now);
  const weeksToCheck = [currentWeek, Math.min(currentWeek + 1, 18)];

  let earliestMs = null;
  for (const week of weeksToCheck) {
    const raw = await env.PFPI_KV.get(`schedule:week:${week}`);
    if (!raw) continue;
    for (const g of JSON.parse(raw)) {
      if (!g.kickoffISO) continue;
      const kickoffParts = getEasternDateParts(new Date(g.kickoffISO));
      const kickoffKey = `${kickoffParts.year}-${kickoffParts.month}-${kickoffParts.day}`;
      if (kickoffKey !== todayKey) continue;
      const t = new Date(g.kickoffISO).getTime();
      if (earliestMs === null || t < earliestMs) earliestMs = t;
    }
  }
  return earliestMs;
}

async function isBigBallsLiveWindow(now, env) {
  const earliestMs = await getTodaysEarliestKickoffMs(env, now);
  if (earliestMs === null) return false;
  // Window ends at ET midnight by construction (once the calendar date
  // rolls over, `getTodaysEarliestKickoffMs` recomputes against the NEW
  // day's games) — same end-of-window boundary the original weekday-based
  // version had, including its known limitation that a game running very
  // late into overtime past midnight ET tail off back to 15-min polling.
  // Not introduced by this rewrite; unchanged from before.
  return now.getTime() >= earliestMs - LIVE_WINDOW_PREGAME_BUFFER_MS;
}

// Outside live windows: poll every 15 min instead of every tick -- still
// catches schedule/flex changes, a fraction of the 2000/day budget. UTC
// minute is safe to gate on directly since every NFL-market US timezone is
// a whole-hour UTC offset (no half-hour zones), so UTC and ET
// minute-of-hour always agree. (Inlined directly in pollAndPublish below,
// which also needs the same `inLiveWindow`/`isFifteenMinMark` values to
// decide the current/next-week split -- no separate wrapper function.)

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
        `Week ${pending.week}'s brief just went live on the public site -- confirmed by reading it back from the real published page, not just that the save succeeded.\n\nhttps://pfpi.me/index.html`,
        env, undefined, "commissioner"
      );
      await env.PFPI_KV.delete(key.name);
      continue;
    }

    const ageMs = Date.now() - new Date(pending.createdAt).getTime();
    if (ageMs > BRIEF_CONFIRM_MAX_AGE_MS) {
      // Honest fallback: only ever claim "live" once actually confirmed
      // above, so this is a heads-up, not a fabricated confirmation --
      // a genuinely stuck publish shouldn't just go silent forever. Body
      // text simplified 2026-09-08, per Yeti's own wording -- the
      // "robots" line is intentional, not a placeholder.
      await sendPfpiEmail(
        pending.notifyEmail,
        `PFPI Week ${pending.week} brief: still checking after 30 minutes`,
        `Week ${pending.week}'s brief was saved, but our robots couldn't confirm it's actually live on the public site after 30 minutes of checking. It may still show up on its own, but it's worth contacting Yeti if it's still missing.`,
        env, undefined, "commissioner"
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

  const now = new Date();
  const inLiveWindow = env.BIG_BALLS_API_KEY ? await isBigBallsLiveWindow(now, env) : false;
  const isFifteenMinMark = now.getUTCMinutes() % 15 === 0;

  if (!env.BIG_BALLS_API_KEY) {
    console.error("Skipping Big Balls poll: BIG_BALLS_API_KEY not set. No regular-season score/schedule data fetched or published this tick.");
  } else if (!force && !inLiveWindow && !isFifteenMinMark) {
    // Throttled: outside a live window and not a 15-min mark this tick.
  } else {
    await preloadFullSeasonScheduleIfNeeded(env);

    // Own throttle, independent of Big Balls' -- see
    // getHighlightlyKickoffLookup's own comment (and the bug it fixes:
    // this must return a usable lookup on EVERY tick, from cache if this
    // isn't a refetch tick, not just the tick that actually refetches --
    // Big Balls resynthesizes a placeholder kickoff time from scratch
    // every time it runs, so anything less than "enrich every tick"
    // silently reverts the fix between refetches).
    const kickoffLookup = await getHighlightlyKickoffLookup(env, force);

    // Poll current week every qualifying tick (it's the only week that can
    // ever have a live/finishing game). Next week's games haven't kicked
    // off yet, so it never needs faster-than-15-min freshness -- added
    // 2026-09-11 per Yeti, this is the biggest single lever in the
    // Sunday-budget fix (see BUILD_LOG.md): it removes the second of the
    // two /v1/nfl/games calls from every live-window tick except the
    // 15-min marks, without ever delaying next week's kickoff times (and
    // therefore deadlines) by more than 15 minutes -- still comfortably
    // ahead of Tuesday's picks email.
    const nextWeek = Math.min(currentWeek + 1, 18);
    const weeksToPoll = (force || !inLiveWindow || isFifteenMinMark)
      ? [currentWeek, nextWeek]
      : [currentWeek];
    const weekFiles = {};

    for (const week of weeksToPoll) {
      const raw = await fetchBigBallsWeek(week, env);
      if (!raw) continue;
      let normalized = enrichKickoffTimes(raw.map(normalizeGame), kickoffLookup);

      // Live/final score enrichment (2026-09-10, per Yeti -- see
      // enrichLiveScores' own comment above for the full real incident
      // this fixes). `knownFinalsById` is this week's own existing
      // results:week: cache -- read BEFORE this tick overwrites it, so an
      // already-confirmed final never needs a fresh stored-matches call
      // and can never be silently dropped by this tick's own write below.
      const existingResultsRaw = await env.PFPI_KV.get(`results:week:${week}`);
      const knownFinalsById = new Map(
        (existingResultsRaw ? JSON.parse(existingResultsRaw) : []).map(g => [g.id, g])
      );
      normalized = await enrichLiveScores(normalized, knownFinalsById, env, week, force);

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

  // The preseason Week 3 stopgap that used to run here (Highlightly fetch,
  // KV-cache fallback, picks merge, and the data/week-preseason-3.json
  // republish) has been removed -- retired 2026-09-03 along with the rest
  // of the preseason infrastructure, see BUILD_LOG.md. This was also the
  // real root cause behind the "~28 commits/hour" cron-drift finding from
  // that same investigation: this block's `minute % 5 === 0` gate had no
  // expiration tied to Highlightly's own Aug-29 cutoff, so it kept
  // recommitting stale cached preseason data every 5 minutes indefinitely.
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
const PFPI_OWN_HOSTS = new Set(["the-greg-cote-show.github.io", "pfpi.me"]);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Small fixed set of named sources per the handoff, plus "other:domain"
// (not one opaque "other" bucket) so a real, unexpected source stays
// visible and actionable instead of disappearing into noise. Exact
// hostname match (after stripping a leading "www."), not endsWith --
// PFPI_OWN_HOSTS is checked first as "internal" above, so pfpi.me never
// falls through to the "thegregcoteshow" bucket below regardless; the
// exact-match approach here just keeps every other bucket honest too
// (e.g. a rare mobile-subdomain referrer like m.youtube.com falls into
// "other:m.youtube.com" instead of "youtube" -- an honest miss, not a
// misattribution, and easy to widen later once real data shows it's
// worth it).
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
