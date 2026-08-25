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
  isTargetLocalTime,
  computeGameDeadline,
  isGameLocked,
  computeCurrentWeekFromDate,
  commitJSONToGitHub,
  NUM_WEEKS,
  TEAMS,
  FAMILY_MEMBERS,
} from "./shared.js";

const ADMIN_EMAIL = "yeti@yetiblanc.com";

// Greg doesn't have his own account/email wired up yet — his password reset
// emails go to Yeti for now (per Yeti, 2026-08-24). Change this to Greg's
// real address when he's actually onboarded; nothing else about the reset
// flow needs to change.
const GREG_EMAIL = "yeti@yetiblanc.com";

// Allowed frontend origins for CORS. Update once the real custom domain is
// live; workers.dev origin kept for local/interim testing.
const ALLOWED_ORIGINS = [
  "https://pfpi.thegregcoteshow.com",
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

async function handleWeeklyTrigger(env) {
  if (!isTargetLocalTime(7, 2, "America/New_York")) return; // 2 = Tuesday

  const currentWeek = await getCurrentWeek(env);
  const schedule = await getWeekSchedule(currentWeek, env);
  const deadlineSummary = formatWeekDeadlines(schedule);

  for (const member of FAMILY_MEMBERS) {
    const token = await generateWeeklyToken(member.team, currentWeek, env);
    const link = `https://pfpi.thegregcoteshow.com/picks.html?token=${token}`;
    await sendPicksEmail(member.email, member.name, currentWeek, link, deadlineSummary, env);
  }
}

// Groups this week's real per-game deadlines into a scannable day-by-day
// summary for the picks email, per Yeti (2026-08-25) — e.g. "Thursday's
// game locks Wednesday 6pm ET. Sunday's games lock Saturday 6pm ET." Not
// hardcoded day names: computed from the real schedule since the mix
// varies week to week (bye weeks, holiday games on unusual days). Under
// the current (non-hybrid) deadline rule every game sharing a kickoff
// weekday shares one deadline date, so grouping by kickoff weekday is
// equivalent to grouping by deadline date but reads more naturally in the
// email. Falls back to the old generic line if there's no real schedule
// yet (season hasn't started / Big Balls hasn't published this week) —
// honest fallback, not a fabricated deadline list.
function formatWeekDeadlines(schedule) {
  if (!schedule || schedule.length === 0) {
    return "Deadlines are per-game (6pm ET the day before).";
  }
  const weekdayET = iso => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(iso));
  const dayOrder = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"];
  const groups = new Map(); // kickoff weekday -> { deadlineWeekday, count }

  for (const g of schedule) {
    const kickoffWeekday = weekdayET(g.kickoffISO);
    const deadlineWeekday = weekdayET(g.deadline);
    const existing = groups.get(kickoffWeekday);
    if (existing) existing.count++;
    else groups.set(kickoffWeekday, { deadlineWeekday, count: 1 });
  }

  const lines = [];
  for (const day of dayOrder) {
    const g = groups.get(day);
    if (!g) continue;
    const noun = g.count === 1 ? "game" : "games";
    const verb = g.count === 1 ? "locks" : "lock";
    lines.push(`${day}'s ${noun} ${verb} ${g.deadlineWeekday} 6pm ET.`);
  }
  return lines.join(" ");
}

