/* WhoUnfollowedMe — renderer */
'use strict';

const bridge = window.api; // named differently from window.api: Electron makes that global non-configurable
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dtFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return dayFmt.format(ts);
}

const ICON = {
  keep: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6M16 11h6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6M19 8v6M16 11h6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  lock: '<svg viewBox="0 0 24 24" class="i-lock"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  check: '<svg viewBox="0 0 24 24" class="i-verified"><path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path class="tick" d="M8.5 12.2l2.3 2.3 4.7-4.8"/></svg>',
};

// ---------- state ----------
const S = {
  key: null, store: null, d: null, loggedIn: false, accounts: [],
  view: 'overview', q: '', chips: new Set(), sort: 'default', showKept: false,
  skipConfirm: false, busy: new Set(),
};
const isImport = () => S.key === 'import';
const user = (id) => S.store.users[id] || { id, username: id, full_name: '' };

const VIEWS = {
  overview: { label: 'Overview', group: 'Insights' },
  notBack: { label: "Don't follow back", group: 'Insights', tone: 'coral' },
  unfollowers: { label: 'Unfollowed you', group: 'Insights', tone: 'coral' },
  newFollowers: { label: 'New followers', group: 'Insights', tone: 'mint' },
  fans: { label: "You don't follow back", group: 'Insights', tone: 'amber' },
  mutuals: { label: 'Mutuals', group: 'Insights', tone: 'mint' },
  followers: { label: 'Followers', group: 'Lists' },
  following: { label: 'Following', group: 'Lists' },
  history: { label: 'Scan history', group: 'Lists' },
};

function derive() {
  const snaps = S.store?.snapshots || [];
  const cur = snaps.at(-1);
  if (!cur) return null;
  const prev = snaps.at(-2);
  const fol = new Set(cur.followers);
  const ing = new Set(cur.following);
  const kept = new Set(S.store.whitelist);
  const prevFol = new Set(prev ? prev.followers : []);
  const notBackAll = cur.following.filter((id) => !fol.has(id));
  const lostAt = new Map();
  for (let i = 1; i < snaps.length; i++) {
    const now = new Set(snaps[i].followers);
    for (const id of snaps[i - 1].followers) if (!now.has(id)) lostAt.set(id, snaps[i].ts);
  }
  return {
    cur, prev, fol, ing, kept, lostAt,
    followers: cur.followers,
    following: cur.following,
    mutuals: cur.following.filter((id) => fol.has(id)),
    fans: cur.followers.filter((id) => !ing.has(id)),
    notBackAll,
    notBack: notBackAll.filter((id) => !kept.has(id)),
    keptCount: notBackAll.length - notBackAll.filter((id) => !kept.has(id)).length,
    newFollowers: prev ? cur.followers.filter((id) => !prevFol.has(id)) : [],
    lostSinceLast: prev ? prev.followers.filter((id) => !fol.has(id)) : [],
    unfollowers: [...lostAt.entries()].filter(([id]) => !fol.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id),
  };
}

// ---------- shell ----------
function show(el, on) { el.hidden = !on; }

function showWelcome() {
  show($('#shell'), false);
  show($('#welcome'), true);
  const rec = $('#recent-accounts');
  const list = S.accounts || [];
  rec.innerHTML = list.length
    ? `<p class="recent-title">Saved scans on this computer</p>${list.map((a) => `
      <button class="recent-item" data-key="${esc(a.key)}">
        ${avatar({ username: a.username, pic: a.pic }, 'sm')}
        <span><b>${a.key === 'import' ? 'Data download' : '@' + esc(a.username)}</b><small>Last scan ${esc(ago(a.last))}</small></span>
      </button>`).join('')}`
    : '';
}

function showShell() {
  show($('#welcome'), false);
  show($('#shell'), true);
  renderAll();
}

function renderAll() {
  S.d = derive();
  renderMe();
  renderNav();
  renderView();
}

function renderMe() {
  const p = S.store.profile || {};
  const snap = S.d?.cur;
  $('#me').innerHTML = `
    <div class="me-row">
      ${avatar(p, 'md')}
      <div class="me-id">
        <b>${esc(p.full_name || p.username || 'Your account')}</b>
        <span>${isImport() ? 'From a data download' : p.username ? '@' + esc(p.username) : 'Instagram account'}</span>
      </div>
    </div>
    <div class="me-stats">
      <div><b>${fmt(snap ? snap.followers.length : p.followers)}</b><span>followers</span></div>
      <div><b>${fmt(snap ? snap.following.length : p.following)}</b><span>following</span></div>
    </div>`;
  $('#last-scan').textContent = snap ? `Last scan ${ago(snap.ts)}` : 'No scans yet';
  $('#btn-scan').textContent = isImport() ? 'Scan with Instagram login' : 'Scan now';
}

