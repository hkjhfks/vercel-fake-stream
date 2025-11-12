const axios = require('axios');

// 延迟函数
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 统一日志控制
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const log = (...args) => DEBUG && console.log('[proxy]', ...args);

// 心跳包发送函数
function sendHeartbeat(res) {
  try {
    // 发送仅包含空格的 SSE 注释行作为心跳包
    res.write(': \n\n');
  } catch (error) {
    // 避免因连接关闭导致异常
  }
}

// 启动心跳定时器
function startHeartbeat(res, interval = 3000) {
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(res);
  }, interval);
  return heartbeatTimer;
}

// 停止心跳
function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

// 将文本分解为合理的块（兼容中英文）
function chunkText(text, targetLen = 30) {
  if (!text || typeof text !== 'string') return [];
  const chunks = [];
  let buffer = '';

  const push = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  // 先按换行与句号/问号/叹号等断句
  const sentences = text.split(/([。！？!?\n])/).reduce((acc, part, idx, arr) => {
    if (["。", "！", "？", "!", "?", "\n"].includes(part)) {
      acc[acc.length - 1] += part;
    } else if (part) {
      acc.push(part);
    }
    return acc;
  }, []);

  for (const s of sentences) {
    // 若句子很长，按固定长度切
    if (s.length > targetLen * 2) {
      for (let i = 0; i < s.length; i += targetLen) {
        chunks.push(s.slice(i, i + targetLen));
      }
      continue;
    }
    if ((buffer + s).length >= targetLen) {
      push();
    }
    buffer += s;
  }
  push();
  return chunks.filter(Boolean);
}

// 生成 SSE 格式的数据
function formatSSEData(data) {
  if (typeof data === 'string') {
    return `data: ${data}\n\n`;
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

// 兼容提取上游返回的文本（OpenAI Chat Completions / Gemini candidates 等）
function extractTextFromUpstream(data) {
  try {
    // OpenAI Chat Completions 标准：choices[0].message.content 可能是字符串或数组
    const choice0 = data?.choices?.[0];
    const msg = choice0?.message;
    if (msg) {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        // 聚合文本片段
        return msg.content
          .map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || '')))
          .join('');
      }
    }
    // 一些代理会直接返回 choices[0].text
    if (typeof choice0?.text === 'string') return choice0.text;

    // Gemini 风格：candidates[0].content.parts[].text
    const cand0 = data?.candidates?.[0];
    const parts = cand0?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map((p) => p?.text || '').join('');
    }
  } catch (_) {}
  return '';
}

