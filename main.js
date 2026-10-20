/**
 * Node.js uyarlaması - Render.com için
 * Orijinal Deno Deploy koduyla aynı işlevselliği sunar.
 */
const http = require('http');
const { URL } = require('url');

// ============================================================
//  AYNI WHITELIST VE SABİTLER
// ============================================================
const DEFAULT_ALLOWED_CHANNEL_IDS = [
    '22330664333ebb4acbb6ab',
    '3828793616b62b9cc5834c',
   '159609588253825d67ec56',
'300113394ceebba66c8ad',
'38404756531618c87fcc6',
'22330664333ebb4acbb6ab',
'2576216897d1c2b14af4e9',
'13524210538e192d878d20',
'2729088606df69156b1eda',
'24034250314fd9aa349685',
'66217962033a2d3e9c47f',
'5934938605e361d7e0ff0',
'267105889a25a483e5e80',
'1536730627bbf8f95ca477',
'1453692314f52730c50395',
'143239535a2e3c23c1d1',
    '267105889a25a483e5e80',
    '1536730627bbf8f95ca477'
    
    // 'buraya_yeni_kanal_id_ekle',
];

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Accept, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Location',
};

const AUTH_TIMEOUT_MS = 8000;
const RESOLVE_TIMEOUT_MS = 8000;
const PLAYLIST_TIMEOUT_MS = 10000;

const AUTH_CACHE_TTL_MS = 15 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const STALE_RETENTION_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

const SLOW_REQUEST_THRESHOLD_MS = 3000;

// ============================================================
//  YARDIMCILAR
// ============================================================
function getClientIP(req) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const explicitIp = url.searchParams.get('ip');
        if (explicitIp && explicitIp.trim()) return explicitIp.trim();
    } catch {}
    return req.headers['cf-connecting-ip'] ||
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        '127.0.0.1';
}

class ExtractorError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ExtractorError';
        this.status = status;
    }
}

function getAllowedChannelIds() {
    const envVal = process.env.ALLOWED_CHANNEL_IDS;
    if (envVal && envVal.trim() !== '') {
        return new Set(envVal.split(',').map(s => s.trim()).filter(Boolean));
    }
    return new Set(DEFAULT_ALLOWED_CHANNEL_IDS);
}

function isVavooHost(url) {
    try {
        const u = new URL(url);
        return u.hostname === 'vavoo.to' || u.hostname.endsWith('.vavoo.to');
    } catch {
        return false;
    }
}