function countFor(view) {
  const d = S.d;
  if (!d) return null;
  return { notBack: d.notBack.length, unfollowers: d.unfollowers.length, newFollowers: d.newFollowers.length, fans: d.fans.length, mutuals: d.mutuals.length, followers: d.followers.length, following: d.following.length, history: S.store.snapshots.length }[view] ?? null;
}

function renderNav() {
  let html = '';
  let group = '';
  for (const [key, v] of Object.entries(VIEWS)) {
    if (v.group !== group) { group = v.group; html += `<p class="nav-group">${group}</p>`; }
    const c = countFor(key);
    html += `<button class="nav-item ${S.view === key ? 'active' : ''}" data-view="${key}">
      <span class="dot ${v.tone || ''}"></span><span class="nav-label">${v.label}</span>
      ${c != null && key !== 'overview' ? `<span class="nav-count ${v.tone && c ? v.tone : ''}">${fmt(c)}</span>` : ''}
    </button>`;
  }
  $('#nav').innerHTML = html;
}

function go(view) {
  S.view = view; S.q = ''; S.chips.clear(); S.sort = 'default';
  renderNav();
  renderView();
  $('.content').scrollTop = 0;
}

function renderView() {
  if (!S.d) {
    $('#view').innerHTML = `<div class="empty big"><h2>No scan yet</h2><p>You're logged in. Press Scan now to sort your followers.</p>
      <button class="btn primary" data-act="scan">Scan now</button></div>`;
    return;
  }
  if (S.view === 'overview') return renderOverview();
  if (S.view === 'history') return renderHistory();
  return renderListView(S.view);
}

// ---------- avatars ----------
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function initials(u) { return esc(((u.full_name || u.username || '?').replace(/[^\p{L}\p{N}]/gu, '') || '?').slice(0, 1).toUpperCase()); }
function avatar(u, size = '') {
  const fb = `<span class="av av-fb ${size}" style="--h:${hue(u.username || '')}">${initials(u)}</span>`;
  if (!u.pic) return fb;
  // Pictures load through the app (igimg://), which caches them on disk so they still show after Instagram's links expire.
  const src = `igimg://avatar/?id=${encodeURIComponent(u.id || u.username || 'x')}&src=${encodeURIComponent(u.pic)}`;
  return `<img class="av ${size}" src="${esc(src)}" loading="lazy" decoding="async" alt="" data-fb="${esc(fb)}">`;
}
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.dataset.fb) t.outerHTML = t.dataset.fb;
}, true);

// ---------- overview ----------
function lensArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

function vennSvg(nA, nB, nAB) {
  const W = 640; const H = 400;
  let r1 = Math.max(Math.sqrt(nA), 1); let r2 = Math.max(Math.sqrt(nB), 1);
  const target = (nAB / Math.max(nA, nB, 1)) * Math.PI * Math.max(r1, r2) ** 2;
  let d;
  if (nAB <= 0) d = r1 + r2 + 4;
  else {
    let lo = Math.abs(r1 - r2); let hi = r1 + r2;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (lensArea(r1, r2, m) > target) lo = m; else hi = m; }
    d = (lo + hi) / 2;
  }
  // keep every region visible
  // readability over strict area accuracy: every region gets room for its number
  const minR = Math.min(r1, r2);
  d = Math.max(d, Math.abs(r1 - r2) + minR * 0.75);
  if (nAB > 0) d = Math.min(d, r1 + r2 - minR * 0.6);
  const w = r1 + d + r2;
  const s = Math.min((W - 60) / w, (H - 90) / (2 * Math.max(r1, r2)));
  r1 *= s; r2 *= s; d *= s;
  const x1 = (W - (r1 + d + r2)) / 2 + r1; const x2 = x1 + d; const cy = H / 2 + 14;
  const cxFans = ((x1 - r1) + (x2 - r2)) / 2;
  const cxMut = ((x2 - r2) + (x1 + r1)) / 2;
  const cxNot = ((x1 + r1) + (x2 + r2)) / 2;
  const top = cy - Math.max(r1, r2) - 18;
  const d0 = S.d;
  return `<svg viewBox="0 0 ${W} ${H}" class="venn" id="venn" data-geo='${JSON.stringify({ x1, x2, cy, r1, r2 })}' role="img"
      aria-label="${fmt(nA)} followers, ${fmt(nB)} following, ${fmt(nAB)} mutual">
    <defs><clipPath id="clipA"><circle cx="${x1}" cy="${cy}" r="${r1}"/></clipPath></defs>
    <circle class="v-a" cx="${x1}" cy="${cy}" r="${r1}"/>
    <circle class="v-b" cx="${x2}" cy="${cy}" r="${r2}"/>
    <circle class="v-ab" cx="${x2}" cy="${cy}" r="${r2}" clip-path="url(#clipA)"/>
    <text class="v-cap" x="${x1 - r1}" y="${top}" text-anchor="start">People who follow you</text>
    <text class="v-cap" x="${x2 + r2}" y="${top}" text-anchor="end">People you follow</text>
    <text class="v-num amber" x="${cxFans}" y="${cy + 10}" text-anchor="middle">${fmt(d0.fans.length)}</text>
    <text class="v-num mint" x="${cxMut}" y="${cy + 10}" text-anchor="middle">${fmt(nAB)}</text>
    <text class="v-num coral" x="${cxNot}" y="${cy + 10}" text-anchor="middle">${fmt(d0.notBack.length)}</text>
  </svg>`;
}