module.exports = async (req, res) => {
  // CORS 支持
  const allowOrigin = process.env.CORS_ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 只允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    model = 'gpt-4o-mini',
    messages,
    temperature = 0.7,
    max_tokens,
    stream = false,
    ...otherParams
  } = req.body || {};

  // 参数校验（不记录message内容避免泄露）
  if (!Array.isArray(messages)) {
    return res.status(400).json({
      error: {
        message: 'messages is required and must be an array',
        type: 'invalid_request_error',
      },
    });
  }

  // 获取环境变量
  const envApiKey = process.env.OPENAI_API_KEY;
  const sourceApiUrl = process.env.SOURCE_API_URL || 'https://api.openai.com';
  const allowEnvKeyFallback = process.env.ALLOW_ENV_API_KEY === '1' || process.env.ALLOW_ENV_API_KEY === 'true';
  const heartbeatInterval = Number(process.env.HEARTBEAT_INTERVAL_MS || 3000);

  if (!envApiKey) {
    return res.status(500).json({
      error: {
        message: 'OPENAI_API_KEY environment variable is not set',
        type: 'server_error',
      },
    });
  }

  // 从请求头获取 API 密钥
  const authHeader = req.headers.authorization || '';
  const headerKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  const hasHeaderKey = !!headerKey;
  if (!hasHeaderKey && !allowEnvKeyFallback) {
    return res.status(401).json({
      error: { message: 'Missing Authorization header', type: 'unauthorized' },
    });
  }
  const requestApiKey = hasHeaderKey ? headerKey : envApiKey;

  // 准备发送到源 API 的请求体（强制非流式）
  const requestBody = {
    model,
    messages,
    temperature,
    ...otherParams,
    stream: false,
  };
  if (max_tokens !== undefined) requestBody.max_tokens = max_tokens;

  // 如果客户端需要流式响应，设置SSE响应头并开始心跳
  let heartbeatTimer = null;
  let clientAborted = false;
  let roleSent = false;
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    heartbeatTimer = startHeartbeat(res, heartbeatInterval);
    // 使用响应的 close 事件检测客户端断开
    res.on('close', () => {
      clientAborted = true;
      stopHeartbeat(heartbeatTimer);
      try { res.end(); } catch (_) {}
    });
    // 立即发送一个 role 块，确保响应体非空，避免 content-length: 0
    const preRoleChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    try {
      log('pre role chunk write');
      res.write(formatSSEData(preRoleChunk));
      roleSent = true;
      log('pre role chunk written');
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); log('headers flushed'); } catch (_) {}
      }
    } catch (e) { log('pre role chunk error', e?.message || e); }
  }

  try {
    log('Requesting source API', { stream, model });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requestApiKey}`,
    };
    try {
      if (process.env.UPSTREAM_EXTRA_HEADERS_JSON) {
        Object.assign(headers, JSON.parse(process.env.UPSTREAM_EXTRA_HEADERS_JSON));
      }
    } catch (_) {}

    const response = await axios.post(`${sourceApiUrl}/v1/chat/completions`, requestBody, { headers });

    if (!stream) {
      return res.status(200).json(response.data);
    }

    // 客户端需要流式响应：先停止心跳，再进行伪流式发送
    stopHeartbeat(heartbeatTimer);
    if (clientAborted) return; // 已断开

    const choice0 = response.data?.choices?.[0] || {};
    const fullContent = extractTextFromUpstream(response.data);
    const contentLen = typeof fullContent === 'string' ? fullContent.length : 0;
    log('upstream content length:', contentLen);
    const finishReason = choice0?.finish_reason || response.data?.candidates?.[0]?.finishReason?.toLowerCase?.() || 'stop';
    const sseBase = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: response.data?.model || model,
    };

    // 发送角色块（如果之前未发送）
    if (!roleSent) {
      log('late role chunk write');
      const roleChunk = { ...sseBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
      res.write(formatSSEData(roleChunk));
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); log('headers flushed (late)'); } catch (_) {}
      }
    }

    // 内容分块并发送（加入轻微延迟模拟流式）
    let parts = chunkText(fullContent, Number(process.env.CHUNK_TARGET_LENGTH || 30));
    // 若无可发送内容，按需求返回一个空格字符作为占位
    if (!parts || parts.length === 0) {
      parts = [contentLen > 0 ? fullContent : ' '];
    }
    for (const part of parts) {
      if (clientAborted) break;
      const contentChunk = { ...sseBase, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] };
      res.write(formatSSEData(contentChunk));
      const jitter = Math.max(10, Math.min(120, Number(process.env.CHUNK_DELAY_MS || 35)));
      // 可选抖动
      await delay(jitter);
    }

    // 发送最后一个空块，包含 finish_reason
    if (!clientAborted) {
      const finalChunk = { ...sseBase, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
      res.write(formatSSEData(finalChunk));
      res.write(formatSSEData('[DONE]'));
      res.end();
    }
  } catch (error) {
    // 错误处理
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;
    log('Upstream error', statusCode);

    if (stream) {
      const errorPayload = {
        error: {
          message: upErr?.error?.message || error.message || 'An unexpected error occurred.',
          type: upErr?.error?.type || 'server_error',
        },
      };
      try { res.write(formatSSEData(errorPayload)); } catch (_) {}
      try { res.end(); } catch (_) {}
    } else {
      res.status(statusCode).json(upErr || {
        error: { message: 'An unexpected error occurred.', type: 'server_error' },
      });
    }
  } finally {
    stopHeartbeat(heartbeatTimer);
  }
};
