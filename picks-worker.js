// ============================================================
// PFPI Picks Auth & Submission Worker
// Adapted from pfpi_picks_worker_framework.js (reference framework, locked
// terms with Yeti). Core logic (token model, DST-safe deadline math, PBKDF2
// admin auth) is unchanged from that file. Additions made here to make it a
// real deployable Worker:
//   - GET /my-picks endpoint (framework only specced submit/admin actions;
//     a frontend needs a read endpoint to render the picks form)
//   - CORS handling, since the frontend is served from GitHub Pages
//     (a different origin than this Worker)
//   - Wired to env bindings/secrets instead of bare placeholders
// ============================================================

import {
  computeGameDeadline,
  isGameLocked,
  computeCurrentWeekFromDate,
  commitJSONToGitHub,
  sendPfpiEmail,
  fullTeamName,
  isTargetLocalTime,
  NUM_WEEKS,
  TEAMS,
  FAMILY_MEMBERS,
} from "./shared.js";

const ADMIN_EMAIL = "yeti@yetiblanc.com";

// Greg's real personal email (2026-09-07, per Yeti -- same address he gave
// on 2026-09-06 for shared.js's "Reply to Greg" link, and already used as
// Greg's Lobos' training-page routing email). Until now this stayed the
// yeti@yetiblanc.com placeholder deliberately -- the 2026-09-06 session
// scoped Yeti's ask to just the reply-to link, not to redirecting real
// sends here (see BUILD_LOG.md) -- but tonight's ask is specifically to
// wire Greg up as a real send target, so this now governs his password
// reset, his own copy of picks-submission confirmations, and the
// brief-published confirmation (handlePublishBrief below) alike. Still
// subject to sendPfpiEmail's emails-live-for-everyone gate like every
// other real address in this file -- see shared.js -- so this alone does
// NOT make these actually land in Greg's inbox until Yeti flips that flag.
const GREG_EMAIL = "upsetbird@aol.com";

// Allowed frontend origins for CORS. pfpi.me is the real, live custom
// domain; github.io origin kept alongside it since GitHub Pages still
// serves the site there too (pfpi.me is a CNAME on top of it, not a
// replacement host).
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
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Session-Token",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

// ============================================================
// TOKEN GENERATION
// ============================================================

async function generateWeeklyToken(team, week, env) {
  const payload = { team, week, issued: Date.now() };
  const signed = await signPayload(payload, env.FAMILY_TOKEN_SECRET);
  await env.PFPI_KV.put(`token:${signed}`, JSON.stringify({ team, week }));
  return signed;
}

// Per Yeti (2026-08-25): "a way for me as the admin to send a correction
// form... much better than me making the changes." Unlike a normal weekly
// token, this one carries a correctionGameId that unlocks exactly that one
// game past its deadline (see handleGetPicks/handleSubmitPicks) -- nothing
// else about the token or the picks flow changes.
//
// TTL changed (2026-08-27, per Yeti) from a flat 24h to expiring exactly
// at that game's own kickoff -- "it's too late if you missed the window
// and the game has started." A flat 24h window could let a correction
// outlive kickoff entirely (a deadline that passed hours before a late
// kickoff) or, for the Sat/Sun/Mon flat-cutoff rule, expire well BEFORE a
// Monday game's real kickoff even though the correction should still be
// valid until then -- kickoff is the actual real-world boundary Yeti
// wants, a flat 24h was only ever an approximation of it. Cloudflare KV
// requires a minimum 60s TTL, so this floors there rather than reject a
// correction for a game about to kick off in under a minute (the request
// itself is still refused outright below if kickoff has already passed).
async function generateCorrectionToken(team, week, gameId, kickoffISO, env) {
  const payload = { team, week, correctionGameId: gameId, issued: Date.now() };
  const signed = await signPayload(payload, env.FAMILY_TOKEN_SECRET);
  const secondsUntilKickoff = Math.floor((new Date(kickoffISO).getTime() - Date.now()) / 1000);
  await env.PFPI_KV.put(
    `token:${signed}`,
    JSON.stringify({ team, week, correctionGameId: gameId }),
    { expirationTtl: Math.max(60, secondsUntilKickoff) }
  );
  return signed;
}

async function signPayload(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const data = encoder.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  const payloadB64 = btoa(JSON.stringify(payload));
  return `${payloadB64}.${sigHex}`;
}

async function verifyToken(token, env) {
  const lookup = await env.PFPI_KV.get(`token:${token}`);
  if (!lookup) return null;
  return JSON.parse(lookup);
}

// ============================================================
// SCHEDULED TRIGGER — Tuesday 7:00 AM Eastern (DST-safe)
// Cron itself fires hourly, configured in wrangler.toml's [triggers]
// block (moved there from dashboard-only 2026-08-25 — see BUILD_LOG.md for
// why: a dashboard-only trigger was proven to get silently cleared by a
// plain `wrangler deploy`).
// ============================================================

// Flat "Tuesday 7:00 AM ET, every week" (per Yeti, 2026-09-08) -- REPLACES
// the first-game-day/7am-floor logic this used from 2026-08-25 through
// tonight (that rule existed specifically for weeks whose first game
// wasn't Thursday, e.g. 2026 Week 1's Wednesday opener; Yeti's since
// decided the simpler, predictable flat Tuesday send is what he actually
// wants going forward, restoring the ORIGINAL design this section's own
// header comment above has said all along). Reuses
// `isTargetLocalTime(7, 2, "America/New_York")` from shared.js -- the
// exact DST-safe helper the original always-Tuesday design already had,
// left in place as unused-but-intact dead code the whole time this was
// floored instead, so this is a revert to proven code, not a rewrite.
async function handleWeeklyTrigger(env) {
  if (!isTargetLocalTime(7, 2, "America/New_York")) return; // 2 == Tuesday

  const currentWeek = await getCurrentWeek(env);

  // Never re-send once this week's email has gone out -- also a safety net
  // if the cron cadence ever changes, not just a Tuesday-specific concern.
  const alreadySent = await env.PFPI_KV.get(`weekly-email-sent:${currentWeek}`);
  if (alreadySent) return;

  const schedule = await getWeekSchedule(currentWeek, env);
  if (!schedule || schedule.length === 0) {
    // Per Yeti: if the schedule isn't known yet when Tuesday 7am fires,
    // hold and log -- don't guess a deadline summary and don't send
    // without real per-game data.
    console.error(`Weekly picks email: no real schedule cached yet for week ${currentWeek} -- holding, not sending until schedule data is available.`);
    return;
  }

  const deadlineSummary = formatWeekDeadlines(schedule);

  for (const member of FAMILY_MEMBERS) {
    const token = await generateWeeklyToken(member.team, currentWeek, env);
    const link = `https://pfpi.me/picks.html?token=${token}`;
    await sendPicksEmail(member.email, member.team, currentWeek, link, deadlineSummary, env);
  }

  // 30-day TTL: comfortably outlives a single week without growing forever.
  await env.PFPI_KV.put(`weekly-email-sent:${currentWeek}`, "sent", { expirationTtl: 30 * 24 * 60 * 60 });
}

// Groups this week's real per-game deadlines into a scannable summary for
// the picks email, matching the revised deadline structure in shared.js's
// computeGameDeadline() (confirmed by Greg via Yeti, 2026-08-25 -- fully
// replaces the old flat "6pm ET the day before" rule this used to
// describe): Tue/Wed/Thu/Fri games each deadline individually (2 hours
// before their own kickoff, so no single shared time to quote), while
// Sat/Sun/Mon games all collapse onto one flat cutoff -- read directly off
// any one of those games' already-computed `deadline` rather than
// re-deriving the rule here, so this can never drift from the real
// per-game math. Falls back to a generic line if there's no real schedule
// yet (season hasn't started / Big Balls hasn't published this week) —
// honest fallback, not a fabricated deadline list.
function formatWeekDeadlines(schedule) {
  if (!schedule || schedule.length === 0) {
    return "Deadlines vary by game — check the picks link for each game's exact cutoff.";
  }
  const weekdayET = iso => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(iso));
  const dayOrder = ["Tuesday", "Wednesday", "Thursday", "Friday"];
  const earlyWeekDays = new Set();
  const weekendGames = [];

  for (const g of schedule) {
    const wd = weekdayET(g.kickoffISO);
    if (wd === "Saturday" || wd === "Sunday" || wd === "Monday") weekendGames.push(g);
    else earlyWeekDays.add(wd);
  }

  const lines = [];
  for (const day of dayOrder) {
    if (earlyWeekDays.has(day)) lines.push(`${day}'s game(s) lock 2 hours before kickoff.`);
  }
  if (weekendGames.length > 0) {
    const satDate = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
    }).format(new Date(weekendGames[0].deadline));
    lines.push(`Saturday, Sunday, and Monday games all lock ${satDate} at 1:00 PM ET.`);
  }
  return lines.join(" ");
}

