const fs = require("node:fs");
const path = require("node:path");

loadEnv(path.join(__dirname, "..", ".env"));

const config = {
  telegramToken: requiredTelegramToken("TELEGRAM_BOT_TOKEN"),
  apiBaseUrl: trimRightSlash(requiredEnv("AI_API_BASE_URL")),
  apiKey: requiredEnv("AI_API_KEY"),
  chatApiBaseUrl: trimRightSlash(process.env.CHAT_API_BASE_URL || requiredEnv("AI_API_BASE_URL")),
  chatApiKey: process.env.CHAT_API_KEY || requiredEnv("AI_API_KEY"),
  model: process.env.CHAT_MODEL || process.env.AI_MODEL || "gpt-4o-mini",
  imageApiBaseUrl: trimRightSlash(process.env.IMAGE_API_BASE_URL || requiredEnv("AI_API_BASE_URL")),
  imageApiKey: process.env.IMAGE_API_KEY || requiredEnv("AI_API_KEY"),
  imageModel: process.env.IMAGE_MODEL || "gpt-image-2",
  imageEndpoint: process.env.IMAGE_ENDPOINT || "images",
  imageSize: process.env.IMAGE_SIZE || "1024x1024",
  systemPrompt: loadSystemPrompt(),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES || 12),
  responseMaxTokens: Number(process.env.RESPONSE_MAX_TOKENS || 1000),
  streamEnabled: process.env.STREAM_ENABLED !== "false", // 默认开启
  streamEditIntervalMs: Number(process.env.STREAM_EDIT_INTERVAL_MS || 500), // 编辑节流间隔
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || "",
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || "",
  azureTtsVoice: process.env.AZURE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
  azureTtsMaxChars: Number(process.env.AZURE_TTS_MAX_CHARS || 1000),
  azureSttLanguage: process.env.AZURE_STT_LANGUAGE || "zh-CN",
};

const telegramApi = `https://api.telegram.org/bot${config.telegramToken}`;
const chatHistories = new Map();
let offset = 0;

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Bot failed to start:", error);
  process.exit(1);
});

async function main() {
  const me = await telegram("getMe");
  console.log(`Bot started: @${me.username}`);

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(2000);
    }
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat) return;

  if (message.voice && !message.text) {
    await handleVoiceMessage(message);
    return;
  }

  if (!message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const from = message.from?.username || message.from?.first_name || "unknown";
  console.log(`Message from ${from} (${chatId}): ${text}`);

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, [
      "Bot is online.",
      "",
      "Send any question to call the AI API.",
      "Send a voice message - I'll transcribe and reply (Azure STT)",
      "/image prompt - generate an image",
      "/tts text - text-to-speech (Azure)",
      "/reset - clear chat memory",
      "/model - show current model",
      "/stream on|off - toggle streaming",
    ].join("\n"));
    return;
  }

  if (text === "/reset") {
    chatHistories.delete(chatId);
    await sendMessage(chatId, "Chat memory cleared.");
    return;
  }

  if (text === "/model") {
    const streamStatus = config.streamEnabled ? "ON" : "OFF";
    await sendMessage(chatId, `Chat model: ${config.model}\nImage model: ${config.imageModel}\nStream: ${streamStatus}`);
    return;
  }

  if (text.startsWith("/stream")) {
    const arg = text.replace("/stream", "").trim().toLowerCase();
    if (arg === "on") {
      config.streamEnabled = true;
      await sendMessage(chatId, "Streaming enabled ✅");
    } else if (arg === "off") {
      config.streamEnabled = false;
      await sendMessage(chatId, "Streaming disabled ❌");
    } else {
      const status = config.streamEnabled ? "ON" : "OFF";
      await sendMessage(chatId, `Usage: /stream on|off\nCurrent: ${status}`);
    }
    return;
  }

  const ttsText = parseTtsPrompt(text);
  if (ttsText !== null) {
    if (!ttsText) {
      await sendMessage(chatId, "用法: /tts 要朗读的文字");
      return;
    }
    if (!config.azureSpeechKey || !config.azureSpeechRegion) {
      await sendMessage(chatId, "未配置 Azure TTS。请在 .env 设置 AZURE_SPEECH_KEY 与 AZURE_SPEECH_REGION。");
      return;
    }
    await telegram("sendChatAction", { chat_id: chatId, action: "record_voice" });
    try {
      const audio = await synthesizeAzureTts(ttsText);
      await sendVoiceMessage(chatId, audio);
    } catch (error) {
      console.error("TTS error:", error);
      await sendMessage(chatId, formatAzureTtsError(error));
    }
    return;
  }

  const imagePrompt = parseImagePrompt(text);
  if (imagePrompt) {
    await telegram("sendChatAction", {
      chat_id: chatId,
      action: "upload_photo",
    });

    try {
      const image = await generateImage(imagePrompt);
      await sendGeneratedImage(chatId, image, imagePrompt);
    } catch (error) {
      console.error("Image error:", error);
      await sendMessage(chatId, formatAiError(error));
    }
    return;
  }

  // --- 聊天回复：流式 / 非流式 ---
  try {
    if (config.streamEnabled) {
      await sendMessageStream(chatId, text);
    } else {
      await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
      const reply = await askAi(chatId, text);
      await sendMessage(chatId, reply);
    }
  } catch (error) {
    console.error("AI error:", error);
    await sendMessage(chatId, formatAiError(error));
  }
}