function vennRegion(evt) {
  const svg = $('#venn');
  if (!svg) return null;
  const g = JSON.parse(svg.dataset.geo);
  const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const inA = (p.x - g.x1) ** 2 + (p.y - g.cy) ** 2 <= g.r1 ** 2;
  const inB = (p.x - g.x2) ** 2 + (p.y - g.cy) ** 2 <= g.r2 ** 2;
  return inA && inB ? 'mutuals' : inA ? 'fans' : inB ? 'notBack' : null;
}

function faces(ids, n = 6) {
  return `<div class="faces">${ids.slice(0, n).map((id) => avatar(user(id), 'xs')).join('')}${ids.length > n ? `<span class="more">+${fmt(ids.length - n)}</span>` : ''}</div>`;
}

function renderOverview() {
  const d = S.d;
  const p = S.store.profile || {};
  const nb = d.notBack.length;
  const headline = nb === 0
    ? 'Everyone you follow follows you back.'
    : `${plural(nb, 'account', 'accounts')} you follow ${nb === 1 ? "doesn't" : "don't"} follow you back.`;
  const followersSeries = S.store.snapshots.map((s) => ({ t: s.ts, v: s.followers.length }));

  let changes;
  if (!d.prev) {
    changes = `<p class="muted">This is your first scan. Scan again in a few days and this panel shows exactly who unfollowed you in between.</p>`;
  } else {
    const net = d.followers.length - d.prev.followers.length;
    changes = `
      <p class="since">Compared with ${esc(dtFmt.format(d.prev.ts))}</p>
      <button class="change-row" data-view="unfollowers">
        <span class="c-num coral">${fmt(d.lostSinceLast.length)}</span>
        <span class="c-text"><b>${d.lostSinceLast.length === 1 ? 'person unfollowed you' : 'people unfollowed you'}</b>${d.lostSinceLast.length ? faces(d.lostSinceLast) : ''}</span>
      </button>
      <button class="change-row" data-view="newFollowers">
        <span class="c-num mint">${fmt(d.newFollowers.length)}</span>
        <span class="c-text"><b>${d.newFollowers.length === 1 ? 'new follower' : 'new followers'}</b>${d.newFollowers.length ? faces(d.newFollowers) : ''}</span>
      </button>
      <p class="net ${net < 0 ? 'down' : 'up'}">Net change: ${net > 0 ? '+' : ''}${fmt(net)} followers</p>`;
  }

  $('#view').innerHTML = `
    <div class="page-head">
      <h1>${esc(headline)}</h1>
      <p class="muted">${isImport() ? 'From your Instagram data download' : p.username ? `@${esc(p.username)}` : 'Your account'}, scanned ${esc(dtFmt.format(d.cur.ts))}. Click any part of the diagram to see the accounts.</p>
    </div>
    <div class="ov-grid">
      <section class="venn-wrap">
        ${vennSvg(d.followers.length, d.following.length, d.mutuals.length)}
        <div class="legend">
          <button data-view="fans" class="lg-item amber"><b>${fmt(d.fans.length)}</b><span>you don't follow back</span></button>
          <button data-view="mutuals" class="lg-item mint"><b>${fmt(d.mutuals.length)}</b><span>mutuals</span></button>
          <button data-view="notBack" class="lg-item coral"><b>${fmt(nb)}</b><span>don't follow you back${d.keptCount ? ` (${fmt(d.keptCount)} starred hidden)` : ''}</span></button>
        </div>
      </section>
      <aside class="side-panel">
        <h2>Since your last scan</h2>
        ${changes}
        <div class="trend">
          <h3>Followers over time</h3>
          ${followersSeries.length > 1 ? lineChart([{ name: 'Followers', cls: 'lilac', pts: followersSeries }], 320, 120, true) : '<p class="muted small">The trend appears after your second scan.</p>'}
        </div>
        <div class="ratio">
          <div><b>${(d.following.length ? (d.followers.length / d.following.length) : 0).toFixed(2)}</b><span>followers per account you follow</span></div>
          <div><b>${d.following.length ? Math.round((d.mutuals.length / d.following.length) * 100) : 0}%</b><span>of the people you follow follow back</span></div>
        </div>
      </aside>
    </div>`;
}

