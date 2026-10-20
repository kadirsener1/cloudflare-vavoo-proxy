/**
 * Deno Deploy - Vavoo Stream Extractor
 * Version: 1.3-deno
 * Uyarlama: Cloudflare Workers -> Deno Deploy
 */

// ============================================================
//  İZİN VERİLEN KANALLAR (WHITELIST)
// ============================================================
const DEFAULT_ALLOWED_CHANNEL_IDS = [
    '22330664333ebb4acbb6ab',
    // 'buraya_yeni_kanal_id_ekle',
];

// ============================================================
//  Sabitler
// ============================================================

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
//  Yardımcılar
// ============================================================

function getClientIP(request: Request): string {
    try {
        const url = new URL(request.url);
        const explicitIp = url.searchParams.get('ip');
        if (explicitIp && explicitIp.trim()) return explicitIp.trim();
    } catch {}
    return request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        request.headers.get('X-Real-IP') ||
        '127.0.0.1';
}

class ExtractorError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'ExtractorError';
        this.status = status;
    }
}

// --- Whitelist (Deno Deploy ortam değişkeni) ---

function getAllowedChannelIds(): Set<string> {
    const envVal = Deno.env.get('ALLOWED_CHANNEL_IDS');
    if (envVal && envVal.trim() !== '') {
        return new Set(
            envVal.split(',').map((s: string) => s.trim()).filter(Boolean)
        );
    }
    return new Set(DEFAULT_ALLOWED_CHANNEL_IDS);
}

function isVavooHost(url: string): boolean {
    try {
        const u = new URL(url);
        return u.hostname === 'vavoo.to' || u.hostname.endsWith('.vavoo.to');
    } catch {
        return false;
    }
}