// Sender identity "commissioner" (mail.pfpi.me, verified 2026-09-06) --
// this is the real weekly picks-open email, addressed to a real family
// member once FAMILY_MEMBERS is populated, so it's squarely Greg/
// commissioner-side, same category as the picks-confirmation and missing-
// picks-reminder emails below. Delegates to the shared sendPfpiEmail
// (2026-09-06) instead of its own raw Resend fetch -- was a standalone
// fetch call only because it predates sendPfpiEmail's identity/reply-link/
// live-flag logic; refactored so this gets all three for free instead of
// tripling that logic here.
//
// Body text amended 2026-09-08, per Yeti: greets by TEAM name, not a
// personal first name (`fullTeamName(team)`, the same single source of
// truth every other email in this file already uses -- deliberately not
// a separate stored name on the FAMILY_MEMBERS entry, so this can never
// drift from TEAM_SHORT), and adds an explicit "picks lock the moment
// you submit, but you can still come back for the rest" paragraph Yeti
// asked for. The link line and deadline summary are otherwise unchanged
// from the original template -- only the domain changed (see
// handleWeeklyTrigger's caller).
async function sendPicksEmail(toEmail, team, week, link, deadlineSummary, env) {
  const teamName = fullTeamName(team);
  const subject = `PFPI Week ${week} picks are open`;
  const text = `Hi, ${teamName}\n\nYour Week ${week} picks are ready. You don't have to do them all at once, pick a few now and come back for the rest before each game's deadline.\n\nUse this link any time this week, you can save and come back before each game's deadline:\n\n${link}\n\nJust remember: once you click Submit, any games you've picked in that submission are locked in for good. You can still come back and submit picks for the games you haven't gotten to yet, right up until each one's own deadline, but a submitted pick can't be changed afterward.\n\n${deadlineSummary}\n\nGood luck.`;
  return sendPfpiEmail(toEmail, subject, text, env, undefined, "commissioner");
}

// ============================================================
// GET /my-picks — read endpoint for the picks frontend
// (not in the original framework file; needed so picks.html has something
// to render against)
// ============================================================

async function handleGetPicks(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return jsonResponse({ error: "Missing token." }, 400, request);

  const tokenData = await verifyToken(token, env);
  if (!tokenData) return jsonResponse({ error: "Invalid or expired link." }, 401, request);

  const { team, week, correctionGameId } = tokenData;
  const schedule = await getWeekSchedule(week, env);
  const saved = await getSavedPicks(team, week, env) || {};
  // A correction token unlocks its one named game unconditionally (see
  // below), so its lock set is never consulted -- skip the KV read.
  const lockedIds = correctionGameId ? new Set() : await getLockedGameIds(team, week, env);
  // Admin-only team/week deadline-unlock bypass (handleUnlockWeekPicks) --
  // see isDeadlineUnlocked's own comment. Never consulted for a correction
  // token, same reasoning as lockedIds above.
  const deadlineUnlocked = correctionGameId ? false : await isDeadlineUnlocked(team, week, env);

  // A correction token (see handleSendCorrectionEmail) shows ONLY the one
  // game it names -- not the rest of that week's slate, locked or
  // otherwise. Changed 2026-08-27 per Yeti: seeing the whole week's games
  // (even locked) both risked cheating (a peek at what everyone else
  // picked/how the week is shaping up past deadline) and read as
  // confusing next to the original weekly link. A normal weekly token is
  // completely unaffected -- correctionGameId is simply absent from its
  // payload, so `visibleSchedule` below is the full schedule as before.
  const visibleSchedule = correctionGameId ? schedule.filter(g => g.id === correctionGameId) : schedule;

  const games = visibleSchedule.map(g => {
    // `submissionLocked` (Part 2a, 2026-09-05) is the new permanent,
    // submit-triggered lock -- distinct from the pre-existing deadline lock
    // below, so picks.html can tell a visitor WHY a game is locked ("you
    // already submitted this" vs. "the deadline passed") instead of one
    // generic label for both.
    const submissionLocked = g.id !== correctionGameId && lockedIds.has(g.id);
    const deadlineLocked = g.id === correctionGameId || deadlineUnlocked ? false : isGameLocked(g.deadline);
    return {
      id: g.id,
      home: g.home,
      away: g.away,
      kickoffISO: g.kickoffISO,
      deadline: g.deadline,
      locked: submissionLocked || deadlineLocked,
      submissionLocked,
      pick: saved[g.id] || null,
    };
  });

  // `isGracelin` (2026-09-08, per Yeti): lets picks.html show the same
  // "these picks are for Gracelin's Giraffes" acknowledgment gate
  // training-picks.html already has for her sample-picks flow, now on
  // the real, live picks page too -- this was a real gap, never carried
  // over when the real flow was built. Computed the exact same way
  // TRAINING_ROUTES' own `isGracelin` flag is (team === "Giraffes"),
  // server-side, so the frontend never needs to hardcode a team name to
  // detect this -- `false` for all 7 other real teams and any correction
  // token, no other team's flow is affected.
  return jsonResponse({ team, week, games, isCorrection: !!correctionGameId, isGracelin: team === "Giraffes" }, 200, request);
}

// ============================================================
// PICKS SUBMISSION
// ============================================================

// Per Yeti (2026-08-25): individual pick changes save silently now -- no
// email per click. Notification only fires from handleConfirmPicks() below,
// once, when the visitor explicitly clicks Submit. This function's job is
// purely save + lock enforcement, unchanged from before.
async function handleSubmitPicks(request, env) {
  const { token, picks } = await request.json();

  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: "Invalid or expired link." }, 401, request);
  }

  const { team, week, correctionGameId } = tokenData;
  const schedule = await getWeekSchedule(week, env);
  const existing = await getSavedPicks(team, week, env) || {};
  const lockedIds = correctionGameId ? new Set() : await getLockedGameIds(team, week, env);
  const deadlineUnlocked = correctionGameId ? false : await isDeadlineUnlocked(team, week, env);

  const rejected = [];
  for (const [gameId, pick] of Object.entries(picks || {})) {
    const game = schedule.find(g => g.id === gameId);
    if (!game) continue;
    // A correction token may only ever touch the one game it was issued
    // for -- never any other game in that week's schedule, whether locked
    // or still open (per Yeti, 2026-08-27: without this, a correction
    // token could be used as a general submission link for the rest of
    // that week's still-open games, not just the one it was meant to fix).
    // A normal weekly token (correctionGameId absent) is rejected on EITHER
    // the pre-existing deadline lock OR the new permanent submission lock
    // (Part 2a, 2026-09-05) -- a submitted pick is final immediately, not
    // just once its deadline passes.
    if (correctionGameId) {
      if (gameId !== correctionGameId) { rejected.push(gameId); continue; }
    } else if ((!deadlineUnlocked && isGameLocked(game.deadline)) || lockedIds.has(gameId)) {
      rejected.push(gameId);
      continue;
    }
    // pick === null means "deselect" (per Yeti, 2026-08-26) -- remove the
    // saved pick entirely rather than storing a null value, so this game
    // goes back to genuinely unpicked (matches the missing-picks tracker's
    // own "no pick" check, which just tests for a falsy value).
    if (pick === null) delete existing[gameId];
    else existing[gameId] = pick;
  }

  await savePicks(team, week, existing, env);

  return jsonResponse({
    saved: true,
    rejectedLockedGames: rejected,
  }, 200, request);
}

// ============================================================
// CONFIRM PICKS — the one-email-per-submit flow (picks.html's Submit button)
// ============================================================
// Per Yeti (2026-08-25): a single consolidated email per Submit click,
// covering the visitor's full current picks (not just what changed), with
// an "(Updated)" tag only on picks that differ from what was already
// notified in a PRIOR submission -- brand-new picks (never notified
// before) show plainly, matching "New picks should just show what the
// pick was." Tracks the last-notified snapshot in its own KV key so
// resubmitting after further edits only flags what's genuinely different
// this time, not the whole history.
// Real per-team emails for the 8 real roster teams aren't set up yet
// (Greg hasn't provided real family addresses) -- ADMIN_EMAIL is the same
// placeholder used everywhere else in this file until those exist. The two
// sandboxed FAMILY_MEMBERS test teams already have a real stored email, so
// those resolve correctly today.
function getPickerEmail(team) {
  const member = FAMILY_MEMBERS.find(m => m.team === team);
  return member ? member.email : ADMIN_EMAIL;
}

