// ============================================================
// Shared constants/helpers used by both picks-worker.js and worker.js.
// Kept in one place so the two Workers can never drift on things like the
// current-week formula or the ET deadline math (bundled in separately by
// wrangler for each Worker via ES module import, not published on its own).
// ============================================================

export const TEAMS = ["Lobos", "Roughriders", "Maniacs", "Critters", "Chickens", "Ferraris", "Llamas", "Giraffes"];

// Full display names, matching index.html/brief.html's own TEAM_SHORT
// objects exactly (kept in sync by hand -- there's no single shared
// import between the frontend pages and this file, but the values must
// never drift). Moved here (2026-08-27) so picks-worker.js's automated
// emails can use full names instead of the bare mascot key -- see
// fullTeamName() below and BUILD_LOG.md for the full list of email
// functions this fixed.
export const TEAM_SHORT = {
  Lobos: "Greg's Lobos", Roughriders: "Dick's Roughriders", Maniacs: "Mom's Maniacs", Critters: "Chris' Critters",
  Chickens: "Mike's Chickens", Ferraris: "Christie's Ferraris", Llamas: "Tati's Llamas", Giraffes: "Gracelin's Giraffes",
};

// FAMILY_MEMBERS' `.team` values (when any exist) are already full display
// names on their own -- this only maps the bare mascot keys above, falling
// back to the input unchanged for anything else (a FAMILY_MEMBERS entry, or
// any already-full name passed in by mistake).
export function fullTeamName(team) {
  return TEAM_SHORT[team] || team;
}

// Sandboxed test teams ("Yeti's Big Feet", "Gentry's Neanderbrows") were
// removed 2026-08-29, per Yeti -- no longer needed. Left as an empty array
// (not deleted outright) since worker.js and picks-worker.js both spread
// this into their real-roster team lists (`[...TEAMS, ...FAMILY_MEMBERS.
// map(m => m.team)]`) rather than hardcoding the two test teams by name --
// emptying this array here was the single-source-of-truth removal, no
// other code changes were needed to fully retire them from every code path
// (preseason picks merging, test-email team lists, missing-picks tracking).
export const FAMILY_MEMBERS = [];

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

// DST-safe: resolves a specific ET wall-clock hour on a given ET calendar
// date to its real UTC instant, by trying both possible UTC offsets and
// keeping whichever one actually lands back on that hour/date in America/
// New_York (handles the EDT/EST transition without hardcoding which is in
// effect). Shared by both branches of computeGameDeadline() below.
function etWallClockToISO(year, month, day, hour) {
  for (const offsetHours of [4, 5]) { // EDT is UTC-4, EST is UTC-5
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + offsetHours, 0, 0));
    const check = getEasternDateParts(candidate);
    if (parseInt(check.hour, 10) === hour && parseInt(check.day, 10) === day && parseInt(check.month, 10) === month) {
      return candidate.toISOString();
    }
  }
  throw new Error(`Could not resolve ${hour}:00 ET for ${year}-${month}-${day}`);
}