// ---------- charts ----------
function lineChart(series, W, H, compact = false) {
  const all = series.flatMap((s) => s.pts);
  let min = Math.min(...all.map((p) => p.v)); let max = Math.max(...all.map((p) => p.v));
  if (min === max) { min -= 1; max += 1; }
  const pad = { l: compact ? 4 : 44, r: 8, t: 10, b: compact ? 18 : 26 };
  const n = series[0].pts.length;
  const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const paths = series.map((s) => {
    const dPath = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const last = s.pts.at(-1);
    return `<path class="ln ${s.cls}" d="${dPath}"/><circle class="pt ${s.cls}" cx="${x(n - 1)}" cy="${y(last.v)}" r="3.5"/>`;
  }).join('');
  const t0 = series[0].pts[0].t; const t1 = series[0].pts.at(-1).t;
  const grid = compact ? '' : [min, (min + max) / 2, max].map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(Math.round(v))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${paths}
    <text class="ax" x="${pad.l}" y="${H - 4}">${esc(dayFmt.format(t0))}</text>
    <text class="ax" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${esc(dayFmt.format(t1))}</text></svg>`;
}

// ---------- history ----------
function renderHistory() {
  const snaps = S.store.snapshots;
  const rows = snaps.map((s, i) => {
    const prev = snaps[i - 1];
    let gained = '—'; let lost = '—';
    if (prev) {
      const a = new Set(prev.followers); const b = new Set(s.followers);
      gained = s.followers.filter((id) => !a.has(id)).length;
      lost = prev.followers.filter((id) => !b.has(id)).length;
    }
    return `<tr><td>${esc(dtFmt.format(s.ts))}</td><td>${fmt(s.followers.length)}</td><td>${fmt(s.following.length)}</td>
      <td class="mint">${gained === '—' || gained === 0 ? gained : '+' + fmt(gained)}</td><td class="coral">${lost === '—' || lost === 0 ? lost : '−' + fmt(lost)}</td></tr>`;
  }).reverse().join('');
  $('#view').innerHTML = `
    <div class="page-head row-head">
      <div><h1>Scan history</h1><p class="muted">${plural(snaps.length, 'scan', 'scans')} saved on this computer. Each scan is compared with the one before it.</p></div>
      ${snaps.length > 1 ? '<button class="btn ghost" data-act="clear-history">Clear older scans</button>' : ''}
    </div>
    ${snaps.length > 1 ? `<section class="chart-panel">
      <div class="chart-legend"><span class="lilac">Followers</span><span class="haze">Following</span></div>
      ${lineChart([
    { name: 'Followers', cls: 'lilac', pts: snaps.map((s) => ({ t: s.ts, v: s.followers.length })) },
    { name: 'Following', cls: 'haze', pts: snaps.map((s) => ({ t: s.ts, v: s.following.length })) },
  ], 900, 260)}</section>` : ''}
    <table class="hist"><thead><tr><th>Scanned</th><th>Followers</th><th>Following</th><th>Gained</th><th>Lost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- list views ----------
const LIST_COPY = {
  notBack: (d) => `${plural(d.notBack.length, 'account', 'accounts')} you follow ${d.notBack.length === 1 ? "doesn't" : "don't"} follow you back. Star the ones you're fine with, like celebrities and brands, to hide them.`,
  unfollowers: (d) => (S.store.snapshots.length < 2 ? 'Each scan is compared with the one before, so this fills in from your second scan.' : `${plural(d.unfollowers.length, 'person has', 'people have')} stopped following you across your saved scans, newest first.`),
  newFollowers: (d) => (d.prev ? `Started following you since ${dtFmt.format(d.prev.ts)}.` : 'New followers appear after your second scan.'),
  fans: () => "They follow you, but you don't follow them.",
  mutuals: () => 'You follow each other.',
  followers: () => 'Everyone who follows you.',
  following: () => 'Everyone you follow, most recent first.',
};

const EMPTY = {
  notBack: ['Everyone you follow follows you back.', 'Nothing to clean up here.'],
  unfollowers: ['Nobody has unfollowed you.', 'Scan again in a few days to keep checking.'],
  newFollowers: ['No new followers since the last scan.', ''],
  fans: ["You follow back everyone who follows you.", ''],
  mutuals: ['No mutuals yet.', ''],
  followers: ['No followers found.', ''],
  following: ["You aren't following anyone.", ''],
};

function idsFor(view) {
  const d = S.d;
  if (view === 'notBack') return S.showKept ? d.notBackAll : d.notBack;
  return d[view] || [];
}

function filtered(view) {
  const q = S.q.trim().toLowerCase().replace(/^@/, '');
  let list = idsFor(view).map(user).filter((u) => {
    if (q && !(u.username.toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q))) return false;
    if (S.chips.has('verified') && !u.verified) return false;
    if (S.chips.has('private') && !u.private) return false;
    if (S.chips.has('still') && !S.d.ing.has(u.id)) return false;
    return true;
  });
  if (S.sort === 'az') list = [...list].sort((a, b) => a.username.localeCompare(b.username));
  if (S.sort === 'name') list = [...list].sort((a, b) => (a.full_name || a.username).localeCompare(b.full_name || b.username));
  return list;
}

