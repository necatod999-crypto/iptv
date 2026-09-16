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
function headers(extra = {}) {
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
    headers: headers(auth ? { 'x-auth-token': auth } : {}),
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
  const profileId = data.profile?.id || data.masterProfile?.id || data.master_profile?.id || data.customer_profile_id || data.profile_id;
  return {
    auth: data.auth_token,
    customerId: data.customer_id,
    profileId,
    deviceId: data.device_id,
    uid
  };
}

function primitiveText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = primitiveText(x);
      if (t) return t;
    }
    return '';
  }
  if (typeof v === 'object') {
    for (const k of ['name','title','value','text','label','translation','displayName','display_name']) {
      if (v[k] != null) {
        const t = primitiveText(v[k]);
        if (t) return t;
      }
    }
    for (const x of Object.values(v)) {
      const t = primitiveText(x);
      if (t) return t;
    }
  }
  return '';
}
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}
function collectObjects(v, depth = 0, out = []) {
  if (depth > 9 || v == null || out.length > 20000) return out;
  if (Array.isArray(v)) {
    for (const x of v) collectObjects(x, depth + 1, out);
  } else if (typeof v === 'object') {
    out.push(v);
    for (const x of Object.values(v)) collectObjects(x, depth + 1, out);
  }
  return out;
}
function pickDirect(o, names) {
  for (const n of names) if (o && Object.prototype.hasOwnProperty.call(o, n) && o[n] != null) return o[n];
}
function parseChannels(data) {
  const objects = collectObjects(data);
  const idKeys = ['liveId','live_id','id','contentId','content_id','channelId','channel_id','assetId','asset_id','programId','program_id'];
  const nameKeys = ['name','title','channelName','channel_name','displayName','display_name','originalTitle','original_title','shortName','short_name','label'];
  const logoKeys = ['logo','icon','logoUrl','logo_url','imageUrl','image_url','thumbnail','thumb'];
  const catKeys = ['categoryName','category_name','category','genreName','genre_name','groupName','group_name'];
  const found = new Map();

  for (const o of objects) {
    const id = num(pickDirect(o, idKeys));
    if (!id) continue;

    let name = primitiveText(pickDirect(o, nameKeys));
    if (!name) {
      name = primitiveText(pickDirect(o, ['translations','translation','translate','localized','localization','metadata']));
    }
    if (!name || /^https?:\/\//i.test(name)) continue;

    const pic = pickDirect(o, ['picture','pictures','images','image','artwork']) || {};
    const logo = primitiveText(pickDirect(o, logoKeys)) || primitiveText(pickDirect(pic, logoKeys));
    const category = primitiveText(pickDirect(o, catKeys)) || 'MOVE';

    if (!found.has(id)) found.set(id, { id, name, logo, category });
    else {
      const old = found.get(id);
      if ((!old.logo || old.logo === '[object Object]') && logo) old.logo = logo;
      if ((!old.category || old.category === 'MOVE') && category) old.category = category;
      if ((!old.name || old.name.length < name.length) && name.length < 150) old.name = name;
    }
  }

  const rows = [...found.values()].filter(x => x.id > 0 && x.name && x.name !== '[object Object]');
  console.log('MOVE live/all parsed', JSON.stringify({ topKeys: data && typeof data === 'object' ? Object.keys(data).slice(0,30) : [], objects: objects.length, channels: rows.length }));
  return rows;
}
async function channelsFor(creds) {
  const s = await login(creds);
  if (!s.profileId) throw new Error('MOVE profile ID nije pronadjen u login odgovoru');
  const data = await post('/api/v2/content/live/all', {
    customerId: s.customerId,
    customerProfileId: s.profileId,
    lang: 1
  }, s.auth);
  return { s, channels: parseChannels(data) };
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
    headerValue: data?.protection?.headerValue || data?.protection?.value,
    encryption: data?.encryption || null,
    mediaInfo: data?.urlMediaInfo || null
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
function streamKey(token, id) {
  return crypto.createHash('sha256').update(`${token}:${id}`).digest('hex');
}
function allowStream(token, id) {
  const now = Date.now();
  for (const [k, t] of activeStreams) if (now - t > 30000) activeStreams.delete(k);
  const key = streamKey(token, id);
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

app.get('/', (_req, res) => res.send(page(`<div class=card><h2>MOVE login</h2><form method=post action=/login><p><input name=username placeholder='MOVE username' autocomplete=username required></p><p><input name=password type=password placeholder='MOVE password' autocomplete=current-password required></p><button>Prijavi se i ucitaj kanale</button></form><p>Posle prijave dobijas pravi M3U fajl. Sam server dodaje potreban MOVE playback header za kanale bez DRM-a.</p></div>`)));

app.post('/login', async (req, res) => {
  try {
    const creds = { username: String(req.body.username || '').trim(), password: String(req.body.password || '') };
    if (!creds.username || !creds.password) throw new Error('Nedostaje username/password');
    const { channels } = await channelsFor(creds);
    const token = enc(creds);
    const base = publicBase(req);
    const m3u = `${base}/playlist.m3u?token=${encodeURIComponent(token)}`;
    const rows = channels.map(c => `<tr><td>${esc(c.name)}</td><td><code>${esc(`${base}/play/${token}/${c.id}/index.mpd`)}</code></td></tr>`).join('');
    res.send(page(`<div class=card><b class=ok>Uspesno.</b><p><b>Kanali: ${channels.length}</b></p><p>M3U fajl:<br><a href='${esc(m3u)}'>${esc(m3u)}</a></p><p>Ovaj link cuvaj privatno.</p></div><div class=card><h2>Kanali (${channels.length})</h2><table><tr><th>Kanal</th><th>Playable link</th></tr>${rows}</table></div>`));
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

app.get('/source/:id', async (req, res) => {
  try {
    const creds = dec(String(req.query.token || ''));
    const src = await sourceFor(creds, req.params.id);
    res.json({ success: true, liveId: Number(req.params.id), url: src.url, type: src.url.includes('.mpd') ? 'dash' : src.url.includes('.m3u8') ? 'hls' : 'unknown', drm: false });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

function rewriteManifest(text, srcUrl, proxyBase) {
  const upstreamDir = new URL('.', srcUrl).toString();
  let out = text.split(upstreamDir).join(proxyBase);
  const srcOrigin = new URL(srcUrl).origin;
  out = out.replace(/<BaseURL>\s*([^<]+)\s*<\/BaseURL>/gi, (m, v) => {
    try {
      const abs = new URL(v.trim(), srcUrl);
      if (abs.origin === srcOrigin) {
        const baseDir = new URL('.', srcUrl);
        if (abs.pathname.startsWith(baseDir.pathname)) {
          const rel = abs.pathname.slice(baseDir.pathname.length) + abs.search;
          return `<BaseURL>${proxyBase}${rel}</BaseURL>`;
        }
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
    const base = publicBase(req);
    const proxyBase = `${base}/play/${token}/${id}/`;
    const rewritten = rewriteManifest(text, src.url, proxyBase);
    const ct = r.headers.get('content-type') || (src.url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
    res.set('content-type', ct);
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
app.listen(PORT, '0.0.0.0', () => console.log(`NOVA MOVE listening on ${PORT}`));