async function handleConfirmPicks(request, env) {
  const { token } = await request.json();

  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: "Invalid or expired link." }, 401, request);
  }

  const { team, week } = tokenData;
  const schedule = await getWeekSchedule(week, env);
  const current = await getSavedPicks(team, week, env) || {};

  if (Object.keys(current).length === 0) {
    return jsonResponse({ error: "No picks to submit yet." }, 400, request);
  }

  const notifiedKey = `notified-picks:${week}:${team}`;
  const lastNotifiedRaw = await env.PFPI_KV.get(notifiedKey);
  const lastNotified = lastNotifiedRaw ? JSON.parse(lastNotifiedRaw) : {};

  const lines = [];
  for (const [gameId, pick] of Object.entries(current)) {
    const game = schedule.find(g => g.id === gameId);
    const matchup = game ? `${game.away} @ ${game.home}` : gameId;
    const wasNotifiedBefore = Object.prototype.hasOwnProperty.call(lastNotified, gameId);
    const isUpdated = wasNotifiedBefore && lastNotified[gameId] !== pick;
    lines.push(`${matchup}: ${pick}${isUpdated ? " (Updated)" : ""}`);
  }

  // Tally line above the actual picks, per Yeti (2026-08-26) -- how many
  // games are picked vs. still pending, at a glance before the per-game
  // detail. `schedule.length` is every game this week; `current` already
  // has deselected games removed (see handleSubmitPicks), so this can't
  // overcount a pick that was cleared after being notified once before.
  const totalGames = schedule.length;
  const pickedCount = Object.keys(current).length;
  const pendingCount = Math.max(0, totalGames - pickedCount);
  const tally = `Picked: ${pickedCount} of ${totalGames} games. Still pending: ${pendingCount}.`;

  const subject = `PFPI: ${fullTeamName(team)} submitted Week ${week} picks`;
  const text = `${fullTeamName(team)} submitted Week ${week} picks (${new Date().toISOString()}).\n\n${tally}\n\n${lines.join("\n")}\n\nThese picks are now permanently locked and can no longer be changed. Any game not listed above is still open and can be picked and submitted later, up until that game's own deadline.`;
  // CC's the picker themselves (per Yeti, 2026-08-26) so they have a copy
  // of exactly what they submitted. Real per-team emails now come from
  // FAMILY_MEMBERS (2026-09-08+, populated) via getPickerEmail() -- falls
  // back to ADMIN_EMAIL for any team it doesn't cover.
  const pickerEmail = getPickerEmail(team);
  // Collapsed from two separate sends to one (2026-09-08, per Yeti --
  // confirmed via code review first that the two copies were always
  // identical subject/text with no functional difference, only sender
  // branding, so nothing real is lost). To Greg (commissioner identity,
  // since this is fundamentally Greg-facing), Cc the picker. Yeti no
  // longer needs his own explicit "admin" copy here -- sendPfpiEmail's
  // own "Bcc Yeti on every real send" behavior (2026-09-07) already puts
  // him on every send where he isn't already the direct To/Cc, which is
  // exactly this case, so he still gets it without a second email.
  const sent = await sendPfpiEmail(GREG_EMAIL, subject, text, env, pickerEmail, "commissioner");

  if (!sent) {
    return jsonResponse({ error: "Could not send confirmation email. Check Worker logs." }, 502, request);
  }

  await env.PFPI_KV.put(notifiedKey, JSON.stringify(current));

  // Permanently lock every game that currently has a pick (Part 2a,
  // 2026-09-05, per Yeti) -- ONLY the games actually picked as of this
  // Submit click, not the whole week's schedule; anything left blank stays
  // open for a future visit/submission. Deliberately placed after the
  // `sent` check above (not before) -- only a submission that actually
  // completed end-to-end should ever produce an irreversible lock; a failed
  // send returns the 502 above and leaves every pick exactly as editable as
  // before this request.
  const lockedGameIds = Object.keys(current);
  await lockGameIds(team, week, lockedGameIds, env);

  return jsonResponse({ submitted: true, lockedGameIds }, 200, request);
}

// ============================================================
// PART 1: TRAINING/SAMPLE PICKS PAGE (2026-09-05, per Yeti)
// ============================================================
// Genuinely separate from the real picks flow above -- separate frontend
// (training-picks.html, not picks.html), separate endpoints (this section),
// separate KV key prefix (`training-picks:{token}`) that the real scoring
// engine (worker.js's computeStandings) and the real public JSON
// (buildWeekPublicJSON) never read from -- both of those only ever read
// `picks:{week}:{team}` for team in TEAMS, never anything under
// `training-picks:`. This section reads the REAL Week 1 schedule (read-only
// -- getWeekSchedule below is the same function the real flow uses; safe,
// since the risk here is only ever on the WRITE side) but never reads or
// writes `picks:1:{team}` or anything the real scoring/public pipeline
// touches.  No deadline enforcement anywhere in this section -- training
// picks are freely repeatable, on purpose.
//
// Tokens here are fixed, hand-assigned per real family member (routing-only
// -- they determine which real address gets the confirmation email, nothing
// more; nothing here is ever scored or tied to a real identity for scoring
// purposes) rather than the real flow's signed/expiring HMAC tokens, since
// there's no security property to protect: worst case someone else finds a
// training link and submits fake sample picks, which has zero real
// consequence by design.
//
// Real email addresses below are for THIS TRAINING PAGE ONLY -- explicitly
// NOT added to shared.js's FAMILY_MEMBERS or any real-Week-1-facing
// recipient list (that stays empty; see shared.js's own comment on why).
const TRAINING_WEEK = 1;
const TRAINING_ROUTES = {
  "training-critters":    { team: "Critters",    emails: ["ccote215@gmail.com"] },
  "training-ferraris":    { team: "Ferraris",    emails: ["christineiferrara@gmail.com"] },
  "training-roughriders": { team: "Roughriders", emails: ["cote7714@gmail.com"] },
  "training-maniacs":     { team: "Maniacs",     emails: ["lawyermom59@aol.com"] },
  // Gracelin is a young child; both parents get her training confirmations
  // on her behalf -- Chris Cote and Christine "Christie" Ferrara (the same
  // real people/addresses as Chris' Critters and Christie's Ferraris
  // above, not new addresses; they each also have their own team). The
  // frontend (training-picks.html) also requires an explicit
  // acknowledgment click before her picks form becomes usable -- see that
  // file. `isGracelin` drives both that page-side gate and the extra
  // explicit "for Gracelin's Giraffes" framing in the email below.
  //
  // CORRECTED 2026-09-07, per Yeti: the original pairing here
  // (cote7714@gmail.com, i.e. Uncle Dick's Roughriders address, +
  // christineiferrara@gmail.com) was wrong -- Yeti fed the wrong address
  // for one of Gracelin's parents. Real pairing is ccote215@gmail.com
  // (Chris) + christineiferrara@gmail.com (Christie); Dick's address never
  // belonged here.
  "training-giraffes":    { team: "Giraffes", emails: ["ccote215@gmail.com", "christineiferrara@gmail.com"], isGracelin: true },
  "training-lobos":       { team: "Lobos",       emails: ["upsetbird@aol.com"] },
  "training-chickens":    { team: "Chickens",    emails: ["mcote0363@gmail.com"] },
  "training-llamas":      { team: "Llamas",      emails: ["tati.capote92@gmail.com"] },
};

// ============================================================
// LEAGUE ROSTER -- real addresses for general league-wide email (2026-09-07,
// per Yeti: "a way for us to send a message to the whole league").
// ============================================================
// Deliberately a SEPARATE table from TRAINING_ROUTES above, even though it
// reuses the exact same real addresses -- TRAINING_ROUTES is explicitly
// scoped to training/sample picks only (per the original Part 1 hard rule:
// "do not add these to the real FAMILY_MEMBERS list or anything that feeds
// live Week 1 picks"). This table exists for a different, new purpose (a
// general broadcast tool), kept separate so the two concepts can never be
// silently conflated even though today they hold identical real data.
// Confirmed directly with Yeti before building this: reuse the real
// addresses already on file, not FAMILY_MEMBERS (still `[]`) and not a
// new/guessed list -- see BUILD_LOG.md.
const LEAGUE_ROSTER = {
  Critters:    ["ccote215@gmail.com"],
  Ferraris:    ["christineiferrara@gmail.com"],
  Roughriders: ["cote7714@gmail.com"],
  Maniacs:     ["lawyermom59@aol.com"],
  Giraffes:    ["ccote215@gmail.com", "christineiferrara@gmail.com"],
  Lobos:       ["upsetbird@aol.com"],
  Chickens:    ["mcote0363@gmail.com"],
  Llamas:      ["tati.capote92@gmail.com"],
};

// admin.html (both its own Admin Portal AND its Commissioner Portal mirror
// section) and brief.html all POST here -- identity in the body decides
// "admin" (admin@mail.pfpi.me) vs. "commissioner" (commissioner@mail.pfpi.me).
// One email per real team (never one email exposing every recipient to
// every other recipient), each through the same sendPfpiEmail pipeline as
// everything else -- same live-email gate (nothing reaches a real address
// until Yeti flips emails-live-for-everyone on), same reply-to footer, same
// automatic bcc to Yeti.
async function handleSendLeagueEmail(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { identity, subject, message } = await request.json();
  if (identity !== "admin" && identity !== "commissioner") {
    return jsonResponse({ error: "Invalid identity." }, 400, request);
  }
  // Greg's own session can only ever send as "commissioner" -- brief.html
  // has no UI offering "admin" at all, but this blocks it server-side too,
  // rather than trusting the frontend alone to never send that value.
  if (identity === "admin" && !isAdmin) {
    return jsonResponse({ error: "Only an admin session can send as admin." }, 403, request);
  }

  const trimmedSubject = (subject || "").trim();
  const trimmedMessage = (message || "").trim();
  if (!trimmedSubject || !trimmedMessage) {
    return jsonResponse({ error: "Subject and message are required." }, 400, request);
  }

  let sentCount = 0;
  let failedCount = 0;
  for (const emails of Object.values(LEAGUE_ROSTER)) {
    for (const to of emails) {
      const ok = await sendPfpiEmail(to, trimmedSubject, trimmedMessage, env, undefined, identity);
      if (ok) sentCount++; else failedCount++;
    }
  }

  return jsonResponse({ sent: true, sentCount, failedCount }, 200, request);
}

async function getTrainingPicks(token, env) {
  const raw = await env.PFPI_KV.get(`training-picks:${token}`);
  return raw ? JSON.parse(raw) : {};
}

async function handleTrainingGetPicks(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const route = token && TRAINING_ROUTES[token];
  if (!route) return jsonResponse({ error: "Invalid training link." }, 401, request);

  const schedule = await getWeekSchedule(TRAINING_WEEK, env);
  const saved = await getTrainingPicks(token, env);

  const games = schedule.map(g => ({
    id: g.id, home: g.home, away: g.away, kickoffISO: g.kickoffISO,
    pick: saved[g.id] || null,
  }));

  return jsonResponse({ team: route.team, isGracelin: !!route.isGracelin, games }, 200, request);
}

