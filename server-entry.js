import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = new URL('./server-fixed.js', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

const needle = "app.listen(PORT,'0.0.0.0',()=>console.log(`NOVA MOVE v3 listening on ${PORT}`));";
if (!src.includes(needle)) {
  throw new Error('server-fixed.js start marker not found');
}

const injection = `
// Short-lived MOVE session bridge for UMOTV M3U playback.
// Anyone with the private M3U token can already access the account-backed stream,
// so keep the token private. This response is never cached.
app.get('/session/:token', async (req,res) => {
  try {
    const token = String(req.params.token || '');
    const creds = dec(token);
    const s = await login(creds);
    if (!s.auth || !s.customerId || !s.profileId) throw new Error('MOVE session incomplete');
    res.set('cache-control','no-store, no-cache, must-revalidate').json({
      success: true,
      api: MOVE_API,
      authToken: s.auth,
      customerId: s.customerId,
      profileId: s.profileId,
      appVersion: '3.4.8'
    });
  } catch (e) {
    res.status(401).set('cache-control','no-store').json({success:false,error:String(e.message || e)});
  }
});

app.listen(PORT,'0.0.0.0',()=>console.log(\`NOVA MOVE v4 listening on \${PORT}\`));`;

src = src.replace(needle, injection);
const runtimePath = path.join(os.tmpdir(), 'nova-move-runtime.mjs');
fs.writeFileSync(runtimePath, src, 'utf8');
await import(pathToFileURL(runtimePath).href + `?v=${Date.now()}`);
