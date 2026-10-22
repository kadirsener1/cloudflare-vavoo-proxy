/**
 * Node.js uyarlaması - Render.com için
 * AKILLI YÖNLENDİRME MİMARİSİ (302 Redirect + Token Refresh)
 * 
 * Video trafiği Render'dan GEÇMEZ → bant genişliği kotası korunur
 * Render sadece yönlendirme ve token dağıtım istasyonu olarak çalışır
 */
const http = require('http');
const { URL } = require('url');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Accept, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Location',
};

const AUTH_TIMEOUT_MS = 8000;
const RESOLVE_TIMEOUT_MS = 10000;
const PLAYLIST_TIMEOUT_MS = 10000;

// Token ~10 dk ömürlü; cache 5 dk
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_RETENTION_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

const SLOW_REQUEST_THRESHOLD_MS = 3000;

// ============================================================
// YARDIMCILAR
// ============================================================
function getOrigin(req) {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

function getClientIP(req) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const explicitIp = url.searchParams.get('ip');
        if (explicitIp && explicitIp.trim()) return explicitIp.trim();
    } catch {}
    return req.headers['cf-connecting-ip'] ||
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        null;
}

class ExtractorError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ExtractorError';
        this.status = status;
    }
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

// Whitelist kısıtlaması kaldırıldı: Geçerli bir Vavoo kanal ID'sine sahip tüm URL'ler kabul edilir
function isAllowedVavooUrl(url) {
    return extractVavooChannelId(url) !== null;
}

// ============================================================
// TTL CACHE
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
    delete(key) { this.map.delete(key); }
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
// FETCH YARDIMCILARI
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
// VAVOO EXTRACTOR
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
            "X-Forwarded-For": clientIP || '',
            "X-Real-IP": clientIP || '',
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
            "X-Forwarded-For": clientIP || '',
            "X-Real-IP": clientIP || '',
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
}

// ============================================================
// YENİLEME (REFRESH) ENDPOINT
// ============================================================
async function handleRefresh(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const vavooUrl = url.searchParams.get('vavoo_url') || url.searchParams.get('url');
    if (!vavooUrl) {
        res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing vavoo_url parameter' }));
        return;
    }
    if (!isVavooHost(vavooUrl) || !isAllowedVavooUrl(vavooUrl)) {
        res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vavoo URL not authorized' }));
        return;
    }

    const clientIP = getClientIP(req);
    const extractor = new VavooExtractor();

    try {
        const cacheKey = `${clientIP}|${vavooUrl}`;
        streamCache.delete(cacheKey);
        authCache.delete(clientIP);

        const freshUrl = await extractor.resolveStream(vavooUrl, clientIP);
        const ttlSeconds = STREAM_CACHE_TTL_MS / 1000;

        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({
            url: freshUrl,
            vavoo_url: vavooUrl,
            expires_in: ttlSeconds,
            next_refresh_in: Math.max(60, ttlSeconds - 30),
            timestamp: new Date().toISOString(),
        }));
    } catch (e) {
        console.error(`Refresh failed for ${vavooUrl}: ${e.message}`);
        res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Refresh failed', detail: e.message }));
    }
}

// ============================================================
// MANIFEST (302 REDIRECT)
// ============================================================
async function handleManifestRedirect(req, res, targetUrl) {
    const clientIP = getClientIP(req);

    if (clientIP && clientIP.includes(':')) {
        res.writeHead(403, CORS_HEADERS);
        res.end('IPv6 connections are not allowed for this service. Please disable IPv6.');
        return;
    }

    const startTime = Date.now();
    const extractor = new VavooExtractor();

    let streamUrl;
    try {
        streamUrl = await extractor.resolveStream(targetUrl, clientIP);
    } catch (e) {
        console.error(`Resolve failed for ${targetUrl}: ${e.message}`);
        res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to resolve stream.', detail: e.message }));
        return;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > SLOW_REQUEST_THRESHOLD_MS) {
        console.warn(`Slow resolve: ${elapsed}ms for ${targetUrl}`);
    }

    res.writeHead(302, {
        ...CORS_HEADERS,
        'Location': streamUrl,
        'Cache-Control': 'private, max-age=60',
    });
    res.end();
}

// ============================================================
// PLAYLIST PROXY
// ============================================================
async function handlePlaylistProxy(req, res) {
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

    const results = await Promise.all(m3uUrls.map(async (m3uUrl) => {
        try {
            const r = await fetchWithTimeout(m3uUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            }, PLAYLIST_TIMEOUT_MS);
            if (r.ok) return await r.text();
        } catch (e) {
            console.error(`Failed to fetch playlist ${m3uUrl}: ${e.message}`);
        }
        return '';
    }));

    const combined = results.filter(t => t).join('\n');
    const origin = getOrigin(req);
    const modified = rewritePlaylistUrls(combined, origin);

    res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Disposition': 'inline; filename="playlist.m3u"',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    });
    res.end(modified);
}