// One combined save+confirm action per Submit click, unlike the real flow's
// separate silent-save/Submit split -- there is no locking or deadline
// concept here to protect, so there's nothing that needs to happen ONLY
// once per week. Every visit is freely repeatable, on purpose.
async function handleTrainingSubmitPicks(request, env) {
  const { token, picks } = await request.json();
  const route = token && TRAINING_ROUTES[token];
  if (!route) return jsonResponse({ error: "Invalid training link." }, 401, request);

  const schedule = await getWeekSchedule(TRAINING_WEEK, env);
  const existing = await getTrainingPicks(token, env);

  for (const [gameId, pick] of Object.entries(picks || {})) {
    const game = schedule.find(g => g.id === gameId);
    if (!game) continue;
    if (pick === null) delete existing[gameId];
    else existing[gameId] = pick;
  }

  await env.PFPI_KV.put(`training-picks:${token}`, JSON.stringify(existing));

  const lines = Object.entries(existing).map(([gameId, pick]) => {
    const game = schedule.find(g => g.id === gameId);
    const matchup = game ? `${game.away} @ ${game.home}` : gameId;
    return `${matchup}: ${pick}`;
  });

  // Per Yeti (Part 1, 2026-09-05, reinforced 2026-09-07): every email for
  // Gracelin's token must explicitly and unambiguously say "Gracelin's
  // Giraffes" -- not just imply it via which link was used -- in both
  // subject and body. Strengthened further 2026-09-07: since her token now
  // shares BOTH recipient addresses with their own separate teams
  // (ccote215@gmail.com also gets Critters' own emails, christineiferrara@
  // gmail.com also gets Ferraris' own emails -- see TRAINING_ROUTES above),
  // the team name is front-loaded in the subject (not buried at the end,
  // where a mobile notification preview could truncate it) and the body's
  // opening line explicitly contrasts "not your own team" rather than just
  // naming Gracelin's team in isolation.
  const subject = route.isGracelin
    ? `[TRAINING] GRACELIN'S GIRAFFES -- sample picks submitted`
    : `[TRAINING] Sample picks submitted -- ${fullTeamName(route.team)}`;
  const gracelinLine = route.isGracelin
    ? `THESE PICKS ARE FOR GRACELIN'S GIRAFFES -- submitted on her behalf, not for your own team.\n\n`
    : "";
  const text = `${gracelinLine}This is a TRAINING/SAMPLE submission for ${fullTeamName(route.team)} -- it is not a real Week 1 pick and is not scored anywhere. Feel free to try it again as many times as you'd like before the real season starts.\n\n${lines.length > 0 ? lines.join("\n") : "(no picks made yet)"}`;

  // "commissioner" identity (2026-09-06) -- this previews the real,
  // family-facing picks-confirmation experience, same category as the real
  // one in handleConfirmPicks above. Also now subject to sendPfpiEmail's
  // own emails-live-for-everyone gate like every other real-address send in
  // this codebase -- per Yeti's explicit, unconditional hard rule tonight
  // ("do not send to any real family/Greg address until Yeti explicitly
  // turns this on," no training-specific carve-out given) -- so until the
  // flag is flipped on, these redirect to yeti@yetiblanc.com exactly like
  // every other real-family send, on top of (not instead of) the earlier,
  // separate Resend-domain-verification block on this exact path. Flagging
  // this explicitly since it's a real behavior change from the original
  // Part 1 spec's "sends real email to real family addresses" intent --
  // tonight's blanket rule takes precedence; see BUILD_LOG.md.
  let sent = true;
  for (const to of route.emails) {
    const ok = await sendPfpiEmail(to, subject, text, env, undefined, "commissioner");
    sent = sent && ok;
  }

  if (!sent) {
    return jsonResponse({ error: "Saved, but the confirmation email could not be sent. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ submitted: true }, 200, request);
}

// ============================================================
// ADMIN OVERRIDE
// ============================================================

async function handleAdminOverride(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week, gameId, newPick, adminName } = await request.json();

  const existing = await getSavedPicks(team, week, env) || {};
  const previousValue = existing[gameId] || null;
  existing[gameId] = newPick;
  await savePicks(team, week, existing, env);

  const logEntry = {
    timestamp: new Date().toISOString(),
    adminName,
    team, week, gameId,
    previousValue, newValue: newPick,
  };
  const logKey = `override-log:${week}:${Date.now()}`;
  await env.PFPI_KV.put(logKey, JSON.stringify(logEntry));

  return jsonResponse({ saved: true, logged: true }, 200, request);
}

// ============================================================
// DEADLINE OVERRIDE (picks.html, real-time admin-session-only tool)
// ============================================================
// Real scenario (2026-09-09, per Yeti): he opens a team's real picks link
// himself (e.g. via "Resend picks link") to help them, and finds a game
// already past its own deadline that still needs fixing/entering, right
// there on picks.html -- rather than having to build a separate
// correction link first (handleSendCorrectionEmail) for something he can
// see and fix in the moment. Deliberately a DIFFERENT endpoint from
// handleAdminOverride/`/admin/override-pick` above (which has no frontend
// caller yet and no reason/email requirement) rather than changing that
// one's contract -- this flow has two hard requirements neither
// handleAdminOverride nor any other existing tool enforces:
//   1. A real, non-empty reason is mandatory (picks.html's own UI also
//      enforces this client-side, but the server never trusts that alone).
//   2. It ALWAYS fires a real, named accountability email to Greg (Cc
//      Yeti) -- this is a real security-boundary action (bypassing a
//      lock a family member can't bypass themselves), not a quiet
//      backend fix, so a durable record of who/what/why goes out every
//      single time, unconditionally.
// Authorization is the exact same server-verified admin-session check
// every other /admin/* route uses (verifyAdminToken -> a real KV lookup
// against a session token minted only by a real /admin/login) -- picks.html
// itself only ever shows the override control after independently
// confirming a valid admin session via GET /verify-session?kind=admin
// (see that page's own comment), so a family member loading their own
// exact same link never even sees the control, let alone could satisfy
// this check without Yeti's real password.
// Reuses the exact same override-log:{week}:{timestamp} audit trail
// handleAdminOverride/handleClearWeekPicks already write to -- same
// pattern, `action` field distinguishes this from those.
async function handleDeadlineOverride(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week, gameId, newPick, adminName, reason } = await request.json();

  if (!TEAMS.includes(team)) {
    return jsonResponse({ error: "team must be one of the real roster teams." }, 400, request);
  }
  if (!reason || !reason.trim()) {
    return jsonResponse({ error: "A reason is required for a deadline override." }, 400, request);
  }
  if (!gameId || !newPick) {
    return jsonResponse({ error: "gameId and newPick are required." }, 400, request);
  }

  const schedule = await getWeekSchedule(week, env);
  const game = schedule.find(g => g.id === gameId);
  if (!game) {
    return jsonResponse({ error: `No game with id "${gameId}" found in week ${week}'s schedule.` }, 400, request);
  }
  if (game.home !== newPick && game.away !== newPick) {
    return jsonResponse({ error: "newPick must be one of this game's two real teams." }, 400, request);
  }

  const existing = await getSavedPicks(team, week, env) || {};
  const previousValue = existing[gameId] || null;
  existing[gameId] = newPick;
  await savePicks(team, week, existing, env);

  const who = (adminName && adminName.trim()) || "Yeti";
  const logEntry = {
    timestamp: new Date().toISOString(),
    action: "deadline-override",
    adminName: who,
    team, week, gameId,
    previousValue, newValue: newPick,
    reason,
  };
  await env.PFPI_KV.put(`override-log:${week}:${Date.now()}`, JSON.stringify(logEntry));

  const sent = await sendPfpiEmail(
    GREG_EMAIL,
    `PFPI deadline override — ${fullTeamName(team)}, Week ${week}, ${game.away} @ ${game.home}`,
    `${who} used the admin deadline-override tool on picks.html.\n\nTeam: ${fullTeamName(team)}\nWeek: ${week}\nGame: ${game.away} @ ${game.home}\nPick entered: ${newPick}\nPrevious saved value for this game: ${previousValue || "(none)"}\n\nReason given (verbatim):\n${reason}`,
    env, ADMIN_EMAIL, "commissioner"
  );

  return jsonResponse({ saved: true, logged: true, emailed: sent }, 200, request);
}

// ============================================================
// CLEAR ALL PICKS FOR A WEEK (admin.html "Clear all picks" tool)
// ============================================================
// Per Yeti (2026-08-26): a real destructive reset for a selected week's
// test data (his stated use case: resetting preseason picks before a
// clean multi-person test) -- but deliberately works on ANY week, not
// just preseason (confirmed intentional, not scope creep). Clears EVERY
// team's picks for that week -- the real 8-team roster AND the 2
// sandboxed FAMILY_MEMBERS test teams -- since Yeti's own testing uses the
// test teams too. Logged to the same override-log:{week}:{timestamp}
// audit trail admin pick overrides already use, so there's a record of
// when this ran and by whom even though it's Yeti's own tool.
async function handleClearWeekPicks(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { week, adminName } = await request.json();
  if (week === undefined || week === null || week === "") {
    return jsonResponse({ error: "week is required." }, 400, request);
  }

  // Root-cause fix (2026-09-09, per Yeti -- see BUILD_LOG.md's "orphaned-
  // lock sweep"): this used to clear ONLY `picks:{week}:{team}`, leaving
  // `locked-picks:{week}:{team}` (and, since last session, the
  // `deadline-unlock:{week}:{team}` bypass flag) fully intact -- so a team
  // that had already submitted/locked a game before this ran was left
  // stuck locked with nothing behind it, exactly what happened to Uncle
  // Dick's real Week 1 Roughriders data. "Clear all picks for a week" is
  // supposed to be a genuine clean slate, so it now clears all three keys
  // together for every team -- this failure mode can't recur through this
  // tool again.
  const allTeams = [...TEAMS, ...FAMILY_MEMBERS.map(m => m.team)];
  for (const team of allTeams) {
    await env.PFPI_KV.delete(`picks:${week}:${team}`);
    await env.PFPI_KV.delete(`locked-picks:${week}:${team}`);
    await env.PFPI_KV.delete(`deadline-unlock:${week}:${team}`);
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    adminName: adminName || "Yeti",
    week,
    action: "clear-week-picks",
    clearedTeams: allTeams,
  };
  await env.PFPI_KV.put(`override-log:${week}:${Date.now()}`, JSON.stringify(logEntry));

  return jsonResponse({ cleared: true, week, teamCount: allTeams.length }, 200, request);
}

// ============================================================
// UNLOCK ALL PICKS FOR ONE TEAM/WEEK (admin.html "Admin Portal" only)
// ============================================================
// Real scenario (2026-09-09, per Yeti): Uncle Dick's real picks link was
// showing every Week 1 game as locked, even though he believed he'd only
// ever used the training link -- confirmed via a read-only KV check before
// building this that his real `picks:1:Roughriders` (pick VALUES) doesn't
// exist at all, while `locked-picks:1:Roughriders` (submission-lock STATE)
// already listed all 16 of that week's games as locked -- a genuinely
// orphaned lock with nothing behind it (every other real team's two keys
// were consistent with each other; his weren't). This tool exists to reset
// exactly that kind of stuck lock state for a team/week, WITHOUT ever
// touching saved pick values.
//
// Two independent lock signals exist for a game (see isDeadlineUnlocked's
// comment above for the second one): the permanent submission lock
// (locked-picks:{week}:{team}, this function clears it outright) and the
// real per-game deadline (isGameLocked(game.deadline), computed live from
// the schedule every request, never stored -- can't be "cleared" the same
// way, so this sets a persistent per-team/week bypass flag instead,
// deadline-unlock:{week}:{team}, that handleGetPicks/handleSubmitPicks
// both now check). Together these make every game for this team/week
// freely editable again, regardless of real deadlines already passed,
// while `picks:{week}:{team}` (the actual saved values) is never read for
// writing here at all -- only read once, for the "before" snapshot logged
// below, exactly so there's a real record that nothing was touched.
//
// No email -- explicitly not wanted for this action (per Yeti, 2026-09-09:
// "Greg doesn't need an email about me unlocking someone's picks (I may
// build that in later)"). Logged to the same override-log:{week}:{timestamp}
// audit trail every other admin override/reset action already uses.
async function handleUnlockWeekPicks(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week, adminName } = await request.json();
  if (!TEAMS.includes(team)) {
    return jsonResponse({ error: "team must be one of the real roster teams." }, 400, request);
  }
  if (week === undefined || week === null || week === "") {
    return jsonResponse({ error: "week is required." }, 400, request);
  }

  // "Before" snapshot, logged below -- proves (rather than assumes) that
  // pick values are untouched by this action.
  const previousSavedPicks = await getSavedPicks(team, week, env) || {};
  const previousLockedGameIds = [...(await getLockedGameIds(team, week, env))];

  await env.PFPI_KV.delete(`locked-picks:${week}:${team}`);
  await env.PFPI_KV.put(`deadline-unlock:${week}:${team}`, "true");

  const who = (adminName && adminName.trim()) || "Yeti";
  const logEntry = {
    timestamp: new Date().toISOString(),
    action: "unlock-week-picks",
    adminName: who,
    team, week,
    previousSavedPicks,
    previousLockedGameIds,
  };
  await env.PFPI_KV.put(`override-log:${week}:${Date.now()}`, JSON.stringify(logEntry));

  return jsonResponse({
    unlocked: true, team, week,
    previousSavedPicks, previousLockedGameIds,
  }, 200, request);
}

