// ============================================================
// Shared constants/helpers used by both picks-worker.js and worker.js.
// Kept in one place so the two Workers can never drift on things like the
// current-week formula or the ET deadline math (bundled in separately by
// wrangler for each Worker via ES module import, not published on its own).
// ============================================================

export const TEAMS = ["Lobos", "Roughriders", "Maniacs", "Critters", "Chickens", "Ferraris", "Llamas", "Giraffes"];

// Test data only, per Yeti (Aug 2026 sessions) — NOT the real 8-team
// roster above. Real family emails are still pending from Greg; do not
// invent them here. Moved here from picks-worker.js (2026-08-25) so
// worker.js can also merge these teams' picks into published preseason
// data — a single source of truth instead of two copies that could drift.
export const FAMILY_MEMBERS = [
  { team: "Yeti's Big Feet", name: "Yeti (test)", email: "yetiblancmusic@gmail.com" },
  { team: "Gentry's Neanderbrows", name: "Yeti (test, 2nd account)", email: "ggentry@gmail.com" },
];

// Re-verified for the 2026 season (see BUILD_LOG.md). Week 1 runs from
// kickoff through the following Tuesday morning, when the next week's picks
// window opens.
export const SEASON_START_ET = "2026-09-09T00:00:00-04:00";
export const NUM_WEEKS = 18;

export function getEasternDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

export function isTargetLocalTime(targetHour, targetDayOfWeek, ianaZone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour").value, 10);
  const weekday = parts.find(p => p.type === "weekday").value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return hour === targetHour && dayMap[weekday] === targetDayOfWeek;
}

// Per-game deadline: 6:00 PM ET the day before kickoff. Weekend hybrid rule
// (one shared deadline for Sat/Sun/Mon games) is still unconfirmed with
// Greg — built generically so that stays a data change, not a rework. Do
// not add weekend-specific logic here.
export function computeGameDeadline(gameKickoffISO) {
  const kickoff = new Date(gameKickoffISO);
  const kickoffEastern = getEasternDateParts(kickoff);
  const dayBeforeUTC = new Date(Date.UTC(
    parseInt(kickoffEastern.year), parseInt(kickoffEastern.month) - 1,
    parseInt(kickoffEastern.day) - 1
  ));

  for (const offsetHours of [4, 5]) { // EDT is UTC-4, EST is UTC-5
    const candidate = new Date(Date.UTC(
      dayBeforeUTC.getUTCFullYear(), dayBeforeUTC.getUTCMonth(), dayBeforeUTC.getUTCDate(),
      18 + offsetHours, 0, 0
    ));
    const check = getEasternDateParts(candidate);
    if (parseInt(check.hour) === 18 && check.day === String(dayBeforeUTC.getUTCDate()).padStart(2, "0")) {
      return candidate.toISOString();
    }
  }

  throw new Error(`Could not resolve 6pm ET deadline for kickoff ${gameKickoffISO}`);
}

export function isGameLocked(gameDeadlineISO) {
  return Date.now() > new Date(gameDeadlineISO).getTime();
}

// ============================================================
// GITHUB CONTENTS API
// Used by worker.js (scores/standings) and picks-worker.js (brief publisher)
// to commit static JSON that GitHub Pages then serves directly — visitors
// never hit a Worker to read this data. Requires GITHUB_PAT: a fine-grained
// PAT scoped to only The-Greg-Cote-Show/PFPI with contents:write. Each
// Worker has its own separate secret store in Cloudflare, so GITHUB_PAT must
// be set on whichever Worker calls this, even though both point at the same
// repo.
// ============================================================

export const GITHUB_OWNER = "The-Greg-Cote-Show";
export const GITHUB_REPO = "PFPI";

// Returns true if the commit actually happened, false if it was skipped
// (missing PAT) or failed — callers that report success to a human (not just
// a background cron tick) should check this rather than assume it worked.
export async function commitJSONToGitHub(path, jsonObj, message, env) {
  if (!env.GITHUB_PAT) {
    console.error(`Skipping GitHub commit of ${path}: GITHUB_PAT not set.`);
    return false;
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_PAT}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "pfpi-worker",
  };

  let sha;
  const existing = await fetch(apiUrl, { headers });
  if (existing.ok) {
    const existingData = await existing.json();
    sha = existingData.sha;
  } else if (existing.status !== 404) {
    console.error(`Failed to check existing file ${path}: ${existing.status}`);
    return false;
  }

  const content = btoa(unescape(encodeURIComponent(JSON.stringify(jsonObj, null, 2))));
  const put = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, sha }),
  });

  if (!put.ok) {
    console.error(`Failed to commit ${path}: ${put.status} ${await put.text()}`);
    return false;
  }
  return true;
}

// Falls back to a date-based formula when KV hasn't been seeded yet (should
// be rare in practice, since the scores worker seeds current-week on every
// cron tick regardless of whether the Big Balls key is set).
export function computeCurrentWeekFromDate(now = new Date()) {
  const start = new Date(SEASON_START_ET);
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksElapsed = Math.floor((now - start) / msPerWeek);
  return Math.max(1, Math.min(NUM_WEEKS, weeksElapsed + 1));
}
