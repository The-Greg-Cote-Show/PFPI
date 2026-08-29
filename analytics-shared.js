// ============================================================
// PFPI ANALYTICS -- SHARED DASHBOARD RENDERER (2026-08-29, per Yeti)
//
// Single source of truth for the analytics dashboard UI. Both
// analytics.html (standalone page, kept) and admin.html's "Analytics"
// portal tab load THIS file and call PFPIAnalytics.mount(...) -- neither
// page has its own copy of the rendering logic. There is nothing to keep
// "in sync" between the two: the underlying data is the same live
// KV-backed feed from pfpi-scores-worker regardless of which page asks
// for it, this file just draws it wherever it's mounted. See
// BUILD_LOG.md ("Analytics-as-portal-tab...") for why both the
// standalone page and the portal tab were kept rather than picking one.
//
// Auth is NOT handled here -- the caller (analytics.html's own login
// form, or admin.html's existing admin session) supplies a valid admin
// session token via `getToken()` and is told about a 401/403 via
// `onUnauthorized()`. This file never logs anyone in.
// ============================================================
(function (global) {
  "use strict";

  // ----- date helpers (ported as-is from the original analytics.html) -----
  function fmtDate(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(dt);
  }
  function todayETKey() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  // ----- ISO 3166-1 alpha-2 -> numeric-3 (world-atlas topojson feature ids) -----
  // Best-effort, hand-maintained static table (ISO 3166-1 is a stable
  // standard, this isn't expected to need updates). Non-critical if a rare
  // country is missing: it just renders as "no data" gray on the map
  // instead of colored, the same as any country PFPI has never had a
  // visitor from -- never a crash. Kosovo omitted (no universally agreed
  // ISO code / not present in most Natural-Earth-derived topojson).
  const COUNTRY_ALPHA2_TO_NUMERIC = {
    AF:"004",AX:"248",AL:"008",DZ:"012",AS:"016",AD:"020",AO:"024",AI:"660",AQ:"010",AG:"028",
    AR:"032",AM:"051",AW:"533",AU:"036",AT:"040",AZ:"031",BS:"044",BH:"048",BD:"050",BB:"052",
    BY:"112",BE:"056",BZ:"084",BJ:"204",BM:"060",BT:"064",BO:"068",BA:"070",BW:"072",BR:"076",
    IO:"086",BN:"096",BG:"100",BF:"854",BI:"108",CV:"132",KH:"116",CM:"120",CA:"124",KY:"136",
    CF:"140",TD:"148",CL:"152",CN:"156",CX:"162",CC:"166",CO:"170",KM:"174",CG:"178",CD:"180",
    CK:"184",CR:"188",CI:"384",HR:"191",CU:"192",CW:"531",CY:"196",CZ:"203",DK:"208",DJ:"262",
    DM:"212",DO:"214",EC:"218",EG:"818",SV:"222",GQ:"226",ER:"232",EE:"233",SZ:"748",ET:"231",
    FK:"238",FO:"234",FJ:"242",FI:"246",FR:"250",GF:"254",PF:"258",GA:"266",GM:"270",GE:"268",
    DE:"276",GH:"288",GI:"292",GR:"300",GL:"304",GD:"308",GP:"312",GU:"316",GT:"320",GG:"831",
    GN:"324",GW:"624",GY:"328",HT:"332",HN:"340",HK:"344",HU:"348",IS:"352",IN:"356",ID:"360",
    IR:"364",IQ:"368",IE:"372",IM:"833",IL:"376",IT:"380",JM:"388",JP:"392",JE:"832",JO:"400",
    KZ:"398",KE:"404",KI:"296",KW:"414",KG:"417",LA:"418",LV:"428",LB:"422",LS:"426",LR:"430",
    LY:"434",LI:"438",LT:"440",LU:"442",MO:"446",MG:"450",MW:"454",MY:"458",MV:"462",ML:"466",
    MT:"470",MH:"584",MQ:"474",MR:"478",MU:"480",YT:"175",MX:"484",FM:"583",MD:"498",MC:"492",
    MN:"496",ME:"499",MS:"500",MA:"504",MZ:"508",MM:"104",NA:"516",NR:"520",NP:"524",NL:"528",
    NC:"540",NZ:"554",NI:"558",NE:"562",NG:"566",NU:"570",NF:"574",KP:"408",MK:"807",MP:"580",
    NO:"578",OM:"512",PK:"586",PW:"585",PS:"275",PA:"591",PG:"598",PY:"600",PE:"604",PH:"608",
    PN:"612",PL:"616",PT:"620",PR:"630",QA:"634",RE:"638",RO:"642",RU:"643",RW:"646",BL:"652",
    SH:"654",KN:"659",LC:"662",MF:"663",PM:"666",VC:"670",WS:"882",SM:"674",ST:"678",SA:"682",
    SN:"686",RS:"688",SC:"690",SL:"694",SG:"702",SX:"534",SK:"703",SI:"705",SB:"090",SO:"706",
    ZA:"710",KR:"410",SS:"728",ES:"724",LK:"144",SD:"729",SR:"740",SJ:"744",SE:"752",CH:"756",
    SY:"760",TW:"158",TJ:"762",TZ:"834",TH:"764",TL:"626",TG:"768",TK:"772",TO:"776",TT:"780",
    TN:"788",TR:"792",TM:"795",TC:"796",TV:"798",UG:"800",UA:"804",AE:"784",GB:"826",US:"840",
    UY:"858",UZ:"860",VU:"548",VA:"336",VE:"862",VN:"704",VG:"092",VI:"850",WF:"876",EH:"732",
    YE:"887",ZM:"894",ZW:"716",
  };
  const NUMERIC_TO_ALPHA2 = {};
  Object.keys(COUNTRY_ALPHA2_TO_NUMERIC).forEach(a2 => { NUMERIC_TO_ALPHA2[COUNTRY_ALPHA2_TO_NUMERIC[a2]] = a2; });

  // Display names for the alpha-2 codes actually seen in real data --
  // filled in lazily from d3-fetched topojson feature properties instead
  // of a second hardcoded name table, see renderWorldMap below.

  const D3_URL = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";
  // topojson-client isn't published on cdnjs (checked live -- 404); jsdelivr
  // serves its real npm dist build directly, pinned to major version 3.
  const TOPOJSON_URL = "https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js";
  const WORLD_TOPO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";
  const US_TOPO_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

  let libsPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }
  function ensureMapLibs() {
    if (global.d3 && global.topojson) return Promise.resolve();
    if (!libsPromise) libsPromise = loadScript(D3_URL).then(() => loadScript(TOPOJSON_URL));
    return libsPromise;
  }

  const STYLE_ID = "pfpi-analytics-shared-style";
  const CSS = `
.pa-root{font-size:14px;}
.pa-root .hidden{display:none !important;}
.pa-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1.1rem;}
.pa-meta{font-size:.72rem;color:var(--muted,#7a8ba8);}
.pa-refresh-btn{margin-top:0;background:none;border:1px solid var(--border2,rgba(255,255,255,.13));color:var(--muted,#7a8ba8);font-size:.72rem;padding:5px 14px;border-radius:8px;cursor:pointer;font-weight:700;}
.pa-refresh-btn:hover{color:var(--text,#eef2f7);border-color:var(--gold,#e8b84b);}
.pa-subtabs{display:flex;gap:6px;margin-bottom:1.1rem;}
.pa-subtab-btn{flex:1;background:var(--panel2,#141d2e);border:1px solid var(--border2,rgba(255,255,255,.13));color:var(--muted,#7a8ba8);font-size:.76rem;font-weight:700;padding:.55rem .5rem;border-radius:8px;cursor:pointer;}
.pa-subtab-btn.active{background:var(--gold,#e8b84b);color:#1a1305;border-color:var(--gold,#e8b84b);}
.pa-stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin-bottom:1.1rem;}
@media(max-width:640px){.pa-stats-row{grid-template-columns:1fr 1fr;}}
.pa-stat{background:var(--panel,#0f1623);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:12px;padding:1rem 1.1rem;}
.pa-stat-label{font-size:.62rem;color:var(--muted,#7a8ba8);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;}
.pa-stat-val{font-size:1.6rem;font-weight:900;color:var(--gold,#e8b84b);line-height:1;}
.pa-stat-sub{font-size:.68rem;color:var(--muted,#7a8ba8);margin-top:5px;}
.pa-stat-sub b{color:var(--text,#eef2f7);}
.pa-bottom-row{display:grid;grid-template-columns:1.3fr 1fr;gap:1.1rem;margin-bottom:1.1rem;align-items:start;}
@media(max-width:750px){.pa-bottom-row{grid-template-columns:1fr;}}
.pa-panel{background:var(--panel,#0f1623);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:14px;overflow:hidden;margin-bottom:1.1rem;}
.pa-panel-hdr{padding:.75rem 1rem;border-bottom:1px solid var(--border,rgba(255,255,255,.07));font-size:.66rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--gold,#e8b84b);}
.pa-trend-table{width:100%;border-collapse:collapse;font-size:.78rem;}
.pa-trend-table th{text-align:right;color:var(--muted,#7a8ba8);font-weight:600;font-size:.63rem;text-transform:uppercase;letter-spacing:.04em;padding:.5rem .9rem;border-bottom:1px solid var(--border,rgba(255,255,255,.07));}
.pa-trend-table th:first-child,.pa-trend-table td:first-child{text-align:left;}
.pa-trend-table td{text-align:right;padding:.45rem .9rem;border-bottom:1px solid var(--border,rgba(255,255,255,.07));}
.pa-trend-table tr:last-child td{border-bottom:none;}
.pa-trend-table tr.pa-today td{color:var(--gold,#e8b84b);font-weight:700;}
.pa-empty{padding:2rem 1rem;text-align:center;color:var(--muted,#7a8ba8);font-size:.82rem;}
.pa-ref-row{display:flex;align-items:center;justify-content:space-between;padding:8px 1rem;border-bottom:1px solid var(--border,rgba(255,255,255,.07));font-size:.82rem;}
.pa-ref-row:last-child{border-bottom:none;}
.pa-ref-name{text-transform:capitalize;}
.pa-ref-bar-wrap{flex:1;margin:0 .75rem;background:rgba(255,255,255,0.05);border-radius:3px;height:5px;overflow:hidden;}
.pa-ref-bar{height:5px;border-radius:3px;background:var(--gold,#e8b84b);}
.pa-ref-count{font-weight:700;color:var(--gold,#e8b84b);min-width:32px;text-align:right;}
.pa-internal-row{display:flex;justify-content:space-between;padding:.5rem 1rem;font-size:.78rem;color:var(--muted,#7a8ba8);}
.pa-internal-row b{color:var(--text,#eef2f7);}
.pa-methodology{font-size:.76rem;color:var(--muted,#7a8ba8);line-height:1.65;padding:1.1rem 1.25rem;}
.pa-methodology b{color:var(--text,#eef2f7);}
.pa-methodology .pa-tradeoff{color:var(--gold2,#f5d07a);}
.pa-loc-toggle{display:flex;gap:6px;margin-bottom:1rem;}
.pa-loc-toggle button{flex:0 0 auto;background:var(--panel2,#141d2e);border:1px solid var(--border2,rgba(255,255,255,.13));color:var(--muted,#7a8ba8);font-size:.76rem;font-weight:700;padding:.5rem 1.1rem;border-radius:8px;cursor:pointer;}
.pa-loc-toggle button.active{background:var(--gold,#e8b84b);color:#1a1305;border-color:var(--gold,#e8b84b);}
.pa-map-row{display:grid;grid-template-columns:1.6fr 1fr;gap:1.1rem;align-items:start;}
@media(max-width:800px){.pa-map-row{grid-template-columns:1fr;}}
.pa-map-svg-wrap{background:var(--panel,#0f1623);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:14px;padding:.75rem;}
.pa-map-svg-wrap svg{width:100%;height:auto;display:block;}
.pa-map-feature{stroke:var(--bg,#080c14);stroke-width:.5;cursor:pointer;transition:opacity .1s;}
.pa-map-feature:hover{opacity:.8;}
.pa-map-tooltip{position:fixed;pointer-events:none;background:var(--panel3,#1a2540);border:1px solid var(--border2,rgba(255,255,255,.13));border-radius:6px;padding:6px 10px;font-size:.74rem;color:var(--text,#eef2f7);z-index:9999;display:none;white-space:nowrap;}
.pa-drilldown-hdr{font-size:.72rem;font-weight:700;color:var(--gold,#e8b84b);text-transform:uppercase;letter-spacing:.05em;padding:.9rem 1rem .3rem;}
.pa-drilldown-hint{font-size:.72rem;color:var(--muted,#7a8ba8);padding:0 1rem .8rem;line-height:1.5;}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function skeletonHtml() {
    return `
      <div class="pa-root">
        <div class="pa-header">
          <div class="pa-meta" id="paMetaLine">Loading...</div>
          <button class="pa-refresh-btn" type="button" data-pa="refresh">Refresh</button>
        </div>
        <div class="pa-subtabs">
          <button class="pa-subtab-btn active" type="button" data-pa="subtab" data-subtab="overview">Overview</button>
          <button class="pa-subtab-btn" type="button" data-pa="subtab" data-subtab="locations">Locations</button>
        </div>

        <div id="paOverview">
          <div class="pa-stats-row" id="paStatsRow"></div>
          <div class="pa-bottom-row">
            <div class="pa-panel" style="margin-bottom:0;">
              <div class="pa-panel-hdr">Daily unique visitors — last 14 days</div>
              <div style="overflow-x:auto;">
                <table class="pa-trend-table">
                  <thead><tr><th>Date</th><th>Unique</th><th>New</th><th>Repeat</th></tr></thead>
                  <tbody id="paTrendBody"></tbody>
                </table>
              </div>
            </div>
            <div class="pa-panel" style="margin-bottom:0;">
              <div class="pa-panel-hdr">Traffic sources (all-time pageviews)</div>
              <div id="paReferrerList"></div>
            </div>
          </div>
          <div class="pa-panel">
            <div class="pa-panel-hdr">Internal tool traffic (today) — excluded from all numbers above</div>
            <div class="pa-internal-row"><span>Commissioner Portal (brief.html)</span><b id="paBriefViews">0</b></div>
            <div class="pa-internal-row"><span>Admin Portal (admin.html)</span><b id="paAdminViews">0</b></div>
          </div>
          <div class="pa-panel">
            <div class="pa-panel-hdr">Bot filtering (today)</div>
            <div class="pa-internal-row"><span>Bot / crawler requests excluded from all counters</span><b id="paBotsFiltered">0</b></div>
          </div>
          <div class="pa-panel">
            <div class="pa-panel-hdr">Methodology — what "unique" actually means here</div>
            <div class="pa-methodology">
              <b>Daily unique visitors</b> are counted with a one-way hash of each
              visitor's IP address + browser, combined with today's date. Because
              the date is baked in, that exact hash can never repeat on a
              different day — it fully resets every 24 hours, the same way
              privacy-respecting tools like Fathom or Plausible work. Raw IP
              addresses are never stored anywhere, only this hash.
              <br><br>
              <b>New vs. repeat</b> visitors need a second hash that does
              <i>not</i> include the date, so it can actually recognize the same
              visitor coming back on a later day. <span class="pa-tradeoff">Honest
              tradeoff, not hidden:</span> this second hash is coarser and
              longer-lived than the daily one — it persists as long as a
              visitor's IP + browser combination stays the same, realistically
              days to weeks for most people, and changes the moment they switch
              networks or devices. It is still fully anonymous and one-way
              hashed; it is simply not reset every 24 hours the way the daily
              hash is.
              <br><br>
              <b>Known limitation:</b> visitors are identified by device/browser,
              not by person — the same person on their phone and then their
              laptop the same day will show as two visitors. Every
              privacy-respecting analytics tool has this exact limitation, Fathom
              and Plausible included.
              <br><br>
              <b>Week-to-date / month-to-date / all-time totals</b> above are a
              <i>sum of daily unique counts</i>, not a fully deduplicated count
              across that whole range — a person who visits three separate days
              in one week is counted three times toward that week's total, not
              once. A true multi-day deduplicated count is a possible future
              addition, not built yet.
              <br><br>
              <b>Commissioner Portal and Admin Portal traffic</b> (Greg's and
              Yeti's own login-gated tools) is tracked separately as plain
              pageview counts and is never included in any number above — it
              isn't real audience.
              <br><br>
              <b>Bot filtering, honestly stated:</b> requests are excluded from
              every counter on this dashboard when Cloudflare has already
              verified them as a known bot (search engines and similar), or
              when their User-Agent string self-identifies as a bot, crawler,
              spider, or common automation tool (curl, wget, headless
              browsers, etc). <span class="pa-tradeoff">Real, expected gap,
              not a bug to chase further:</span> a bot that deliberately
              disguises its User-Agent as a normal browser will NOT be
              caught by this. Cloudflare's fully automated bot-confidence
              scoring is an Enterprise-only feature this account is not on
              — this dashboard catches the large majority of well-behaved,
              self-identifying bots (search engines, link-preview
              generators, monitoring services), not every possible bot.
            </div>
          </div>
        </div>

        <div id="paLocations" class="hidden">
          <div class="pa-loc-toggle">
            <button type="button" class="active" data-pa="geoview" data-geoview="world">World</button>
            <button type="button" data-pa="geoview" data-geoview="us">United States</button>
          </div>
          <div class="pa-map-row">
            <div class="pa-map-svg-wrap" id="paMapSvgWrap"><div class="pa-empty" id="paMapStatus">Loading map…</div></div>
            <div class="pa-panel" style="margin-bottom:0;">
              <div class="pa-drilldown-hdr" id="paDrillHdr">Click a country</div>
              <div class="pa-drilldown-hint" id="paDrillHint">Darker shading means more recorded visits (all-time). Click any shaded area for a breakdown.</div>
              <div id="paDrillList"></div>
            </div>
          </div>
          <div class="pa-panel">
            <div class="pa-panel-hdr">Methodology — location data</div>
            <div class="pa-methodology">
              Country, region (state/province), and city are read directly
              from Cloudflare's own edge network for each pageload — free on
              every plan, no extra lookup or third-party service involved.
              These are approximate, network-derived locations (based on
              which network the request is routed through), not GPS or
              precise addresses, and the same privacy posture as the rest of
              this system applies: no raw IP address is ever stored, and
              this data is excluded for the same requests the rest of this
              dashboard excludes (opted-out visitors via <code>notrack</code>,
              and filtered bot traffic).
              <br><br>
              <span class="pa-tradeoff">City-level data is more granular than
              country or region</span> — worth calling out plainly, in the
              same spirit as the rest of this dashboard's transparency about
              what it collects. City is the most specific location field
              this system captures; it is never combined with any other
              identifying information, and, like everything else here, is
              never tied to a real name or account.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function PFPIAnalytics(rootEl, opts) {
    this.root = rootEl;
    this.opts = opts || {};
    this.activeSubtab = "overview";
    this.geoView = "world";
    this.geoData = null;
    this.geoLoaded = false;
    this._selectedCountry = null;
    ensureStyle();
    this.root.innerHTML = skeletonHtml();
    this._wire();
    this.loadOverview();
  }

  PFPIAnalytics.prototype._headers = function () {
    return { "X-Admin-Token": this.opts.getToken() };
  };

  PFPIAnalytics.prototype._wire = function () {
    const self = this;
    this.root.querySelector('[data-pa="refresh"]').addEventListener("click", () => {
      if (self.activeSubtab === "overview") self.loadOverview();
      else self.loadGeo(true);
    });
    this.root.querySelectorAll('[data-pa="subtab"]').forEach(btn => {
      btn.addEventListener("click", () => self.showSubtab(btn.dataset.subtab));
    });
    this.root.querySelectorAll('[data-pa="geoview"]').forEach(btn => {
      btn.addEventListener("click", () => self.setGeoView(btn.dataset.geoview));
    });
  };

  PFPIAnalytics.prototype.showSubtab = function (tab) {
    this.activeSubtab = tab;
    this.root.querySelectorAll('[data-pa="subtab"]').forEach(b => b.classList.toggle("active", b.dataset.subtab === tab));
    this.root.querySelector("#paOverview").classList.toggle("hidden", tab !== "overview");
    this.root.querySelector("#paLocations").classList.toggle("hidden", tab !== "locations");
    if (tab === "locations" && !this.geoLoaded) {
      this.geoLoaded = true;
      this.loadGeo();
    }
  };

  PFPIAnalytics.prototype._unauthorized = function () {
    if (typeof this.opts.onUnauthorized === "function") this.opts.onUnauthorized();
  };

  // ----- OVERVIEW -----
  PFPIAnalytics.prototype.loadOverview = async function () {
    const metaEl = this.root.querySelector("#paMetaLine");
    metaEl.textContent = "Refreshing...";
    try {
      const res = await fetch(`${this.opts.scoresWorkerBase}/admin/analytics-data`, { headers: this._headers() });
      if (res.status === 401 || res.status === 403) { this._unauthorized(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load analytics.");
      this._renderOverview(data);
      const since = data.trackingSince ? ` — tracking since ${fmtDate(data.trackingSince)}` : "";
      metaEl.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + since;
    } catch (e) {
      metaEl.textContent = "Error: " + e.message;
    }
  };

  PFPIAnalytics.prototype._renderOverview = function (data) {
    const root = this.root;
    const today = todayETKey();

    root.querySelector("#paStatsRow").innerHTML = `
      <div class="pa-stat">
        <div class="pa-stat-label">Today — Unique Visitors</div>
        <div class="pa-stat-val">${data.today.unique.toLocaleString()}</div>
        <div class="pa-stat-sub"><b>${data.today.new}</b> new &middot; <b>${data.today.repeat}</b> repeat</div>
      </div>
      <div class="pa-stat">
        <div class="pa-stat-label">Week to Date</div>
        <div class="pa-stat-val">${data.weekToDate.unique.toLocaleString()}</div>
        <div class="pa-stat-sub"><b>${data.weekToDate.new}</b> new &middot; <b>${data.weekToDate.repeat}</b> repeat</div>
      </div>
      <div class="pa-stat">
        <div class="pa-stat-label">Month to Date</div>
        <div class="pa-stat-val">${data.monthToDate.unique.toLocaleString()}</div>
        <div class="pa-stat-sub"><b>${data.monthToDate.new}</b> new &middot; <b>${data.monthToDate.repeat}</b> repeat</div>
      </div>
      <div class="pa-stat">
        <div class="pa-stat-label">All-Time</div>
        <div class="pa-stat-val">${data.allTime.unique.toLocaleString()}</div>
        <div class="pa-stat-sub"><b>${data.allTime.new}</b> new &middot; <b>${data.allTime.repeat}</b> repeat</div>
      </div>
    `;

    const trendDates = Object.keys(data.trend).sort();
    const trendBody = root.querySelector("#paTrendBody");
    if (trendDates.length === 0) {
      trendBody.innerHTML = `<tr><td colspan="4" class="pa-empty">No data yet.</td></tr>`;
    } else {
      trendBody.innerHTML = trendDates.map(d => {
        const row = data.trend[d];
        const isToday = d === today;
        return `<tr class="${isToday ? "pa-today" : ""}">
          <td>${fmtDate(d)}${isToday ? " (today)" : ""}</td>
          <td>${row.unique}</td>
          <td>${row.new}</td>
          <td>${row.repeat}</td>
        </tr>`;
      }).join("");
    }

    const refEntries = Object.entries(data.referrers || {}).sort((a, b) => b[1] - a[1]);
    const refListEl = root.querySelector("#paReferrerList");
    if (refEntries.length === 0) {
      refListEl.innerHTML = `<div class="pa-empty">No traffic-source data yet.</div>`;
    } else {
      const maxVal = refEntries[0][1] || 1;
      refListEl.innerHTML = refEntries.map(([name, count]) => `
        <div class="pa-ref-row">
          <div class="pa-ref-name">${name.replace(/^other:/, "other: ")}</div>
          <div class="pa-ref-bar-wrap"><div class="pa-ref-bar" style="width:${Math.round(count / maxVal * 100)}%"></div></div>
          <div class="pa-ref-count">${count}</div>
        </div>`).join("");
    }

    root.querySelector("#paBriefViews").textContent = data.internalPageviewsToday.brief;
    root.querySelector("#paAdminViews").textContent = data.internalPageviewsToday.admin;
    root.querySelector("#paBotsFiltered").textContent = data.botsFilteredToday || 0;
  };

  // ----- LOCATIONS -----
  PFPIAnalytics.prototype.setGeoView = function (view) {
    this.geoView = view;
    this.root.querySelectorAll('[data-pa="geoview"]').forEach(b => b.classList.toggle("active", b.dataset.geoview === view));
    this._selectedCountry = null;
    this._drawCurrentMap();
  };

  PFPIAnalytics.prototype.loadGeo = async function (forceStatusMsg) {
    const statusEl = this.root.querySelector("#paMapStatus");
    if (statusEl) statusEl.textContent = "Loading map…";
    try {
      const [libsResult, dataResult] = await Promise.allSettled([
        ensureMapLibs(),
        fetch(`${this.opts.scoresWorkerBase}/admin/analytics-geo`, { headers: this._headers() }),
      ]);
      if (libsResult.status === "rejected") throw libsResult.reason;
      const res = dataResult.value;
      if (dataResult.status === "rejected") throw dataResult.reason;
      if (res.status === 401 || res.status === 403) { this._unauthorized(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load location data.");
      this.geoData = data;
      this._drawCurrentMap();
    } catch (e) {
      const wrap = this.root.querySelector("#paMapSvgWrap");
      wrap.innerHTML = `<div class="pa-empty">Could not load the map: ${e.message}</div>`;
    }
  };

  PFPIAnalytics.prototype._drawCurrentMap = function () {
    if (!this.geoData) return;
    if (this.geoView === "world") this._renderWorldMap();
    else this._renderUSMap();
  };

  PFPIAnalytics.prototype._tooltip = function () {
    let tip = document.body.querySelector("#paMapTooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "paMapTooltip";
      tip.className = "pa-map-tooltip";
      document.body.appendChild(tip);
    }
    return tip;
  };

  PFPIAnalytics.prototype._renderWorldMap = async function () {
    const d3 = global.d3, topojson = global.topojson;
    const wrap = this.root.querySelector("#paMapSvgWrap");
    wrap.innerHTML = `<div class="pa-empty">Loading world map…</div>`;
    let topo;
    try {
      topo = await fetch(WORLD_TOPO_URL).then(r => r.json());
    } catch (e) {
      wrap.innerHTML = `<div class="pa-empty">Could not load world map data.</div>`;
      return;
    }
    const features = topojson.feature(topo, topo.objects.countries).features;
    const countryCounts = this.geoData.countries || {};
    const maxCount = Math.max(1, ...Object.values(countryCounts).map(Number));
    const colorScale = d3.scaleSequential(d3.interpolateOranges).domain([0, Math.max(1, Math.sqrt(maxCount))]);

    wrap.innerHTML = "";
    const width = 900, height = 480;
    const svg = d3.select(wrap).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
    const projection = d3.geoNaturalEarth1().fitSize([width - 10, height - 10], { type: "Sphere" });
    const path = d3.geoPath(projection);
    const tip = this._tooltip();
    const self = this;

    svg.append("path").attr("d", path({ type: "Sphere" })).attr("fill", "none");

    svg.selectAll("path.pa-map-feature")
      .data(features)
      .join("path")
      .attr("class", "pa-map-feature")
      .attr("d", path)
      .attr("fill", d => {
        const a2 = NUMERIC_TO_ALPHA2[String(d.id).padStart(3, "0")];
        const count = a2 ? (countryCounts[a2] || 0) : 0;
        return count > 0 ? colorScale(Math.sqrt(count)) : "rgba(255,255,255,0.06)";
      })
      .on("mousemove", function (event, d) {
        const a2 = NUMERIC_TO_ALPHA2[String(d.id).padStart(3, "0")];
        const count = a2 ? (countryCounts[a2] || 0) : 0;
        const name = (d.properties && d.properties.name) || a2 || "Unknown";
        tip.style.display = "block";
        tip.style.left = (event.clientX + 14) + "px";
        tip.style.top = (event.clientY + 10) + "px";
        tip.textContent = `${name}: ${count.toLocaleString()} visit${count === 1 ? "" : "s"}`;
      })
      .on("mouseleave", function () { tip.style.display = "none"; })
      .on("click", function (event, d) {
        const a2 = NUMERIC_TO_ALPHA2[String(d.id).padStart(3, "0")];
        const name = (d.properties && d.properties.name) || a2 || "Unknown";
        if (a2) self._showCountryDrilldown(a2, name);
      });
  };

  PFPIAnalytics.prototype._renderUSMap = async function () {
    const d3 = global.d3, topojson = global.topojson;
    const wrap = this.root.querySelector("#paMapSvgWrap");
    wrap.innerHTML = `<div class="pa-empty">Loading US map…</div>`;
    let topo;
    try {
      topo = await fetch(US_TOPO_URL).then(r => r.json());
    } catch (e) {
      wrap.innerHTML = `<div class="pa-empty">Could not load US map data.</div>`;
      return;
    }
    const features = topojson.feature(topo, topo.objects.states).features;

    // Region counts are stored as "US|<region name>" -- pull just the US
    // slice out of the flat all-time map this.geoData.regions gives us.
    const stateCounts = {};
    Object.keys(this.geoData.regions || {}).forEach(key => {
      const parts = key.split("|");
      if (parts[0] === "US" && parts[1]) stateCounts[parts[1]] = this.geoData.regions[key];
    });
    const maxCount = Math.max(1, ...Object.values(stateCounts).map(Number));
    const colorScale = d3.scaleSequential(d3.interpolateOranges).domain([0, Math.max(1, Math.sqrt(maxCount))]);

    wrap.innerHTML = "";
    const width = 900, height = 560;
    const svg = d3.select(wrap).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
    const projection = d3.geoAlbersUsa().fitSize([width - 10, height - 10], { type: "FeatureCollection", features });
    const path = d3.geoPath(projection);
    const tip = this._tooltip();
    const self = this;

    svg.selectAll("path.pa-map-feature")
      .data(features)
      .join("path")
      .attr("class", "pa-map-feature")
      .attr("d", path)
      .attr("fill", d => {
        const name = d.properties && d.properties.name;
        const count = name ? (stateCounts[name] || 0) : 0;
        return count > 0 ? colorScale(Math.sqrt(count)) : "rgba(255,255,255,0.06)";
      })
      .on("mousemove", function (event, d) {
        const name = (d.properties && d.properties.name) || "Unknown";
        const count = stateCounts[name] || 0;
        tip.style.display = "block";
        tip.style.left = (event.clientX + 14) + "px";
        tip.style.top = (event.clientY + 10) + "px";
        tip.textContent = `${name}: ${count.toLocaleString()} visit${count === 1 ? "" : "s"}`;
      })
      .on("mouseleave", function () { tip.style.display = "none"; })
      .on("click", function (event, d) {
        const name = d.properties && d.properties.name;
        if (name) self._showStateDrilldown(name);
      });
  };

  PFPIAnalytics.prototype._showCountryDrilldown = function (countryCode, countryName) {
    const hdr = this.root.querySelector("#paDrillHdr");
    const hint = this.root.querySelector("#paDrillHint");
    const list = this.root.querySelector("#paDrillList");
    hdr.textContent = countryName + " — regions";
    hint.textContent = "All-time recorded visits by region within this country.";

    const regions = {};
    Object.keys(this.geoData.regions || {}).forEach(key => {
      const parts = key.split("|");
      if (parts[0] === countryCode && parts[1]) regions[parts[1]] = this.geoData.regions[key];
    });
    const entries = Object.entries(regions).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      list.innerHTML = `<div class="pa-empty">No region-level data recorded for ${countryName} yet.</div>`;
      return;
    }
    const maxVal = entries[0][1] || 1;
    list.innerHTML = entries.map(([name, count]) => `
      <div class="pa-ref-row">
        <div class="pa-ref-name">${name}</div>
        <div class="pa-ref-bar-wrap"><div class="pa-ref-bar" style="width:${Math.round(count / maxVal * 100)}%"></div></div>
        <div class="pa-ref-count">${count}</div>
      </div>`).join("");
  };

  PFPIAnalytics.prototype._showStateDrilldown = function (stateName) {
    const hdr = this.root.querySelector("#paDrillHdr");
    const hint = this.root.querySelector("#paDrillHint");
    const list = this.root.querySelector("#paDrillList");
    hdr.textContent = stateName + " — cities";
    hint.textContent = "All-time recorded visits by city within this state.";

    const cities = {};
    Object.keys(this.geoData.cities || {}).forEach(key => {
      const parts = key.split("|");
      if (parts[0] === "US" && parts[1] === stateName && parts[2]) cities[parts[2]] = this.geoData.cities[key];
    });
    const entries = Object.entries(cities).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      list.innerHTML = `<div class="pa-empty">No city-level data recorded for ${stateName} yet.</div>`;
      return;
    }
    const maxVal = entries[0][1] || 1;
    list.innerHTML = entries.map(([name, count]) => `
      <div class="pa-ref-row">
        <div class="pa-ref-name">${name}</div>
        <div class="pa-ref-bar-wrap"><div class="pa-ref-bar" style="width:${Math.round(count / maxVal * 100)}%"></div></div>
        <div class="pa-ref-count">${count}</div>
      </div>`).join("");
  };

  global.PFPIAnalytics = {
    mount: function (rootEl, opts) { return new PFPIAnalytics(rootEl, opts); },
  };
})(window);