// ─────────────────────────────────────────────
//  非流式 AI 调用
// ─────────────────────────────────────────────

async function askAi(chatId, text) {
  const history = chatHistories.get(chatId) || [];
  const messages = [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: text },
  ];

  const response = await fetchJson(`${config.chatApiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.chatApiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.7,
      max_tokens: config.responseMaxTokens,
    }),
    timeoutMs: config.requestTimeoutMs,
  });

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("API did not return choices[0].message.content");
  }

  const nextHistory = [
    ...history,
    { role: "user", content: text },
    { role: "assistant", content },
  ].slice(-config.maxHistoryMessages);

  chatHistories.set(chatId, nextHistory);
  return content;
}

// ─────────────────────────────────────────────
//  流式 AI 调用（SSE）
// ─────────────────────────────────────────────

async function askAiStream(chatId, text, onChunk) {
  const history = chatHistories.get(chatId) || [];
  const messages = [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: text },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let fullContent = "";

  try {
    const response = await fetch(`${config.chatApiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.chatApiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: config.responseMaxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `${response.status}`;
      try {
        const data = JSON.parse(body);
        msg += ` ${data.error?.message || response.statusText}`;
      } catch {
        msg += ` ${response.statusText}`;
      }
      throw new Error(msg);
    }

    // 解析 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // 保留不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          break;
        }
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(fullContent);
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  // 保存历史
  if (fullContent) {
    const nextHistory = [
      ...history,
      { role: "user", content: text },
      { role: "assistant", content: fullContent },
    ].slice(-config.maxHistoryMessages);
    chatHistories.set(chatId, nextHistory);
  }

  return fullContent;
}

// ─────────────────────────────────────────────
//  流式消息发送（逐步编辑 Telegram 消息）
// ─────────────────────────────────────────────

