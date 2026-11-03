// WhoUnfollowedMe — Electron main process
// Instagram has no public API for follower lists, so the app signs you in on
// instagram.com inside its own window and then reads your lists through that
// signed-in session, the same requests instagram.com makes when you open them.

const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, protocol, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

// Custom scheme for profile pictures (must be registered before the app is ready)
protocol.registerSchemesAsPrivileged([{ scheme: 'igimg', privileges: { standard: true, secure: true } }]);

const PARTITION = 'persist:instagram';
const IS_MAC = process.platform === 'darwin';
const IG = 'https://www.instagram.com';
const APP_ID = '936619743392459'; // instagram.com web client id
const MAX_SNAPSHOTS = 200;        // hard ceiling; the user picks how many to keep in Settings
const MIN_ACTION_GAP_MS = 4500;   // never faster than this between follow changes, even with Override
const REPO = 'CodePraisy/WhoUnfollowedMe';

let win = null;
let loginWin = null;
let worker = null;
let scanning = false;
let cancelScan = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);
const igSession = () => session.fromPartition(PARTITION);
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

class IgError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- debug log ----------
// Written next to the app (or in AppData when that folder is read-only). Holds request
// paths, status codes and errors only: never cookies or follower data.
let logFile = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  for (const f of logFile ? [logFile] : [path.join(__dirname, 'debug.log'), path.join(app.getPath('userData'), 'debug.log')]) {
    try {
      if (!logFile && fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, '');
      fs.appendFileSync(f, line);
      logFile = f;
      return;
    } catch { /* try next location */ }
  }
}
process.on('uncaughtException', (e) => log('main error', e.stack || String(e)));
process.on('unhandledRejection', (e) => log('main rejection', (e && e.stack) || String(e)));
const shortUrl = (u) => u.replace(IG, '').replace(/([?&](max_id|after|variables)=)[^&]+/g, '$1…');

// ---------- storage ----------
const dataDir = () => path.join(app.getPath('userData'), 'accounts');
const storePath = (key) => path.join(dataDir(), `${String(key).replace(/[^\w-]/g, '')}.json`);
const emptyStore = (key) => ({ key, profile: null, users: {}, snapshots: [], whitelist: [] });

function loadStore(key) {
  try { return JSON.parse(fs.readFileSync(storePath(key), 'utf8')); }
  catch { return emptyStore(key); }
}
function saveStore(store) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = storePath(store.key);
  fs.writeFileSync(p + '.tmp', JSON.stringify(store));
  fs.renameSync(p + '.tmp', p);
}
function listAccounts() {
  try {
    return fs.readdirSync(dataDir()).filter((f) => f.endsWith('.json')).map((f) => {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir(), f), 'utf8'));
      return { key: s.key, username: s.profile?.username, pic: s.profile?.pic, last: s.snapshots.at(-1)?.ts || null };
    }).filter((a) => a.last);
  } catch { return []; }
}
function addSnapshot(store, profile, followers, following, source) {
  for (const u of [...followers, ...following]) store.users[u.id] = { ...store.users[u.id], ...u };
  store.profile = profile;
  store.snapshots.push({
    ts: Date.now(), source,
    followers: followers.map((u) => u.id),
    following: following.map((u) => u.id),
    counts: { followers: profile.followers, following: profile.following },
  });
  const keepScans = getSettings().keepScans;
  if (store.snapshots.length > keepScans) store.snapshots.splice(0, store.snapshots.length - keepScans);
  // drop users no snapshot references any more
  const keep = new Set(store.whitelist);
  for (const s of store.snapshots) { s.followers.forEach((id) => keep.add(id)); s.following.forEach((id) => keep.add(id)); }
  for (const id of Object.keys(store.users)) if (!keep.has(id)) delete store.users[id];
}

// ---------- instagram session ----------
async function getCookie(name) {
  const c = await igSession().cookies.get({ url: IG, name });
  return c[0]?.value || null;
}

function openLogin() {
  return new Promise((resolve) => {
    if (loginWin) { loginWin.focus(); return resolve(false); }
    loginWin = new BrowserWindow({
      width: 480, height: 760, parent: win, title: 'Log in to Instagram',
      autoHideMenuBar: true, backgroundColor: '#ffffff', icon: iconPath(),
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    loginWin.loadURL(`${IG}/accounts/login/`);
    let done = false;
    const timer = setInterval(async () => {
      if (await getCookie('sessionid')) {
        done = true;
        clearInterval(timer);
        setTimeout(() => loginWin && !loginWin.isDestroyed() && loginWin.close(), 700);
        resolve(true);
      }
    }, 1000);
    loginWin.on('closed', () => { clearInterval(timer); loginWin = null; if (!done) resolve(false); });
  });
}

// Hidden same-origin page; fetches made from it carry the instagram.com cookies.
async function getWorker() {
  if (worker && !worker.isDestroyed()) return worker;
  log('opening helper page');
  const w = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const loaded = await raceCancel(w.loadURL(`${IG}/`).then(() => true, (e) => { log('helper page failed', e.message); return false; }), 30000);
  if (loaded !== true) {
    w.destroy();
    throw new IgError('NET', "Couldn't reach instagram.com. Check your internet connection and try again.");
  }
  worker = w;
  return worker;
}

// Resolve with the promise, or with `fallback` after `ms`. Rejects as soon as the user cancels.
function raceCancel(promise, ms, fallback = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); resolve(fallback); }, ms);
    const poll = setInterval(() => {
      if (cancelScan) { clearTimeout(timer); clearInterval(poll); reject(new IgError('CANCELLED', 'Scan cancelled.')); }
    }, 200);
    promise.then((v) => { clearTimeout(timer); clearInterval(poll); resolve(v); }, (e) => { clearTimeout(timer); clearInterval(poll); reject(e); });
  });
}