function extractVavooChannelId(url: string): string | null {
    try {
        if (!isVavooHost(url)) return null;
        const u = new URL(url);
        const m = u.pathname.match(/\/play\/([^/?#]+)/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

function isAllowedVavooUrl(url: string, allowedSet: Set<string>): boolean {
    const id = extractVavooChannelId(url);
    return id !== null && allowedSet.has(id);
}

// --- TTL Cache ---

class TTLCache {
    map = new Map<string, { value: string; expiry: number }>();
    ttlMs: number;
    maxEntries: number;
    lastCleanup = Date.now();

    constructor(ttlMs: number, maxEntries = MAX_CACHE_ENTRIES) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    get(key: string): string | null {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (entry.expiry <= Date.now()) return null;
        return entry.value;
    }

    getStale(key: string): string | null {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (Date.now() - entry.expiry > STALE_RETENTION_MS) {
            this.map.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key: string, value: string): void {
        if (this.map.size >= this.maxEntries) {
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined) this.map.delete(firstKey);
        }
        this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
        this.cleanupIfNeeded();
    }

    delete(key: string): void {
        this.map.delete(key);
    }

    cleanupIfNeeded(): void {
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

const authInFlight = new Map<string, Promise<string>>();
const streamInFlight = new Map<string, Promise<string>>();

// --- Fetch ---

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchWithRetry(url: string, options: RequestInit, timeoutMs: number, retries = 1): Promise<Response> {
    let lastErr: Error | ExtractorError | undefined;
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
//  Vavoo Extractor
// ============================================================

class VavooExtractor {

    async getAuthSignature(clientIP: string): Promise<string> {
        const cached = authCache.get(clientIP);
        if (cached) return cached;

        const inFlight = authInFlight.get(clientIP);
        if (inFlight) return inFlight;

        const promise = this._fetchAuthSignature(clientIP)
            .finally(() => authInFlight.delete(clientIP));
        authInFlight.set(clientIP, promise);
        return promise;
    }

    async _fetchAuthSignature(clientIP: string): Promise<string> {
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
        const result = await response.json() as any;
        if (!result.addonSig) throw new ExtractorError('Vavoo auth response missing addonSig.');

        let addonSig: string = result.addonSig;
        try {
            const decoded = atob(addonSig);
            const sigObj = JSON.parse(decoded);
            if (sigObj && sigObj.data) {
                const dataObj = JSON.parse(sigObj.data);
                if (clientIP) {
                    const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
                    dataObj.ips = [clientIP, ...currentIps.filter((x: string) => x && x !== clientIP)];
                    if (typeof dataObj.ip === 'string') dataObj.ip = clientIP;
                    sigObj.data = JSON.stringify(dataObj);
                    addonSig = btoa(JSON.stringify(sigObj));
                }
            }
        } catch (_e) { /* rewrite başarısız → orijinali kullan */ }

        authCache.set(clientIP, addonSig);
        return addonSig;
    }

    async resolveStream(vavooUrl: string, clientIP: string): Promise<string> {
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

    async _resolveWithRecovery(vavooUrl: string, clientIP: string, cacheKey: string): Promise<string> {
        try {
            const signature = await this.getAuthSignature(clientIP);
            const streamUrl = await this._fetchStreamUrl(vavooUrl, signature, clientIP);
            streamCache.set(cacheKey, streamUrl);
            return streamUrl;
        } catch (err: any) {
            if (err.status === 401 || err.status === 403) {
                console.warn(`Auth expired for ${clientIP}, refreshing and retrying...`);
                authCache.delete(clientIP);
                try {
                    const newSig = await this.getAuthSignature(clientIP);
                    const streamUrl = await this._fetchStreamUrl(vavooUrl, newSig, clientIP);
                    streamCache.set(cacheKey, streamUrl);
                    return streamUrl;
                } catch (retryErr: any) {
                    return this._staleFallback(cacheKey, retryErr);
                }
            }
            return this._staleFallback(cacheKey, err);
        }
    }

    _staleFallback(cacheKey: string, err: Error): string {
        const stale = streamCache.getStale(cacheKey);
        if (stale) {
            console.warn(`Using stale stream URL due to: ${err.message}`);
            return stale;
        }
        throw err;
    }

    async _fetchStreamUrl(vavooUrl: string, signature: string, clientIP: string): Promise<string> {
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

        const result = await response.json() as any;
        let streamUrl: string | undefined;
        if (Array.isArray(result)) {
            const httpsStream = result.find((item: any) => item.url && item.url.startsWith('https://'));
            streamUrl = httpsStream ? httpsStream.url : result[0]?.url;
        } else {
            streamUrl = result?.url;
        }
        if (!streamUrl) throw new ExtractorError('Vavoo resolve response contains no valid stream URL.');
        return streamUrl!;
    }

    async handle(url: string, request: Request, allowedSet: Set<string>): Promise<Response> {
        const startTime = Date.now();
        const clientIP = getClientIP(request);

        if (clientIP && clientIP.includes(':')) {
            return new Response('IPv6 connections are not allowed for this service. Please disable IPv6.', {
                status: 403, headers: CORS_HEADERS
            });
        }

        if (!isAllowedVavooUrl(url, allowedSet)) {
            return new Response(JSON.stringify({
                error: 'This Vavoo channel is not authorized on this worker.'
            }), {
                status: 403,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const streamUrl = await this.resolveStream(url, clientIP);

        const elapsed = Date.now() - startTime;
        if (elapsed > SLOW_REQUEST_THRESHOLD_MS) {
            console.warn(`Slow manifest request: ${elapsed}ms for ${url}`);
        }

        return new Response(null, {
            status: 302,
            headers: {
                ...CORS_HEADERS,
                'Location': streamUrl,
                'Cache-Control': 'private, max-age=60',
            },
        });
    }
}

// ============================================================
//  M3U Playlist Proxy
// ============================================================

async function handlePlaylistProxy(request: Request, allowedSet: Set<string>): Promise<Response> {
    const url = new URL(request.url);
    const m3uUrlsParam = url.searchParams.get('url');
    if (!m3uUrlsParam) {
        return new Response('Error: Missing url parameter for playlist.', { status: 400, headers: CORS_HEADERS });
    }

    const m3uUrls = m3uUrlsParam.split(';').filter((u: string) => u.trim() !== '');
    if (m3uUrls.length === 0) {
        return new Response('Error: No valid playlist URLs provided.', { status: 400, headers: CORS_HEADERS });
    }

    const fetchPromises = m3uUrls.map(async (m3uUrl: string) => {
        try {
            // Deno Deploy'da 'cf' yok; edge cache için Cache-Control başlığı kullanıyoruz.
            const response = await fetchWithTimeout(m3uUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            }, PLAYLIST_TIMEOUT_MS);
            if (response.ok) return await response.text();
        } catch (e: any) {
            console.error(`Failed to fetch playlist ${m3uUrl}: ${e.message}`);
        }
        return '';
    });

    const results = await Promise.all(fetchPromises);
    const combinedM3U = results.filter((t: string) => t).join('\n');

    const workerDomain = url.origin;
    const modifiedM3U = rewritePlaylistUrls(combinedM3U, workerDomain, allowedSet);

    return new Response(modifiedM3U, {
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Content-Disposition': 'inline; filename="playlist.m3u"',
            'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        }
    });
}

function rewritePlaylistUrls(m3uContent: string, workerDomain: string, allowedSet: Set<string>): string {
    const lines = m3uContent.split('\n');
    const processedM3uParts: string[] = [];
    let lastExtinf: string | null = null;

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
//  Info & Status
// ============================================================

function handleInfoPage(request: Request): Response {
    const workerDomain = new URL(request.url).origin;
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
          <div class="version-badge"><span>v1.3-deno</span><span class="status-badge">ONLINE</span></div>
          <p class="description">Anti-freeze optimizasyonlu Vavoo stream extractor (Deno Deploy).</p>
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
    return new Response(htmlContent, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function handleStatus(request: Request, allowedSet: Set<string>): Response {
    const clientIP = getClientIP(request);
    const statusInfo = {
        status: "operational",
        version: "1.3-deno",
        timestamp: new Date().toISOString(),
        client_info: {
            ip: clientIP,
            country: request.headers.get('CF-IPCountry') || 'unknown',
            user_agent: request.headers.get('User-Agent') || 'unknown',
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
            info: new URL(request.url).origin + '/',
            status: new URL(request.url).origin + '/status',
            playlist_proxy: new URL(request.url).origin + '/playlist?url=<m3u_url>',
        }
    };
    return new Response(JSON.stringify(statusInfo, null, 2), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
}

// ============================================================
//  Deno Deploy Ana Handler
// ============================================================

Deno.serve(async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const allowedSet = getAllowedChannelIds();

    try {
        if (url.pathname === '/' || url.pathname === '') {
            return handleInfoPage(request);
        }
        if (url.pathname === '/status') {
            return handleStatus(request, allowedSet);
        }
        if (url.pathname === '/playlist') {
            return await handlePlaylistProxy(request, allowedSet);
        }

        if (url.pathname === '/manifest.m3u8') {
            if (!url.searchParams.has('url')) {
                return new Response(JSON.stringify({ error: 'Missing "url" parameter' }), {
                    status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const targetUrl = url.searchParams.get('url')!;

            if (!isVavooHost(targetUrl)) {
                return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported.' }), {
                    status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            if (!isAllowedVavooUrl(targetUrl, allowedSet)) {
                return new Response(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }), {
                    status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const extractor = new VavooExtractor();
            return await extractor.handle(targetUrl, request, allowedSet);
        }

        if (url.pathname === '/proxy/hls/manifest.m3u8') {
            const targetUrl = url.searchParams.get('d');
            if (!targetUrl) {
                return new Response(JSON.stringify({ error: 'Missing "d" parameter' }), {
                    status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            if (!isVavooHost(targetUrl)) {
                return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported in parameter "d".' }), {
                    status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            if (!isAllowedVavooUrl(targetUrl, allowedSet)) {
                return new Response(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }), {
                    status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const extractor = new VavooExtractor();
            return await extractor.handle(targetUrl, request, allowedSet);
        }

        return new Response(JSON.stringify({ error: '404 Not Found' }), {
            status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        console.error(`Deno Deploy Error: ${error.stack || error.message}`);
        return new Response(JSON.stringify({
            error: error.message,
            type: error.name,
        }), {
            status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }
});
