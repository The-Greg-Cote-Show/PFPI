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
} from "./shared.js";

// Test data only, per Yeti (Aug 2026 sessions) — NOT the real 8-team roster.
// Real family emails are still pending from Greg; do not invent them here.
const FAMILY_MEMBERS = [
  { team: "Yeti's Big Feet", name: "Yeti (test)", email: "yetiblancmusic@gmail.com" },
  { team: "Gentry's Neanderbrows", name: "Yeti (test, 2nd account)", email: "ggentry@gmail.com" },
];

const ADMIN_EMAIL = "yeti@yetiblanc.com";

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
// Cron itself fires hourly; actual cron string lives in the Cloudflare
// dashboard Triggers tab (see BUILD_LOG.md), not hardcoded here.
// ============================================================

async function handleWeeklyTrigger(env) {
  if (!isTargetLocalTime(7, 2, "America/New_York")) return; // 2 = Tuesday

  const currentWeek = await getCurrentWeek(env);

  for (const member of FAMILY_MEMBERS) {
    const token = await generateWeeklyToken(member.team, currentWeek, env);
    const link = `https://pfpi.thegregcoteshow.com/picks.html?token=${token}`;
    await sendPicksEmail(member.email, member.name, currentWeek, link, env);
  }
}

async function sendPicksEmail(toEmail, name, week, link, env) {
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
      text: `Hey ${name},\n\nYour Week ${week} picks are ready. Use this link any time this week, you can save and come back before each game's deadline:\n\n${link}\n\nDeadlines are per-game (6pm ET the day before), so submit as you go. Good luck.`,
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
// ADMIN AUTH
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

const ADMIN_SALT = "pfpi-admin";
const ADMIN_PASSWORD_HASH_KV_KEY = "admin-password-hash-override";

// Brute-force protection: per-IP lockout after too many failed admin logins,
// with a capped-frequency security alert email.
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
const LOGIN_ALERT_COOLDOWN_SECONDS = 60 * 60;

// The live password hash normally comes from the ADMIN_PASSWORD_HASH secret.
// A completed password reset (see handleResetPassword) writes a KV override
// that takes precedence, since a Worker can update KV at runtime but can't
// update its own secrets.
async function getAdminPasswordHash(env) {
  const override = await env.PFPI_KV.get(ADMIN_PASSWORD_HASH_KV_KEY);
  return override || env.ADMIN_PASSWORD_HASH;
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function handleAdminLogin(request, env) {
  const ip = getClientIp(request);
  const failKey = `admin-login-fail:${ip}`;
  const failCount = parseInt((await env.PFPI_KV.get(failKey)) || "0", 10);

  if (failCount >= LOGIN_FAIL_THRESHOLD) {
    return jsonResponse({ error: "Too many failed attempts. Try again later." }, 429, request);
  }

  const { password } = await request.json();
  const attemptedHash = await hashPassword(password, ADMIN_SALT);
  const currentHash = await getAdminPasswordHash(env);

  if (attemptedHash !== currentHash) {
    const newFailCount = failCount + 1;
    await env.PFPI_KV.put(failKey, String(newFailCount), { expirationTtl: LOGIN_FAIL_WINDOW_SECONDS });

    if (newFailCount === LOGIN_FAIL_THRESHOLD) {
      await flagPossibleBruteForce(ip, env);
    }

    return jsonResponse({ error: "Login failed." }, 401, request);
  }

  await env.PFPI_KV.delete(failKey);

  const sessionPayload = { role: "admin", issued: Date.now() };
  const sessionToken = await signPayload(sessionPayload, env.ADMIN_SESSION_SECRET);
  await env.PFPI_KV.put(`admin-session:${sessionToken}`, "valid", { expirationTtl: 4 * 60 * 60 });

  return jsonResponse({ sessionToken }, 200, request);
}

async function flagPossibleBruteForce(ip, env) {
  const alertKey = `admin-login-alert:${ip}`;
  const alreadyAlerted = await env.PFPI_KV.get(alertKey);
  if (alreadyAlerted) return;

  await env.PFPI_KV.put(alertKey, "sent", { expirationTtl: LOGIN_ALERT_COOLDOWN_SECONDS });
  await sendAdminEmail(
    "PFPI admin: possible brute-force login attempt",
    `${LOGIN_FAIL_THRESHOLD} failed admin login attempts from IP ${ip} within ${LOGIN_FAIL_WINDOW_SECONDS / 60} minutes.\n\nThat IP is now locked out of /admin/login for ${LOGIN_FAIL_WINDOW_SECONDS / 60} minutes. You won't get another alert for this IP for ${LOGIN_ALERT_COOLDOWN_SECONDS / 60} minutes even if it keeps trying.\n\nIf this wasn't you, no action is needed — the lockout is already in effect. If you're locked out yourself, wait for the cooldown or use "Forgot password?" from another network.`,
    env
  );
}

async function verifyAdminToken(token, env) {
  if (!token) return false;
  const session = await env.PFPI_KV.get(`admin-session:${token}`);
  return session === "valid";
}

// ============================================================
// ADMIN PASSWORD RESET
// ============================================================

async function handleForgotPassword(request, env) {
  const resetPayload = { role: "admin-reset", issued: Date.now() };
  const resetToken = await signPayload(resetPayload, env.ADMIN_SESSION_SECRET);
  await env.PFPI_KV.put(`admin-reset:${resetToken}`, "valid", { expirationTtl: 30 * 60 });

  const link = `https://the-greg-cote-show.github.io/PFPI/admin.html?resetToken=${resetToken}`;
  const sent = await sendAdminEmail(
    "PFPI admin password reset",
    `A password reset was requested for the PFPI admin panel.\n\nThis link is valid for 30 minutes and can only be used once:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    env
  );

  if (!sent) {
    return jsonResponse({ error: "Reset link could not be emailed. Check Worker logs." }, 502, request);
  }
  return jsonResponse({ sent: true }, 200, request);
}

async function sendAdminEmail(subject, text, env) {
  // Admin-only emails (this function) always go to ADMIN_EMAIL, so they can
  // use Resend's default sender — Resend allows onboarding@resend.dev to any
  // recipient even with an unverified sending domain. picks@thegregcoteshow.com
  // stays in sendPicksEmail() since that goes to family members, but it stays
  // broken until thegregcoteshow.com is verified at resend.com/domains
  // (needs DNS console access this Worker doesn't have).
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PFPI Admin <onboarding@resend.dev>",
      to: ADMIN_EMAIL,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send admin email ("${subject}"): ${res.status} ${body}`);
  }
  return res.ok;
}

async function handleResetPassword(request, env) {
  const { token, newPassword } = await request.json();

  const resetKey = `admin-reset:${token}`;
  const valid = token && (await env.PFPI_KV.get(resetKey)) === "valid";
  if (!valid) {
    return jsonResponse({ error: "Invalid or expired reset link." }, 401, request);
  }

  if (!newPassword || newPassword.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400, request);
  }

  const newHash = await hashPassword(newPassword, ADMIN_SALT);
  await env.PFPI_KV.put(ADMIN_PASSWORD_HASH_KV_KEY, newHash);
  await env.PFPI_KV.delete(resetKey);

  return jsonResponse({ reset: true }, 200, request);
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
    if (url.pathname === "/admin/login" && request.method === "POST") {
      return handleAdminLogin(request, env);
    }
    if (url.pathname === "/admin/forgot-password" && request.method === "POST") {
      return handleForgotPassword(request, env);
    }
    if (url.pathname === "/admin/reset-password" && request.method === "POST") {
      return handleResetPassword(request, env);
    }
    if (url.pathname === "/admin/override-pick" && request.method === "POST") {
      return handleAdminOverride(request, env);
    }
    return jsonResponse({ error: "Not found" }, 404, request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleWeeklyTrigger(env));
  },
};