async function igFetch(url, { method = 'GET', form = null, page = false, extra = null } = {}) {
  const w = await getWorker();
  const script = `(async () => {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
    let claim = '0';
    try { claim = sessionStorage.getItem('www-claim-v2') || '0'; } catch (e) {}
    const headers = { 'X-IG-App-ID': '${APP_ID}', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest', 'X-ASBD-ID': '359341', 'X-IG-WWW-Claim': claim, 'Accept': '*/*' };
    const opts = ${JSON.stringify({ method, form, page, extra })};
    if (opts.page) { for (const k of Object.keys(headers)) delete headers[k]; headers['Accept'] = 'text/html'; }
    if (opts.extra) Object.assign(headers, opts.extra);
    let body;
    if (opts.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(opts.form).toString(); }
    try {
      const r = await fetch(${JSON.stringify(url)}, { method: opts.method, headers, body, credentials: 'include', referrer: location.origin + '/', mode: 'same-origin' });
      if (opts.page) { const t = await r.text(); const head = t.slice(0, t.indexOf('</head>') > 0 ? t.indexOf('</head>') : 200000); return { status: r.status, text: head }; }
      return { status: r.status, text: await r.text() };
    } catch (e) { return { status: 0, text: String(e) }; }
  })()`;
  const t0 = Date.now();
  const res = await raceCancel(w.webContents.executeJavaScript(script, true), 30000, { status: 0, text: 'timed out after 30s' });
  log(method, shortUrl(url), '->', res.status, `${Date.now() - t0}ms`, res.status === 200 ? '' : String(res.text).slice(0, 160));
  return res;
}

function checkCancel() { if (cancelScan) throw new IgError('CANCELLED', 'Scan cancelled.'); }
async function sleepCancellable(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { checkCancel(); await sleep(Math.min(250, end - Date.now())); }
}

async function igJson(url, opts, onWait, { noWait = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, text } = await igFetch(url, opts);
    let data = null;
    try { data = JSON.parse(String(text).replace(/^for \(;;\);/, '')); } catch { /* not json */ }
    if (status === 200 && data && data.status !== 'fail') return data;
    const msg = (data && (data.message || data.feedback_message)) || '';
    const loggedOut = status === 401 || data?.require_login || /login_required/i.test(msg);
    // Only call it a logout when Instagram says so AND the login cookie is really gone.
    if (loggedOut && !(await getCookie('sessionid'))) {
      throw new IgError('AUTH', 'Instagram logged you out. Log in again to continue.');
    }
    if (/checkpoint/i.test(msg) || data?.checkpoint_url) {
      throw new IgError('CHECKPOINT', 'Instagram wants you to confirm it’s you. Open instagram.com in your browser, complete the check, then scan again.');
    }
    if (status === 200 && !data) {
      log('unexpected (non-JSON) reply:', String(text).replace(/\s+/g, ' ').slice(0, 120));
      throw new IgError('HTTP', 'Instagram sent an unexpected reply.');
    }
    if (status === 429 || /wait a few minutes|try again later|rate limit/i.test(msg)) {
      if (noWait) throw new IgError('RATE429', 'Instagram refused this request (429).');
      if (attempt >= 2) break; // don't make people wait for ages; give a clear message instead
      const wait = 60000 * (attempt + 1);
      if (onWait) onWait(wait, 'rate');
      await sleepCancellable(wait);
      continue;
    }
    if (status === 0 || status >= 500) {
      const wait = 3000 * (attempt + 1);
      if (onWait) onWait(wait, status === 0 ? 'network' : 'server');
      await sleepCancellable(wait);
      continue;
    }
    throw new IgError('HTTP', `Instagram returned an error (${status})${msg ? `: ${msg}` : ''}.`);
  }
  throw new IgError('RATE', 'Instagram is limiting requests from this account. Wait 15–30 minutes, then scan again.');
}

const norm = (u) => ({
  id: String(u.pk ?? u.pk_id ?? u.id),
  username: u.username,
  full_name: u.full_name || '',
  pic: u.profile_pic_url || '',
  verified: !!u.is_verified,
  private: !!u.is_private,
});

