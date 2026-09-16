import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const APP_SECRET = process.env.APP_SECRET || '';
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const MOVE_UID = (process.env.MOVE_UID || '').trim();
const MAX_ACTIVE_STREAMS = Math.max(1, Number(process.env.MAX_ACTIVE_STREAMS || 2));
const DEBUG_ACCESS_TOKEN = (process.env.DEBUG_ACCESS_TOKEN || '').trim();

if (APP_SECRET.length < 24) throw new Error('APP_SECRET must be at least 24 characters');

const MOVE_API = 'https://api2.mts-si.tv';
const KEY = crypto.createHash('sha256').update(APP_SECRET).digest();
const sourceCache = new Map();
const activeStreams = new Map();

function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64url');
}
function dec(token) {
  const b = Buffer.from(token, 'base64url');
  if (b.length < 29) throw new Error('Invalid token');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), body = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}
function stableUid(username) {
  if (MOVE_UID) return MOVE_UID;
  const b = crypto.createHash('sha256').update(`${APP_SECRET}:${String(username).toLowerCase()}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function apiHeaders(extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    origin: 'https://play.move.tv',
    pragma: 'no-cache',
    referer: 'https://play.move.tv/',
    'sec-ch-ua': '"Chromium";v="153", "Not_A Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    ...extra
  };
}
async function post(path, payload, auth) {
  const r = await fetch(MOVE_API + path, {
    method: 'POST',
    headers: apiHeaders(auth ? { 'x-auth-token': auth } : {}),
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!r.ok || data?.success === false) {
    const msg = data?.message || data?.error || data?.description || data?.raw || `MOVE HTTP ${r.status}`;
    const err = new Error(String(msg));
    err.status = r.status;
    throw err;
  }
  return data;
}
async function login(creds) {
  const uid = stableUid(creds.username);
  const data = await post('/api/v2/login', {
    username: creds.username,
    password: creds.password,
    partnerId: 2,
    deviceName: 'Chrome 153',
    deviceModelId: 10,
    appVersion: '3.4.8',
    uid
  });
  const profileId =
    data.profile?.id ||
    data.masterProfile?.id ||
    data.master_profile?.id ||
    data.customer_profile_id ||
    data.profile_id;
  return {
    auth: data.auth_token,
    customerId: data.customer_id,
    profileId,
    deviceId: data.device_id,
    uid
  };
}
async function liveAll(creds) {
  const s = await login(creds);
  if (!s.profileId) throw new Error('MOVE profile ID nije pronadjen');
  const data = await post('/api/v2/content/live/all', {
    customerId: s.customerId,
    customerProfileId: s.profileId,
    lang: 1
  }, s.auth);
  return { s, data };
}

const ID_KEYS = [
  'liveId','liveID','live_id','live',
  'id','ID','contentId','contentID','content_id',
  'channelId','channelID','channel_id','channel',
  'assetId','assetID','asset_id','programId','program_id',
  'cid','content','pk'
];
const NAME_KEYS = [
  'name','title','channelName','channel_name','displayName','display_name',
  'originalTitle','original_title','shortName','short_name','label',
  'caption','text','description'
];
const LOGO_KEYS = ['logo','icon','logoUrl','logo_url','imageUrl','image_url','thumbnail','thumb','poster'];
const CAT_KEYS = ['categoryName','category_name','category','genreName','genre_name','groupName','group_name','genre'];

function numeric(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())) return Number(v.trim());
  return 0;
}
function simpleText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}
function directByKeys(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] != null) return o[k];
}
function deepFirst(o, keys, depth = 0, seen = new Set()) {
  if (depth > 5 || o == null || typeof o !== 'object' || seen.has(o)) return undefined;
  seen.add(o);
  if (!Array.isArray(o)) {
    const d = directByKeys(o, keys);
    if (d != null) return d;
  }
  const vals = Array.isArray(o) ? o : Object.values(o);
  for (const v of vals) {
    if (v && typeof v === 'object') {
      const x = deepFirst(v, keys, depth + 1, seen);
      if (x != null) return x;
    }
  }
}
function deepText(o, keys, depth = 0, seen = new Set()) {
  if (depth > 6 || o == null || typeof o !== 'object' || seen.has(o)) return '';
  seen.add(o);
  if (!Array.isArray(o)) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        const v = o[k];
        const t = simpleText(v);
        if (t && t.length <= 180 && !/^https?:\/\//i.test(t)) return t;
        if (v && typeof v === 'object') {
          const nested = deepText(v, keys, depth + 1, seen);
          if (nested) return nested;
        }
      }
    }
  }
  const vals = Array.isArray(o) ? o : Object.values(o);
  for (const v of vals) {
    if (v && typeof v === 'object') {
      const t = deepText(v, keys, depth + 1, seen);
      if (t) return t;
    }
  }
  return '';
}
function deepUrl(o, keys, depth = 0, seen = new Set()) {
  if (depth > 5 || o == null || typeof o !== 'object' || seen.has(o)) return '';
  seen.add(o);
  if (!Array.isArray(o)) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        const v = o[k];
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
      }
    }
  }
  const vals = Array.isArray(o) ? o : Object.values(o);
  for (const v of vals) {
    if (v && typeof v === 'object') {
      const u = deepUrl(v, keys, depth + 1, seen);
      if (u) return u;
    }
  }
  return '';
}

function schemaSummary(data) {
  try {
    const keyFreq = new Map();
    const sigFreq = new Map();
    const arrays = [];
    const numericParents = [];
    let objects = 0;

    function walk(v, path = '$', depth = 0) {
      if (depth > 8 || v == null) return;
      if (Array.isArray(v)) {
        if (arrays.length < 20) {
          const firstObj = v.find(x => x && typeof x === 'object' && !Array.isArray(x));
          arrays.push({
            path,
            len: v.length,
            firstKeys: firstObj ? Object.keys(firstObj).slice(0,30) : []
          });
        }
        for (let i = 0; i < Math.min(v.length, 80); i++) walk(v[i], `${path}[]`, depth + 1);
        return;
      }
      if (typeof v !== 'object') return;
      objects++;
      const keys = Object.keys(v);
      for (const k of keys) keyFreq.set(k, (keyFreq.get(k) || 0) + 1);
      const sig = keys.slice().sort().join(',');
      sigFreq.set(sig, (sigFreq.get(sig) || 0) + 1);
      for (const [k, child] of Object.entries(v)) {
        if (/^\d{2,12}$/.test(k) && child && typeof child === 'object' && numericParents.length < 20) {
          numericParents.push({ path: `${path}.${k}`, keys: Array.isArray(child) ? ['<array>'] : Object.keys(child).slice(0,30) });
        }
        walk(child, `${path}.${k}`, depth + 1);
      }
    }
    walk(data);
    const content = data?.content;
    const summary = {
      topKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      contentType: Array.isArray(content) ? 'array' : typeof content,
      contentLen: Array.isArray(content) ? content.length : undefined,
      contentKeys: content && !Array.isArray(content) && typeof content === 'object' ? Object.keys(content).slice(0,60) : [],
      objects,
      topObjectKeys: [...keyFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,60),
      signatures: [...sigFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25),
      arrays,
      numericParents
    };
    console.log('MOVE_SCHEMA', JSON.stringify(summary));
  } catch (e) {
    console.log('MOVE_SCHEMA_ERROR', e.message);
  }
}

function parseChannels(data) {
  const found = new Map();

  function addCandidate(obj, idHint = 0, categoryHint = 'MOVE') {
    if (!obj || typeof obj !== 'object') return;
    let id = numeric(directByKeys(obj, ID_KEYS));
    if (!id) {
      const deepId = deepFirst(obj, ID_KEYS);
      id = numeric(deepId);
    }
    if (!id) id = numeric(idHint);
    if (!id) return;

    let name = '';
    const directName = directByKeys(obj, NAME_KEYS);
    if (typeof directName === 'string' || typeof directName === 'number') name = simpleText(directName);
    if (!name) name = deepText(obj, NAME_KEYS);
    if (!name || /^\d+$/.test(name) || /^https?:\/\//i.test(name)) return;

    let category = simpleText(directByKeys(obj, CAT_KEYS)) || categoryHint || 'MOVE';
    if (!category || /^https?:\/\//i.test(category)) category = 'MOVE';
    const logo = deepUrl(obj, LOGO_KEYS);

    const old = found.get(id);
    if (!old) found.set(id, { id, name, logo, category });
    else {
      if (name && (!old.name || old.name.length < 2)) old.name = name;
      if (logo && !old.logo) old.logo = logo;
      if (category && old.category === 'MOVE') old.category = category;
    }
  }

  function walk(v, pathKey = '', categoryHint = 'MOVE', depth = 0) {
    if (depth > 9 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object') addCandidate(x, 0, categoryHint);
        walk(x, '', categoryHint, depth + 1);
      }
      return;
    }
    if (typeof v !== 'object') return;

    const numericKeyHint = numeric(pathKey);
    addCandidate(v, numericKeyHint, categoryHint);

    let nextCategory = categoryHint;
    const cat = simpleText(directByKeys(v, CAT_KEYS));
    if (cat && cat.length < 100) nextCategory = cat;

    for (const [k, child] of Object.entries(v)) {
      if (child && typeof child === 'object') {
        if (/^\d{1,12}$/.test(k)) addCandidate(child, Number(k), nextCategory);
        walk(child, k, nextCategory, depth + 1);
      }
    }
  }

  walk(data?.content ?? data);
  if (found.size === 0 && data?.content !== data) walk(data);

  const rows = [...found.values()].filter(x => x.id > 0 && x.name).sort((a,b)=>a.id-b.id);
  console.log('MOVE live/all parsed', JSON.stringify({
    topKeys: data && typeof data === 'object' ? Object.keys(data).slice(0,30) : [],
    channels: rows.length
  }));
  if (!rows.length) schemaSummary(data);
  return rows;
}

async function channelsFor(creds) {
  const { s, data } = await liveAll(creds);
  return { s, channels: parseChannels(data), raw: data };
}

async function sourceFor(creds, liveId, force = false) {
  const key = `${String(creds.username).toLowerCase()}:${Number(liveId)}`;
  const cached = sourceCache.get(key);
  if (!force && cached && Date.now() - cached.at < 4 * 60 * 1000) return cached.value;

  const s = await login(creds);
  const data = await post('/api/v2/content/live/source/get', {
    customerId: s.customerId,
    customerProfileId: s.profileId,
    liveId: Number(liveId),
    dtype: 1,
    appVersion: '3.4.8'
  }, s.auth);
  if (data?.drm?.enabled) throw new Error('DRM kanal nije podrzan');
  const value = {
    url: data.content_url,
    headerName: data?.protection?.headerName,
    headerValue: data?.protection?.headerValue || data?.protection?.value
  };
  if (!value.url) throw new Error('MOVE nije vratio content_url');
  sourceCache.set(key, { at: Date.now(), value });
  return value;
}

function sourceHeaders(src, req = null) {
  const h = {
    accept: '*/*',
    origin: 'https://play.move.tv',
    referer: 'https://play.move.tv/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
  };
  if (src.headerName && src.headerValue) h[src.headerName] = src.headerValue;
  if (req?.headers?.range) h.range = req.headers.range;
  return h;
}
function allowStream(token, id) {
  const now = Date.now();
  for (const [k, t] of activeStreams) if (now - t > 30000) activeStreams.delete(k);
  const key = crypto.createHash('sha256').update(`${token}:${id}`).digest('hex');
  if (!activeStreams.has(key) && activeStreams.size >= MAX_ACTIVE_STREAMS) return false;
  activeStreams.set(key, now);
  return true;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function page(body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>NOVA MOVE</title><style>body{font-family:system-ui;background:#101114;color:#eee;margin:0;padding:25px}main{max-width:1100px;margin:auto}.card{background:#191b20;border:1px solid #30343d;border-radius:14px;padding:20px;margin:14px 0}input,button{font:inherit;padding:11px;border-radius:9px;border:1px solid #454b57;background:#111318;color:#eee}input{width:min(430px,90%)}button{cursor:pointer}a{color:#8fc8ff}code{word-break:break-all}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #2b2e35}.err{color:#ff9e9e}.ok{color:#8ee6a0}</style><main><h1>NOVA MOVE</h1>${body}</main>`;
}
function publicBase(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.get('/', (_req, res) => res.send(page(`<div class=card><h2>MOVE login</h2><form method=post action=/login><p><input name=username placeholder='MOVE username' autocomplete=username required></p><p><input name=password type=password placeholder='MOVE password' autocomplete=current-password required></p><button>Prijavi se i ucitaj kanale</button></form></div>`)));

app.post('/login', async (req, res) => {
  try {
    const creds = { username: String(req.body.username || '').trim(), password: String(req.body.password || '') };
    if (!creds.username || !creds.password) throw new Error('Nedostaje username/password');
    const { channels } = await channelsFor(creds);
    const token = enc(creds);
    const base = publicBase(req);
    const m3u = `${base}/playlist.m3u?token=${encodeURIComponent(token)}`;
    const rows = channels.map(c => `<tr><td>${esc(c.name)}</td><td><code>${esc(`${base}/play/${token}/${c.id}/index.mpd`)}</code></td></tr>`).join('');
    res.send(page(`<div class=card><b class=ok>Uspesno.</b><p><b>Kanali: ${channels.length}</b></p><p>M3U fajl:<br><a href='${esc(m3u)}'>${esc(m3u)}</a></p></div><div class=card><h2>Kanali (${channels.length})</h2><table><tr><th>Kanal</th><th>Playable link</th></tr>${rows}</table></div>`));
  } catch (e) {
    console.log('MOVE login failed:', e.status || '', e.message);
    res.status(500).send(page(`<div class='card err'>MOVE greska: ${esc(e.message)}</div>`));
  }
});

app.get('/playlist.m3u', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const creds = dec(token);
    const { channels } = await channelsFor(creds);
    const base = publicBase(req);
    let out = '#EXTM3U\n';
    for (const c of channels) {
      const logo = c.logo ? ` tvg-logo="${String(c.logo).replace(/["\r\n]/g,'')}"` : '';
      out += `#EXTINF:-1${logo} group-title="${String(c.category || 'MOVE').replace(/["\r\n]/g,'')}",${String(c.name).replace(/[\r\n]/g,' ')}\n`;
      out += `${base}/play/${token}/${c.id}/index.mpd\n`;
    }
    res.set('content-disposition', 'attachment; filename="move-channels.m3u"');
    res.type('audio/x-mpegurl').send(out);
  } catch (e) {
    res.status(401).send('Invalid/expired access token: ' + e.message);
  }
});

