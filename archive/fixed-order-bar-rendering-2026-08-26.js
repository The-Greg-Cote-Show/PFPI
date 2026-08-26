// ============================================================
// ARCHIVED SNAPSHOT — index.html's chart bar-rendering logic as it existed
// BEFORE the 2026-08-26 "big feedback round" redesign (dynamic sorting,
// crowns on every category, vertical mascot lettering, coon-skin hat for
// Unique Hits, two-decimal formatting).
//
// Why this exists: item 8 of PFPI_big_feedback_round_handoff.md explicitly
// reverses an earlier LOCKED decision ("team order is fixed and never
// re-sorted by score") per Greg's request, confirmed by Yeti. Per the
// doc's own instruction ("keep the current state saved somewhere
// retrievable... in case it needs to be reverted"), this file preserves
// the exact prior fixed-order rendering code, verbatim, from
// index.html's render() function (the chart-bars section, roughly what
// was lines 496-593 at the time this was cut).
//
// This is NOT wired into the site anywhere — it's a reference/rollback
// copy only. To revert: replace the equivalent section of index.html's
// render() with this logic (TEAMS.forEach in fixed array order, no sort,
// crown only for isBestWeek, no mascot lettering, 3-decimal fmtPct on
// Standings). Full git history also has this exact prior state, one
// commit before this file was added.
// ============================================================

const barsArea = document.getElementById("barsArea");
const yAxis = document.getElementById("yAxis");
const labelsCols = document.getElementById("labelsCols");
barsArea.innerHTML = ""; yAxis.innerHTML = ""; labelsCols.innerHTML = "";

let values = {};
let labels = {};
let bottomLabels = {};

if (cat.isBestWeek) {
  TEAMS.forEach(t => {
    const d = dataset[t][wKey];
    values[t] = d.pct;
    labels[t] = `${d.correct}-${d.total-d.correct}\n(Wk ${d.week})`;
    bottomLabels[t] = fmtPct(d.pct);
  });
} else if (cat.isHitsOpps) {
  TEAMS.forEach(t => {
    const d = dataset[t][wKey];
    values[t] = d.hits;
    labels[t] = `${d.hits}-${d.opps}`;
  });
} else if (cat.isStandings) {
  const pctSource = REAL.standingsPct;
  TEAMS.forEach(t => {
    const v = dataset[t][wKey];
    values[t] = v;
    labels[t] = String(v);
    bottomLabels[t] = fmtPct(pctSource[t][wKey]); // 3-decimal, e.g. ".653"
  });
} else {
  TEAMS.forEach(t => {
    const v = dataset[t][wKey];
    values[t] = v;
    labels[t] = String(v); // note: no toFixed(2) -- "2" would show as "2", not "2.00"
  });
}

const maxVal = Math.max(...TEAMS.map(t => values[t]), 0.01);
const ticks = 4;
for (let i=ticks; i>=0; i--){
  const d = document.createElement("div");
  const tickVal = cat.isBestWeek ? (maxVal/ticks*i).toFixed(2) : Math.round(maxVal/ticks*i*100)/100;
  d.textContent = tickVal;
  yAxis.appendChild(d);
}
for (let i=1; i<ticks; i++){
  const line = document.createElement("div");
  line.className = "grid-line";
  line.style.bottom = (i/ticks*100)+"%";
  barsArea.appendChild(line);
}

// For Best Week, find whichever team currently holds the season's best pct.
// Ties (identical pct) get the crown too, rather than arbitrarily picking one.
// NOTE: this was the ONLY category with crown/leader logic at all -- every
// other category never highlighted a leader.
let championTeam = null;
if (cat.isBestWeek) {
  const topPct = Math.max(...TEAMS.map(t => values[t]));
  const holders = TEAMS.filter(t => values[t] === topPct);
  championTeam = holders; // array, supports shared crown on a tie
}

// NOTE: fixed TEAMS array order below -- "Team order is fixed and never
// re-sorted by score." was the explicit locked rule this snapshot preserves.
TEAMS.forEach(team => {
  const val = values[team];
  const pct = Math.max(2, Math.round((val/maxVal)*1000)/10);
  const color = TEAM_COLORS[team];
  const isChamp = championTeam && championTeam.includes(team);
  const bottomLabel = bottomLabels[team];

  const col = document.createElement("div");
  col.className = "bar-col" + (isChamp ? " is-champion" : "");
  col.innerHTML = `
    <div class="bar-el" style="height:${pct}%;background:${color}">
      <div class="bar-value-label">
        ${isChamp ? '<div class="crown">&#128081;</div>' : ""}
        <div>${labels[team].replace("\n","<br>")}</div>
      </div>
      ${bottomLabel ? `<div class="bar-bottom-label">${bottomLabel}</div>` : ""}
    </div>
  `;
  barsArea.appendChild(col);

  const labelCol = document.createElement("div");
  labelCol.className = "label-col";
  labelCol.innerHTML = `
    <div class="bar-team-avatar" style="border-color:${color};color:${color}">${initials(TEAM_SHORT[team])}</div>
    <div class="bar-team-name">${TEAM_SHORT[team]}</div>
  `;
  labelsCols.appendChild(labelCol);
});

document.getElementById("legendNote").textContent =
  "Live data. Team order is fixed and never re-sorted by score.";
