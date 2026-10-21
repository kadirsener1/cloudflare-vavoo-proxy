const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS Middleware ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Accept, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Location',
};

app.use((req, res, next) => {
  res.set(CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- Stream Cache ---
const streamCache = new Map();
const CACHE_TTL = 300_000;

function getCachedStream(cacheKey) {
  const entry = streamCache.get(cacheKey);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.url;
  if (entry) streamCache.delete(cacheKey);
  return null;
}

function setCachedStream(cacheKey, url) {
  if (streamCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of streamCache) {
      if (now - v.ts >= CACHE_TTL) streamCache.delete(k);
    }
  }
  streamCache.set(cacheKey, { url, ts: Date.now() });
}

// --- Utility ---
function getClientIP(req) {
  const explicitIp = req.query.ip;
  if (explicitIp && explicitIp.trim()) return explicitIp.trim();
  return req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.ip ||
    '127.0.0.1';
}

class ExtractorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtractorError';
  }
}

// --- Vavoo Extractor ---
class VavooExtractor {
  normalizeIPv4(ip) {
    if (!ip) return '1.1.1.1';
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
    if (mapped) return mapped[1];
    if (ip.includes(':')) return '1.1.1.1';
    return ip;
  }

  async getAuthSignature(clientIP) {
    const currentTime = Date.now();
    const uniqueId = Math.random().toString(16).slice(2, 18);
    const authPayload = {
      token: "ldCvE092e7gER0rVIajfsXIvRhwlrAzP6_1oEJ4q6HH89QHt24v6NNL_jQJO219hiLOXF2hqEfsUuEWitEIGN4EaHHEHb7Cd7gojc5SQYRFzU3XWo_kMeryAUbcwWnQrnf0-",
      reason: "app-blur",
      locale: "de",
      theme: "dark",
      metadata: {
        device: { type: "Handset", brand: "google", model: "Nexus", name: "21081111RG", uniqueId },
        os: { name: "android", version: "7.1.2", abis: ["arm64-v8a"], host: "android" },
        app: {
          platform: "android", version: "1.1.0", buildId: "97215000", engine: "hbc85",
          signatures: ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"],
          installer: "com.android.vending"
        },
        version: { package: "app.lokke.main", binary: "1.1.0", js: "1.1.0" }
      },
      appFocusTime: 0, playerActive: false, playDuration: 0,
      devMode: true, hasAddon: true, castConnected: false,
      package: "app.lokke.main", version: "1.1.0", process: "app",
      firstAppStart: currentTime - 86400000, lastAppStart: currentTime,
      ipLocation: clientIP, adblockEnabled: false,
      proxy: { supported: ["ss", "openvpn"], engine: "openvpn", ssVersion: 1, enabled: false, autoServer: true, id: "fi-hel" },
      iap: { supported: true }
    };

    const response = await fetch("https://www.lokke.app/api/app/ping", {
      method: "POST",
      headers: {
        "user-agent": "okhttp/4.11.0",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "X-Forwarded-For": clientIP,
        "X-Real-IP": clientIP,
      },
      body: JSON.stringify(authPayload)
    });

    if (!response.ok) throw new ExtractorError(`Vavoo Auth API failed: ${response.status}`);
    const result = await response.json();
    if (!result.addonSig) throw new ExtractorError('Vavoo auth response missing addonSig.');

    let addonSig = result.addonSig;
    try {
      const decoded = Buffer.from(addonSig, 'base64').toString('utf-8');
      const sigObj = JSON.parse(decoded);
      if (sigObj && sigObj.data) {
        const dataObj = JSON.parse(sigObj.data);
        if (clientIP) {
          const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
          dataObj.ips = [clientIP, ...currentIps.filter(x => x && x !== clientIP)];
          if (typeof dataObj.ip === 'string') dataObj.ip = clientIP;
          sigObj.data = JSON.stringify(dataObj);
          addonSig = Buffer.from(JSON.stringify(sigObj)).toString('base64');
        }
      }
    } catch (e) { /* keep original sig */ }

    return addonSig;
  }

  async resolveStream(vavooUrl, signature, clientIP) {
    const response = await fetch("https://vavoo.to/mediahubmx-resolve.json", {
      method: "POST",
      headers: {
        "user-agent": "MediaHubMX/2",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature,
        "X-Forwarded-For": clientIP,
        "X-Real-IP": clientIP,
      },
      body: JSON.stringify({ language: "de", region: "AT", url: vavooUrl, clientVersion: "3.0.2" })
    });

    if (!response.ok) throw new ExtractorError(`Vavoo Resolve API failed: ${response.status}`);
    const result = await response.json();
    let streamUrl;
    if (Array.isArray(result)) {
      const httpsStream = result.find(item => item.url && item.url.startsWith('https://'));
      streamUrl = httpsStream ? httpsStream.url : result[0]?.url;
    } else {
      streamUrl = result?.url;
    }
    if (!streamUrl) throw new ExtractorError('Vavoo resolve response contains no valid stream URL.');
    return streamUrl;
  }