async function sendMessageStream(chatId, text) {
  // 先发一条占位消息
  const placeholder = await telegram("sendMessage", {
    chat_id: chatId,
    text: ".",
    disable_web_page_preview: true,
  });

  const messageId = placeholder.message_id;
  let lastEditedText = "";
  let lastEditTime = 0;
  let editTimer = null;
  let finalContent = "";

  // 节流编辑函数
  const throttledEdit = (content) => {
    finalContent = content;
    const now = Date.now();
    const elapsed = now - lastEditTime;

    if (elapsed >= config.streamEditIntervalMs) {
      doEdit(content);
    } else if (!editTimer) {
      editTimer = setTimeout(() => {
        editTimer = null;
        if (finalContent !== lastEditedText) {
          doEdit(finalContent);
        }
      }, config.streamEditIntervalMs - elapsed);
    }
  };

  const doEdit = async (content) => {
    if (content === lastEditedText) return;
    lastEditedText = content;
    lastEditTime = Date.now();

    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: content || ".",
        disable_web_page_preview: true,
      });
    } catch (error) {
      // Telegram 429 限流：静默跳过，最终会更新
      if (String(error.message).includes("429")) {
        console.warn("Telegram edit rate limited, skipping chunk");
      } else {
        console.error("Edit message error:", error.message);
      }
    }
  };

  try {
    await askAiStream(chatId, text, throttledEdit);
  } catch (error) {
    console.error("Stream AI error:", error);
    // 出错时更新消息为错误信息
    await doEdit(formatAiError(error));
    return;
  }

  // 清除剩余的定时器
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
  }

  // 最终确保消息内容正确（可能最后一次编辑被限流跳过了）
  if (finalContent !== lastEditedText) {
    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: finalContent,
        disable_web_page_preview: true,
      });
    } catch {
      // 忽略最终编辑失败
    }
  }

  // 如果回复超长，自动分段发送
  if (finalContent.length > 4096) {
    const chunks = splitTelegramText(finalContent);
    // 先更新第一条消息为第一段
    await doEdit(chunks[0]);
    // 后续段落单独发送
    for (let i = 1; i < chunks.length; i++) {
      await sendMessage(chatId, chunks[i]);
    }
  }
}

// ─────────────────────────────────────────────
//  图片生成
// ─────────────────────────────────────────────

async function generateImage(prompt) {
  if (config.imageEndpoint === "chat") {
    return generateImageWithChat(prompt);
  }

  const response = await fetchJson(`${config.imageApiBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.imageApiKey}`,
    },
    body: JSON.stringify({
      model: config.imageModel,
      prompt,
      size: config.imageSize,
      n: 1,
    }),
    timeoutMs: config.requestTimeoutMs,
  });

  const item = response?.data?.[0];
  if (item?.url) {
    return { type: "url", value: item.url };
  }
  if (item?.b64_json) {
    return { type: "base64", value: item.b64_json };
  }

  throw new Error("Image API did not return data[0].url or data[0].b64_json");
}

async function generateImageWithChat(prompt) {
  const response = await fetchJson(`${config.imageApiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.imageApiKey}`,
    },
    body: JSON.stringify({
      model: config.imageModel,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: config.responseMaxTokens,
    }),
    timeoutMs: config.requestTimeoutMs,
  });

  const content = response?.choices?.[0]?.message?.content;
  const url = extractImageUrl(content);
  if (!url) {
    throw new Error("Image chat API did not return an image URL");
  }

  return { type: "url", value: url };
}

// ─────────────────────────────────────────────
//  Azure TTS
// ─────────────────────────────────────────────

async function synthesizeAzureTts(text) {
  const clipped = text.slice(0, config.azureTtsMaxChars);
  const ssml = buildSsml(clipped, config.azureTtsVoice);
  const url = `https://${config.azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": config.azureSpeechKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "ogg-48khz-16bit-mono-opus",
        "User-Agent": "te-bot",
      },
      body: ssml,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Azure TTS ${response.status} ${body || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Azure TTS request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSsml(text, voice) {
  const lang = voice.slice(0, 5);
  const safe = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>${safe}</voice></speak>`;
}

async function sendVoiceMessage(chatId, buffer) {
  await telegramMultipart(
    "sendVoice",
    { chat_id: String(chatId) },
    {
      voice: {
        filename: "voice.ogg",
        contentType: "audio/ogg",
        buffer,
      },
    },
  );
}

// ─────────────────────────────────────────────
//  Azure STT (语音转文字)
// ─────────────────────────────────────────────