// ============================================================
// ADMIN/GREG: FULL, UNGATED WEEK PICKS (Part 2b, 2026-09-05 per Yeti)
// ============================================================
// The public data/week-N.json (worker.js's buildWeekPublicJSON) now hides a
// game's `picks` entirely until that game's own reveal condition is met
// (every real roster team has locked their pick for it, or its deadline has
// passed -- see BUILD_LOG.md). Admin/commissioner-facing tools are
// explicitly exempt from that rule and must keep showing real, live picks
// at all times -- the Missing Picks tracker (admin.html + brief.html) reads
// this endpoint instead of the public JSON for exactly that reason. Same
// admin-or-Greg session gate as handleGetBriefHistory/handleSendReminderEmail
// (both admin.html and brief.html host a Missing Picks tab).
async function handleAdminWeekPicks(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const url = new URL(request.url);
  const rawWeek = url.searchParams.get("week");
  // "preseason-3" stays a valid value here too, matching every other
  // Missing-Picks-adjacent endpoint (handleSendReminderEmail, etc.).
  const week = rawWeek === "preseason-3" ? rawWeek : parseInt(rawWeek, 10);
  if (week !== "preseason-3" && !Number.isInteger(week)) {
    return jsonResponse({ error: "Invalid week." }, 400, request);
  }

  const schedule = await getWeekSchedule(week, env);
  const picksByTeam = {};
  for (const team of TEAMS) {
    picksByTeam[team] = (await getSavedPicks(team, week, env)) || {};
  }

  const games = schedule.map(g => {
    const picks = {};
    for (const team of TEAMS) {
      if (picksByTeam[team][g.id]) picks[team] = picksByTeam[team][g.id];
    }
    return { id: g.id, home: g.home, away: g.away, kickoffISO: g.kickoffISO, deadline: g.deadline, picks };
  });

  return jsonResponse({ week, games }, 200, request);
}