  async handle(targetUrl, req, res) {
    const rawClientIP = getClientIP(req);
    const clientIP = this.normalizeIPv4(rawClientIP);
    const cacheKey = `${targetUrl}|${clientIP}`;

    const cached = getCachedStream(cacheKey);
    if (cached) return res.redirect(302, cached);

    const signature = await this.getAuthSignature(clientIP);
    const streamUrl = await this.resolveStream(targetUrl, signature, clientIP);
    setCachedStream(cacheKey, streamUrl);
    return res.redirect(302, streamUrl);
  }
}

// --- M3U Playlist Proxy ---
function rewritePlaylistUrls(m3uContent, workerDomain) {
  const lines = m3uContent.split('\n');
  const parts = [];
  let lastExtinf = null;

  if (!lines[0]?.startsWith('#EXTM3U')) parts.push('#EXTM3U');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#EXTM3U')) {
      if (!parts.includes('#EXTM3U')) parts.push(trimmed);
    } else if (trimmed.startsWith('#EXTINF:')) {
      lastExtinf = trimmed;
    } else if (trimmed.startsWith('#EXTVLCOPT:')) {
      parts.push(trimmed);
    } else if (trimmed.startsWith('http') && lastExtinf) {
      parts.push(lastExtinf);
      if (trimmed.includes('vavoo.to')) {
        parts.push(`${workerDomain}/manifest.m3u8?url=${encodeURIComponent(trimmed)}`);
      } else {
        parts.push(trimmed);
      }
      lastExtinf = null;
    }
  }
  return parts.join('\n');
}

// --- Routes ---

app.get('/', (req, res) => {
  const domain = `${req.protocol}://${req.get('host')}`;
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vavoo Stream Extractor</title>
  <style>
    body{font-family:sans-serif;background:#0a0a0b;color:#fff;padding:2rem;max-width:800px;margin:auto}
    h1{background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    code{background:#1a1a1d;padding:0.8rem;display:block;border-radius:8px;color:#3b82f6;word-break:break-all;margin:0.5rem 0}
    .card{background:#16181c;border:1px solid #374151;border-radius:12px;padding:1.5rem;margin:1rem 0}
  </style>
</head>
<body>
  <h1>Vavoo Stream Extractor</h1>
  <div class="card">
    <h3>Estrazione Stream</h3>
    <code>${domain}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</code>
  </div>
  <div class="card">
    <h3>Proxy Playlist M3U</h3>
    <code>${domain}/playlist?url=&lt;URL1&gt;;&lt;URL2&gt;</code>
  </div>
  <div class="card">
    <h3>Status</h3>
    <code>${domain}/status</code>
  </div>
</body>
</html>`;
  res.type('html').send(html);
});

app.get('/status', (req, res) => {
  res.json({
    status: "operational",
    version: "1.0",
    timestamp: new Date().toISOString(),
    client_info: {
      ip: getClientIP(req),
      user_agent: req.headers['user-agent'] || 'unknown',
    },
    cache_size: streamCache.size,
  });
});

app.get('/playlist', async (req, res) => {
  const m3uUrlsParam = req.query.url;
  if (!m3uUrlsParam) return res.status(400).send('Error: Missing url parameter.');

  const m3uUrls = m3uUrlsParam.split(';').filter(u => u.trim());
  if (!m3uUrls.length) return res.status(400).send('Error: No valid URLs.');

  let combined = '';
  for (const m3uUrl of m3uUrls) {
    try {
      const r = await fetch(m3uUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) combined += await r.text() + '\n';
    } catch (e) {
      console.error(`Playlist fetch error: ${e.message}`);
    }
  }

  const domain = `${req.protocol}://${req.get('host')}`;
  const modified = rewritePlaylistUrls(combined, domain);

  res.set({
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Content-Disposition': 'inline; filename="playlist.m3u"',
    'Cache-Control': 's-maxage=3600, stale-while-revalidate',
  }).send(modified);
});

app.get('/manifest.m3u8', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing "url" parameter' });
  if (!targetUrl.includes('vavoo.to')) return res.status(400).json({ error: 'Only Vavoo URLs supported.' });

  try {
    const extractor = new VavooExtractor();
    await extractor.handle(targetUrl, req, res);
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: err.message, type: err.name });
  }
});

app.get('/proxy/hls/manifest.m3u8', async (req, res) => {
  const targetUrl = req.query.d;
  if (!targetUrl) return res.status(400).json({ error: 'Missing "d" parameter' });
  if (!targetUrl.includes('vavoo.to')) return res.status(400).json({ error: 'Only Vavoo URLs supported.' });

  try {
    const extractor = new VavooExtractor();
    await extractor.handle(targetUrl, req, res);
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: err.message, type: err.name });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: '404 Not Found' });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Vavoo Extractor running on port ${PORT}`);
});
