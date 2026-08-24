// ============================================================
// Shared constants/helpers used by both picks-worker.js and worker.js.
// Kept in one place so the two Workers can never drift on things like the
// current-week formula or the ET deadline math (bundled in separately by
// wrangler for each Worker via ES module import, not published on its own).
// ============================================================

export const TEAMS = ["Lobos", "Roughriders", "Maniacs", "Critters", "Chickens", "Ferraris", "Llamas", "Giraffes"];

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

// Falls back to a date-based formula when KV hasn't been seeded yet (should
// be rare in practice, since the scores worker seeds current-week on every
// cron tick regardless of whether the Big Balls key is set).
export function computeCurrentWeekFromDate(now = new Date()) {
  const start = new Date(SEASON_START_ET);
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksElapsed = Math.floor((now - start) / msPerWeek);
  return Math.max(1, Math.min(NUM_WEEKS, weeksElapsed + 1));
}