function extractVavooChannelId(url) {
    try {
        if (!isVavooHost(url)) return null;
        const u = new URL(url);
        const m = u.pathname.match(/\/play\/([^/?#]+)/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

function isAllowedVavooUrl(url, allowedSet) {
    const id = extractVavooChannelId(url);
    return id !== null && allowedSet.has(id);
}

// ============================================================
//  TTL CACHE (Node.js Map tabanlı)
// ============================================================
class TTLCache {
    constructor(ttlMs, maxEntries = MAX_CACHE_ENTRIES) {
        this.map = new Map();
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.lastCleanup = Date.now();
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (entry.expiry <= Date.now()) return null;
        return entry.value;
    }

    getStale(key) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (Date.now() - entry.expiry > STALE_RETENTION_MS) {
            this.map.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value) {
        if (this.map.size >= this.maxEntries) {
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined) this.map.delete(firstKey);
        }
        this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
        this.cleanupIfNeeded();
    }

    delete(key) {
        this.map.delete(key);
    }

    cleanupIfNeeded() {
        const now = Date.now();
        if (now - this.lastCleanup < 60000) return;
        this.lastCleanup = now;
        for (const [k, v] of this.map) {
            if (v.expiry + STALE_RETENTION_MS <= now) this.map.delete(k);
        }
    }
}

const authCache = new TTLCache(AUTH_CACHE_TTL_MS);
const streamCache = new TTLCache(STREAM_CACHE_TTL_MS);
const authInFlight = new Map();
const streamInFlight = new Map();

// ============================================================
//  FETCH YARDIMCILARI
// ============================================================
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchWithRetry(url, options, timeoutMs, retries = 1) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetchWithTimeout(url, options, timeoutMs);
            if (res.ok) return res;
            lastErr = new ExtractorError(`HTTP ${res.status} for ${url}`, res.status);
            if (res.status >= 400 && res.status < 500) return res;
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
        }
        if (i < retries) await new Promise(r => setTimeout(r, 300));
    }
    throw lastErr ?? new ExtractorError(`Fetch failed: ${url}`);
}

// ============================================================
//  VAVOO EXTRACTOR (Node.js sınıfı)
// ============================================================
class VavooExtractor {
    async getAuthSignature(clientIP) {
        const cached = authCache.get(clientIP);
        if (cached) return cached;
        const inFlight = authInFlight.get(clientIP);
        if (inFlight) return inFlight;
        const promise = this._fetchAuthSignature(clientIP)
            .finally(() => authInFlight.delete(clientIP));
        authInFlight.set(clientIP, promise);
        return promise;
    }

    async _fetchAuthSignature(clientIP) {
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
            proxy: {
                supported: ["ss", "openvpn"], engine: "openvpn", ssVersion: 1,
                enabled: false, autoServer: true, id: "fi-hel"
            },
            iap: { supported: true }
        };
        const authHeaders = {
            "user-agent": "okhttp/4.11.0",
            "accept": "application/json",
            "content-type": "application/json; charset=utf-8",
            "accept-encoding": "gzip",
            "X-Forwarded-For": clientIP,
            "X-Real-IP": clientIP,
        };

        const response = await fetchWithRetry("https://www.lokke.app/api/app/ping", {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(authPayload)
        }, AUTH_TIMEOUT_MS, 1);

        if (!response.ok) throw new ExtractorError(`Vavoo Auth API failed: ${response.status}`, response.status);
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
        } catch { /* rewrite başarısız → orijinali kullan */ }

        authCache.set(clientIP, addonSig);
        return addonSig;
    }

    async resolveStream(vavooUrl, clientIP) {
        const cacheKey = `${clientIP}|${vavooUrl}`;
        const cached = streamCache.get(cacheKey);
        if (cached) return cached;
        const inFlight = streamInFlight.get(cacheKey);
        if (inFlight) return inFlight;
        const promise = this._resolveWithRecovery(vavooUrl, clientIP, cacheKey)
            .finally(() => streamInFlight.delete(cacheKey));
        streamInFlight.set(cacheKey, promise);
        return promise;
    }

    async _resolveWithRecovery(vavooUrl, clientIP, cacheKey) {
        try {
            const signature = await this.getAuthSignature(clientIP);
            const streamUrl = await this._fetchStreamUrl(vavooUrl, signature, clientIP);
            streamCache.set(cacheKey, streamUrl);
            return streamUrl;
        } catch (err) {
            if (err.status === 401 || err.status === 403) {
                console.warn(`Auth expired for ${clientIP}, refreshing...`);
                authCache.delete(clientIP);
                try {
                    const newSig = await this.getAuthSignature(clientIP);
                    const streamUrl = await this._fetchStreamUrl(vavooUrl, newSig, clientIP);
                    streamCache.set(cacheKey, streamUrl);
                    return streamUrl;
                } catch (retryErr) {
                    return this._staleFallback(cacheKey, retryErr);
                }
            }
            return this._staleFallback(cacheKey, err);
        }
    }

    _staleFallback(cacheKey, err) {
        const stale = streamCache.getStale(cacheKey);
        if (stale) {
            console.warn(`Using stale stream URL due to: ${err.message}`);
            return stale;
        }
        throw err;
    }

    async _fetchStreamUrl(vavooUrl, signature, clientIP) {
        const resolvePayload = {
            language: "de", region: "AT", url: vavooUrl, clientVersion: "3.0.2"
        };
        const resolveHeaders = {
            "user-agent": "MediaHubMX/2",
            "accept": "application/json",
            "content-type": "application/json; charset=utf-8",
            "accept-encoding": "gzip",
            "mediahubmx-signature": signature,
            "X-Forwarded-For": clientIP,
            "X-Real-IP": clientIP,
        };

        const response = await fetchWithRetry("https://vavoo.to/mediahubmx-resolve.json", {
            method: "POST",
            headers: resolveHeaders,
            body: JSON.stringify(resolvePayload)
        }, RESOLVE_TIMEOUT_MS, 1);

        if (!response.ok) throw new ExtractorError(`Vavoo Resolve API failed: ${response.status}`, response.status);

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

    async handle(url, req, res, allowedSet) {
        const startTime = Date.now();
        const clientIP = getClientIP(req);

        if (clientIP && clientIP.includes(':')) {
            res.writeHead(403, CORS_HEADERS);
            res.end('IPv6 connections are not allowed for this service. Please disable IPv6.');
            return;
        }

        if (!isAllowedVavooUrl(url, allowedSet)) {
            res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }));
            return;
        }

        const streamUrl = await this.resolveStream(url, clientIP);

        const elapsed = Date.now() - startTime;
        if (elapsed > SLOW_REQUEST_THRESHOLD_MS) {
            console.warn(`Slow manifest request: ${elapsed}ms for ${url}`);
        }

        res.writeHead(302, {
            ...CORS_HEADERS,
            'Location': streamUrl,
            'Cache-Control': 'private, max-age=60',
        });
        res.end();
    }
}