// Reads name, picture and totals from the <head> of instagram.com/<username>/ (the tags used for link previews).
function decodeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
function metaTag(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(re);
  return m ? decodeHtml(m[1] ?? m[2]) : '';
}
function exactCount(str, label) {
  const m = str.match(new RegExp(`([\\d.,]+\\s*[KMkm]?)\\s+${label}`, 'i'));
  if (!m || /[KMkm]/.test(m[1])) return null; // "1.2K" isn't exact; skip it
  const n = Number(m[1].replace(/[.,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
async function profileFromPage(username) {
  const { status, text } = await igFetch(`${IG}/${encodeURIComponent(username)}/`, { page: true });
  if (status !== 200 || !text) return null;
  const pic = metaTag(text, 'og:image');
  const title = metaTag(text, 'og:title');
  const desc = metaTag(text, 'og:description') || metaTag(text, 'description');
  const name = ((title.match(/^(.*?)\s*\(@/) || [])[1] || '').replace(/[\s\u2022\u00b7|-]+$/, '');
  const out = { pic, full_name: name, followers: exactCount(desc, 'Followers'), following: exactCount(desc, 'Following') };
  log('profile page', { pic: !!pic, name: !!name, followers: out.followers, following: out.following });
  return pic || name || out.followers != null ? out : null;
}

async function fetchProfile(progress) {
  const id = await getCookie('ds_user_id');
  if (!id || !(await getCookie('sessionid'))) throw new IgError('AUTH', 'You are not logged in to Instagram.');
  const onWait = (ms, reason) => progress({ phase: 'profile', waiting: ms, reason });
  progress({ phase: 'profile', note: 'Connecting to Instagram…' });
  await getWorker();
  progress({ phase: 'profile', note: 'Loading your profile…' });
  const fromInfo = (u) => ({
    id: String(id), username: u.username, full_name: u.full_name || '',
    pic: u.hd_profile_pic_url_info?.url || u.profile_pic_url_hd || u.profile_pic_url || '',
    followers: u.follower_count ?? u.edge_followed_by?.count ?? null,
    following: u.following_count ?? u.edge_follow?.count ?? null,
    posts: u.media_count ?? u.edge_owner_to_timeline_media?.count ?? null,
    private: !!u.is_private, verified: !!u.is_verified,
  });
  const attempt = async (fn) => {
    try { return await fn(); } catch (e) {
      if (['AUTH', 'CANCELLED', 'NET', 'CHECKPOINT'].includes(e.code)) throw e;
      log('profile lookup failed', e.code, e.message);
      return null;
    }
  };
  const prev = loadStore(id).profile;

  // 1) the quick way
  let u = await attempt(async () => (await igJson(`${IG}/api/v1/users/${id}/info/`, undefined, onWait, { noWait: true })).user);
  if (u) return fromInfo(u);

  // 2) find the username, then read the public profile (also gives follower/following totals)
  const form = await attempt(async () => (await igJson(`${IG}/api/v1/accounts/edit/web_form_data/`, undefined, onWait, { noWait: true })).form_data);
  const username = form?.username || prev?.username || '';
  const formName = form?.first_name || '';
  if (username) {
    u = await attempt(async () => (await igJson(`${IG}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, undefined, onWait, { noWait: true })).data?.user);
    if (u) return fromInfo(u);
  }

  // 3) the public profile page: picture, name and (usually) exact totals
  const page = username ? await attempt(() => profileFromPage(username)) : null;
  const base = prev || { pic: '', full_name: '' };
  const profile = {
    ...base,
    id: String(id),
    username,
    full_name: page?.full_name || formName || base.full_name || '',
    pic: page?.pic || base.pic || '',
    followers: page?.followers ?? null,
    following: page?.following ?? null,
  };
  if (!page) log('continuing with partial profile details');
  return profile;
}

const GQL = {
  followers: { hash: 'c76146de99bb02f6415203be841dd25a', edge: 'edge_followed_by' },
  following: { hash: '3dec7e2c57367ef3da3d987d89f9dbc8', edge: 'edge_follow' },
};

async function fetchList(userId, kind, total, progress) {
  const out = new Map();
  let cursor = '';
  let page = 0;
  let mode = 'rest';
  const onWait = (ms, reason) => progress({ phase: kind, count: out.size, total, waiting: ms, reason });
  for (;;) {
    checkCancel();
    let users;
    let next;
    if (mode === 'rest') {
      try {
        const q = new URLSearchParams({ count: '50' });
        if (cursor) q.set('max_id', cursor);
        if (kind === 'followers') q.set('search_surface', 'follow_list_page');
        const d = await igJson(`${IG}/api/v1/friendships/${userId}/${kind}/?${q}`, undefined, onWait, { noWait: page === 0 });
        users = d.users || [];
        next = d.next_max_id ? String(d.next_max_id) : '';
      } catch (e) {
        if (page === 0 && (e.code === 'HTTP' || e.code === 'RATE429')) { log('switching to graphql for', kind); mode = 'gql'; continue; } // fall back to the GraphQL endpoint
        throw e;
      }
    } else {
      const vars = { id: userId, include_reel: false, fetch_mutual: false, first: 50 };
      if (cursor) vars.after = cursor;
      const d = await igJson(`${IG}/graphql/query/?query_hash=${GQL[kind].hash}&variables=${encodeURIComponent(JSON.stringify(vars))}`, undefined, onWait);
      const edge = d?.data?.user?.[GQL[kind].edge];
      if (!edge) throw new IgError('HTTP', 'Instagram changed how follower lists load. Use “Import a data download” instead.');
      users = edge.edges.map((x) => x.node);
      next = edge.page_info?.has_next_page ? edge.page_info.end_cursor : '';
    }
    for (const u of users) { const n = norm(u); if (n.username) out.set(n.id, n); }
    page++;
    progress({ phase: kind, count: out.size, total });
    if (!next || users.length === 0) break;
    cursor = next;
    // human-ish pacing: short pauses, a longer breather every 12 pages
    await sleepCancellable(page % 12 === 0 ? jitter(8000, 14000) : jitter(1100, 2600));
  }
  return [...out.values()];
}

// ---------- follow / unfollow ----------
// Instagram retired its old follow/unfollow addresses in October 2026 (they now answer 404 or
// a 200 HTML page while changing nothing). instagram.com's own buttons now send GraphQL
// "mutations" carrying two per-session tokens (fb_dtsg, lsd) from the logged-in page.
// We do the same, and fall back to pressing the real button on the profile page.
// Either way, success only counts once friendships/show confirms the change.

// Captured from instagram.com's Unfollow button (Oct 2026). Refreshed from the page at runtime
// whenever possible, because Instagram can rotate it.
const UNFOLLOW_DOC_ID = '27789106940691111';

// Session tokens and mutation ids, read from the logged-in instagram.com page in the helper window.
async function webTokens() {
  const w = await getWorker();
  const script = `(() => {
    const out = {};
    try {
      const r = window.require;
      if (typeof r === 'function') {
        try { out.fbDtsg = r('DTSGInitialData').token; } catch (e) {}
        try { out.lsd = r('LSD').token; } catch (e) {}
        try { out.rev = String(r('SiteData').client_revision || ''); } catch (e) {}
        for (const n of ['usePolarisUnfollowMutation', 'usePolarisFollowMutation']) {
          try { const v = r(n + '_instagramRelayOperation'); if (v) out[n] = String(v); } catch (e) {}
        }
      }
    } catch (e) {}
    const html = document.documentElement.innerHTML;
    out.fbDtsg = out.fbDtsg || (html.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/) || html.match(/"dtsg":\\{"token":"([^"]+)"/) || [])[1] || '';
    out.lsd = out.lsd || (html.match(/"LSD",\\[\\],\\{"token":"([^"]+)"/) || [])[1] || '';
    out.rev = out.rev || (html.match(/"client_revision":(\\d+)/) || [])[1] || '';
    return out;
  })()`;
  const t = (await raceCancel(w.webContents.executeJavaScript(script, true), 15000, {})) || {};
  // Log only whether each piece was found, never the token values.
  log('web tokens', { fb_dtsg: !!t.fbDtsg, lsd: !!t.lsd, unfollowId: !!t.usePolarisUnfollowMutation, followId: !!t.usePolarisFollowMutation });
  return t;
}

// Instagram's checksum of fb_dtsg: "2" followed by the sum of its character codes.
function jazoest(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return `2${sum}`;
}

async function igMutation(friendly, docId, variables, t) {
  const params = {
    av: (await getCookie('ds_user_id')) || '', __d: 'www', __user: '0', __a: '1', __comet_req: '7',
    fb_dtsg: t.fbDtsg, jazoest: jazoest(t.fbDtsg), lsd: t.lsd,
    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: friendly,
    variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: docId,
  };
  if (t.rev) { params.__rev = t.rev; params.__spin_r = t.rev; }
  const { status, text } = await igFetch(`${IG}/api/graphql`, {
    method: 'POST', form: params, extra: { 'X-FB-Friendly-Name': friendly, 'X-FB-LSD': t.lsd },
  });
  let data = null;
  try { data = JSON.parse(String(text).replace(/^for \(;;\);/, '')); } catch { /* not json */ }
  const errText = `${JSON.stringify(data?.errors ?? data?.error ?? '')} ${data?.message ?? ''}`;
  const blocked = status === 429 || data?.spam === true || /feedback_required|action_blocked|try again later|rate limit/i.test(errText);
  if (!data) log(friendly, 'non-JSON reply', String(text).replace(/\s+/g, ' ').slice(0, 120));
  else if (data.errors || data.error) log(friendly, 'error reply', errText.slice(0, 200));
  return { blocked, ok: !!data?.data && !data.errors };
}

// Last resort: open their profile in a hidden window and press the real button.
async function pressProfileButton(username, want) {
  const w = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  try {
    const loaded = await raceCancel(w.loadURL(`${IG}/${encodeURIComponent(username)}/`).then(() => true, () => false), 30000, false);
    if (!loaded) return 'page did not load';
    const script = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const find = (re) => [...document.querySelectorAll('button, div[role="button"]')].find((b) => re.test((b.innerText || '').trim()));
      const waitFor = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const b = find(re); if (b) return b; await sleep(250); } return null; };
      if (${want ? 'true' : 'false'}) {
        const b = await waitFor(/^(Follow|Follow Back)$/i, 12000);
        if (!b) return 'no Follow button';
        b.click(); await sleep(2500); return 'pressed Follow';
      }
      const b = await waitFor(/^(Following|Requested)$/i, 12000);
      if (!b) return 'no Following button';
      b.click();
      const u = await waitFor(/^Unfollow$/i, 6000);
      if (!u) return 'no Unfollow option';
      u.click(); await sleep(2500); return 'pressed Unfollow';
    })()`;
    const r = await raceCancel(w.webContents.executeJavaScript(script, true), 35000, 'timed out');
    log('profile button', r);
    return r;
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

async function friendshipAction(kind, userId, username) {
  const acct = await getCookie('ds_user_id');
  const cfg = getSettings();
  const u = usageSummary(acct);
  if (!cfg.override) {
    if (u.changesHour >= cfg.changesPerHour) throw new IgError('LIMIT', `You've reached your limit of ${cfg.changesPerHour} follow changes per hour. Try again later, or raise the limit in Settings.`);
    if (u.changesDay >= cfg.changesPerDay) throw new IgError('LIMIT', `You've reached your limit of ${cfg.changesPerDay} follow changes for today. Try again tomorrow, or raise the limit in Settings.`);
  }
  // Pace like a person: the chosen delay plus a little randomness, never under 4.5 s.
  const delay = Math.max(MIN_ACTION_GAP_MS, cfg.actionDelaySec * 1000) + jitter(0, 1500);
  const gap = delay - (Date.now() - (u.lastChange || 0));
  if (gap > 0) await sleep(gap);

  const id = String(userId).replace(/\D/g, '');
  const want = kind === 'create'; // true = we want to be following them afterwards
  const verb = want ? 'follow' : 'unfollow';

  // The real relationship, straight from Instagram (this endpoint still works).
  const check = async () => {
    try {
      const d = await igJson(`${IG}/api/v1/friendships/show/${id}/`, undefined, undefined, { noWait: true });
      return { following: !!d.following, outgoing_request: !!d.outgoing_request };
    } catch (e) {
      if (['AUTH', 'CHECKPOINT'].includes(e.code)) throw e;
      log('friendship check failed', e.code, e.message);
      return null;
    }
  };
  const done = (st) => st && (want ? st.following || st.outgoing_request : !st.following && !st.outgoing_request);

  const before = await check();
  if (done(before)) { log(`${verb}: already done`); return before; }
  recordUsage(acct, 'changes');

  // 1) The GraphQL mutation instagram.com's own button sends
  const t = await webTokens().catch(() => ({}));
  const friendly = want ? 'usePolarisFollowMutation' : 'usePolarisUnfollowMutation';
  const docId = t[friendly] || (want ? '' : UNFOLLOW_DOC_ID);
  if (t.fbDtsg && t.lsd && docId) {
    const r = await igMutation(friendly, docId, {
      target_user_id: id, container_module: 'profile',
      nav_chain: 'PolarisProfilePostsTabRoot:profilePage:1:via_cold_start',
    }, t);
    if (r.blocked) throw new IgError('RATE', 'Instagram is limiting follow changes right now. Try again in a little while.');
    await sleep(800);
    const after = await check();
    if (done(after)) { log(`${verb}: confirmed (graphql)`); return after; }
  }

  // 2) Press the real button on their profile
  if (username) {
    await pressProfileButton(username, want);
    const after = await check();
    if (done(after)) { log(`${verb}: confirmed (profile button)`); return after; }
  }

  throw new IgError('HTTP', want
    ? 'Instagram didn’t accept the follow. Try again in a minute, or follow them from their profile.'
    : 'Instagram didn’t accept the unfollow. Try again in a minute, or unfollow them from their profile.');
}

// ---------- data download import ----------
function walk(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

function parseExport(dir) {
  const followers = new Map();
  const following = new Map();
  const entry = (e) => {
    const s = (e.string_list_data || [])[0] || {};
    let u = e.title || s.value || '';
    if (!u && s.href) u = s.href.replace(/\/+$/, '').split('/').pop();
    if (!u) return null;
    return { id: u.toLowerCase(), username: u, full_name: '', pic: '', verified: false, private: false, since: s.timestamp ? s.timestamp * 1000 : null };
  };
  for (const f of walk(dir)) {
    const base = path.basename(f).toLowerCase();
    let target = null;
    let list = null;
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (j && Array.isArray(j.relationships_following)) { target = following; list = j.relationships_following; }
    else if (j && Array.isArray(j.relationships_followers)) { target = followers; list = j.relationships_followers; }
    else if (Array.isArray(j) && /^followers(_\d+)?\.json$/.test(base)) { target = followers; list = j; }
    else if (Array.isArray(j) && base === 'following.json') { target = following; list = j; }
    if (!target) continue;
    for (const e of list) { const u = entry(e); if (u) target.set(u.id, u); }
  }
  return { followers: [...followers.values()], following: [...following.values()] };
}

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } }

// Defaults are deliberately cautious. Instagram doesn't publish its limits, so these are
// conservative guesses that keep normal personal use well clear of action blocks.
const DEFAULT_SETTINGS = {
  theme: 'system',
  scansPerDay: 8,
  changesPerHour: 40,
  changesPerDay: 150,
  actionDelaySec: 5,
  override: false,
  confirmUnfollow: true,
  keepScans: 60,
};
const SETTING_BOUNDS = {
  scansPerDay: [1, 50], changesPerHour: [1, 200], changesPerDay: [1, 1000], actionDelaySec: [5, 120], keepScans: [2, MAX_SNAPSHOTS],
};
function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...loadSettings() };
  for (const [k, [lo, hi]] of Object.entries(SETTING_BOUNDS)) {
    const n = Math.round(Number(s[k]));
    s[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_SETTINGS[k];
  }
  s.override = s.override === true;
  s.confirmUnfollow = s.confirmUnfollow !== false;
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  return s;
}

// ---------- usage (what counts toward the limits) ----------
// Timestamps per Instagram account, kept for 24 hours: every scan started, and every
// follow/unfollow actually sent to Instagram. Stored on disk so restarting doesn't reset it.
const usagePath = () => path.join(app.getPath('userData'), 'usage.json');
function loadUsage() { try { return JSON.parse(fs.readFileSync(usagePath(), 'utf8')); } catch { return {}; } }
function recordUsage(acct, kind) {
  if (!acct) return;
  const all = loadUsage();
  const day = Date.now() - 86400000;
  const a = all[acct] || { scans: [], changes: [] };
  a.scans = (a.scans || []).filter((t) => t > day);
  a.changes = (a.changes || []).filter((t) => t > day);
  a[kind].push(Date.now());
  all[acct] = a;
  try { fs.writeFileSync(usagePath(), JSON.stringify(all)); } catch (e) { log('usage save failed', e.message); }
}
function usageSummary(acct) {
  const a = (acct && loadUsage()[acct]) || { scans: [], changes: [] };
  const now = Date.now();
  const inLast = (arr, ms) => (arr || []).filter((t) => now - t < ms);
  const scans = inLast(a.scans, 86400000);
  const changes = inLast(a.changes, 86400000);
  const hour = inLast(a.changes, 3600000);
  return {
    scansDay: scans.length,
    changesDay: changes.length,
    changesHour: hour.length,
    lastChange: changes.at(-1) || 0,
    // when the oldest counted item drops off, so the UI can say when room frees up
    scansResetAt: scans.length ? scans[0] + 86400000 : null,
    changesResetAt: changes.length ? changes[0] + 86400000 : null,
    hourResetAt: hour.length ? hour[0] + 3600000 : null,
  };
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s));
  return s;
}
const bgFor = () => (nativeTheme.shouldUseDarkColors ? '#171125' : '#f6f3fa');

// ---------- profile pictures ----------
// The renderer asks for igimg://avatar/?id=<user id>&src=<instagram cdn url>.
// We download through the Instagram session (no cross-origin blocking), cache the
// file per user, and fall back to the cached copy once Instagram's link expires.
const avatarDir = () => path.join(app.getPath('userData'), 'avatars');
const IMG_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;
let imgActive = 0;
const imgQueue = [];
async function limited(fn) {
  if (imgActive >= 6) await new Promise((r) => imgQueue.push(r));
  imgActive++;
  try { return await fn(); } finally { imgActive--; const next = imgQueue.shift(); if (next) next(); }
}
function cachedFor(dir, id) {
  try { const f = fs.readdirSync(dir).find((n) => n.startsWith(`${id}_`)); return f ? path.join(dir, f) : null; } catch { return null; }
}
const imgResponse = (buf, type = 'image/jpeg') => new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'max-age=604800' } });

async function serveAvatar(request) {
  const u = new URL(request.url);
  const src = u.searchParams.get('src') || '';
  const id = (u.searchParams.get('id') || 'x').replace(/[^\w.-]/g, '').slice(0, 60) || 'x';
  let srcUrl;
  try { srcUrl = new URL(src); } catch { return new Response(null, { status: 400 }); }
  if (srcUrl.protocol !== 'https:' || !IMG_HOST.test(srcUrl.hostname)) return new Response(null, { status: 403 });
  const dir = avatarDir();
  fs.mkdirSync(dir, { recursive: true });
  const key = `${id}_${crypto.createHash('sha1').update(srcUrl.pathname).digest('hex').slice(0, 12)}.img`;
  const file = path.join(dir, key);
  if (fs.existsSync(file)) return imgResponse(fs.readFileSync(file));
  try {
    const r = await limited(() => igSession().fetch(src));
    if (!r.ok) throw new Error(String(r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    const old = cachedFor(dir, id);
    fs.writeFileSync(file, buf);
    if (old && old !== file) fs.unlink(old, () => {});
    return imgResponse(buf, r.headers.get('content-type') || 'image/jpeg');
  } catch {
    const old = cachedFor(dir, id);
    return old ? imgResponse(fs.readFileSync(old)) : new Response(null, { status: 404 });
  }
}

// ---------- window ----------
function iconPath() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  const theme = getSettings().theme;
  nativeTheme.themeSource = theme;
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 660,
    // Windows: our own title bar and buttons. Mac: native traffic lights over our title bar.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : { frame: false }),
    backgroundColor: bgFor(), show: false, icon: iconPath(),
    title: 'WhoUnfollowedMe',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { theme, platform: process.platform } });
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e.level ?? level; const msg = e.message ?? message;
    if (lvl === 'error' || lvl === 3) log('renderer', msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d.reason));
  // Closing the main window quits everything, including the hidden helper page.
  win.on('closed', () => { win = null; quitNow(); });
}

// X means quit: stop any scan, close hidden windows, save the login cookies, and exit for real.
let quitting = false;
async function quitNow() {
  if (quitting) return;
  quitting = true;
  cancelScan = true;
  log('quitting');
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  try { await Promise.race([igSession().cookies.flushStore(), sleep(1500)]); } catch { /* ignore */ }
  app.quit(); // normal quit so Electron writes the login cookies to disk
  setTimeout(() => app.exit(0), 4000).unref(); // safety net if something still holds the app open
}

function openExternal(url) {
  try {
    const u = new URL(url);
    const ok = (/(^|\.)instagram\.com$/.test(u.hostname)) || (u.hostname === 'github.com' && u.pathname.toLowerCase().startsWith(`/${REPO.toLowerCase()}`));
    if (u.protocol === 'https:' && ok) shell.openExternal(url);
  } catch { /* ignore */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  else if (app.isReady()) createWindow();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  log(`app started (Electron ${process.versions.electron})`);
  // Mac needs a menu bar for copy/paste/quit to work (including in the Instagram login window).
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  // Look like regular Chrome to instagram.com
  const ua = app.userAgentFallback.replace(/\s?(Electron|who-unfollowed-me|WhoUnfollowedMe)\/\S+/g, '');
  igSession().setUserAgent(ua);
  protocol.handle('igimg', serveAvatar);
  createWindow();
});
app.on('window-all-closed', () => quitNow());

// ---------- IPC ----------
ipcMain.handle('win:minimize', () => win.minimize());
ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => quitNow());
ipcMain.handle('open:external', (_e, url) => openExternal(url));
ipcMain.handle('theme:set', (_e, pref) => {
  if (!['system', 'light', 'dark'].includes(pref)) return;
  saveSettings({ theme: pref });
  nativeTheme.themeSource = pref;
  win.setBackgroundColor(bgFor());
});

ipcMain.handle('auth:status', async () => {
  const loggedIn = !!(await getCookie('sessionid'));
  return { loggedIn, userId: loggedIn ? await getCookie('ds_user_id') : null, accounts: listAccounts() };
});
ipcMain.handle('auth:login', async () => {
  const ok = await openLogin();
  return { loggedIn: ok, userId: ok ? await getCookie('ds_user_id') : null };
});
ipcMain.handle('auth:logout', async () => {
  if (worker && !worker.isDestroyed()) worker.destroy();
  worker = null;
  await igSession().clearStorageData();
  return true;
});

ipcMain.handle('data:load', (_e, key) => loadStore(key));

ipcMain.handle('data:whitelist', (_e, key, id, on) => {
  const s = loadStore(key);
  const set = new Set(s.whitelist);
  on ? set.add(id) : set.delete(id);
  s.whitelist = [...set];
  saveStore(s);
  return s.whitelist;
});

ipcMain.handle('data:clearHistory', (_e, key) => {
  const s = loadStore(key);
  s.snapshots = s.snapshots.slice(-1);
  saveStore(s);
  return s;
});

// Keep only the newest `keep` scans for one account (used when the "keep" setting is lowered).
ipcMain.handle('data:trim', (_e, key, keep) => {
  const s = loadStore(key);
  const n = Math.max(1, Math.round(Number(keep) || 1));
  if (s.snapshots.length > n) s.snapshots = s.snapshots.slice(-n);
  saveStore(s);
  return s;
});

ipcMain.handle('data:deleteScan', (_e, key, ts) => {
  const s = loadStore(key);
  s.snapshots = s.snapshots.filter((x) => x.ts !== ts);
  saveStore(s);
  log('scan deleted');
  return s;
});

// Removes every saved scan, starred account and cached detail for one Instagram account.
ipcMain.handle('data:deleteAccount', (_e, key) => {
  try { fs.unlinkSync(storePath(key)); } catch { /* already gone */ }
  log('account data deleted');
  return { ok: true, accounts: listAccounts() };
});

ipcMain.handle('avatars:clear', () => {
  let n = 0;
  try { for (const f of fs.readdirSync(avatarDir())) { fs.unlinkSync(path.join(avatarDir(), f)); n++; } } catch { /* none */ }
  return { ok: true, removed: n };
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  saveSettings(clean);
  const s = getSettings();
  if ('theme' in clean) { nativeTheme.themeSource = s.theme; if (win) win.setBackgroundColor(bgFor()); }
  if ('override' in clean) log('override', s.override ? 'turned on' : 'turned off');
  return s;
});
ipcMain.handle('usage:get', async () => {
  const acct = await getCookie('ds_user_id');
  return { ...usageSummary(acct), settings: getSettings(), account: acct };
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), repo: `https://github.com/${REPO}` }));
ipcMain.handle('app:checkUpdate', async () => {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WhoUnfollowedMe' } });
    if (!r.ok) return { ok: false };
    const d = await r.json();
    const latest = String(d.tag_name || '').replace(/^v/, '');
    const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
    return { ok: true, latest, current: app.getVersion(), newer: !!latest && cmp(latest, app.getVersion()) > 0, url: d.html_url };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('data:export', async (_e, { filename, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
});

// ---------- backups (move your scans to another computer) ----------
// One gzip'd JSON file with every saved account, its scans, starred accounts and cached
// profile pictures. Login cookies are deliberately NOT included.
const BACKUP_FORMAT = 'whounfollowedme-backup';
function allStores() {
  try {
    return fs.readdirSync(dataDir()).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir(), f), 'utf8')); } catch { return null; } })
      .filter((st) => st && st.key && Array.isArray(st.snapshots) && st.snapshots.length);
  } catch { return []; }
}
const validStore = (st) => st && typeof st.key === 'string' && /^[\w-]{1,40}$/.test(st.key) && Array.isArray(st.snapshots)
  && st.snapshots.every((x) => x && typeof x.ts === 'number' && Array.isArray(x.followers) && Array.isArray(x.following))
  && st.users && typeof st.users === 'object';

