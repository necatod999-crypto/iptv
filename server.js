import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const APP_SECRET = process.env.APP_SECRET || '';
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const MOVE_UID = (process.env.MOVE_UID || '').trim();
if (APP_SECRET.length < 24) throw new Error('APP_SECRET must be at least 24 characters');

const MOVE_API = 'https://api2.mts-si.tv';
const KEY = crypto.createHash('sha256').update(APP_SECRET).digest();

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
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'origin': 'https://play.move.tv',
    'pragma': 'no-cache',
    'referer': 'https://play.move.tv/',
    'sec-ch-ua': '"Chromium";v="153", "Not_A Brand";v="8"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
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
  return {
    auth: data.auth_token,
    customerId: data.customer_id,
    profileId: data.profile?.id || data.masterProfile?.id,
    deviceId: data.device_id,
    uid
  };
}
function findArrays(o, depth = 0, out = []) {
  if (depth > 6 || o == null) return out;
  if (Array.isArray(o)) {
    if (o.length && typeof o[0] === 'object') out.push(o);
    for (const x of o.slice(0, 50)) findArrays(x, depth + 1, out);
  } else if (typeof o === 'object') {
    for (const v of Object.values(o)) findArrays(v, depth + 1, out);
  }
  return out;
}
function pick(o, names) {
  for (const n of names) if (o?.[n] != null) return o[n];
}
function parseChannels(data) {
  let best = [];
  for (const arr of findArrays(data)) {
    const rows = arr.map(x => {
      const id = Number(pick(x, ['liveId','live_id','id','contentId','content_id']));
      const name = String(pick(x, ['name','title','channelName','channel_name','displayName']) || '').trim();
      const p = pick(x, ['picture','images','image']) || {};
      const logo = String(pick(x, ['logo','icon','logoUrl','logo_url']) || pick(p, ['icon','logo','small','medium']) || '');
      const category = String(pick(x, ['categoryName','category_name','category','genreName','groupName']) || 'MOVE');
      return { id, name, logo, category };
    }).filter(x => x.id > 0 && x.name);
    if (rows.length > best.length) best = rows;
  }
  return best;
}
async function channelsFor(creds) {
  const s = await login(creds);
  const data = await post('/api/v2/content/live/all', {
    customerId: s.customerId,
    customerProfileId: s.profileId,
    lang: 1
  }, s.auth);
  return { s, channels: parseChannels(data) };
}
async function sourceFor(creds, liveId) {
  const s = await login(creds);
  const data = await post('/api/v2/content/live/source/get', {
    customerId: s.customerId,
    customerProfileId: s.profileId,
    liveId: Number(liveId),
    dtype: 1,
    appVersion: '3.4.8'
  }, s.auth);
  if (data?.drm?.enabled) throw new Error('DRM channel is not exposed');
  return {
    url: data.content_url,
    headerName: data?.protection?.headerName,
    headerValue: data?.protection?.headerValue || data?.protection?.value,
    encryption: data?.encryption || null,
    mediaInfo: data?.urlMediaInfo || null
  };
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function page(body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>NOVA MOVE</title><style>body{font-family:system-ui;background:#101114;color:#eee;margin:0;padding:25px}main{max-width:1100px;margin:auto}.card{background:#191b20;border:1px solid #30343d;border-radius:14px;padding:20px;margin:14px 0}input,button{font:inherit;padding:11px;border-radius:9px;border:1px solid #454b57;background:#111318;color:#eee}input{width:min(430px,90%)}button{cursor:pointer}a{color:#8fc8ff}code{word-break:break-all}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #2b2e35}.err{color:#ff9e9e}.ok{color:#8ee6a0}</style><main><h1>NOVA MOVE</h1>${body}</main>`;
}

app.get('/', (_req, res) => res.send(page(`<div class=card><h2>MOVE login</h2><form method=post action=/login><p><input name=username placeholder='MOVE username' autocomplete=username required></p><p><input name=password type=password placeholder='MOVE password' autocomplete=current-password required></p><button>Prijavi se i ucitaj kanale</button></form><p>Koristi isti MOVE/Moj mts username i password koji rade na play.move.tv.</p></div>`)));

app.post('/login', async (req, res) => {
  try {
    const creds = { username: String(req.body.username || '').trim(), password: String(req.body.password || '') };
    if (!creds.username || !creds.password) throw new Error('Nedostaje username/password');
    const { channels } = await channelsFor(creds);
    const token = enc(creds);
    const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
    const m3u = `${base}/playlist.m3u?token=${encodeURIComponent(token)}`;
    const rows = channels.map(c => `<tr><td>${esc(c.name)}</td><td><a target=_blank href='/source/${c.id}?token=${encodeURIComponent(token)}'>source</a></td></tr>`).join('');
    res.send(page(`<div class=card><b class=ok>Uspesno.</b><p>M3U lista:<br><code>${esc(m3u)}</code></p><p>Ovaj URL cuvaj privatno jer predstavlja pristup tvom MOVE nalogu.</p></div><div class=card><h2>Kanali (${channels.length})</h2><table><tr><th>Kanal</th><th>Svez source</th></tr>${rows}</table></div>`));
  } catch (e) {
    console.log('MOVE login failed:', e.status || '', e.message);
    res.status(500).send(page(`<div class='card err'>MOVE greska: ${esc(e.message)}</div><div class=card>Ako isti username/password rade na play.move.tv, probaj ponovo posle ovog update-a. Ako i dalje pise Invalid Credentials, posalji screenshot <b>login 200 XHR → Request Headers</b>, ali bez vrednosti tokena/cookie-ja.</div>`));
  }
});

app.get('/playlist.m3u', async (req, res) => {
  try {
    const creds = dec(String(req.query.token || ''));
    const { channels } = await channelsFor(creds);
    const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
    let out = '#EXTM3U\n';
    for (const c of channels) {
      out += `#EXTINF:-1 group-title="${String(c.category).replace(/"/g,'')}"${c.logo ? ` tvg-logo="${String(c.logo).replace(/"/g,'')}"` : ''},${c.name}\n`;
      out += `${base}/source/${c.id}?token=${encodeURIComponent(String(req.query.token))}\n`;
    }
    res.type('application/x-mpegURL').send(out);
  } catch (e) {
    res.status(401).send('Invalid/expired access token: ' + e.message);
  }
});

app.get('/source/:id', async (req, res) => {
  try {
    const creds = dec(String(req.query.token || ''));
    const src = await sourceFor(creds, req.params.id);
    res.json({ success: true, liveId: Number(req.params.id), ...src });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'nova-move-render' }));
app.listen(PORT, '0.0.0.0', () => console.log(`NOVA MOVE listening on ${PORT}`));