async function sendPicksEmail(toEmail, name, week, link, deadlineSummary, env) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PFPI <picks@thegregcoteshow.com>",
      to: toEmail,
      subject: `PFPI Week ${week} picks are open`,
      text: `Hey ${name},\n\nYour Week ${week} picks are ready. Use this link any time this week, you can save and come back before each game's deadline:\n\n${link}\n\n${deadlineSummary}\n\nGood luck.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send picks email to ${toEmail}: ${res.status} ${body}`);
  }
  return res.ok;
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

  const { team, week } = tokenData;
  const schedule = await getWeekSchedule(week, env);
  const saved = await getSavedPicks(team, week, env) || {};

  const games = schedule.map(g => ({
    id: g.id,
    home: g.home,
    away: g.away,
    kickoffISO: g.kickoffISO,
    deadline: g.deadline,
    locked: isGameLocked(g.deadline),
    pick: saved[g.id] || null,
  }));

  return jsonResponse({ team, week, games }, 200, request);
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

  const { team, week } = tokenData;
  const schedule = await getWeekSchedule(week, env);
  const existing = await getSavedPicks(team, week, env) || {};

  const rejected = [];
  for (const [gameId, pick] of Object.entries(picks || {})) {
    const game = schedule.find(g => g.id === gameId);
    if (!game) continue;
    if (isGameLocked(game.deadline)) {
      rejected.push(gameId);
      continue;
    }
    existing[gameId] = pick;
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

  const subject = `PFPI: ${team} submitted Week ${week} picks`;
  const text = `${team} submitted Week ${week} picks (${new Date().toISOString()}).\n\n${lines.join("\n")}`;
  // Two separate sends (not one email with two recipients) so each stays a
  // private notification, consistent with how admin/Greg account emails
  // already work elsewhere in this file. GREG_EMAIL is currently the same
  // placeholder as ADMIN_EMAIL (Greg's real address isn't in the system
  // yet, see its definition above) — not invented here, just reused.
  const sent = await sendPfpiEmail(ADMIN_EMAIL, subject, text, env);
  if (GREG_EMAIL !== ADMIN_EMAIL) {
    await sendPfpiEmail(GREG_EMAIL, subject, text, env);
  }

  if (!sent) {
    return jsonResponse({ error: "Could not send confirmation email. Check Worker logs." }, 502, request);
  }

  await env.PFPI_KV.put(notifiedKey, JSON.stringify(current));

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
// AD-HOC TEST PICKS EMAIL (admin.html "Send test picks email")
// ============================================================
// Per Yeti (2026-08-25): a self-service way to get a picks link emailed
// to himself on demand, as ANY team -- not just the two sandboxed
// FAMILY_MEMBERS test entries -- so he can see how a real roster team
// (e.g. "Roughriders") looks and behaves, and test repeatedly without
// needing a manual KV token seed each time. Reuses generateWeeklyToken()
// and formatWeekDeadlines() unchanged -- no second token or deadline
// logic. Always sends to ADMIN_EMAIL regardless of what's requested,
// never accepts a recipient from the request, so this can never become a
// way to email a real, uninvolved address.
async function handleSendTestPicksEmail(request, env) {
  const adminToken = request.headers.get("X-Admin-Token");
  const isValidAdmin = await verifyAdminToken(adminToken, env);
  if (!isValidAdmin) {
    return jsonResponse({ error: "Not authorized." }, 403, request);
  }

  const { team, week } = await request.json();
  if (!team || !week) {
    return jsonResponse({ error: "team and week are required." }, 400, request);
  }

  const testToken = await generateWeeklyToken(team, week, env);
  const link = `https://the-greg-cote-show.github.io/PFPI/picks.html?token=${testToken}`;
  const schedule = await getWeekSchedule(week, env);
  const deadlineSummary = formatWeekDeadlines(schedule);

  // Deliberately NOT sendPicksEmail() -- that still sends from
  // picks@thegregcoteshow.com, which the unverified Resend domain still
  // rejects (see BUILD_LOG.md, unresolved). sendPfpiEmail's
  // onboarding@resend.dev sender is the one actually proven to deliver.
  const sent = await sendPfpiEmail(
    ADMIN_EMAIL,
    `[TEST] PFPI Week ${week} picks — as ${team}`,
    `Test picks link for "${team}", Week ${week}.\n\nUse this link any time, you can save and come back before each game's deadline:\n\n${link}\n\n${deadlineSummary}\n\nThis is a test email triggered from admin.html, not a real weekly picks notification.`,
    env
  );

  if (!sent) {
    return jsonResponse({ error: "Email could not be sent. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true, link }, 200, request);
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
    label: "Greg's Brief",
    pageDescription: "the PFPI Brief publisher",
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
    env
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

// ============================================================
// PASSWORD RESET (admin and Greg both use this)
// ============================================================

async function handleForgotPassword(kind, request, env) {
  const cfg = AUTH_CONFIG[kind];
  const resetPayload = { role: `${kind}-reset`, issued: Date.now() };
  const resetToken = await signPayload(resetPayload, env[cfg.sessionSecretEnvKey]);
  await env.PFPI_KV.put(`${cfg.resetKvPrefix}:${resetToken}`, "valid", { expirationTtl: 30 * 60 });

  const link = `https://the-greg-cote-show.github.io/PFPI/${cfg.resetPage}?resetToken=${resetToken}`;
  const sent = await sendPfpiEmail(
    cfg.resetEmail,
    `PFPI ${cfg.label} password reset`,
    `A password reset was requested for ${cfg.pageDescription}.\n\nThis link is valid for 30 minutes and can only be used once:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    env
  );

  if (!sent) {
    return jsonResponse({ error: "Reset link could not be emailed. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true }, 200, request);
}

async function sendPfpiEmail(to, subject, text, env) {
  // These emails always go to a fixed PFPI-internal address (ADMIN_EMAIL or,
  // for now, GREG_EMAIL — see its definition), so they can use Resend's
  // default sender: Resend allows onboarding@resend.dev to any recipient
  // even with an unverified sending domain. picks@thegregcoteshow.com stays
  // in sendPicksEmail() since that goes to family members, but it stays
  // broken until thegregcoteshow.com is verified at resend.com/domains
  // (needs DNS console access this Worker doesn't have).
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PFPI <onboarding@resend.dev>",
      to,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send email ("${subject}"): ${res.status} ${body}`);
  }
  return res.ok;
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
  const weekNum = parseInt(week, 10);
  if (!Number.isInteger(weekNum) || weekNum < 1 || weekNum > NUM_WEEKS) {
    return jsonResponse({ error: "Invalid week." }, 400, request);
  }
  const trimmedText = (text || "").trim();
  if (!trimmedText) {
    return jsonResponse({ error: "Brief text is required." }, 400, request);
  }

  const committed = await commitJSONToGitHub(
    `data/brief-week-${weekNum}.json`,
    { week: weekNum, text: trimmedText, updatedAt: new Date().toISOString() },
    `Publish Week ${weekNum} brief${isAdmin ? " [admin correction]" : ""} [automated]`,
    env
  );

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

  return jsonResponse({ published: true }, 200, request);
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
    if (url.pathname === "/admin/send-test-picks-email" && request.method === "POST") {
      return handleSendTestPicksEmail(request, env);
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
    if (url.pathname === "/current-week" && request.method === "GET") {
      return handleCurrentWeek(request, env);
    }
    return jsonResponse({ error: "Not found" }, 404, request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleWeeklyTrigger(env));
  },
};