function renderListView(view) {
  const v = VIEWS[view];
  const d = S.d;
  const chips = [['verified', 'Verified'], ['private', 'Private']];
  if (view === 'unfollowers') chips.unshift(['still', 'You still follow them']);
  $('#view').innerHTML = `
    <div class="page-head">
      <h1 class="${v.tone || ''}">${v.label}</h1>
      <p class="muted">${esc(LIST_COPY[view](d))}</p>
    </div>
    <div class="toolbar">
      <label class="search">${ICON.search}<input id="q" type="search" placeholder="Search by name or username" value="${esc(S.q)}" spellcheck="false"><kbd>Ctrl K</kbd></label>
      <div class="chips">
        ${chips.map(([k, l]) => `<button class="chip ${S.chips.has(k) ? 'on' : ''}" data-chip="${k}">${l}</button>`).join('')}
        ${view === 'notBack' && d.keptCount ? `<button class="chip ${S.showKept ? 'on' : ''}" data-act="toggle-kept">Show ${fmt(d.keptCount)} starred</button>` : ''}
      </div>
      <select id="sort" aria-label="Sort">
        <option value="default">${view === 'following' || view === 'notBack' ? 'Recently followed' : 'Instagram order'}</option>
        <option value="az">Username A–Z</option>
        <option value="name">Name A–Z</option>
      </select>
      <button class="btn ghost icon-btn" data-act="export" title="Export this list as CSV">${ICON.download}<span>Export</span></button>
    </div>
    <p class="result-count" id="result-count"></p>
    <div class="list" id="list"></div>`;
  $('#sort').value = S.sort;
  renderRows(view);
}

let rowObserver = null;
function renderRows(view) {
  const list = filtered(view);
  const el = $('#list');
  const total = idsFor(view).length;
  $('#result-count').textContent = list.length === total ? plural(total, 'account', 'accounts') : `${fmt(list.length)} of ${fmt(total)} accounts`;
  if (rowObserver) rowObserver.disconnect();
  if (!list.length) {
    const [h, p] = S.q || S.chips.size ? ['No accounts match your search.', 'Try a different name or clear the filters.'] : EMPTY[view];
    el.innerHTML = `<div class="empty"><h2>${esc(h)}</h2>${p ? `<p>${esc(p)}</p>` : ''}</div>`;
    return;
  }
  el.innerHTML = '';
  let i = 0;
  const CHUNK = 80;
  const more = () => {
    const frag = document.createElement('div');
    frag.innerHTML = list.slice(i, i + CHUNK).map((u) => row(u, view)).join('');
    el.append(...frag.children);
    i += CHUNK;
    if (i < list.length) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sentinel';
      el.append(sentinel);
      rowObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) { rowObserver.disconnect(); sentinel.remove(); more(); }
      }, { root: $('.content'), rootMargin: '600px' });
      rowObserver.observe(sentinel);
    }
  };
  more();
}

function row(u, view) {
  const d = S.d;
  const kept = d.kept.has(u.id);
  const tags = [];
  if (view === 'unfollowers') {
    tags.push(`<span class="tag">Left ${esc(dayFmt.format(d.lostAt.get(u.id)))}</span>`);
    if (d.ing.has(u.id)) tags.push('<span class="tag coral">You still follow them</span>');
  }
  if (view === 'following') tags.push(d.fol.has(u.id) ? '<span class="tag mint">Mutual</span>' : '<span class="tag coral">Doesn\'t follow back</span>');
  if (view === 'followers' && !d.ing.has(u.id)) tags.push('<span class="tag amber">You don\'t follow</span>');
  if (view === 'notBack' && kept) tags.push('<span class="tag lilac">Starred</span>');

  const acts = [];
  if (view === 'notBack' || (view === 'following' && !d.fol.has(u.id))) {
    acts.push(`<button class="act keep ${kept ? 'on' : ''}" data-act="keep" title="${kept ? 'Unstar: show in Don\'t follow back again' : 'Star: hide from Don\'t follow back'}" aria-pressed="${kept}">${ICON.keep}</button>`);
  }
  acts.push(`<button class="act" data-act="open" title="Open profile on instagram.com">${ICON.open}</button>`);
  if (!isImport() && S.loggedIn) {
    const busy = S.busy.has(u.id);
    if (d.ing.has(u.id) && ['notBack', 'unfollowers', 'following'].includes(view)) {
      acts.push(`<button class="act-text danger" data-act="unfollow" ${busy ? 'disabled' : ''}>${busy ? 'Unfollowing…' : 'Unfollow'}</button>`);
    } else if (!d.ing.has(u.id) && ['fans', 'followers', 'newFollowers', 'unfollowers'].includes(view)) {
      acts.push(`<button class="act-text" data-act="follow" ${busy ? 'disabled' : ''}>${busy ? 'Following…' : 'Follow back'}</button>`);
    }
  }
  return `<div class="row" data-id="${esc(u.id)}">
    ${avatar(u)}
    <div class="who">
      <b>${esc(u.full_name || u.username)}${u.verified ? ICON.check : ''}</b>
      <span>@${esc(u.username)}${u.private ? ICON.lock : ''}</span>
    </div>
    <div class="tags">${tags.join('')}</div>
    <div class="acts">${acts.join('')}</div>
  </div>`;
}

