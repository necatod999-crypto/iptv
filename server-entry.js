import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const sourcePath = new URL('./server-fixed.js', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

// Keep the preferred Serbian channel order in freshly generated M3U files.
src = src.replace("['pink','pink tv']", "['pink','pink tv','tv pink']");

const needle = "app.listen(PORT,'0.0.0.0',()=>console.log(`NOVA MOVE v3 listening on ${PORT}`));";
if (!src.includes(needle)) {
  throw new Error('server-fixed.js start marker not found');
}

const injection = `
const bridgeSessionCache = new Map();

function normalizeMoveApiBase(value) {
  if (!value) return '';
  let v = '';
  if (typeof value === 'string' || typeof value === 'number') {
    v = String(value).trim();
  } else if (typeof value === 'object') {
    for (const key of ['url','baseUrl','base_url','host','server','api_server','apiServer','dedicated_server','dedicatedServer']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        v = value[key].trim();
        break;
      }
    }
  }
  if (!v) return '';
  if (v.startsWith('//')) v = 'https:' + v;
  if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v.replace(/^\\/+/, '');
  v = v.replace(/\\/api\\/v2\\/?$/i, '');
  return v.replace(/\\/$/, '');
}

function moveApiCandidates(data) {
  const raw = [
    data?.dedicated_server,
    data?.dedicatedServer,
    data?.api_server,
    data?.apiServer,
    data?.server,
    MOVE_API
  ];
  const out = [];
  for (const item of raw) {
    const base = normalizeMoveApiBase(item);
    if (base && !out.includes(base)) out.push(base);
  }
  return out.length ? out : [MOVE_API];
}

// Short-lived MOVE session bridge for UMOTV M3U playback.
// It returns the provider-assigned API server so the TV does source/get directly,
// while actual MPD/video remains MOVE -> TV and does not pass through Render.
app.get('/session/:token', async (req,res) => {
  try {
    const token = String(req.params.token || '');
    const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
    const cached = bridgeSessionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
      return res.set('cache-control','no-store, no-cache, must-revalidate').json(cached.value);
    }

    const creds = dec(token);
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
    const customerId = data.customer_id;
    const authToken = data.auth_token;
    const apiCandidates = moveApiCandidates(data);

    if (!authToken || !customerId || !profileId) throw new Error('MOVE session incomplete');

    const value = {
      success: true,
      api: apiCandidates[0],
      apiCandidates,
      authToken,
      customerId,
      profileId,
      appVersion: '3.4.8'
    };

    bridgeSessionCache.set(cacheKey, { at: Date.now(), value });
    console.log('MOVE session API', JSON.stringify({api: apiCandidates[0], candidates: apiCandidates.length}));
    res.set('cache-control','no-store, no-cache, must-revalidate').json(value);
  } catch (e) {
    console.log('MOVE session error', e.status || '', String(e.message || e));
    res.status(401).set('cache-control','no-store').json({success:false,error:String(e.message || e)});
  }
});

app.listen(PORT,'0.0.0.0',()=>console.log(\`NOVA MOVE v5 listening on \${PORT}\`));`;

src = src.replace(needle, injection);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.nova-move-runtime.mjs');
fs.writeFileSync(runtimePath, src, 'utf8');
await import(pathToFileURL(runtimePath).href + `?v=${Date.now()}`);
