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
  if (b.length < 29) throw new Error('Neispravan token');
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
  return {
    auth: data.auth_token,
    customerId: data.customer_id,
    profileId: data.profile?.id || data.masterProfile?.id || data.master_profile?.id || data.customer_profile_id || data.profile_id,
    uid
  };
}
function textValue(v) {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  return '';
}
function categoryName(x) {
  if (!Array.isArray(x?.categories)) return 'MOVE';
  for (const c of x.categories) {
    const n = textValue(c?.name);
    if (n) return n;
  }
  return 'MOVE';
}
function logoFromPicture(p) {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['squareLogo','icon','originalTitleLogo','poster','background']) {
    const v = textValue(p[k]);
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('/')) return MOVE_API + v;
  }
  return '';
}
function normName(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const FIRST_CHANNELS = [
  ['rts 1'], ['rts 2'], ['rts 3'], ['happy','happy tv'], ['pink','pink tv'], ['b92'],
  ['prva','prva tv'], ['n1'], ['nova s'], ['rts drama']
];
function priorityOf(name) {
  const n = normName(name);
  for (let i=0;i<FIRST_CHANNELS.length;i++) if (FIRST_CHANNELS[i].includes(n)) return i;
  return 1000;
}
function sortChannels(rows) {
  return rows.sort((a,b) => {
    const pa=priorityOf(a.name), pb=priorityOf(b.name);
    if (pa!==pb) return pa-pb;
    return a.name.localeCompare(b.name,'sr',{numeric:true,sensitivity:'base'});
  });
}
function parseChannels(data) {
  const src = Array.isArray(data?.content) ? data.content : [];
  const found = new Map();
  for (const x of src) {
    if (!x || typeof x !== 'object') continue;
    const id = Number(x.liveId);
    const name = textValue(x.contentName);
    if (!Number.isFinite(id) || id <= 0 || !name) continue;
    if (x.audioOnly === true || x.audioOnly === 1 || x.audioOnly === '1') continue;
    const row = {
      id, name,
      category: categoryName(x),
      logo: logoFromPicture(x.picture),
      subscribed: x.subscribed !== false && x.subscribed !== 0 && x.subscribed !== '0'
    };
    if (!found.has(id)) found.set(id,row);
  }
  let rows=[...found.values()];
  const subscribed=rows.filter(x=>x.subscribed);
  if (subscribed.length) rows=subscribed;
  sortChannels(rows);
  console.log('MOVE exact channels', JSON.stringify({content:src.length,channels:rows.length,sample:rows.slice(0,12).map(x=>({id:x.id,name:x.name,category:x.category}))}));
  return rows;
}
async function channelsFor(creds) {
  const s=await login(creds);
  if (!s.profileId) throw new Error('MOVE profile ID nije pronadjen');
  const data=await post('/api/v2/content/live/all',{customerId:s.customerId,customerProfileId:s.profileId,lang:1},s.auth);
  return {s,channels:parseChannels(data)};
}
async function sourceFor(creds, liveId, force=false) {
  const key=`${String(creds.username).toLowerCase()}:${Number(liveId)}`;
  const cached=sourceCache.get(key);
  if (!force && cached && Date.now()-cached.at < 2*60*1000) return cached.value;
  const s=await login(creds);
  const data=await post('/api/v2/content/live/source/get',{
    customerId:s.customerId,customerProfileId:s.profileId,liveId:Number(liveId),dtype:1,appVersion:'3.4.8'
  },s.auth);
  if (data?.drm?.enabled) {
    const e=new Error('DRM kanal nije podrzan'); e.code='DRM'; throw e;
  }
  if (!data?.content_url) throw new Error('MOVE nije vratio content_url');
  const value={
    url:data.content_url,
    headerName:data?.protection?.headerName || '',
    headerValue:data?.protection?.headerValue || data?.protection?.value || '',
    mediaInfo:data?.urlMediaInfo || null
  };
  sourceCache.set(key,{at:Date.now(),value});
  return value;
}
function sourceHeaders(src,req) {
  const h={accept:'*/*',origin:'https://play.move.tv',referer:'https://play.move.tv/','user-agent':'Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'};
  if (src.headerName && src.headerValue) h[src.headerName]=src.headerValue;
  if (req?.headers?.range) h.range=req.headers.range;
  return h;
}
function allowStream(token,id) {
  const now=Date.now();
  for (const [k,t] of activeStreams) if (now-t>30000) activeStreams.delete(k);
  const key=crypto.createHash('sha256').update(`${token}:${id}`).digest('hex');
  if (!activeStreams.has(key) && activeStreams.size>=MAX_ACTIVE_STREAMS) return false;
  activeStreams.set(key,now); return true;
}
function esc(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function publicBase(req) { return BASE_URL || `${req.protocol}://${req.get('host')}`; }
function page(body) { return `<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>NOVA MOVE</title><style>body{font-family:system-ui;background:#101114;color:#eee;margin:0;padding:25px}main{max-width:1100px;margin:auto}.card{background:#191b20;border:1px solid #30343d;border-radius:14px;padding:20px;margin:14px 0}input,button{font:inherit;padding:11px;border-radius:9px;border:1px solid #454b57;background:#111318;color:#eee}input{width:min(430px,90%)}button{cursor:pointer}a{color:#8fc8ff}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #2b2e35}.err{color:#ff9e9e}.ok{color:#8ee6a0}</style><main><h1>NOVA MOVE</h1>${body}</main>`; }

app.get('/',(_req,res)=>res.send(page(`<div class=card><h2>MOVE login</h2><form method=post action=/login><p><input name=username placeholder='MOVE username' required></p><p><input name=password type=password placeholder='MOVE password' required></p><button>Prijavi se i ucitaj kanale</button></form><p>Prvi kanali: RTS 1, RTS 2, RTS 3, Happy, Pink, B92, Prva, N1, Nova S, RTS Drama.</p></div>`)));
app.post('/login',async(req,res)=>{
  try {
    const creds={username:String(req.body.username||'').trim(),password:String(req.body.password||'')};
    if(!creds.username||!creds.password) throw new Error('Nedostaje username/password');
    const {channels}=await channelsFor(creds); const token=enc(creds); const base=publicBase(req);
    const m3u=`${base}/playlist.m3u?token=${encodeURIComponent(token)}`;
    const rows=channels.map((c,i)=>`<tr><td>${i+1}</td><td>${esc(c.name)}</td><td>${esc(c.category)}</td></tr>`).join('');
    res.send(page(`<div class=card><b class=ok>Uspesno.</b><p><b>TV kanali: ${channels.length}</b></p><p><a href='${esc(m3u)}'>Preuzmi pravi M3U</a></p></div><div class=card><table><tr><th>#</th><th>Kanal</th><th>Kategorija</th></tr>${rows}</table></div>`));
  } catch(e) { console.log('MOVE login failed:',e.status||'',e.message); res.status(500).send(page(`<div class='card err'>MOVE greska: ${esc(e.message)}</div>`)); }
});
app.get('/playlist.m3u',async(req,res)=>{
  try {
    const token=String(req.query.token||''); const creds=dec(token); const {channels}=await channelsFor(creds); const base=publicBase(req);
    let out='#EXTM3U\n';
    for(const c of channels){
      const logo=c.logo?` tvg-logo="${String(c.logo).replace(/["\r\n]/g,'')}"`:'';
      const group=String(c.category||'MOVE').replace(/["\r\n]/g,''); const name=String(c.name).replace(/[\r\n]/g,' ');
      out+=`#EXTINF:-1 tvg-name="${name.replace(/"/g,'')}"${logo} group-title="${group}",${name}\n`;
      out+=`${base}/play/${token}/${c.id}/index.mpd\n`;
    }
    res.set('content-disposition','attachment; filename="move-tv.m3u"'); res.type('audio/x-mpegurl').send(out);
  } catch(e) { res.status(401).send('Invalid/expired access token: '+e.message); }
});

// Endpoint koji UMOTV koristi: dobije originalni MOVE URL + X-Play-Auth,
// pa video ide direktno MOVE -> TV umesto kroz Render proxy.
async function sendResolved(req,res) {
  try {
    const token=String(req.params.token || req.query.token || '');
    const id=Number(req.params.id);
    const creds=dec(token);
    const src=await sourceFor(creds,id,true);
    res.set('cache-control','no-store').json({success:true,liveId:id,url:src.url,type:src.url.includes('.mpd')?'dash':src.url.includes('.m3u8')?'hls':'auto',headerName:src.headerName,headerValue:src.headerValue,mediaInfo:src.mediaInfo});
  } catch(e) {
    res.status(e.code==='DRM'?409:502).json({success:false,error:e.message,drm:e.code==='DRM'});
  }
}
app.get('/resolve/:token/:id',sendResolved);
app.get('/source/:id',sendResolved);

function proxyRef(raw,srcUrl,proxyBase) {
  const v=String(raw||'').trim(); if(!v) return v;
  if(v.startsWith('/')) return `${proxyBase}__root__/${v.slice(1)}`;
  try { if(/^https?:\/\//i.test(v)){ const a=new URL(v),s=new URL(srcUrl); if(a.origin===s.origin) return `${proxyBase}__root__/${a.pathname.replace(/^\/+/, '')}${a.search}`; } } catch{}
  return v;
}
function rewriteDash(text,srcUrl,proxyBase) {
  let out=text; const upstreamDir=new URL('.',srcUrl).toString(); out=out.split(upstreamDir).join(proxyBase);
  out=out.replace(/(<BaseURL>\s*)([^<]+)(\s*<\/BaseURL>)/gi,(_m,a,v,b)=>a+proxyRef(v,srcUrl,proxyBase)+b);
  out=out.replace(/\b(media|initialization|sourceURL|href)="([^"]+)"/gi,(_m,a,v)=>`${a}="${proxyRef(v,srcUrl,proxyBase)}"`);
  return out;
}
async function upstream(src,url,req){ return fetch(url,{headers:sourceHeaders(src,req),redirect:'follow'}); }
app.get('/play/:token/:id/index.mpd',async(req,res)=>{
  const token=req.params.token,id=Number(req.params.id); if(!allowStream(token,id)) return res.status(429).send('MOVE concurrent stream limit reached');
  try {
    const creds=dec(token); let src=await sourceFor(creds,id); let r=await upstream(src,src.url,req);
    if(r.status===401||r.status===403){src=await sourceFor(creds,id,true);r=await upstream(src,src.url,req);}
    if(!r.ok) throw new Error(`MOVE manifest HTTP ${r.status}`);
    const body=await r.text(); const proxyBase=`${publicBase(req)}/play/${token}/${id}/`;
    if(src.url.includes('.m3u8')){
      const lines=body.split(/\r?\n/).map(line=>{if(!line)return line;if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_m,v)=>`URI="${proxyRef(v,src.url,proxyBase)}"`);return proxyRef(line,src.url,proxyBase);});
      return res.type('application/vnd.apple.mpegurl').set('cache-control','no-store').send(lines.join('\n'));
    }
    return res.type('application/dash+xml').set('cache-control','no-store').send(rewriteDash(body,src.url,proxyBase));
  } catch(e){console.log('manifest error',id,e.message);res.status(e.code==='DRM'?409:502).send(e.message);}
});
app.get('/play/:token/:id/*rest',async(req,res)=>{
  const token=req.params.token,id=Number(req.params.id); if(!allowStream(token,id)) return res.status(429).send('MOVE concurrent stream limit reached');
  try {
    const creds=dec(token); let src=await sourceFor(creds,id); const rest=Array.isArray(req.params.rest)?req.params.rest.join('/'):String(req.params.rest||'');
    const makeUrl=s=>{let u;if(rest.startsWith('__root__/'))u=new URL('/'+rest.slice(9),new URL(s.url).origin);else u=new URL(rest,new URL('.',s.url));for(const[k,v]of Object.entries(req.query))u.searchParams.set(k,String(v));return u.toString();};
    let r=await upstream(src,makeUrl(src),req); if(r.status===401||r.status===403||r.status===404){src=await sourceFor(creds,id,true);r=await upstream(src,makeUrl(src),req);}
    if(!r.ok&&r.status!==206){console.log('segment error',id,r.status,rest.slice(0,120));throw new Error(`MOVE segment HTTP ${r.status}`);}
    res.status(r.status); for(const h of ['content-type','content-length','content-range','accept-ranges']){const v=r.headers.get(h);if(v)res.set(h,v);} res.set('cache-control','no-store');
    if(!r.body)return res.end(); const reader=r.body.getReader(); while(true){const{done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise(ok=>res.once('drain',ok));} res.end();
  } catch(e){if(!res.headersSent)res.status(e.code==='DRM'?409:502).send(e.message);else res.end();}
});
app.get('/health',(_req,res)=>res.json({ok:true,service:'nova-move-render-v3',maxStreams:MAX_ACTIVE_STREAMS,directResolver:true}));
app.listen(PORT,'0.0.0.0',()=>console.log(`NOVA MOVE v3 listening on ${PORT}`));