async function handleVoiceMessage(message) {
  const chatId = message.chat.id;
  const from = message.from?.username || message.from?.first_name || "unknown";
  const duration = message.voice?.duration || 0;
  console.log(`Voice from ${from} (${chatId}): ${duration}s`);

  if (!config.azureSpeechKey || !config.azureSpeechRegion) {
    await sendMessage(chatId, "未配置 Azure 语音服务。请在 .env 设置 AZURE_SPEECH_KEY 与 AZURE_SPEECH_REGION。");
    return;
  }

  if (duration > 58) {
    await sendMessage(chatId, "语音超过 60 秒,Azure STT 短音频接口不支持。请发短一点的。");
    return;
  }

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });

  let transcript = "";
  try {
    const audioBuffer = await downloadTelegramFile(message.voice.file_id);
    transcript = await transcribeAzureStt(audioBuffer);
  } catch (error) {
    console.error("STT error:", error);
    await sendMessage(chatId, formatAzureSttError(error));
    return;
  }

  if (!transcript) {
    await sendMessage(chatId, "🎙️ 没听清,请再说一次。");
    return;
  }

  await sendMessage(chatId, `🎙️ 你说: ${transcript}`);

  try {
    if (config.streamEnabled) {
      await sendMessageStream(chatId, transcript);
    } else {
      await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
      const reply = await askAi(chatId, transcript);
      await sendMessage(chatId, reply);
    }
  } catch (error) {
    console.error("AI error:", error);
    await sendMessage(chatId, formatAiError(error));
  }
}

async function downloadTelegramFile(fileId) {
  const fileInfo = await telegram("getFile", { file_id: fileId });
  if (!fileInfo.file_path) throw new Error("Telegram getFile 未返回 file_path");

  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${fileInfo.file_path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Telegram download ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Telegram download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function transcribeAzureStt(audioBuffer) {
  const url = `https://${config.azureSpeechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(config.azureSttLanguage)}&format=simple`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": config.azureSpeechKey,
        "Content-Type": "audio/ogg; codecs=opus",
        "Accept": "application/json",
        "User-Agent": "te-bot",
      },
      body: audioBuffer,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Azure STT ${response.status} ${body || response.statusText}`);
    }

    const data = await response.json();
    const status = data?.RecognitionStatus;
    if (status === "Success") {
      return String(data.DisplayText || "").trim();
    }
    if (status === "NoMatch" || status === "InitialSilenceTimeout" || status === "BabbleTimeout") {
      return "";
    }
    throw new Error(`Azure STT 识别失败: ${status || "unknown"}`);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Azure STT request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────
//  Telegram 工具函数
// ─────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const chunks = splitTelegramText(text);
  for (const chunk of chunks) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

async function sendGeneratedImage(chatId, image, prompt) {
  if (image.type === "url") {
    await telegram("sendPhoto", {
      chat_id: chatId,
      photo: image.value,
      caption: trimTelegramCaption(prompt),
    });
    return;
  }

  const buffer = Buffer.from(image.value, "base64");
  await telegramMultipart(
    "sendPhoto",
    {
      chat_id: String(chatId),
      caption: trimTelegramCaption(prompt),
    },
    {
      photo: {
        filename: "image.png",
        contentType: "image/png",
        buffer,
      },
    },
  );
}

async function telegram(method, payload = {}) {
  const url = `${telegramApi}/${method}`;
  const response = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: config.requestTimeoutMs,
  });

  if (!response.ok) {
    throw new Error(response.description || `Telegram ${method} failed`);
  }

  return response.result;
}

async function telegramMultipart(method, fields, files) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  for (const [key, file] of Object.entries(files)) {
    const blob = new Blob([file.buffer], { type: file.contentType });
    form.append(key, blob, file.filename);
  }

  const response = await fetchJson(`${telegramApi}/${method}`, {
    method: "POST",
    body: form,
    timeoutMs: config.requestTimeoutMs,
  });

  if (!response.ok) {
    throw new Error(response.description || `Telegram ${method} failed`);
  }

  return response.result;
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const message = data.error?.message || data.description || response.statusText;
      throw new Error(`${response.status} ${message}`);
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────

function splitTelegramText(text) {
  const maxLength = 3900;
  const chunks = [];
  let rest = String(text || "");

  while (rest.length > maxLength) {
    // 尝试在换行符处断开
    let breakAt = rest.lastIndexOf("\n", maxLength);
    if (breakAt < maxLength * 0.5) breakAt = maxLength;
    chunks.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt);
  }

  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [" "];
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function loadSystemPrompt() {
  const promptFile = process.env.BOT_SYSTEM_PROMPT_FILE;
  if (promptFile) {
    const filePath = path.resolve(__dirname, "..", promptFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`BOT_SYSTEM_PROMPT_FILE not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, "utf8").trim();
  }

  return process.env.BOT_SYSTEM_PROMPT || "You are a concise and reliable Chinese assistant.";
}

