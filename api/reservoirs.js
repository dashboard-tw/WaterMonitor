const https = require('https');

const CLIENT_ID = process.env.DASHBOARD_TW_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DASHBOARD_TW_CLIENT_SECRET || '';

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedData = null;
let cachedDataTime = 0;
let cachedEtag = null;
let cachedSites = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

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
          data: json
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

module.exports = async (req, res) => {
  const now = Date.now();
  if (cachedData && (now - cachedDataTime < CACHE_TTL_MS)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    return res.status(200).json(cachedData);
  }

  try {
    const token = await getAccessToken();
    const headers = { 'User-Agent': 'dashboard.tw-WaterMonitor/1.0' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    if (!cachedSites) {
      const sitesRes = await fetchApi('https://dashboard.tw/api/v1/datasets/reservoir_obs/sites', { headers });
      if (sitesRes.status === 200 && sitesRes.data) {
        cachedSites = sitesRes.data;
      }
    }

    const latestHeaders = { ...headers };
    if (cachedEtag) latestHeaders['If-None-Match'] = cachedEtag;

    const latestRes = await fetchApi('https://dashboard.tw/api/v1/datasets/reservoir_obs/latest', { headers: latestHeaders });

    if (latestRes.status === 304 && cachedData) {
      cachedDataTime = now;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
      return res.status(200).json(cachedData);
    }

    if (latestRes.status === 200 && latestRes.data) {
      if (latestRes.headers['etag']) cachedEtag = latestRes.headers['etag'];
      cachedData = {
        sites: cachedSites,
        latest: latestRes.data,
        cached_at: new Date().toISOString()
      };
      cachedDataTime = now;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
      return res.status(200).json(cachedData);
    }

    if (cachedData) {
      return res.status(200).json(cachedData);
    }

    return res.status(latestRes.status).json({ error: '無法自 dashboard.tw 取得資料' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