function removeRow(id) {
  const el = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.add('leaving');
  setTimeout(() => { el.remove(); const v = S.view; const total = idsFor(v).length; const rc = $('#result-count'); if (rc) rc.textContent = plural(total, 'account', 'accounts'); }, 260);
}
function refreshRow(id) {
  const el = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (el) el.outerHTML = row(user(id), S.view);
}

// ---------- actions ----------
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 7000 : 4000);
}

function confirmBox({ title, body, ok, skippable = false }) {
  if (skippable && S.skipConfirm) return Promise.resolve(true);
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    $('#modal-ok').textContent = ok;
    $('#modal-skip').checked = false;
    show($('.check'), skippable);
    show($('#modal'), true);
    $('#modal-ok').focus();
    const done = (v) => {
      if (v && skippable && $('#modal-skip').checked) S.skipConfirm = true;
      show($('#modal'), false);
      $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

async function friendship(id, kind) {
  const u = user(id);
  if (kind === 'destroy') {
    const ok = await confirmBox({
      title: `Unfollow @${u.username}?`,
      body: 'Instagram limits how many accounts you can unfollow in a short time, so the app waits a few seconds between unfollows.',
      ok: 'Unfollow', skippable: true,
    });
    if (!ok) return;
  }
  S.busy.add(id);
  refreshRow(id);
  const r = await bridge.friendship(S.key, id, kind);
  S.busy.delete(id);
  if (!r.ok) {
    refreshRow(id);
    toast(r.message || 'That didn\'t work. Try again in a minute.', 'error');
    if (r.code === 'AUTH') return backToStart(r.message);
    return;
  }
  S.store = r.store;
  S.d = derive();
  renderNav();
  renderMe();
  if (kind === 'destroy') {
    toast(`Unfollowed @${u.username}`, 'success');
    refreshRow(id);
    if (S.view === 'notBack' || (S.view === 'unfollowers' && S.chips.has('still'))) removeRow(id);
  } else {
    toast(r.requested ? `Follow request sent to @${u.username}` : `Following @${u.username}`, 'success');
    if (S.view === 'fans' && !r.requested) removeRow(id); else refreshRow(id);
  }
}

async function toggleKeep(id) {
  const on = !S.d.kept.has(id);
  S.store.whitelist = await bridge.setKept(S.key, id, on);
  S.d = derive();
  renderNav();
  if (S.view === 'notBack' && on && !S.showKept) {
    removeRow(id);
    toast(`Starred @${user(id).username}. Turn on “Show starred” to see starred accounts.`);
  } else refreshRow(id);
}

function exportCsv() {
  const list = filtered(S.view);
  const cell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['username', 'full_name', 'profile_url', 'verified', 'private'].join(',')]
    .concat(list.map((u) => [u.username, u.full_name, `https://www.instagram.com/${u.username}/`, u.verified, u.private].map(cell).join(',')));
  const name = VIEWS[S.view].label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  bridge.exportFile(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\r\n'))
    .then((r) => r.ok && toast(`Exported ${plural(list.length, 'account', 'accounts')}`, 'success'));
}

// ---------- scan ----------
let waitTimer = null;
function setScan({ phase, step, count = 0, total, waiting, reason, note, estimated }) {
  const titles = { profile: 'Opening your profile', followers: 'Reading your followers', following: 'Reading who you follow' };
  const s = step || (phase === 'followers' ? 1 : phase === 'following' ? 2 : 0);
  $('#scan-step').textContent = s ? `Step ${s} of 2` : 'Getting ready';
  $('#scan-title').textContent = titles[phase] || 'Scanning';

  const known = phase !== 'profile' && total > 0;
  const pct = known ? Math.min(100, Math.floor((count / total) * 100)) : 0;
  if (phase === 'profile') {
    $('#scan-count').textContent = '';
    $('#scan-pct').textContent = '';
  } else if (known) {
    $('#scan-count').textContent = `${fmt(Math.min(count, total))} / ${fmt(total)}`;
    $('#scan-pct').textContent = `${pct}%${estimated ? ' (total from your last scan)' : ''}`;
  } else {
    $('#scan-count').textContent = fmt(count);
    $('#scan-pct').textContent = 'Total not available yet';
  }
  const track = $('#scan-track');
  track.classList.toggle('indeterminate', !known);
  if (known) track.setAttribute('aria-valuenow', String(pct)); else track.removeAttribute('aria-valuenow');
  $('#scan-fill').style.width = known ? `${pct}%` : '';

  clearInterval(waitTimer);
  if (waiting) {
    const why = {
      rate: 'Instagram asked the app to slow down.',
      network: "Instagram didn't answer.",
      server: 'Instagram had a temporary problem.',
    }[reason] || 'Waiting for Instagram.';
    let left = Math.round(waiting / 1000);
    const upd = () => { $('#scan-sub').textContent = `${why} Trying again in ${left}s.`; left--; };
    upd();
    waitTimer = setInterval(() => (left >= 0 ? upd() : clearInterval(waitTimer)), 1000);
  } else if (note) {
    $('#scan-sub').textContent = note;
  } else if (phase !== 'profile') {
    $('#scan-sub').textContent = s === 1 ? 'Next: the accounts you follow.' : 'Almost done. Your results appear right after this.';
  }
}

async function runScan() {
  if (!S.loggedIn) {
    const r = await bridge.login();
    if (!r.loggedIn || !r.userId) return backToStart('Login didn’t finish, so nothing changed. Try again when you’re ready.');
    S.loggedIn = true;
    S.key = r.userId;
    S.store = await bridge.load(r.userId);
    showShell();
  }
  setScan({ phase: 'profile', note: 'Connecting to Instagram…' });
  show($('#scan'), true);
  const r = await bridge.scan();
  clearInterval(waitTimer);
  show($('#scan'), false);
  if (r.ok) {
    S.key = r.store.key;
    S.store = r.store;
    S.view = 'overview';
    renderAll();
    const d = S.d;
    toast(d.prev
      ? `Scan finished. ${plural(d.lostSinceLast.length, 'person', 'people')} unfollowed you since last time.`
      : `Scan finished. ${plural(d.notBack.length, 'account doesn\'t', 'accounts don\'t')} follow you back.`, 'success');
  } else if (r.code === 'CANCELLED') {
    toast('Scan cancelled. Nothing was saved.');
  } else if (r.code === 'AUTH') {
    await backToStart(r.message);
  } else {
    toast(r.message, 'error');
  }
}

// ---------- boot & events ----------
// Return to the welcome screen (used when a login fails or Instagram really logs you out).
async function backToStart(message) {
  S.loggedIn = false;
  S.key = null;
  S.store = null;
  S.d = null;
  try { S.accounts = (await bridge.status()).accounts; } catch { S.accounts = []; }
  showWelcome();
  if (message) toast(message, 'error');
}

async function openKey(key) {
  S.key = key;
  S.store = await bridge.load(key);
  S.view = 'overview';
  showShell();
}

async function doRestore() {
  const r = await bridge.importBackup();
  if (!r.ok) { if (!r.cancelled) toast(r.message, 'error'); return; }
  const added = r.restored.reduce((n, a) => n + a.added, 0);
  const who = r.restored.map((a) => (a.key === 'import' ? 'your data download' : a.username ? '@' + a.username : 'your account')).join(', ');
  toast(added ? `Restored ${plural(added, 'scan', 'scans')} for ${who}.` : `Everything in that backup was already here (${who}).`, 'success');
  // Show the restored account: the one already open if it was in the backup, otherwise the first one.
  const open = r.restored.find((a) => a.key === S.key) || r.restored[0];
  S.accounts = (await bridge.status()).accounts;
  await openKey(open.key);
}

async function doImport() {
  const r = await bridge.importDownload();
  if (r.ok) {
    S.key = 'import'; S.store = r.store; S.view = 'overview';
    showShell();
    toast(`Imported ${plural(S.d.followers.length, 'follower', 'followers')} and ${fmt(S.d.following.length)} following`, 'success');
  } else if (!r.cancelled) toast(r.message, 'error');
}

function markTheme() {
  document.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themePick === window.__themePref)));
}
markTheme();