function requiredTelegramToken(name) {
  const value = requiredEnv(name);
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
    throw new Error(`${name} is not a valid BotFather token.`);
  }
  return value;
}

function formatAiError(error) {
  const message = String(error?.message || error);
  if (message.includes("sensitive_words_detected")) {
    return "Request blocked by the API content filter. Please change the bot prompt or rephrase the message.";
  }
  if (message.includes("rate_limit_exceeded") || message.includes("No available accounts")) {
    return "The selected model is temporarily unavailable. Try again later or switch AI_MODEL in .env.";
  }
  if (message.includes("used all available credits") || message.includes("monthly spending limit")) {
    return "The xAI API key has no available credits or has reached its monthly spending limit. Please add credits or raise the spending limit in the xAI console.";
  }
  if (message.includes("No available channel")) {
    return "This model has no available API channel right now. Try another IMAGE_MODEL or wait and retry.";
  }
  return `AI API failed: ${message}`;
}

function parseImagePrompt(text) {
  const trimmed = text.trim();
  const commands = ["/image", "/img", "画图", "生成图片", "生图"];

  for (const command of commands) {
    if (trimmed === command) return "";
    if (trimmed.startsWith(`${command} `)) {
      return trimmed.slice(command.length).trim();
    }
  }

  return "";
}

function parseTtsPrompt(text) {
  const trimmed = text.trim();
  const commands = ["/tts", "/voice", "朗读", "读一下"];

  for (const command of commands) {
    if (trimmed === command) return "";
    if (trimmed.startsWith(`${command} `)) {
      return trimmed.slice(command.length).trim();
    }
  }

  return null;
}

function formatAzureTtsError(error) {
  const msg = String(error?.message || error);
  if (msg.includes("401") || msg.includes("403")) {
    return "Azure TTS 鉴权失败,请检查 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION。";
  }
  if (msg.includes("429")) {
    return "Azure TTS 限流或配额耗尽,稍后再试。";
  }
  if (msg.includes("timed out")) {
    return "Azure TTS 请求超时,请重试。";
  }
  return `Azure TTS 失败: ${msg}`;
}

function formatAzureSttError(error) {
  const msg = String(error?.message || error);
  if (msg.includes("401") || msg.includes("403")) {
    return "Azure STT 鉴权失败,请检查 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION。";
  }
  if (msg.includes("429")) {
    return "Azure STT 限流或配额耗尽,稍后再试。";
  }
  if (msg.includes("timed out")) {
    return "语音识别超时,请重试。";
  }
  return `语音识别失败: ${msg}`;
}

function trimTelegramCaption(text) {
  return String(text || "").slice(0, 1024);
}

function extractImageUrl(text) {
  const value = String(text || "");
  const markdownMatch = value.match(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (markdownMatch) return markdownMatch[1];

  const plainMatch = value.match(/https?:\/\/\S+/);
  if (plainMatch) return plainMatch[0].replace(/[).,，。]+$/, "");

  return "";
}

function trimRightSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(signal) {
  console.log(`Received ${signal}, exiting.`);
  process.exit(0);
}