function mergeStore(cur, inc) {
  const newest = (st) => st.snapshots.reduce((m, x) => Math.max(m, x.ts), 0);
  const incNewer = newest(inc) >= newest(cur);
  const byTs = new Map();
  for (const x of [...cur.snapshots, ...inc.snapshots]) if (!byTs.has(x.ts)) byTs.set(x.ts, x);
  const snapshots = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-getSettings().keepScans);
  return {
    key: cur.key,
    profile: (incNewer ? inc.profile : cur.profile) || cur.profile || inc.profile || null,
    users: incNewer ? { ...cur.users, ...inc.users } : { ...inc.users, ...cur.users },
    snapshots,
    whitelist: [...new Set([...(cur.whitelist || []), ...(inc.whitelist || [])])],
    added: snapshots.length - cur.snapshots.length,
  };
}

ipcMain.handle('backup:export', async () => {
  const accounts = allStores();
  if (!accounts.length) return { ok: false, message: 'There are no saved scans to back up yet.' };
  const avatars = {};
  try {
    for (const f of fs.readdirSync(avatarDir())) {
      if (/^[\w.-]+\.img$/.test(f)) avatars[f] = fs.readFileSync(path.join(avatarDir(), f)).toString('base64');
    }
  } catch { /* no pictures yet */ }
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save backup',
    defaultPath: path.join(app.getPath('documents'), `WhoUnfollowedMe-backup-${stamp}.wumbackup`),
    filters: [{ name: 'WhoUnfollowedMe backup', extensions: ['wumbackup'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  const payload = { format: BACKUP_FORMAT, version: 1, exportedAt: Date.now(), appVersion: app.getVersion(), accounts, avatars };
  fs.writeFileSync(filePath, zlib.gzipSync(JSON.stringify(payload)));
  const scans = accounts.reduce((n, a) => n + a.snapshots.length, 0);
  log('backup exported', { accounts: accounts.length, scans, pictures: Object.keys(avatars).length });
  return { ok: true, filePath, accounts: accounts.length, scans };
});

ipcMain.handle('backup:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Restore a backup',
    properties: ['openFile'],
    filters: [{ name: 'WhoUnfollowedMe backup', extensions: ['wumbackup', 'json'] }],
  });
  if (canceled || !filePaths[0]) return { ok: false, cancelled: true };
  let payload;
  try {
    const raw = fs.readFileSync(filePaths[0]);
    let text;
    try { text = zlib.gunzipSync(raw).toString('utf8'); } catch { text = raw.toString('utf8'); }
    payload = JSON.parse(text);
  } catch {
    return { ok: false, message: 'That file isn’t a WhoUnfollowedMe backup, or it’s damaged.' };
  }
  if (!payload || payload.format !== BACKUP_FORMAT || !Array.isArray(payload.accounts)) {
    return { ok: false, message: 'That file isn’t a WhoUnfollowedMe backup.' };
  }
  const restored = [];
  for (const inc of payload.accounts) {
    if (!validStore(inc)) continue;
    const merged = mergeStore(loadStore(inc.key), inc);
    const { added, ...store } = merged;
    saveStore(store);
    restored.push({ key: store.key, username: store.profile?.username || '', added, scans: store.snapshots.length });
  }
  if (payload.avatars && typeof payload.avatars === 'object') {
    fs.mkdirSync(avatarDir(), { recursive: true });
    for (const [name, b64] of Object.entries(payload.avatars)) {
      if (!/^[\w.-]+\.img$/.test(name) || typeof b64 !== 'string') continue;
      const p = path.join(avatarDir(), name);
      if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    }
  }
  if (!restored.length) return { ok: false, message: 'That backup didn’t contain any scans.' };
  log('backup imported', restored);
  return { ok: true, restored };
});

