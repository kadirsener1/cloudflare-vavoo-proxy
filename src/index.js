/**
 * Cloudflare Worker for Vavoo Stream Extraction
 * Repo: cloudflare-vavoo-proxy
 * Version: 2.3 (Fixed 403: vavoo.tv API + Referer/Origin + HTTPS + Cache API)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Accept, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Location',
};

// Segmentlerin edge cache'de kalma süresi (saniye)
const SEGMENT_CACHE_TTL = 3600;

function getClientIP(request) {
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
  constructor(message) {
      super(message);
      this.name = 'ExtractorError';
  }
}

// --- m3u8 URL Rewrite ---
function rewritePlaylist(text, baseUrl, workerOrigin) {
  const base = new URL(baseUrl);
  const proxyPrefix = `${workerOrigin}/proxy-segment?url=`;

  function rewriteUrl(urlStr) {
      if (!urlStr) return urlStr;
      if (urlStr.includes('/proxy-segment?url=')) return urlStr;
      if (/^(data:|skd:|blob:)/i.test(urlStr)) return urlStr;
      try {
          let absolute;
          if (/^https?:\/\//i.test(urlStr)) {
              absolute = urlStr;
          } else {
              absolute = new URL(urlStr, base).toString();
          }
          return `${proxyPrefix}${encodeURIComponent(absolute)}`;
      } catch {
          return urlStr;
      }
  }

  let result = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewriteUrl(uri)}"`);

  result = result.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return rewriteUrl(trimmed);
  }).join('\n');

  return result;
}

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
              app: { platform: "android", version: "1.1.0", buildId: "97215000", engine: "hbc85", signatures: ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"], installer: "com.android.vending" },
              version: { package: "app.lokke.main", binary: "1.1.0", js: "1.1.0" }
          },
          appFocusTime: 0, playerActive: false, playDuration: 0, devMode: true, hasAddon: true, castConnected: false,
          package: "app.lokke.main", version: "1.1.0", process: "app",
          firstAppStart: currentTime - 86400000, lastAppStart: currentTime,
          ipLocation: clientIP, adblockEnabled: false,
          proxy: { supported: ["ss", "openvpn"], engine: "openvpn", ssVersion: 1, enabled: false, autoServer: true, id: "fi-hel" },
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
      // ✅ DÜZELTME 1: API adresi vavoo.tv olarak güncellendi
      const response = await fetch("https://www.vavoo.tv/api/app/ping", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(authPayload)
      });
      if (!response.ok) throw new ExtractorError(`Vavoo Auth API failed: ${response.status}`);
      const result = await response.json();
      if (!result.addonSig) throw new ExtractorError('Vavoo auth response missing addonSig.');

      let addonSig = result.addonSig;
      try {
          const decoded = atob(addonSig);
          const sigObj = JSON.parse(decoded);
          if (sigObj && sigObj.data) {
              const dataObj = JSON.parse(sigObj.data);
              if (clientIP) {
                  const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
                  dataObj.ips = [clientIP, ...currentIps.filter(x => x && x !== clientIP)];
                  if (typeof dataObj.ip === 'string') dataObj.ip = clientIP;
                  sigObj.data = JSON.stringify(dataObj);
                  addonSig = btoa(JSON.stringify(sigObj));
              }
          }
      } catch (e) { /* keep original sig if rewrite fails */ }
      return addonSig;
  }

  async resolveStream(vavooUrl, signature, clientIP) {
      const resolvePayload = { language: "de", region: "AT", url: vavooUrl, clientVersion: "3.0.2" };
      const resolveHeaders = {
          "user-agent": "MediaHubMX/2",
          "accept": "application/json",
          "content-type": "application/json; charset=utf-8",
          "accept-encoding": "gzip",
          "mediahubmx-signature": signature,
          "X-Forwarded-For": clientIP,
          "X-Real-IP": clientIP,
      };
      // ✅ DÜZELTME 2: Resolve endpoint'i de vavoo.tv'ye taşındı (çalışmazsa vavoo.to'ya geri dönülebilir)
      const response = await fetch("https://www.vavoo.tv/mediahubmx-resolve.json", {
          method: "POST",
          headers: resolveHeaders,
          body: JSON.stringify(resolvePayload)
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

  async handle(url, request, env, ctx) {
      const rawClientIP = getClientIP(request);
      const clientIP = this.normalizeIPv4(rawClientIP);
      const signature = await this.getAuthSignature(clientIP);
      const streamUrl = await this.resolveStream(url, signature, clientIP);
      return this.proxyStream(streamUrl, request, env, ctx);
  }

  // --- Cache API Tabanlı Proxy (403 Düzeltmeleri Dahil) ---
  async proxyStream(streamUrl, request, env, ctx) {
      // ✅ DÜZELTME 3: HTTP -> HTTPS zorlaması
      // Not: Bazı Vavoo stream sunucuları HTTPS desteklemez, bu yüzden
      // sadece deneme amaçlıdır; başarısız olursa orijinal HTTP kullanılır.
      const originalStreamUrl = streamUrl;
      if (streamUrl.startsWith('http://')) {
          streamUrl = streamUrl.replace('http://', 'https://');
      }

      if (!/^https?:\/\//i.test(streamUrl)) {
          return new Response(JSON.stringify({ error: 'Invalid upstream URL scheme.' }), {
              status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
          });
      }

      const isM3U8 = /m3u8/i.test(streamUrl);
      const rangeHeader = request.headers.get('Range');
      const cache = caches.default;
      const cacheKey = new Request(streamUrl, { method: 'GET' });

      // 1) Sadece Range'siz isteklerde cache'e bak
      if (!rangeHeader && !isM3U8) {
          const cached = await cache.match(cacheKey);
          if (cached) {
              const headers = new Headers(cached.headers);
              Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
              return new Response(cached.body, { status: cached.status, headers });
          }
      }

      // 2) Upstream'den çek
      const fetchHeaders = new Headers();
      // ✅ DÜZELTME 4: Vavoo stream sunucularının beklediği başlıklar
      fetchHeaders.set('User-Agent', 'okhttp/4.11.0');
      fetchHeaders.set('Accept', '*/*');
      fetchHeaders.set('Accept-Encoding', 'identity');
      fetchHeaders.set('Referer', 'https://vavoo.to/');
      fetchHeaders.set('Origin', 'https://vavoo.to');
      fetchHeaders.set('Connection', 'keep-alive');
      if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

      let originResponse = await fetch(streamUrl, {
          method: 'GET',
          headers: fetchHeaders,
          redirect: 'follow',
      });

      // ✅ DÜZELTME 5: HTTPS denemesi başarısız olursa orijinal HTTP URL'ye geri dön
      if (!originResponse.ok && originResponse.status === 403 && streamUrl !== originalStreamUrl) {
          const fallbackHeaders = new Headers(fetchHeaders);
          fallbackHeaders.set('Referer', 'http://vavoo.to/');
          fallbackHeaders.set('Origin', 'http://vavoo.to');
          originResponse = await fetch(originalStreamUrl, {
              method: 'GET',
              headers: fallbackHeaders,
              redirect: 'follow',
          });
      }

      if (!originResponse.ok && originResponse.status !== 206) {
          return new Response(JSON.stringify({
              error: `Upstream fetch failed: ${originResponse.status}`,
              url: streamUrl
          }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      const contentType = (originResponse.headers.get('content-type') || '').toLowerCase();
      const isM3U8Response = isM3U8 || contentType.includes('mpegurl') || contentType.includes('m3u8');

      // 3) m3u8: içeriği yeniden yaz, cache'leme (canlı yayın sürekli değişir)
      if (isM3U8Response) {
          const text = await originResponse.text();
          const workerOrigin = new URL(request.url).origin;
          const rewritten = rewritePlaylist(text, streamUrl, workerOrigin);

          return new Response(rewritten, {
              status: 200,
              headers: {
                  ...CORS_HEADERS,
                  'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                  'Cache-Control': 'no-store',
              },
          });
      }

      // 4) Segment: istemciye dön + (Range'siz ve 200 ise) cache'e yaz
      const newHeaders = new Headers();
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          if (originResponse.headers.has(h)) newHeaders.set(h, originResponse.headers.get(h));
      }
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.set('Cache-Control', `public, max-age=${SEGMENT_CACHE_TTL}`);

      const clientResponse = new Response(originResponse.body, {
          status: originResponse.status,
          headers: newHeaders,
      });

      // Sadece Range'siz, tam (200) yanıtları cache'e al
      if (!rangeHeader && originResponse.status === 200) {
          ctx.waitUntil(
              cache.put(cacheKey, clientResponse.clone()).catch(() => {})
          );
      }

      return clientResponse;
  }
}

// --- M3U Playlist Proxy ---
async function handlePlaylistProxy(request) {
  const url = new URL(request.url);
  const m3uUrlsParam = url.searchParams.get('url');
  if (!m3uUrlsParam) {
      return new Response('Error: Missing url parameter for playlist.', { status: 400, headers: CORS_HEADERS });
  }

  const m3uUrls = m3uUrlsParam.split(';').filter(u => u.trim() !== '');
  if (m3uUrls.length === 0) {
      return new Response('Error: No valid playlist URLs provided.', { status: 400, headers: CORS_HEADERS });
  }

  let combinedM3U = '';
  for (const m3uUrl of m3uUrls) {
      try {
          const response = await fetch(m3uUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (response.ok) {
              const text = await response.text();
              combinedM3U += text + '\n';
          }
      } catch (e) {
          console.error(`Failed to fetch or process playlist ${m3uUrl}: ${e.message}`);
      }
  }

  const workerDomain = url.origin;
  const modifiedM3U = rewritePlaylistUrls(combinedM3U, workerDomain);

  return new Response(modifiedM3U, {
      headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Disposition': 'inline; filename="playlist.m3u"',
          'Cache-Control': 's-maxage=3600, stale-while-revalidate',
      }
  });
}

function rewritePlaylistUrls(m3uContent, workerDomain) {
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
          if (trimmedLine.includes('vavoo.to')) {
              processedM3uParts.push(lastExtinf);
              const newUrl = `${workerDomain}/manifest.m3u8?url=${encodeURIComponent(trimmedLine)}`;
              processedM3uParts.push(newUrl);
          } else {
              processedM3uParts.push(lastExtinf);
              processedM3uParts.push(trimmedLine);
          }
          lastExtinf = null;
      }
  }
  return processedM3uParts.join('\n');
}

// --- Info & Status Pages ---
function handleInfoPage(request) {
  const workerDomain = new URL(request.url).origin;
  const htmlContent = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>?? Vavoo Stream Extractor</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
      :root { --bg-primary: #0a0a0b; --bg-card: #16181c; --text-primary: #ffffff; --text-secondary: #b3b3b3; --accent-primary: #3b82f6; --accent-green: #10b981; --border-color: #374151; --gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
      body { font-family: 'Inter', sans-serif; background: var(--bg-primary); color: var(--text-primary); line-height: 1.7; margin: 0; }
      .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
      .header { text-align: center; margin-bottom: 3rem; }
      .header h1 { font-size: clamp(2.5rem, 5vw, 4rem); font-weight: 700; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
      .version-badge { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--bg-card); border: 1px solid var(--border-color); padding: 0.5rem 1.2rem; border-radius: 2rem; font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 1rem; }
      .status-badge { background: var(--accent-green); color: white; padding: 0.2rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; }
      .description { font-size: 1.2rem; color: var(--text-secondary); max-width: 700px; margin: 0 auto 2rem; }
      .cards-grid { display: grid; gap: 2rem; margin: 3rem 0; }
      .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 1.5rem; padding: 2rem; transition: all 0.3s ease; }
      .card:hover { transform: translateY(-8px); border-color: var(--accent-primary); }
      .card-title { font-size: 1.4rem; font-weight: 600; margin-bottom: 1rem; }
      .card-description { color: var(--text-secondary); margin-bottom: 1.5rem; }
      .endpoint-code { background: #1a1a1d; border: 1px solid var(--border-color); border-radius: 0.8rem; padding: 1rem; font-family: 'SF Mono', monospace; font-size: 0.9rem; color: var(--accent-primary); word-break: break-all; }
      .footer { text-align: center; margin-top: 4rem; padding: 2rem 0; border-top: 1px solid var(--border-color); color: #6b7280; }
      .warning { color: #f59e0b; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
      <header class="header">
          <h1>?? Vavoo Stream Extractor</h1>
          <div class="version-badge"><span>v2.3</span><span class="status-badge">ONLINE</span></div>
          <p class="description">Estrazione stream Vavoo con proxy integrato, cache edge tramite Cache API e bassa latenza.</p>
      </header>
      <div class="cards-grid">
          <div class="card">
              <h3 class="card-title">Estrazione Stream</h3>
              <p class="card-description">Fornisci un URL Vavoo per ottenere uno stream proxato con cache edge integrata.<br><span class="warning">?? Nota:</span> Se gli stream non partono, disattiva IPv6 sulla tua connessione.</p>
              <div class="endpoint-code">${workerDomain}/manifest.m3u8?url=&lt;VAVOO_URL&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Proxy Playlist M3U</h3>
              <p class="card-description">Fornisci una o più playlist M3U (separate da ';'). Il worker le unirà e riscriverà i canali Vavoo.</p>
              <div class="endpoint-code">${workerDomain}/playlist?url=&lt;URL1&gt;;&lt;URL2&gt;</div>
          </div>
          <div class="card">
              <h3 class="card-title">Debug & Status</h3>
              <p class="card-description">Visualizza informazioni sulla tua connessione e sullo stato del worker.</p>
              <div class="endpoint-code">${workerDomain}/status</div>
          </div>
      </div>
      <footer class="footer"><p>&copy; 2025 Vavoo Extractor</p></footer>
  </div>
</body>
</html>`;
  return new Response(htmlContent, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function handleStatus(request) {
  const clientIP = getClientIP(request);
  const statusInfo = {
      status: "operational",
      version: "2.3",
      repo: "cloudflare-vavoo-proxy",
      timestamp: new Date().toISOString(),
      client_info: { ip: clientIP, country: request.headers.get('CF-IPCountry') || 'unknown', user_agent: request.headers.get('User-Agent') || 'unknown', is_ipv6: clientIP.includes(':') },
      supported_services: { vavoo: { mode: "proxy-cache-api", path: "/manifest.m3u8?url=https://vavoo.to/..." } },
      endpoints: { info: new URL(request.url).origin + '/', status: new URL(request.url).origin + '/status', playlist_proxy: new URL(request.url).origin + '/playlist?url=<m3u_url>' }
  };
  return new Response(JSON.stringify(statusInfo, null, 2), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
      if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);

      try {
          if (url.pathname === '/' || url.pathname === '') {
              return handleInfoPage(request);
          }
          if (url.pathname === '/status') {
              return handleStatus(request);
          }
          if (url.pathname === '/playlist') {
              return await handlePlaylistProxy(request);
          }

          if (url.pathname === '/proxy-segment') {
              const segmentUrl = url.searchParams.get('url');
              if (!segmentUrl) {
                  return new Response(JSON.stringify({ error: 'Missing segment URL' }), {
                      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                  });
              }
              const extractor = new VavooExtractor();
              return await extractor.proxyStream(segmentUrl, request, env, ctx);
          }

          if (url.pathname === '/manifest.m3u8') {
              if (url.searchParams.has('url')) {
                  const targetUrl = url.searchParams.get('url');
                  if (targetUrl.includes('vavoo.to')) {
                      const extractor = new VavooExtractor();
                      return await extractor.handle(targetUrl, request, env, ctx);
                  }
                  return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported.' }), {
                      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                  });
              }
              return new Response(JSON.stringify({ error: 'Missing "url" parameter' }), {
                  status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
              });
          }

          if (url.pathname === '/proxy/hls/manifest.m3u8') {
              const targetUrl = url.searchParams.get('d');
              if (targetUrl) {
                  if (targetUrl.includes('vavoo.to')) {
                      const extractor = new VavooExtractor();
                      return await extractor.handle(targetUrl, request, env, ctx);
                  }
                  return new Response(JSON.stringify({ error: 'Unsupported URL. Only Vavoo URLs are supported in parameter "d".' }), {
                      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
                  });
              }
              return new Response(JSON.stringify({ error: 'Missing "d" parameter' }), {
                  status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
              });
          }

          return new Response(JSON.stringify({ error: '404 Not Found' }), {
              status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
          });

      } catch (error) {
          console.error(`Worker Error: ${error.stack}`);
          return new Response(JSON.stringify({ error: error.message, type: error.name }), {
              status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
          });
      }
  },
};