// ============================================================
//  PLAYLIST PROXY (Node.js)
// ============================================================
async function handlePlaylistProxy(req, res, allowedSet) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m3uUrlsParam = url.searchParams.get('url');
    if (!m3uUrlsParam) {
        res.writeHead(400, CORS_HEADERS);
        res.end('Error: Missing url parameter for playlist.');
        return;
    }

    const m3uUrls = m3uUrlsParam.split(';').filter(u => u.trim() !== '');
    if (m3uUrls.length === 0) {
        res.writeHead(400, CORS_HEADERS);
        res.end('Error: No valid playlist URLs provided.');
        return;
    }

    const fetchPromises = m3uUrls.map(async (m3uUrl) => {
        try {
            const response = await fetchWithTimeout(m3uUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            }, PLAYLIST_TIMEOUT_MS);
            if (response.ok) return await response.text();
        } catch (e) {
            console.error(`Failed to fetch playlist ${m3uUrl}: ${e.message}`);
        }
        return '';
    });

    const results = await Promise.all(fetchPromises);
    const combinedM3U = results.filter(t => t).join('\n');

    const workerDomain = url.origin;
    const modifiedM3U = rewritePlaylistUrls(combinedM3U, workerDomain, allowedSet);

    res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Disposition': 'inline; filename="playlist.m3u"',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    });
    res.end(modifiedM3U);
}

function rewritePlaylistUrls(m3uContent, workerDomain, allowedSet) {
    const lines = m3uContent.split('\n');
    const processedM3uParts = [];
    let lastExtinf = null;

    if (!lines[0]?.startsWith('#EXTM3U')) {
        processedM3uParts.push('#EXTM3U');
    }

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        if (trimmedLine.startsWith('#EXTM3U')) {
            if (!processedM3uParts.includes('#EXTM3U')) processedM3uParts.push(trimmedLine);
        } else if (trimmedLine.startsWith('#EXTINF:')) {
            lastExtinf = trimmedLine;
        } else if (trimmedLine.startsWith('#EXTVLCOPT:')) {
            processedM3uParts.push(trimmedLine);
        } else if (trimmedLine.startsWith('http') && lastExtinf) {
            if (isVavooHost(trimmedLine)) {
                if (isAllowedVavooUrl(trimmedLine, allowedSet)) {
                    processedM3uParts.push(lastExtinf);
                    processedM3uParts.push(`${workerDomain}/manifest.m3u8?url=${encodeURIComponent(trimmedLine)}`);
                }
            } else {
                processedM3uParts.push(lastExtinf);
                processedM3uParts.push(trimmedLine);
            }
            lastExtinf = null;
        }
    }
    return processedM3uParts.join('\n');
}