ipcMain.handle('data:openFolder', () => shell.openPath(app.getPath('userData')));

ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose your unzipped Instagram data download folder',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { ok: false, cancelled: true };
  const { followers, following } = parseExport(filePaths[0]);
  if (!followers.length && !following.length) {
    return { ok: false, message: 'No follower files found. Request your download in JSON format, unzip it, and choose that folder.' };
  }
  const s = loadStore('import');
  const profile = { id: 'import', username: 'Data download', full_name: 'Imported from Instagram', pic: '', followers: followers.length, following: following.length };
  addSnapshot(s, profile, followers, following, 'import');
  saveStore(s);
  return { ok: true, store: s };
});

ipcMain.handle('ig:scan', async () => {
  if (scanning) return { ok: false, code: 'BUSY', message: 'A scan is already running.' };
  const acct = await getCookie('ds_user_id');
  const cfg = getSettings();
  if (!cfg.override && usageSummary(acct).scansDay >= cfg.scansPerDay) {
    return { ok: false, code: 'LIMIT', message: `You've used all ${cfg.scansPerDay} scans for today. Try again tomorrow, or raise the limit in Settings.` };
  }
  scanning = true;
  cancelScan = false;
  try {
    log('scan started', cfg.override ? '(override on)' : '');
    recordUsage(acct, 'scans');
    const profile = await fetchProfile((p) => send('scan:progress', p));
    const last = loadStore(profile.id).snapshots.at(-1);
    const totals = {
      followers: profile.followers ?? last?.followers.length ?? null,
      following: profile.following ?? last?.following.length ?? null,
    };
    const estimated = profile.followers == null && !!last;
    log('totals', totals, estimated ? '(estimated from last scan)' : '');
    const followers = await fetchList(profile.id, 'followers', totals.followers, (p) => send('scan:progress', { ...p, step: 1, estimated }));
    send('scan:progress', { phase: 'following', step: 2, count: 0, total: totals.following, estimated });
    await sleepCancellable(jitter(1500, 3000));
    const following = await fetchList(profile.id, 'following', totals.following, (p) => send('scan:progress', { ...p, step: 2, estimated }));
    const s = loadStore(profile.id);
    addSnapshot(s, profile, followers, following, 'live');
    saveStore(s);
    log('scan finished', { followers: followers.length, following: following.length });
    return { ok: true, store: s };
  } catch (e) {
    log('scan failed', e.code || 'ERR', e.message || String(e));
    return { ok: false, code: e.code || 'ERR', message: e.message || String(e) };
  } finally {
    scanning = false;
  }
});
ipcMain.handle('ig:cancel', () => { cancelScan = true; });

ipcMain.handle('ig:friendship', async (_e, key, userId, kind) => {
  if (!['create', 'destroy'].includes(kind)) return { ok: false, message: 'Unknown action.' };
  // Only act for the account that's logged in; never use another account's saved list.
  if (String(key) !== String(await getCookie('ds_user_id'))) {
    return { ok: false, code: 'WRONG_ACCOUNT', message: 'These scans belong to a different account than the one logged in.' };
  }
  try {
    const username = loadStore(key).users?.[userId]?.username || '';
    const status = await friendshipAction(kind, userId, username);
    const s = loadStore(key);
    const snap = s.snapshots.at(-1);
    let requested = false;
    if (snap) {
      if (kind === 'destroy') snap.following = snap.following.filter((id) => id !== userId);
      else if (status.following) { if (!snap.following.includes(userId)) snap.following.unshift(userId); }
      else requested = !!status.outgoing_request;
      saveStore(s);
    }
    return { ok: true, store: s, requested };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message };
  }
});