function rewritePlaylistUrls(m3uContent, origin) {
    const lines = m3uContent.split('\n');
    const parts = [];
    let lastExtinf = null;

    if (!lines[0]?.startsWith('#EXTM3U')) parts.push('#EXTM3U');

    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;

        if (t.startsWith('#EXTM3U')) {
            if (!parts.includes('#EXTM3U')) parts.push(t);
        } else if (t.startsWith('#EXTINF:')) {
            lastExtinf = t;
        } else if (t.startsWith('#EXTVLCOPT:')) {
            parts.push(t);
        } else if (t.startsWith('http') && lastExtinf) {
            if (isVavooHost(t)) {
                if (isAllowedVavooUrl(t)) {
                    parts.push(lastExtinf);
                    parts.push(`${origin}/manifest.m3u8?url=${encodeURIComponent(t)}`);
                }
            } else {
                parts.push(lastExtinf);
                parts.push(t);
            }
            lastExtinf = null;
        }
    }
    return parts.join('\n');
}

// ============================================================
// INFO SAYFASI
// ============================================================
function handleInfoPage(req, res) {
    const origin = getOrigin(req);
    const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vavoo Smart Redirect</title>
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
      .green { color:var(--accent-green); font-weight:600; }
  </style>
</head>
<body>
  <div class="container">
      <header class="header">
          <h1>Vavoo Smart Redirect</h1>
          <div class="version-badge"><span>v3.0 - Unrestricted</span><span class="status-badge">ONLINE</span></div>
          <p class="description">302 yönlendirme + token refresh mimarisi. <span class="green">Video trafiği Render'dan geçmez.</span></p>
      </header>
      <div class="cards-grid">
          <div class="card">
              <h3 class="card-title">Manifest (302 Redirect)</h3>
              <p class="card-description">Vavoo URL'si için 302 redirect. Player doğrudan Vavoo'ya bağlanır, Render sadece yönlendirme gönderir.</p>
              <div class="endpoint-code">${origin}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Token Refresh (JSON)</h3>
              <p class="card-description">Player periyodik olarak bu endpoint'i çağırıp taze stream URL'i alır.</p>
              <div class="endpoint-code">${origin}/refresh?vavoo_url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Playlist Proxy</h3>
              <p class="card-description">Bir veya daha fazla M3U dosyası proxy'lenir.</p>
              <div class="endpoint-code">${origin}/playlist?url=&lt;URL1&gt;;&lt;URL2&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Status</h3>
              <p class="card-description">Cache istatistikleri ve durum.</p>
              <div class="endpoint-code">${origin}/status</div>
          </div>
      </div>
      <footer class="footer"><p>&copy; 2025 Vavoo Smart Redirect — Bant genişliği dostu</p></footer>
  </div>
</body>
</html>`;
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

// ============================================================
// STATUS
// ============================================================
function handleStatus(req, res) {
    const clientIP = getClientIP(req) || '';
    const origin = getOrigin(req);
    const statusInfo = {
        status: "operational",
        version: "3.0-smart-redirect-unrestricted",
        timestamp: new Date().toISOString(),
        client_info: {
            ip: clientIP,
            country: req.headers['cf-ipcountry'] || 'unknown',
            user_agent: req.headers['user-agent'] || 'unknown',
            is_ipv6: clientIP.includes(':'),
        },
        whitelist: { enabled: false, note: "All valid Vavoo channels are allowed" },
        cache_stats: {
            auth_cache_size: authCache.map.size,
            stream_cache_size: streamCache.map.size,
            auth_in_flight: authInFlight.size,
            stream_in_flight: streamInFlight.size,
            auth_ttl_minutes: AUTH_CACHE_TTL_MS / 60000,
            stream_ttl_minutes: STREAM_CACHE_TTL_MS / 60000,
            stale_retention_minutes: STALE_RETENTION_MS / 60000,
        },
        architecture: {
            mode: "302-redirect",
            video_traffic_through_render: false,
            bandwidth_used_per_play: "~200 bytes (redirect only)",
            refresh_endpoint: `${origin}/refresh?vavoo_url=<url>`,
            recommended_refresh_interval_seconds: 300,
        },
        endpoints: {
            info: `${origin}/`,
            status: `${origin}/status`,
            manifest: `${origin}/manifest.m3u8?url=<vavoo_url>`,
            refresh: `${origin}/refresh?vavoo_url=<vavoo_url>`,
            playlist_proxy: `${origin}/playlist?url=<m3u_url>`,
        }
    };
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusInfo, null, 2));
}

// ============================================================
// ANA SUNUCU
// ============================================================
const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        // ---- INFO
        if (url.pathname === '/' || url.pathname === '') {
            handleInfoPage(req, res);
            return;
        }

        // ---- STATUS
        if (url.pathname === '/status') {
            handleStatus(req, res);
            return;
        }

        // ---- PLAYLIST PROXY
        if (url.pathname === '/playlist') {
            await handlePlaylistProxy(req, res);
            return;
        }

        // ---- REFRESH (JSON)
        if (url.pathname === '/refresh') {
            await handleRefresh(req, res);
            return;
        }

        // ---- MANIFEST → 302 REDIRECT
        if (url.pathname === '/manifest.m3u8' || url.pathname === '/proxy/hls/manifest.m3u8') {
            const paramName = url.pathname === '/manifest.m3u8' ? 'url' : 'd';
            if (!url.searchParams.has(paramName)) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Missing "${paramName}" parameter` }));
                return;
            }
            const targetUrl = url.searchParams.get(paramName);
            if (!isVavooHost(targetUrl) || !isAllowedVavooUrl(targetUrl)) {
                res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Vavoo URL not authorized' }));
                return;
            }
            await handleManifestRedirect(req, res, targetUrl);
            return;
        }

        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
        console.error(`Server error: ${e.message}`);
        res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', detail: e.message }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
