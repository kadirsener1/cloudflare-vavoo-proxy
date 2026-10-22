/**
 * Node.js uyarlaması - Render.com için
 * AKILLI YÖNLENDİRME MİMARİSİ (302 Redirect + Token Refresh)
 * 
 * Video trafiği Render'dan GEÇMEZ → bant genişliği kotası korunur
 * Render sadece yönlendirme ve token dağıtım istasyonu olarak çalışır
 */
const http = require('http');
const { URL } = require('url');

// ============================================================
//  WHITELIST
// ============================================================
const DEFAULT_ALLOWED_CHANNEL_IDS = [
   '143239535a2e3c23c1d16', //1 BEIN SPOTS1 SD
'1363827223a1c98515d612', //2 BEIN 1 FEED (720P)
'3692337241ec1b0872b06e', //3 BEIN 1 SD (360P)
'300113394ceebba66c8ad', //4 BEIN SPORTS 1
'38404756531618c87fcc66', //5 BEIN SPORTS 1 (720P)
'22330664333ebb4acbb6ab', //6 BEIN SPORTS 1 (720PFEED)
'342898470360b159ef8301', //7 BEIN SPORTS 1 [LIVE DURING EVENTS ONLY]
'2576216897d1c2b14af4e9', //8 BEIN SPORTS 1 +
'13524210538e192d878d20', //9 BEIN SPORTS 1 50 FPS
'2729088606df69156b1eda', //10 BEIN SPORTS 1 FEED
'24034250314fd9aa349685', //11 BEIN SPORTS 1 H265
'5934938605e361d7e0ff0', //12 BEIN SPORTS 1 HD (TURKEY)
'499485497d6131f47417d', //13 BEIN SPORTS 720P FEED
'2113462398d8dd57a8ea73', //14 BEIN SPORTS 8K FEED
'1453692314f52730c50395', //15 BEIN SPORTS FEED (OZEL FEED YAYIN)
'267105889a25a483e5e80', //16 BEIN SPORTS 4K FEED(KUTU)
'1536730627bbf8f95ca477', //17 BEIN SPORTS 4K FEED(UYDU)
'1447241506bdccfad8b85c', //18 BEIN SPORTS 2
'250946619196f7d48e5d74', //19 BEIN SPORTS 2
'28515391437e928cafd5dd', //20 BEIN SPORTS 2 HD
'323636291171b2af97d745', //21 BEIN SPORTS 2 SD
'3694662475a36c53181838', //22 BEIN SPORTS 2 UHD
'179745960216563080394f', //23 BEIN SPORTS 3
'2834514943d9fcc1df9594', //24 BEIN SPORTS 3
'17005958018c5d23b49ef0', //25 BEIN SPORTS 3 HD
'206371329905d7f81fb9d', //26 BEIN SPORTS 3 SD
'3410167560f6960a0d6de9', //27 BEIN SPORTS 3 UHD
'3640906370384c4c528e99', //28 BEIN SPORTS 4
'450076655d706ff73e384', //29 BEIN SPORTS 4
'1872232768c7c65ceb9862', //30 BEIN SPORTS 4 HD
'2938268353a63a37b4528e', //31 BEIN SPORTS 4 UHD
'12304481920a92c9204dcd', //32 BEIN SPORTS 5 (MATCH TIME)
'2737963486b4d9c437a945', //33 BEIN SPORTS 5 HD
'1197336000e1b7dd01506d', //34 BEIN SPORTS HABER
'280607961285361f558fc8', //35 BEIN SPORTS HABER
'3989995533d0efea1c8696', //36 BEIN SPORTS HABER HD
'164663282518e6179f90af', //37 BEIN SPORTS HABER RAW
'1221587067c43d5b265b10', //38 BEIN SPORTS MAX 1
'283243053554cc6eb0a10a', //39 BEIN SPORTS MAX 1
'4071474743dbe8a60b9395', //40 BEIN SPORTS MAX 1 FHD
'22528142332d275721233', //41 BEIN SPORTS MAX 1 HD
'25896823596a84e43dd09', //42 BEIN SPORTS MAX 2
'4017295127660d677c32f9', //43 BEIN SPORTS MAX 2
'3407936242f95c33ae8820', //44 BEIN SPORTS MAX 2 FHD
'2212659820b109b476a4d3', //45 BEIN SPORTS MAX 2 HD
'21232735984a3f0b463d66', //46 S SPORT
'33465497225b9857743b71', //47 S SPORT
'37183362955b988ce99242', //48 S SPORT
'3962972352ea44b8b75128', //49 S SPORT
'1313768516926dc999c43b', //50 S SPORT 2
'1234604880d226de6d47be', //51 S SPORT 2
'3269372326de5ff1a4d9d7', //52 S SPORT+3 MAC SAATI
'1507829436cb5aa4fb5b34', //53 S SPORT+4 MAC SAATI
'376048776421ffc14b9074', //54 S SPORT+5 MAC SAATI
'1406262118fb4f653061f6', //55 TIVIBU SPOR RAW
'1159899920595e9c441350', //56 TIVIBU SPOR
'36535158588fee46401238', //57 TIVIBUSPOR SPOR HD
'25659723389efdd2098be1', //58 TIVIBU SPOR 1
'1528949791210996169a6f', //59 TIVIBU SPOR 1
'2046583925cdbd476d8733', //60 TIVIBU SPOR 1 HD
'289665874444b8f4f2d451', //61 TIVIBUSPOR 1 FHD
'36545180071dd8a862ae2e', //62 TIVIBUSPOR 1 HD
'37466838109fc1c67c228d', //63 TIVIBU SPOR 2
'4782547993a1194125c51', //64 TIVIBU SPOR 2
'415153448631eabe6978ed', //65 TIVIBU SPOR 2 HD
'25026063331fd9c2bab71e', //66 TIVIBUSPOR 2 FHD
'1465680660b8cd069bfa4c', //67 TIVIBUSPOR 2 HD
'37949240505288959ad99c', //68 TIVIBU SPOR 3
'568442751987b14d1ad00', //69 TIVIBU SPOR 3
'100410240872b813d41c94', //70 TIVIBU SPOR 3 HD
'21863899508f19a672f26d', //71 TIVIBUSPOR 3 FHD
'261662401043fc1ad1ed6f', //72 TIVIBUSPOR 3 HD
'1343303170fbfea75b9f15', //73 TIVIBU SPOR 4
'3307062704472686916fe7', //74 TIVIBU SPOR 4 HD
'163038510f87c95f99d11', //75 TIVIBU SPOR 5 HD
'3159604752e1cba547bb', //76 4K TR: SPOR SMART
'4137962062d812f45c58bd', //77 SMART SPOR 1
'1771511397d05184d3e443', //78 SPOR SMART
'3278735965dfe5a38d92ee', //79 SPOR SMART 1
'37639315201c3521e36c44', //80 SPOR SMART FHD
'1313563350f4a25655e128', //81 SPOR SMART HD
'3445708926e6195304f00c', //82 SPOR SMART HEVC
'660246670c64f4ea57a46', //83 SPOR SMART SD
'90716509593fd6426951b', //84 SPOR SMART 2
'2228088973f56fff74c71f', //85 SPOR SMART 2
'2726496671ea6fd3c6dc54', //86 SPOR SMART 2 HD
   //ULUSAL
   '4559304258567c5d6cd2a', //atv hd
   '194868101172e4362de24e', //atv fhd
   '161305206673e7c4b7739', //NOW HD
   //HABER
   '41338152650143743f9d7', //CNN FHD
   '3278683973d0eaa4e57d76', //CNN2
   '960578312ee36cc17c5d2', // sozcü
   '194868101172e4362de24e', //akit
   //BELGESEL
'361703541447c2d8cea904', //87 BEİN GURME
'178850393550c13d869fbf', // 88 YABAN TV
'1165670263945583e36e19', //viasat history
'17854799144cbb1c340ac1', // special box belgesel
'3856957052050da882aa10', // tarih tv
'1960546091bcaf052d3800', //nat geo
'1324166169d75d5197aa7', //NAT WİLD
'4017734592f45fd8456678', //discovery
   //ÇOCUK
   '11743931b356e8661a4d', // Cartonito
   '2046583925cdbd476d8733', //Anigo Zorex
   '7274274379cbbe0c37b06', //REDBOX ANİMASYON 1
];