function rewriteManifest(text, srcUrl, proxyBase) {
  const upstreamDir = new URL('.', srcUrl).toString();
  let out = text.split(upstreamDir).join(proxyBase);
  const srcOrigin = new URL(srcUrl).origin;
  out = out.replace(/<BaseURL>\s*([^<]+)\s*<\/BaseURL>/gi, (m, v) => {
    try {
      const abs = new URL(v.trim(), srcUrl);
      const baseDir = new URL('.', srcUrl);
      if (abs.origin === srcOrigin && abs.pathname.startsWith(baseDir.pathname)) {
        const rel = abs.pathname.slice(baseDir.pathname.length) + abs.search;
        return `<BaseURL>${proxyBase}${rel}</BaseURL>`;
      }
    } catch {}
    return m;
  });
  return out;
}
async function fetchUpstream(src, url, req) {
  return fetch(url, { headers: sourceHeaders(src, req), redirect: 'follow' });
}

app.get('/play/:token/:id/index.mpd', async (req, res) => {
  const token = req.params.token;
  const id = Number(req.params.id);
  if (!allowStream(token, id)) return res.status(429).send('MOVE concurrent stream limit reached');
  try {
    const creds = dec(token);
    let src = await sourceFor(creds, id);
    let r = await fetchUpstream(src, src.url, req);
    if (r.status === 401 || r.status === 403) {
      src = await sourceFor(creds, id, true);
      r = await fetchUpstream(src, src.url, req);
    }
    if (!r.ok) throw new Error(`MOVE manifest HTTP ${r.status}`);
    const text = await r.text();
    const proxyBase = `${publicBase(req)}/play/${token}/${id}/`;
    const rewritten = rewriteManifest(text, src.url, proxyBase);
    res.set('content-type', r.headers.get('content-type') || 'application/dash+xml');
    res.set('cache-control', 'no-store');
    res.send(rewritten);
  } catch (e) {
    res.status(502).send(e.message);
  }
});