// ============================================================
//  INFO & STATUS (Node.js)
// ============================================================
function handleInfoPage(req, res) {
    const workerDomain = `http://${req.headers.host}`;
    const htmlContent = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vavoo Stream Extractor</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
      :root { --bg-primary:#0a0a0b; --bg-card:#16181c; --text-primary:#fff; --text-secondary:#b3b3b3; --accent-primary:#3b82f6; --accent-green:#10b981; --border-color:#374151; --gradient:linear-gradient(135deg,#667eea 0%,#764ba2 100%); }
      body { font-family:'Inter',sans-serif; background:var(--bg-primary); color:var(--text-primary); line-height:1.7; margin:0; }
      .container { max-width:1000px; margin:0 auto; padding:2rem; }
      .header { text-align:center; margin-bottom:3rem; }
      .header h1 { font-size:clamp(2.5rem,5vw,4rem); font-weight:700; background:var(--gradient); -webkit-background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:0.5rem; }
      .version-badge { display:inline-flex; align-items:center; gap:0.5rem; background:var(--bg-card); border:1px solid var(--border-color); padding:0.5rem 1.2rem; border-radius:2rem; font-size:0.9rem; color:var(--text-secondary); margin-bottom:1rem; }
      .status-badge { background:var(--accent-green); color:white; padding:0.2rem 0.6rem; border-radius:1rem; font-size:0.8rem; font-weight:600; }
      .description { font-size:1.2rem; color:var(--text-secondary); max-width:700px; margin:0 auto 2rem; }
      .cards-grid { display:grid; gap:2rem; margin:3rem 0; }
      .card { background:var(--bg-card); border:1px solid var(--border-color); border-radius:1.5rem; padding:2rem; }
      .card-title { font-size:1.4rem; font-weight:600; margin-bottom:1rem; }
      .card-description { color:var(--text-secondary); margin-bottom:1.5rem; }
      .endpoint-code { background:#1a1a1d; border:1px solid var(--border-color); border-radius:0.8rem; padding:1rem; font-family:'SF Mono',monospace; font-size:0.9rem; color:var(--accent-primary); word-break:break-all; }
      .footer { text-align:center; margin-top:4rem; padding:2rem 0; border-top:1px solid var(--border-color); color:#6b7280; }
      .warning { color:#f59e0b; font-weight:500; }
  </style>
</head>
<body>
  <div class="container">
      <header class="header">
          <h1>Vavoo Stream Extractor</h1>
          <div class="version-badge"><span>v1.4</span><span class="status-badge">ONLINE</span></div>
          <p class="description">Anti-freeze optimizasyonlu Vavoo stream extractor (Node.js / Render).</p>
      </header>
      <div class="cards-grid">
          <div class="card">
              <h3 class="card-title">Stream Extraction</h3>
              <p class="card-description">Yetkili Vavoo URL'si için 302 redirect.<br><span class="warning">Not:</span> Stream donuyorsa IPv6 kapat.</p>
              <div class="endpoint-code">${workerDomain}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Playlist Proxy</h3>
              <p class="card-description">Bir veya daha fazla M3U (noktalı virgülle). Sadece yetkili Vavoo kanalları listeye girer.</p>
              <div class="endpoint-code">${workerDomain}/playlist?url=&lt;URL1&gt;;&lt;URL2&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Status</h3>
              <p class="card-description">Cache istatistikleri ve durum.</p>
              <div class="endpoint-code">${workerDomain}/status</div>
          </div>
      </div>
      <footer class="footer"><p>&copy; 2025 Vavoo Extractor</p></footer>
  </div>
</body>
</html>`;
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
}

function handleStatus(req, res, allowedSet) {
    const clientIP = getClientIP(req);
    const statusInfo = {
        status: "operational",
        version: "1.4-node",
        timestamp: new Date().toISOString(),
        client_info: {
            ip: clientIP,
            country: req.headers['cf-ipcountry'] || 'unknown',
            user_agent: req.headers['user-agent'] || 'unknown',
            is_ipv6: clientIP.includes(':'),
        },
        whitelist: { enabled: true, allowed_channel_count: allowedSet.size },
        cache_stats: {
            auth_cache_size: authCache.map.size,
            stream_cache_size: streamCache.map.size,
            auth_in_flight: authInFlight.size,
            stream_in_flight: streamInFlight.size,
            auth_ttl_minutes: AUTH_CACHE_TTL_MS / 60000,
            stream_ttl_minutes: STREAM_CACHE_TTL_MS / 60000,
            stale_retention_minutes: STALE_RETENTION_MS / 60000,
        },
        supported_services: {
            vavoo: { mode: "redirect", path: "/manifest.m3u8?url=https://vavoo.to/..." },
        },
        endpoints: {
            info: `http://${req.headers.host}/`,
            status: `http://${req.headers.host}/status`,
            playlist_proxy: `http://${req.headers.host}/playlist?url=<m3u_url>`,
        }
    };
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusInfo, null, 2));
}

// ============================================================
//  ANA SUNUCU (Node.js HTTP)
// ============================================================
const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const allowedSet = getAllowedChannelIds();

    try {
        if (url.pathname === '/' || url.pathname === '') {
            handleInfoPage(req, res);
            return;
        }
        if (url.pathname === '/status') {
            handleStatus(req, res, allowedSet);
            return;
        }
        if (url.pathname === '/playlist') {
            await handlePlaylistProxy(req, res, allowedSet);
            return;
        }

        if (url.pathname === '/manifest.m3u8') {
            if (!url.searchParams.has('url')) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing "url" parameter' }));
                return;
            }
            const targetUrl = url.searchParams.get('url');

            if (!isVavooHost(targetUrl)) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported.' }));
                return;
            }
            if (!isAllowedVavooUrl(targetUrl, allowedSet)) {
                res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }));
                return;
            }
            const extractor = new VavooExtractor();
            await extractor.handle(targetUrl, req, res, allowedSet);
            return;
        }

        if (url.pathname === '/proxy/hls/manifest.m3u8') {
            const targetUrl = url.searchParams.get('d');
            if (!targetUrl) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing "d" parameter' }));
                return;
            }
            if (!isVavooHost(targetUrl)) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported in parameter "d".' }));
                return;
            }
            if (!isAllowedVavooUrl(targetUrl, allowedSet)) {
                res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }));
                return;
            }
            const extractor = new VavooExtractor();
            await extractor.handle(targetUrl, req, res, allowedSet);
            return;
        }

        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '404 Not Found' }));

    } catch (error) {
        console.error(`Node.js Error: ${error.stack || error.message}`);
        res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message, type: error.name }));
    }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Vavoo Extractor listening on port ${PORT}`);
});
