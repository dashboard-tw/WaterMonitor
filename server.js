const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 若本機存在 .env 檔案，自動載入環境變數（免裝 dotenv）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.DASHBOARD_TW_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DASHBOARD_TW_CLIENT_SECRET || '';

// --- 後端快取與防刷機制 ---
let cachedToken = null;
let tokenExpiresAt = 0;

// 快取資料與 ETag，避免每次請求重複打 dashboard.tw API
let cachedData = null;
let cachedDataTime = 0;
let cachedEtag = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分鐘快取（水庫資料為每小時更新）

// 單一 IP 請求限速（Rate Limiting）：每分鐘最多 30 次
const ipRequests = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipRequests.entries()) {
    if (now - data.resetTime > 60000) {
      ipRequests.delete(ip);
    }
  }
}, 60000);

function isRateLimited(ip) {
  const now = Date.now();
  let record = ipRequests.get(ip);
  if (!record || now - record.resetTime > 60000) {
    record = { count: 1, resetTime: now };
    ipRequests.set(ip, record);
    return false;
  }
  record.count++;
  return record.count > 30;
}

function fetchApi(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = null;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
          text: data
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return null;
  }

  const postData = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  }).toString();

  const res = await fetchApi('https://dashboard.tw/api/v1/auth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'dashboard.tw-WaterMonitor/1.0'
    },
    body: postData
  });

  if (res.status === 200 && res.data && res.data.access_token) {
    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + (res.data.expires_in || 86400) * 1000;
    return cachedToken;
  }

  return null;
}

let cachedSites = null;
async function fetchReservoirData() {
  const now = Date.now();
  if (cachedData && (now - cachedDataTime < CACHE_TTL_MS)) {
    return cachedData;
  }

  const token = await getAccessToken();
  const headers = {
    'User-Agent': 'dashboard.tw-WaterMonitor/1.0'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // 1. 站點資訊只取一次並快取（站點資訊極少變動）
  if (!cachedSites) {
    const sitesRes = await fetchApi('https://dashboard.tw/api/v1/datasets/reservoir_obs/sites', { headers });
    if (sitesRes.status === 200 && sitesRes.data) {
      cachedSites = sitesRes.data;
    }
  }

  // 2. 帶上 ETag 節省流量（304 響應不耗費 traffic）
  const latestHeaders = { ...headers };
  if (cachedEtag) {
    latestHeaders['If-None-Match'] = cachedEtag;
  }

  const latestRes = await fetchApi('https://dashboard.tw/api/v1/datasets/reservoir_obs/latest', {
    headers: latestHeaders
  });

  if (latestRes.status === 304 && cachedData) {
    cachedDataTime = now;
    return cachedData;
  }

  if (latestRes.status === 200 && latestRes.data) {
    if (latestRes.headers['etag']) {
      cachedEtag = latestRes.headers['etag'];
    }
    cachedData = {
      sites: cachedSites,
      latest: latestRes.data,
      server_cached_at: new Date().toISOString()
    };
    cachedDataTime = now;
    return cachedData;
  }

  // 若 API 發生異常且有舊快取，降級回傳舊快取
  if (cachedData) {
    return cachedData;
  }

  throw new Error(`無法取得水情資料 (HTTP ${latestRes.status})`);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (parsedUrl.pathname === '/api/reservoirs') {
    // 檢查 IP 限速防刷
    if (isRateLimited(clientIp)) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60'
      });
      res.end(JSON.stringify({ error: '請求過於頻繁，請稍候再試。' }));
      return;
    }

    try {
      const data = await fetchReservoirData();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300' // 前端與 CDN 快取 5 分鐘
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`dashboard.tw-WaterMonitor running at http://localhost:${PORT}`);
});