// ============================================================
// RESEND PICKS LINK (admin.html "Resend picks link")
// ============================================================
// Replaces the old ad-hoc "[TEST] Admin Picks Link" tool entirely
// (2026-09-08, per Yeti) now that real family members are actually
// receiving real weekly picks emails. That old tool was a stand-in built
// before real recipient emails existed, and always sent to ADMIN_EMAIL by
// design -- this is a real tool for the real use case it names: "resend
// someone's link if they lose the original email."
//
// Team is restricted to FAMILY_MEMBERS (the real 8 roster teams) -- no
// free-typed recipient, no arbitrary team string -- so this can never
// reach anyone but the real person already on file for that team, exactly
// like handleWeeklyTrigger's own real send below. Week is never taken
// from the request either: this always resends for the current real week
// (getCurrentWeek(), the same shared value handleWeeklyTrigger uses), per
// Yeti -- "resend their current, real, already-issued weekly link", not a
// pick-a-week tool.
//
// Mints a FRESH token via generateWeeklyToken() rather than trying to
// recover the exact original signed token (there's no reverse index from
// team/week back to the token string handleWeeklyTrigger originally
// issued -- verifyToken only maps token -> {team, week}). This is
// functionally identical to the original, not just "close enough": every
// downstream read (handleGetPicks/handleSubmitPicks) derives deadlines,
// already-saved picks, and lock state from `team`+`week` alone, never
// from the token string itself, so a new token for the same team/week
// behaves 100% the same as the one already sent -- same deadlines, same
// pre-filled picks, same per-game lock rules. Per Yeti: "It can be the
// original for all I care" -- this satisfies that without needing a
// token-lookup index that doesn't exist today. The old token, if the
// recipient still has it, keeps working too (nothing is invalidated).
//
// Reuses sendPicksEmail() UNCHANGED -- the real Weekly Picks Are Open
// subject/body/sender identity ("commissioner"), not a distinct "resend"
// template -- so this reads exactly like the original email they already
// got, per Yeti's explicit ask.
async function handleResendPicksLink(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team } = await request.json();
  const member = FAMILY_MEMBERS.find(m => m.team === team);
  if (!member) {
    return jsonResponse({ error: `"${team}" is not a real roster team.` }, 400, request);
  }

  const week = await getCurrentWeek(env);
  const schedule = await getWeekSchedule(week, env);
  const deadlineSummary = formatWeekDeadlines(schedule);
  const token = await generateWeeklyToken(team, week, env);
  const link = `https://pfpi.me/picks.html?token=${token}`;

  const sent = await sendPicksEmail(member.email, team, week, link, deadlineSummary, env);
  if (!sent) {
    return jsonResponse({ error: "Email could not be sent. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true, week, email: member.email, link }, 200, request);
}

// Per Yeti (2026-08-25): "a way for me as the admin to send a correction
// form... much better than me making the changes." Still always sends to
// ADMIN_EMAIL (unlike handleResendPicksLink above, which does send to the
// real team address) -- real family emails weren't in the system yet when
// this was built, and it hasn't been revisited since. He forwards it
// himself once ready; this endpoint never accepts or looks at a recipient
// in the request.
async function handleSendCorrectionEmail(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week, gameId } = await request.json();
  if (!team || !week || !gameId) {
    return jsonResponse({ error: "team, week, and gameId are required." }, 400, request);
  }

  const schedule = await getWeekSchedule(week, env);
  const game = schedule.find(g => g.id === gameId);
  if (!game) {
    return jsonResponse({ error: `No game with id "${gameId}" found in week ${week}'s schedule.` }, 400, request);
  }

  // Per Yeti (2026-08-27): "it's too late if you missed the window and the
  // game has started" -- a correction exists to fix a pick before kickoff,
  // even though its own per-game deadline already passed; once the game
  // has actually started there's nothing left to correct.
  if (Date.now() >= new Date(game.kickoffISO).getTime()) {
    return jsonResponse({ error: `${game.away} @ ${game.home} has already kicked off -- a correction link can no longer unlock this pick.` }, 400, request);
  }

  const correctionToken = await generateCorrectionToken(team, week, gameId, game.kickoffISO, env);
  const link = `https://pfpi.me/picks.html?token=${correctionToken}`;

  const sent = await sendPfpiEmail(
    ADMIN_EMAIL,
    `[CORRECTION] PFPI Week ${week} — ${fullTeamName(team)} — ${game.away} @ ${game.home}`,
    `One-time correction link for "${fullTeamName(team)}", Week ${week}, ${game.away} @ ${game.home}.\n\nThis link shows and unlocks ONLY that one game -- no other games from this week are shown or accessible on it, even if still open. It expires automatically at kickoff (${game.kickoffISO}), not on a flat timer, so it's impossible to use once the game has actually started. Forward it to whoever needs to fix their pick.\n\n${link}`,
    env, undefined, "admin"
  );

  if (!sent) {
    return jsonResponse({ error: "Email could not be sent. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true, link }, 200, request);
}

// ============================================================
// CONTACT SUPPORT (picks.html's "Contact Yeti" popup)
// ============================================================
// Public, unauthenticated -- picks.html visitors never have a session.
// Per-IP rate limit (same shape as the login brute-force guard above)
// since this is a public write endpoint with no login gate at all.
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_SECONDS = 60 * 60;
const CONTACT_MESSAGE_MAX_LENGTH = 5000;

async function handleContactSupport(request, env) {
  const ip = getClientIp(request);
  const rateKey = `contact-rate:${ip}`;
  const count = parseInt((await env.PFPI_KV.get(rateKey)) || "0", 10);
  if (count >= CONTACT_RATE_LIMIT) {
    return jsonResponse({ error: "Too many requests. Try again later." }, 429, request);
  }

  const { email, message, page, team, week } = await request.json();
  if (!email || !message) {
    return jsonResponse({ error: "Email and message are required." }, 400, request);
  }
  if (message.length > CONTACT_MESSAGE_MAX_LENGTH) {
    return jsonResponse({ error: "Message is too long." }, 400, request);
  }
  // Light shape check, not full RFC validation -- just enough to catch an
  // obviously blank/garbage field so Yeti has somewhere real to reply.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400, request);
  }

  const context = [
    team ? `Team: ${fullTeamName(team)}` : null,
    week !== undefined && week !== null ? `Week: ${week}` : null,
    page ? `Page: ${page}` : null,
  ].filter(Boolean).join("\n");

  const sent = await sendPfpiEmail(
    ADMIN_EMAIL,
    `PFPI support request from ${email}`,
    `From: ${email}\n${context ? context + "\n" : ""}\nMessage:\n${message}`,
    env, undefined, "admin"
  );

  if (!sent) {
    return jsonResponse({ error: "Could not send. Check Worker logs." }, 502, request);
  }

  await env.PFPI_KV.put(rateKey, String(count + 1), { expirationTtl: CONTACT_RATE_WINDOW_SECONDS });
  return jsonResponse({ sent: true }, 200, request);
}

// ============================================================
// MISSING-PICKS REMINDER (brief.html's "Send reminder" button)
// ============================================================
// CORRECTED 2026-09-08, per Yeti: now that FAMILY_MEMBERS is populated,
// this reaches the real missing team's own address via getPickerEmail()
// -- the same helper handleConfirmPicks already uses -- instead of
// always standing in with Yeti's own address. Falls back to ADMIN_EMAIL
// for any team FAMILY_MEMBERS doesn't cover. The list of that team's
// still-missing games is pulled from the same real schedule + saved-
// picks data the tracker itself reads, not a second/guessed source.
async function handleSendReminderEmail(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week } = await request.json();
  // "preseason-3" is a valid week value too (per Yeti, 2026-08-26 -- the
  // Missing Picks tracker now supports testing against the preseason
  // sandbox), not just a real numbered week -- only reject it if it's
  // neither a real week integer nor that literal string.
  const weekNum = week === "preseason-3" ? week : parseInt(week, 10);
  if (!team || (weekNum !== "preseason-3" && !Number.isInteger(weekNum))) {
    return jsonResponse({ error: "team and week are required." }, 400, request);
  }
  const weekLabel = weekNum === "preseason-3" ? "Preseason" : `Week ${weekNum}`;

  const schedule = await getWeekSchedule(weekNum, env);
  if (!schedule || schedule.length === 0) {
    return jsonResponse({ error: "No schedule found for that week." }, 400, request);
  }

  const saved = (await getSavedPicks(team, weekNum, env)) || {};
  const missing = schedule.filter(g => !saved[g.id]);
  if (missing.length === 0) {
    return jsonResponse({ error: `${team} has already picked every game this week.` }, 400, request);
  }

  const lines = missing.map(g => `${g.away} @ ${g.home}`);
  // "commissioner" identity (2026-09-06) -- this reminder is nominally to a
  // real family member on Greg's behalf, same category as the real
  // picks-open/picks-confirmation emails, and now genuinely reaches that
  // real recipient via getPickerEmail() (2026-09-08) rather than standing
  // in with Yeti's own address -- the stale "(Test send...)" disclaimer
  // that used to be true is gone accordingly.
  const sent = await sendPfpiEmail(
    getPickerEmail(team),
    `PFPI reminder: ${fullTeamName(team)}, ${weekLabel} picks still needed`,
    `${fullTeamName(team)} is still missing ${weekLabel} picks for:\n\n${lines.join("\n")}`,
    env, undefined, "commissioner"
  );

  if (!sent) {
    return jsonResponse({ error: "Could not send reminder email. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true, missingCount: missing.length }, 200, request);
}

// ============================================================
// PER-GAME REMINDER (admin.html "Missing Picks by Game" test view,
// 2026-09-09, per Yeti)
// ============================================================
// Same real mechanism as handleSendReminderEmail above -- same auth (admin
// OR Greg session), same sendPfpiEmail/getPickerEmail/"commissioner"
// pattern, same real per-team recipient -- just re-scoped to ONE specific
// game instead of a team's whole remaining week. Sends one INDIVIDUAL
// email per missing team (not one combined email to multiple real
// addresses at once) -- each family only ever sees their own reminder,
// same privacy property the per-team version already has; "multiple real
// recipients" for one game click just means multiple separate real sends,
// not one email exposing every missing family's address to each other.
async function handleSendGameReminderEmail(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { week, gameId } = await request.json();
  const weekNum = week === "preseason-3" ? week : parseInt(week, 10);
  if (!gameId || (weekNum !== "preseason-3" && !Number.isInteger(weekNum))) {
    return jsonResponse({ error: "week and gameId are required." }, 400, request);
  }
  const weekLabel = weekNum === "preseason-3" ? "Preseason" : `Week ${weekNum}`;

  const schedule = await getWeekSchedule(weekNum, env);
  const game = schedule.find(g => g.id === gameId);
  if (!game) {
    return jsonResponse({ error: `No game with id "${gameId}" found in ${weekLabel}'s schedule.` }, 400, request);
  }

  // Real 8-team roster only, matching the Missing Picks by Game view's own
  // scope -- not FAMILY_MEMBERS' test-team spread other admin tools use.
  const missingTeams = [];
  for (const team of TEAMS) {
    const saved = (await getSavedPicks(team, weekNum, env)) || {};
    if (!saved[gameId]) missingTeams.push(team);
  }
  if (missingTeams.length === 0) {
    return jsonResponse({ error: `Every real team has already picked ${game.away} @ ${game.home}.` }, 400, request);
  }

  const matchup = `${game.away} @ ${game.home}`;
  const results = [];
  for (const team of missingTeams) {
    const sent = await sendPfpiEmail(
      getPickerEmail(team),
      `PFPI reminder: ${fullTeamName(team)}, ${weekLabel} pick still needed for ${matchup}`,
      `${fullTeamName(team)} is still missing a ${weekLabel} pick for ${matchup}.`,
      env, undefined, "commissioner"
    );
    results.push({ team, sent });
  }

  const failedTeams = results.filter(r => !r.sent).map(r => r.team);
  if (failedTeams.length > 0) {
    return jsonResponse({
      error: `Reminder failed for: ${failedTeams.join(", ")}. Check Worker logs.`,
      sentTeams: results.filter(r => r.sent).map(r => r.team),
    }, 502, request);
  }
  return jsonResponse({ sent: true, sentTeams: missingTeams }, 200, request);
}

// ============================================================
// AUTH (admin + Greg's Brief — two independent credentials)
// ============================================================

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Two independent credentials share this same machinery: "admin" (Yeti,
// admin.html) and "greg" (Greg, brief.html). Each gets its own password
// hash, session namespace, and reset-token namespace, keyed by `kind` below
// — Greg's credential is never accepted where an admin token is required,
// and vice versa, since /admin/override-pick and the admin-only parts of
// /admin/publish-brief specifically check for an admin session.
const AUTH_CONFIG = {
  admin: {
    salt: "pfpi-admin",
    hashKvKey: "admin-password-hash-override",
    passwordHashEnvKey: "ADMIN_PASSWORD_HASH",
    sessionSecretEnvKey: "ADMIN_SESSION_SECRET",
    sessionKvPrefix: "admin-session",
    resetKvPrefix: "admin-reset",
    resetPage: "admin.html",
    resetEmail: ADMIN_EMAIL,
    senderIdentity: "admin",
    label: "admin",
    pageDescription: "the PFPI admin panel",
  },
  greg: {
    salt: "pfpi-greg",
    hashKvKey: "greg-password-hash-override",
    passwordHashEnvKey: "GREG_PASSWORD_HASH",
    sessionSecretEnvKey: "GREG_SESSION_SECRET",
    sessionKvPrefix: "greg-session",
    resetKvPrefix: "greg-reset",
    resetPage: "brief.html",
    resetEmail: GREG_EMAIL,
    senderIdentity: "commissioner",
    // Matches brief.html's own established page name/description exactly
    // ("PFPI Commissioner Portal") -- these feed real user-facing email
    // text (password reset, brute-force alert), so they'd drifted from the
    // naming rounds that already renamed the page itself. Was "Greg's
    // Brief" / "the PFPI Brief publisher" (pre-rename terminology).
    label: "Commissioner Portal",
    pageDescription: "the PFPI Commissioner Portal",
  },
};

// Brute-force protection: per-IP lockout after too many failed logins (of
// either kind), with a capped-frequency security alert email to Yeti.
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
const LOGIN_ALERT_COOLDOWN_SECONDS = 60 * 60;

// The live password hash normally comes from the <kind>'s *_PASSWORD_HASH
// secret. A completed password reset (see handleResetPassword) writes a KV
// override that takes precedence, since a Worker can update KV at runtime
// but can't update its own secrets.
async function getPasswordHash(kind, env) {
  const cfg = AUTH_CONFIG[kind];
  const override = await env.PFPI_KV.get(cfg.hashKvKey);
  return override || env[cfg.passwordHashEnvKey];
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function handleLogin(kind, request, env) {
  const cfg = AUTH_CONFIG[kind];
  const ip = getClientIp(request);
  const failKey = `${kind}-login-fail:${ip}`;
  const failCount = parseInt((await env.PFPI_KV.get(failKey)) || "0", 10);

  if (failCount >= LOGIN_FAIL_THRESHOLD) {
    return jsonResponse({ error: "Too many failed attempts. Try again later." }, 429, request);
  }

  const { password } = await request.json();
  const attemptedHash = await hashPassword(password, cfg.salt);
  const currentHash = await getPasswordHash(kind, env);

  if (attemptedHash !== currentHash) {
    const newFailCount = failCount + 1;
    await env.PFPI_KV.put(failKey, String(newFailCount), { expirationTtl: LOGIN_FAIL_WINDOW_SECONDS });

    if (newFailCount === LOGIN_FAIL_THRESHOLD) {
      await flagPossibleBruteForce(kind, ip, env);
    }

    return jsonResponse({ error: "Login failed." }, 401, request);
  }

  await env.PFPI_KV.delete(failKey);

  const sessionPayload = { role: kind, issued: Date.now() };
  const sessionToken = await signPayload(sessionPayload, env[cfg.sessionSecretEnvKey]);
  await env.PFPI_KV.put(`${cfg.sessionKvPrefix}:${sessionToken}`, "valid", { expirationTtl: 4 * 60 * 60 });

  return jsonResponse({ sessionToken }, 200, request);
}

async function flagPossibleBruteForce(kind, ip, env) {
  const alertKey = `${kind}-login-alert:${ip}`;
  const alreadyAlerted = await env.PFPI_KV.get(alertKey);
  if (alreadyAlerted) return;

  await env.PFPI_KV.put(alertKey, "sent", { expirationTtl: LOGIN_ALERT_COOLDOWN_SECONDS });
  await sendPfpiEmail(
    ADMIN_EMAIL,
    `PFPI ${AUTH_CONFIG[kind].label}: possible brute-force login attempt`,
    `${LOGIN_FAIL_THRESHOLD} failed ${AUTH_CONFIG[kind].label} login attempts from IP ${ip} within ${LOGIN_FAIL_WINDOW_SECONDS / 60} minutes.\n\nThat IP is now locked out of that login for ${LOGIN_FAIL_WINDOW_SECONDS / 60} minutes. You won't get another alert for this IP for ${LOGIN_ALERT_COOLDOWN_SECONDS / 60} minutes even if it keeps trying.\n\nIf this wasn't you, no action is needed — the lockout is already in effect. If you're locked out yourself, wait for the cooldown or use "Forgot password?" from another network.`,
    env, undefined, "admin"
  );
}

async function verifySessionToken(kind, token, env) {
  if (!token) return false;
  const session = await env.PFPI_KV.get(`${AUTH_CONFIG[kind].sessionKvPrefix}:${token}`);
  return session === "valid";
}

async function verifyAdminToken(token, env) {
  return verifySessionToken("admin", token, env);
}

// GET /verify-session?kind=admin|greg -- cheap (one KV get), no side
// effects. Lets admin.html/brief.html restore a session saved in
// localStorage across a page refresh (per Yeti, 2026-08-26) without
// guessing: they show a "checking..." state on load, call this, and only
// then decide whether to show the logged-in dashboard or the login gate --
// rather than either always forcing a fresh login (the bug being fixed) or
// blindly trusting a stored token that may have expired.
async function handleVerifySession(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "admin" && kind !== "greg") {
    return jsonResponse({ error: "Invalid kind." }, 400, request);
  }
  const token = request.headers.get("X-Session-Token");
  const valid = await verifySessionToken(kind, token, env);
  return jsonResponse({ valid }, 200, request);
}

// ============================================================
// PASSWORD RESET (admin and Greg both use this)
// ============================================================

async function handleForgotPassword(kind, request, env) {
  const cfg = AUTH_CONFIG[kind];
  const resetPayload = { role: `${kind}-reset`, issued: Date.now() };
  const resetToken = await signPayload(resetPayload, env[cfg.sessionSecretEnvKey]);
  await env.PFPI_KV.put(`${cfg.resetKvPrefix}:${resetToken}`, "valid", { expirationTtl: 30 * 60 });

  const link = `https://pfpi.me/${cfg.resetPage}?resetToken=${resetToken}`;
  const sent = await sendPfpiEmail(
    cfg.resetEmail,
    `PFPI ${cfg.label} password reset`,
    `A password reset was requested for ${cfg.pageDescription}.\n\nThis link is valid for 30 minutes and can only be used once:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    env, undefined, cfg.senderIdentity
  );

  if (!sent) {
    return jsonResponse({ error: "Reset link could not be emailed. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true }, 200, request);
}

async function handleResetPassword(kind, request, env) {
  const cfg = AUTH_CONFIG[kind];
  const { token, newPassword } = await request.json();

  const resetKey = `${cfg.resetKvPrefix}:${token}`;
  const valid = token && (await env.PFPI_KV.get(resetKey)) === "valid";
  if (!valid) {
    return jsonResponse({ error: "Invalid or expired reset link." }, 401, request);
  }

  if (!newPassword || newPassword.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400, request);
  }

  const newHash = await hashPassword(newPassword, cfg.salt);
  await env.PFPI_KV.put(cfg.hashKvKey, newHash);
  await env.PFPI_KV.delete(resetKey);

  return jsonResponse({ reset: true }, 200, request);
}

// ============================================================
// GREG'S BRIEF — publish + admin correction
// ============================================================

async function handlePublishBrief(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));

  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { week, text, adminName } = await request.json();
  // "preseason-3" is a valid week value too (per Yeti, 2026-08-28 -- the
  // Commissioner's Report should be testable against the preseason
  // sandbox the same way Missing Picks/Weekly Digest already are, since
  // it's meant as a full dress rehearsal, not just a real-week tool).
  // weekNum stays numeric-only for the NUM_WEEKS bounds check and for the
  // handful of places below (version history, override log) that
  // genuinely only make sense as a number; weekKey is whichever of the two
  // actually names this brief's storage/file location.
  const weekNum = week === "preseason-3" ? week : parseInt(week, 10);
  if (weekNum !== "preseason-3" && (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > NUM_WEEKS)) {
    return jsonResponse({ error: "Invalid week." }, 400, request);
  }
  const trimmedText = (text || "").trim();
  if (!trimmedText) {
    return jsonResponse({ error: "Brief text is required." }, 400, request);
  }

  const updatedAt = new Date().toISOString();
  const committed = await commitJSONToGitHub(
    `data/brief-week-${weekNum}.json`,
    { week: weekNum, text: trimmedText, updatedAt },
    `Publish ${weekNum === "preseason-3" ? "Preseason" : "Week " + weekNum} brief${isAdmin ? " [admin correction]" : ""} [automated]`,
    env
  );

  // Per-week version history (Yeti, 2026-08-25 big feedback round): each
  // save is its own version, scoped to that week only -- Week 6's history
  // never mixes with Week 7's. Kept in KV (not GitHub) since this is an
  // internal audit trail, not something the public site needs to serve;
  // `brief-version:{week}:{timestamp}` sorts chronologically by key already,
  // matching the existing override-log key convention below.
  const versionEntry = {
    text: trimmedText,
    updatedAt,
    source: isAdmin ? "admin" : "greg",
    adminName: isAdmin ? (adminName || "Yeti") : undefined,
  };
  await env.PFPI_KV.put(`brief-version:${weekNum}:${Date.now()}`, JSON.stringify(versionEntry));

  if (isAdmin) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      adminName: adminName || "Yeti",
      week: weekNum,
      action: "publish-brief-override",
      newText: trimmedText,
    };
    await env.PFPI_KV.put(`override-log:${weekNum}:${Date.now()}`, JSON.stringify(logEntry));
  }

  if (!committed) {
    return jsonResponse({
      published: false,
      error: "Saved, but not yet live — GitHub publishing isn't configured yet (GITHUB_PAT missing). Ask Yeti to set it.",
    }, 202, request);
  }

  // "Brief is live" confirmation email, per Yeti (2026-08-26) -- sent only
  // once the commit above is ACTUALLY visible on the real public site, not
  // merely committed to GitHub (a commit succeeding doesn't mean GitHub
  // Pages has finished rebuilding/deploying it yet -- see BUILD_LOG.md for
  // the investigation into why that gap is sometimes seconds and sometimes
  // 10-15 minutes). pfpi-scores-worker's existing every-minute cron picks
  // this KV flag up (checkPendingBriefConfirmations in worker.js) and polls
  // the real deployed URL until `updatedAt` matches, rather than guessing a
  // fixed delay. One flag per week -- a newer publish for the same week
  // simply overwrites the pending record for it.
  await env.PFPI_KV.put(`brief-pending-confirm:${weekNum}`, JSON.stringify({
    week: weekNum,
    expectedUpdatedAt: updatedAt,
    notifyEmail: GREG_EMAIL,
    createdAt: updatedAt,
  }));

  return jsonResponse({ published: true }, 200, request);
}

// GET /greg/brief-history?week=N -- current saved text (if any) plus that
// week's version list, newest first. Greg or admin session either one, same
// as publish itself.
async function handleGetBriefHistory(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const url = new URL(request.url);
  const rawWeek = url.searchParams.get("week");
  const weekNum = rawWeek === "preseason-3" ? rawWeek : parseInt(rawWeek, 10);
  if (weekNum !== "preseason-3" && (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > NUM_WEEKS)) {
    return jsonResponse({ error: "Invalid week." }, 400, request);
  }

  const prefix = `brief-version:${weekNum}:`;
  const list = await env.PFPI_KV.list({ prefix });
  const versions = [];
  for (const key of list.keys) {
    const raw = await env.PFPI_KV.get(key.name);
    if (raw) versions.push(JSON.parse(raw));
  }
  versions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return jsonResponse({
    current: versions[0] || null,
    versions,
  }, 200, request);
}

// GET /greg/brief-weeks -- every week that has at least one published
// version, for the Commissioner's Report "Past Weeks" archive (2026-08-31,
// per Yeti). Same auth as brief-history. Derives the week list straight
// from the brief-version:{week}:{timestamp} key names already written by
// handlePublishBrief() -- no separate index to keep in sync.
async function handleGetBriefWeeks(request, env) {
  const sessionToken = request.headers.get("X-Session-Token");
  const isGreg = await verifySessionToken("greg", sessionToken, env);
  const isAdmin = !isGreg && (await verifySessionToken("admin", sessionToken, env));
  if (!isGreg && !isAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const weeks = new Set();
  let cursor;
  do {
    const page = await env.PFPI_KV.list({ prefix: "brief-version:", cursor });
    for (const key of page.keys) {
      const rest = key.name.slice("brief-version:".length);
      const week = rest.slice(0, rest.lastIndexOf(":"));
      if (week) weeks.add(week);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ weeks: [...weeks] }, 200, request);
}

async function handleCurrentWeek(request, env) {
  const currentWeek = await getCurrentWeek(env);
  return jsonResponse({ currentWeek }, 200, request);
}

// ============================================================
// STORAGE HELPERS
// ============================================================

async function getSavedPicks(team, week, env) {
  const raw = await env.PFPI_KV.get(`picks:${week}:${team}`);
  return raw ? JSON.parse(raw) : null;
}

async function savePicks(team, week, picks, env) {
  await env.PFPI_KV.put(`picks:${week}:${team}`, JSON.stringify(picks));
}

// ============================================================
// PER-GAME PERMANENT SUBMISSION LOCKS (Part 2a, 2026-09-05 per Yeti)
// Separate from the existing per-game DEADLINE lock (isGameLocked, shared.js)
// -- this is a stronger, one-way lock that takes effect the moment a pick is
// included in a Submit (handleConfirmPicks), regardless of how much time is
// left before that game's own deadline. Stored as its own KV key (not baked
// into the `picks:{week}:{team}` value) so every existing reader of that key
// -- standings, buildWeekPublicJSON, admin overrides -- keeps working
// unchanged against a plain gameId->pick string map. Monotonic: a gameId is
// only ever added, never removed, through the normal picks flow (admin
// override tooling bypasses this entirely, by design -- see
// handleAdminOverride, which never checks this set).
async function getLockedGameIds(team, week, env) {
  const raw = await env.PFPI_KV.get(`locked-picks:${week}:${team}`);
  return raw ? new Set(JSON.parse(raw)) : new Set();
}

async function lockGameIds(team, week, gameIds, env) {
  if (!gameIds || gameIds.length === 0) return;
  const existing = await getLockedGameIds(team, week, env);
  gameIds.forEach(id => existing.add(id));
  await env.PFPI_KV.put(`locked-picks:${week}:${team}`, JSON.stringify([...existing]));
}

// Admin-set bypass for the real per-game DEADLINE lock (isGameLocked,
// shared.js) -- separate from the above submission-lock set, since a real
// deadline isn't stored state that can just be deleted; it's recomputed
// live from the schedule's kickoffISO every request. Set by
// handleUnlockWeekPicks (admin.html "Unlock all picks for a team/week")
// when a family member's real link is stuck locked (all/most games past
// their real deadline, nothing actually saved) -- persists (no TTL) until
// an admin clears it, so the team stays freely editable for the rest of
// that week, not just for one request.
async function isDeadlineUnlocked(team, week, env) {
  return (await env.PFPI_KV.get(`deadline-unlock:${week}:${team}`)) === "true";
}

async function getWeekSchedule(week, env) {
  // Reads the schedule cache written by the scores worker (pfpi-scores-worker,
  // see worker.js) into this same KV namespace. This Worker only reads it,
  // never writes it, so there is exactly one writer of schedule data.
  const raw = await env.PFPI_KV.get(`schedule:week:${week}`);
  if (!raw) {
    console.error(`No schedule cached for week ${week} — scores worker may not have run yet.`);
    return [];
  }
  const games = JSON.parse(raw);
  return games.map(g => ({
    ...g,
    deadline: computeGameDeadline(g.kickoffISO),
  }));
}

async function getCurrentWeek(env) {
  // current-week is written every cron tick by the scores worker
  // (pfpi-scores-worker, see worker.js) so both Workers share one value.
  // This fallback only matters if that worker hasn't run yet.
  const stored = await env.PFPI_KV.get("current-week");
  if (stored) return parseInt(stored, 10);
  return computeCurrentWeekFromDate();
}

// ============================================================
// WORKER ENTRY POINTS
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
    if (url.pathname === "/my-picks" && request.method === "GET") {
      return handleGetPicks(request, env);
    }
    if (url.pathname === "/submit-picks" && request.method === "POST") {
      return handleSubmitPicks(request, env);
    }
    if (url.pathname === "/confirm-picks" && request.method === "POST") {
      return handleConfirmPicks(request, env);
    }
    if (url.pathname === "/contact-support" && request.method === "POST") {
      return handleContactSupport(request, env);
    }
    if (url.pathname === "/training-my-picks" && request.method === "GET") {
      return handleTrainingGetPicks(request, env);
    }
    if (url.pathname === "/training-submit-picks" && request.method === "POST") {
      return handleTrainingSubmitPicks(request, env);
    }
    if (url.pathname === "/admin/login" && request.method === "POST") {
      return handleLogin("admin", request, env);
    }
    if (url.pathname === "/admin/forgot-password" && request.method === "POST") {
      return handleForgotPassword("admin", request, env);
    }
    if (url.pathname === "/admin/reset-password" && request.method === "POST") {
      return handleResetPassword("admin", request, env);
    }
    if (url.pathname === "/admin/override-pick" && request.method === "POST") {
      return handleAdminOverride(request, env);
    }
    if (url.pathname === "/admin/clear-week-picks" && request.method === "POST") {
      return handleClearWeekPicks(request, env);
    }
    if (url.pathname === "/admin/unlock-week-picks" && request.method === "POST") {
      return handleUnlockWeekPicks(request, env);
    }
    if (url.pathname === "/admin/deadline-override" && request.method === "POST") {
      return handleDeadlineOverride(request, env);
    }
    if (url.pathname === "/admin/week-picks" && request.method === "GET") {
      return handleAdminWeekPicks(request, env);
    }
    if (url.pathname === "/admin/send-league-email" && request.method === "POST") {
      return handleSendLeagueEmail(request, env);
    }
    if (url.pathname === "/admin/resend-picks-link" && request.method === "POST") {
      return handleResendPicksLink(request, env);
    }
    if (url.pathname === "/admin/send-correction-email" && request.method === "POST") {
      return handleSendCorrectionEmail(request, env);
    }
    if (url.pathname === "/greg/login" && request.method === "POST") {
      return handleLogin("greg", request, env);
    }
    if (url.pathname === "/greg/forgot-password" && request.method === "POST") {
      return handleForgotPassword("greg", request, env);
    }
    if (url.pathname === "/greg/reset-password" && request.method === "POST") {
      return handleResetPassword("greg", request, env);
    }
    if (url.pathname === "/admin/publish-brief" && request.method === "POST") {
      return handlePublishBrief(request, env);
    }
    if (url.pathname === "/greg/brief-history" && request.method === "GET") {
      return handleGetBriefHistory(request, env);
    }
    if (url.pathname === "/greg/brief-weeks" && request.method === "GET") {
      return handleGetBriefWeeks(request, env);
    }
    if (url.pathname === "/greg/send-reminder" && request.method === "POST") {
      return handleSendReminderEmail(request, env);
    }
    if (url.pathname === "/greg/send-game-reminder" && request.method === "POST") {
      return handleSendGameReminderEmail(request, env);
    }
    if (url.pathname === "/current-week" && request.method === "GET") {
      return handleCurrentWeek(request, env);
    }
    if (url.pathname === "/verify-session" && request.method === "GET") {
      return handleVerifySession(request, env);
    }
    return jsonResponse({ error: "Not found" }, 404, request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleWeeklyTrigger(env));
  },
};
