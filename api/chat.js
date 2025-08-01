const axios = require('axios');

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 心跳包发送函数
function sendHeartbeat(res) {
  try {
    // 发送空的 SSE 注释行作为心跳包
    res.write(': heartbeat\n\n');
  } catch (error) {
    console.error('Failed to send heartbeat:', error);
  }
}

// 启动心跳定timer
function startHeartbeat(res, interval = 1000) {
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(res);
  }, interval);
  
  return heartbeatTimer;
}

// 停止心跳
function stopHeartbeat(timer) {
  if (timer) {
    clearInterval(timer);
  }
}

// 将文本分解为合理的块
function chunkText(text, chunkSize = 10) {
  const words = text.split(' ');
  const chunks = [];
  
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  
  return chunks;
}

// 生成 SSE 格式的数据
function formatSSEData(data) {
  if (typeof data === 'string') {
    return `data: ${data}\n\n`;
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

module.exports = async (req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { 
    model = 'gpt-3.5-turbo',
    messages,
    temperature = 0.7,
    max_tokens,
    stream = false, // 从请求中获取 stream 参数
    ...otherParams 
  } = req.body;

  // 调试信息：打印客户端请求参数
  console.log('Client request - stream:', stream);
  console.log('Client request - otherParams:', JSON.stringify(otherParams, null, 2));

  // 验证必需参数
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ 
      error: { 
        message: 'messages is required and must be an array',
        type: 'invalid_request_error'
      }
    });
  }

  // 获取环境变量
  const apiKey = process.env.OPENAI_API_KEY;
  const sourceApiUrl = process.env.SOURCE_API_URL || 'https://api.openai.com';

  if (!apiKey) {
    return res.status(500).json({ 
      error: { 
        message: 'OPENAI_API_KEY environment variable is not set',
        type: 'server_error'
      }
    });
  }

  // 从请求头获取 API 密钥（如果提供）
  const authHeader = req.headers.authorization;
  let requestApiKey = apiKey;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    requestApiKey = authHeader.substring(7);
  }

  // 准备发送到源 API 的请求体
  // 强制设置 stream: false，以实现"假流式"
  const requestBody = {
    model,
    messages,
    temperature,
    ...otherParams,
    stream: false, // 核心修改：始终以非流式请求源 API（必须放在otherParams之后以覆盖客户端的stream参数）
  };

  // 如果 max_tokens 存在，则添加到请求体中
  if (max_tokens !== undefined) {
    requestBody.max_tokens = max_tokens;
  }

  // 如果客户端需要流式响应，立即设置流式响应头并开始心跳
  let heartbeatTimer = null;
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // 立即开始心跳，不等待模型响应
    heartbeatTimer = startHeartbeat(res);
  }

  try {
    // 调试信息：打印实际发送给源API的请求体
    console.log('Request to source API:', JSON.stringify(requestBody, null, 2));
    
    // 向源 API 发起非流式请求
    const response = await axios.post(`${sourceApiUrl}/v1/chat/completions`, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${requestApiKey}`,
      },
    });

    // 根据客户端请求的 stream 参数决定如何响应
    if (stream) {
      // 客户端需要流式响应，在等待期间发送心跳，最后一次性返回内容
      try {
        // 获取完整响应内容
        const fullContent = response.data.choices[0].message.content;

        // 停止心跳包
        stopHeartbeat(heartbeatTimer);

        // 一次性发送完整内容
        const contentChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: response.data.model || model,
          choices: [{
            index: 0,
            delta: { content: fullContent },
            finish_reason: null,
          }],
        };
        res.write(formatSSEData(contentChunk));

        // 发送最后一个空块，包含 finish_reason
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: response.data.model || model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: response.data.choices[0].finish_reason || 'stop',
          }],
        };
        res.write(formatSSEData(finalChunk));

        // 发送结束标志
        res.write(formatSSEData('[DONE]'));

      } catch (error) {
        console.error('Error during fake stream generation:', error);
        const errorPayload = {
          error: {
            message: 'Error processing response from source API.',
            type: 'server_error'
          }
        };
        res.write(formatSSEData(errorPayload));
      } finally {
        stopHeartbeat(heartbeatTimer);
        res.end();
      }

    } else {
      // 客户端需要非流式响应，直接返回结果
      res.status(200).json(response.data);
    }

  } catch (error) {
    // 处理请求源 API 时发生的错误
    console.error('Error calling source API:', error.response ? error.response.data : error.message);
    
    // 如果有心跳在运行，需要先停止
    if (heartbeatTimer) {
      stopHeartbeat(heartbeatTimer);
    }
    
    if (stream) {
      // 流式响应的错误处理
      const errorPayload = {
        error: {
          message: error.response?.data?.error?.message || 'An unexpected error occurred.',
          type: 'server_error'
        }
      };
      res.write(formatSSEData(errorPayload));
      res.end();
    } else {
      // 非流式响应的错误处理
      const statusCode = error.response ? error.response.status : 500;
      const errorResponse = error.response ? error.response.data : { 
        error: { 
          message: 'An unexpected error occurred.',
          type: 'server_error'
        } 
      };
      res.status(statusCode).json(errorResponse);
    }
  }
};