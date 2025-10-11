const axios = require('axios');

module.exports = async (req, res) => {
  // CORS
  const allowOrigin = process.env.CORS_ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const envApiKey = process.env.OPENAI_API_KEY;
  const sourceApiUrl = process.env.SOURCE_API_URL || 'https://api.openai.com';
  const allowEnvKeyFallback = process.env.ALLOW_ENV_API_KEY === '1' || process.env.ALLOW_ENV_API_KEY === 'true';

  if (!envApiKey) {
    return res.status(500).json({
      error: { message: 'OPENAI_API_KEY environment variable is not set', type: 'server_error' },
    });
  }

  const authHeader = req.headers.authorization || '';
  const headerKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  const hasHeaderKey = !!headerKey;
  if (!hasHeaderKey && !allowEnvKeyFallback) {
    return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'unauthorized' } });
  }
  const requestApiKey = hasHeaderKey ? headerKey : envApiKey;

  const headers = { Authorization: `Bearer ${requestApiKey}` };
  try {
    if (process.env.UPSTREAM_EXTRA_HEADERS_JSON) {
      Object.assign(headers, JSON.parse(process.env.UPSTREAM_EXTRA_HEADERS_JSON));
    }
  } catch (_) {}

  try {
    const response = await axios.get(`${sourceApiUrl}/v1/models`, { headers });
    return res.status(200).json(response.data);
  } catch (error) {
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;
    return res.status(statusCode).json(upErr || { error: { message: 'Failed to fetch models', type: 'server_error' } });
  }
};