const ALLOWED_CHANNEL_SET = (() => {
    const envVal = process.env.ALLOWED_CHANNEL_IDS;
    if (envVal && envVal.trim() !== '') {
        return new Set(envVal.split(',').map(s => s.trim()).filter(Boolean));
    }
    return new Set(DEFAULT_ALLOWED_CHANNEL_IDS);
})();

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
//  YARDIMCILAR
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

function isAllowedVavooUrl(url) {
    const id = extractVavooChannelId(url);
    return id !== null && ALLOWED_CHANNEL_SET.has(id);
}

// ============================================================
//  TTL CACHE
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
//  VAVOO EXTRACTOR
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
//  YENİLEME (REFRESH) ENDPOINT — istemci periyodik olarak çağırır
//  Video trafiği YOK, sadece JSON cevap
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
        // Cache'i atlayarak her zaman yeni token al
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
//  MANIFEST (302 REDIRECT — video trafiği Render'dan geçmez)
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

    // 302 redirect: player doğrudan Vavoo CDN'e gider
    // Render'dan sadece ~200 byte'lık yönlendirme çıkar
    res.writeHead(302, {
        ...CORS_HEADERS,
        'Location': streamUrl,
        'Cache-Control': 'private, max-age=60',
    });
    res.end();
}

// ============================================================
//  PLAYLIST PROXY
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
                    // Liste içinde manifest endpoint'ine yönlendir
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
//  INFO SAYFASI
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
      .warning { color:#f59e0b; font-weight:500; }
      .green { color:var(--accent-green); font-weight:600; }
  </style>
</head>
<body>
  <div class="container">
      <header class="header">
          <h1>Vavoo Smart Redirect</h1>
          <div class="version-badge"><span>v3.0</span><span class="status-badge">ONLINE</span></div>
          <p class="description">302 yönlendirme + token refresh mimarisi. <span class="green">Video trafiği Render'dan geçmez.</span></p>
      </header>
      <div class="cards-grid">
          <div class="card">
              <h3 class="card-title">Manifest (302 Redirect)</h3>
              <p class="card-description">Yetkili Vavoo URL'si için 302 redirect. Player doğrudan Vavoo'ya bağlanır, Render sadece ~200 byte yönlendirme gönderir.</p>
              <div class="endpoint-code">${origin}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Token Refresh (JSON)</h3>
              <p class="card-description">Player periyodik olarak (örn. 5 dk) bu endpoint'i çağırıp taze stream URL'i alır. Video verisi yok, sadece JSON.</p>
              <div class="endpoint-code">${origin}/refresh?vavoo_url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Playlist Proxy</h3>
              <p class="card-description">Bir veya daha fazla M3U (noktalı virgülle). Sadece yetkili Vavoo kanalları listeye girer.</p>
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
//  STATUS
// ============================================================
function handleStatus(req, res) {
    const clientIP = getClientIP(req) || '';
    const origin = getOrigin(req);
    const statusInfo = {
        status: "operational",
        version: "3.0-smart-redirect",
        timestamp: new Date().toISOString(),
        client_info: {
            ip: clientIP,
            country: req.headers['cf-ipcountry'] || 'unknown',
            user_agent: req.headers['user-agent'] || 'unknown',
            is_ipv6: clientIP.includes(':'),
        },
        whitelist: { enabled: true, allowed_channel_count: ALLOWED_CHANNEL_SET.size },
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
//  ANA SUNUCU
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

        // ---- REFRESH (JSON — istemci periyodik çağırır)
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

            if (!isVavooHost(targetUrl)) {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported.' }));
                return;
            }
            if (!isAllowedVavooUrl(targetUrl)) {
                res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'This Vavoo channel is not authorized on this worker.' }));
                return;
            }

            await handleManifestRedirect(req, res, targetUrl);
            return;
        }

        // ---- 404
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '404 Not Found' }));

    } catch (error) {
        console.error(`Node.js Error: ${error.stack || error.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message, type: error.name }));
        } else {
            try { res.destroy(); } catch {}
        }
    }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Vavoo Smart Redirect v3.0 listening on port ${PORT}`);
    console.log(`Architecture: 302 redirect + token refresh`);
    console.log(`Video traffic: NOT through this server`);
});