document.addEventListener('click', async (e) => {
  const w = e.target.closest('[data-win]');
  if (w) return bridge[w.dataset.win]();
  const tp = e.target.closest('[data-theme-pick]');
  if (tp) {
    const pref = tp.dataset.themePick;
    await bridge.setTheme(pref);          // updates Windows' theme hint first so "system" resolves correctly
    window.__applyTheme(pref);
    return markTheme();
  }

  if (e.target.closest('#btn-login')) {
    const r = await bridge.login();
    if (r.loggedIn && r.userId) { S.loggedIn = true; await openKey(r.userId); if (!S.store.snapshots.length) runScan(); }
    else await backToStart('Login didn’t finish, so nothing changed. Try again when you’re ready.');
    return;
  }
  if (e.target.closest('#btn-import, #btn-import2')) return doImport();
  if (e.target.closest('#btn-backup')) {
    const r = await bridge.exportBackup();
    if (r.ok) toast(`Backed up ${plural(r.scans, 'scan', 'scans')}. Copy the file to another computer and choose Restore backup there.`, 'success');
    else if (!r.cancelled) toast(r.message, 'error');
    return;
  }
  if (e.target.closest('#btn-restore, #btn-restore2')) return doRestore();
  if (e.target.closest('#btn-folder')) return bridge.openDataFolder();
  if (e.target.closest('#btn-scan')) return runScan();
  if (e.target.closest('#btn-cancel')) { clearInterval(waitTimer); $('#scan-sub').textContent = 'Stopping…'; return bridge.cancelScan(); }
  if (e.target.closest('#btn-logout')) {
    const ok = await confirmBox({ title: 'Log out of Instagram?', body: 'Your saved scans stay on this computer. You can log back in any time.', ok: 'Log out' });
    if (!ok) return;
    await bridge.logout();
    S.loggedIn = false;
    S.accounts = (await bridge.status()).accounts;
    return showWelcome();
  }
  const rec = e.target.closest('.recent-item');
  if (rec) return openKey(rec.dataset.key);

  const nav = e.target.closest('[data-view]');
  if (nav) return go(nav.dataset.view);

  const venn = e.target.closest('#venn');
  if (venn) { const reg = vennRegion(e); if (reg) go(reg); return; }

  const chip = e.target.closest('[data-chip]');
  if (chip) {
    const k = chip.dataset.chip;
    S.chips.has(k) ? S.chips.delete(k) : S.chips.add(k);
    chip.classList.toggle('on');
    return renderRows(S.view);
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = act.closest('.row')?.dataset.id;
  switch (act.dataset.act) {
    case 'scan': return runScan();
    case 'export': return exportCsv();
    case 'toggle-kept': S.showKept = !S.showKept; return renderListView(S.view);
    case 'keep': return toggleKeep(id);
    case 'open': return bridge.openExternal(`https://www.instagram.com/${encodeURIComponent(user(id).username)}/`);
    case 'unfollow': return friendship(id, 'destroy');
    case 'follow': return friendship(id, 'create');
    case 'clear-history': {
      const older = S.store.snapshots.length - 1;
      const ok = await confirmBox({
        title: `Delete ${plural(older, 'older scan', 'older scans')}?`,
        body: `Only your latest scan is kept, so the record of who unfollowed you before it is lost. This can't be undone. To keep a copy, choose Back up scans first.`,
        ok: `Delete ${plural(older, 'scan', 'scans')}`,
      });
      if (!ok) return;
      S.store = await bridge.clearHistory(S.key);
      renderAll();
      return toast('Older scans cleared', 'success');
    }
    default:
  }
});

document.addEventListener('mousemove', (e) => {
  const svg = e.target.closest?.('#venn');
  const all = document.getElementById('venn');
  if (!all) return;
  const reg = svg ? vennRegion(e) : null;
  if (all.dataset.hover !== (reg || '')) all.dataset.hover = reg || '';
  all.style.cursor = reg ? 'pointer' : 'default';
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; renderRows(S.view); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') { S.sort = e.target.value; renderRows(S.view); }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q')?.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); if (!$('#shell').hidden && $('#scan').hidden) runScan(); }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { const q = $('#q'); if (q) { e.preventDefault(); q.focus(); } }
});

bridge.on('scan:progress', setScan);
bridge.on('win:state', ({ maximized }) => document.body.classList.toggle('maximized', maximized));

// Never leave a blank window: if something breaks before a screen is shown, show the welcome screen and the error.
function bootFailed(err) {
  if ($('#welcome').hidden && $('#shell').hidden) showWelcome();
  toast(`Something went wrong while starting: ${err && err.message ? err.message : err}`, 'error');
}
window.addEventListener('error', (e) => bootFailed(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => bootFailed(e.reason));

(async function boot() {
  const st = await bridge.status();
  S.loggedIn = st.loggedIn;
  S.accounts = st.accounts;
  if (st.loggedIn && st.userId) {
    await openKey(st.userId); // opens on your last results, or the "No scan yet" screen; never starts a scan by itself
  } else {
    showWelcome();
  }
}());