app.get('/play/:token/:id/*rest', async (req, res) => {
  const token = req.params.token;
  const id = Number(req.params.id);
  if (!allowStream(token, id)) return res.status(429).send('MOVE concurrent stream limit reached');
  try {
    const creds = dec(token);
    let src = await sourceFor(creds, id);
    const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    const makeUrl = currentSrc => {
      const u = new URL(rest, new URL('.', currentSrc.url));
      for (const [k, v] of Object.entries(req.query)) u.searchParams.set(k, String(v));
      return u.toString();
    };
    let r = await fetchUpstream(src, makeUrl(src), req);
    if (r.status === 401 || r.status === 403) {
      src = await sourceFor(creds, id, true);
      r = await fetchUpstream(src, makeUrl(src), req);
    }
    if (!r.ok && r.status !== 206) throw new Error(`MOVE segment HTTP ${r.status}`);
    res.status(r.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
      const v = r.headers.get(h); if (v) res.set(h, v);
    }
    res.set('cache-control', 'no-store');
    if (!r.body) return res.end();
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).send(e.message); else res.end();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'nova-move-render', maxStreams: MAX_ACTIVE_STREAMS }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NOVA MOVE listening on ${PORT}`);
  if (DEBUG_ACCESS_TOKEN) {
    setTimeout(async () => {
      try {
        const creds = dec(DEBUG_ACCESS_TOKEN);
        const { data } = await liveAll(creds);
        schemaSummary(data);
        const rows = parseChannels(data);
        console.log('MOVE_DEBUG_RESULT', JSON.stringify({ channels: rows.length }));
      } catch (e) {
        console.log('MOVE_DEBUG_ERROR', e.status || '', e.message);
      }
    }, 1200);
  }
});