// Calendar-day-only subtraction (not a real elapsed-time subtraction) --
// used to walk back from a Sun/Mon kickoff to that same week's Saturday.
function subtractEasternCalendarDays(easternParts, days) {
  const d = new Date(Date.UTC(parseInt(easternParts.year, 10), parseInt(easternParts.month, 10) - 1, parseInt(easternParts.day, 10)));
  d.setUTCDate(d.getUTCDate() - days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Per-game deadline (revised structure, confirmed by Greg via Yeti,
// 2026-08-25 big feedback round -- fully replaces the old flat "6pm ET the
// day before" rule everywhere it applied):
//   - Wed/Thu/Fri/Tue kickoffs: exactly 2 hours before that game's own
//     kickoff (Tuesday is a rare real edge case, confirmed to follow this
//     branch, not the weekend one).
//   - Sat/Sun/Mon kickoffs: one flat shared cutoff regardless of the game's
//     actual kickoff time -- Saturday 1:00 PM ET of that same week. A
//     Saturday game's own deadline is same-day; Sunday backs up one
//     calendar day, Monday backs up two -- always landing on that week's
//     single Saturday (verified against Greg's worked example: Sun Sept 13
//     and Mon Sept 14 games both deadline Sat Sept 12 1:00 PM ET).
export function computeGameDeadline(gameKickoffISO) {
  const kickoff = new Date(gameKickoffISO);
  const kickoffEastern = getEasternDateParts(kickoff);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(kickoff);

  if (weekday === "Sat" || weekday === "Sun" || weekday === "Mon") {
    const daysBackToSaturday = weekday === "Sat" ? 0 : weekday === "Sun" ? 1 : 2;
    const saturday = subtractEasternCalendarDays(kickoffEastern, daysBackToSaturday);
    return etWallClockToISO(saturday.year, saturday.month, saturday.day, 13);
  }

  return new Date(kickoff.getTime() - 2 * 60 * 60 * 1000).toISOString();
}

export function isGameLocked(gameDeadlineISO) {
  return Date.now() > new Date(gameDeadlineISO).getTime();
}

// ============================================================
// EMAIL (Resend)
// Moved here from picks-worker.js (2026-08-26) so worker.js can also send
// mail -- specifically the "brief is live" confirmation once a publish is
// confirmed actually deployed (see worker.js's checkPendingBriefConfirmations).
// Kept in one place so the two Workers can never drift on the sender/shape.
//
// mail.pfpi.me verified in Resend (DKIM/SPF/DMARC all green, 2026-09-06,
// per Yeti) -- replaces the old onboarding@resend.dev sender everywhere.
// Every real send now declares WHICH of two identities it's conceptually
// from (see SENDER_IDENTITIES below); `sendPfpiEmail` picks the real
// `from` address and reply-to footer from that, so no call site hardcodes
// a sender string itself.
// ============================================================

// The one real, monitored inbox this whole system is allowed to reach
// while EMAILS_LIVE_FOR_EVERYONE (below) is off. Both Workers' own
// ADMIN_EMAIL constants are already hardcoded to this same literal string;
// kept here too (rather than imported from there) since shared.js has no
// reason to depend on either Worker's own local constants.
export const YETI_EMAIL = "yeti@yetiblanc.com";

// Two real sender identities (2026-09-06, per Yeti) -- assign each real
// email call site to whichever one it conceptually belongs to:
//   - "admin": Yeti/admin-side (test tools, correction links, brute-force
//     alerts, the public contact-support form).
//   - "commissioner": Greg/commissioner-side (weekly picks-open email,
//     picks-submission confirmations, missing-picks reminders, the Weekly
//     Digest, and brief-is-live confirmations).
// Neither admin@mail.pfpi.me nor commissioner@mail.pfpi.me is a real,
// monitored inbox, so every email carries a "Reply to ___" mailto footer
// pointing at the real human on that side instead.
//
// Greg's real personal email address was NOT found anywhere in this
// codebase or BUILD_LOG.md (grepped both before writing this) -- GREG_EMAIL
// in both Workers is still explicitly a yeti@yetiblanc.com placeholder, and
// no other real address for Greg appears anywhere. Per Yeti's own
// instruction not to invent a real-looking address, `commissioner`'s
// replyTo below is a deliberately, obviously-non-deliverable placeholder
// (the .invalid TLD is reserved by RFC 2606 for exactly this purpose) --
// NOT a guess at Greg's real address, and NOT yeti@yetiblanc.com either
// (so a reply attempt fails loudly/bounces rather than silently misrouting
// to Yeti). Swap this one string for Greg's real address the moment it's
// known; nothing else needs to change when that happens.
const SENDER_IDENTITIES = {
  admin: {
    from: "PFPI Admin <admin@mail.pfpi.me>",
    replyLabel: "Reply to Yeti",
    replyTo: YETI_EMAIL,
  },
  commissioner: {
    from: "PFPI Commissioner <commissioner@mail.pfpi.me>",
    replyLabel: "Reply to Greg",
    replyTo: "greg-real-email-not-yet-provided@pfpi-placeholder.invalid",
  },
};

// Real, explicit on/off switch (2026-09-06, per Yeti's hard rule) -- a KV
// value, not a Secret, specifically so Yeti can flip it himself with one
// `wrangler kv key put` command, no redeploy needed (see BUILD_LOG.md for
// the exact command). Defaults OFF via plain KV-miss (`null !== "true"`),
// so no pre-seeding is required for the safe default to hold; explicitly
// seeded to the literal string "false" at ship time anyway purely so the
// key is discoverable via `wrangler kv key list`, not because absence
// wouldn't already be safe.
export async function emailsLiveForEveryone(env) {
  return (await env.PFPI_KV.get("emails-live-for-everyone")) === "true";
}

export async function sendPfpiEmail(to, subject, text, env, cc, identity = "admin") {
  const sender = SENDER_IDENTITIES[identity] || SENDER_IDENTITIES.admin;
  const bodyWithReply = `${text}\n\n---\n${sender.replyLabel}: mailto:${sender.replyTo}`;

  // Gate: while the flag is off, no send may reach any address other than
  // YETI_EMAIL -- checked against BOTH `to` and `cc`, not just `to`, since
  // several real call sites (picks-confirmation, training confirmations)
  // put the real family address in `cc`. A blocked address is redirected
  // to YETI_EMAIL (if it was the primary `to`) or simply dropped (if it
  // was `cc` and `to` already resolves to Yeti) rather than silently
  // vanishing -- either way it's named in a "[WOULD HAVE GONE TO: ...]"
  // subject marker so a real send is never indistinguishable from a
  // redirected one in Yeti's own inbox.
  const live = await emailsLiveForEveryone(env);
  let finalTo = to;
  let finalCc = cc;
  const blocked = [];
  if (!live) {
    if (to && to !== YETI_EMAIL) {
      blocked.push(to);
      finalTo = YETI_EMAIL;
    }
    if (cc && cc !== YETI_EMAIL) {
      blocked.push(cc);
      finalCc = undefined;
    }
  }
  const finalSubject = blocked.length > 0 ? `[WOULD HAVE GONE TO: ${blocked.join(", ")}] ${subject}` : subject;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: sender.from,
      to: finalTo,
      ...(finalCc ? { cc: finalCc } : {}),
      subject: finalSubject,
      text: bodyWithReply,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Failed to send email ("${subject}"): ${res.status} ${body}`);
  }
  return res.ok;
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
