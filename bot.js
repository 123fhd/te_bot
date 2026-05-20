const fs = require("node:fs");
const path = require("node:path");

loadEnv(path.join(__dirname, ".env"));

const config = {
  telegramToken: requiredTelegramToken("TELEGRAM_BOT_TOKEN"),
  apiBaseUrl: trimRightSlash(requiredEnv("AI_API_BASE_URL")),
  apiKey: requiredEnv("AI_API_KEY"),
  model: process.env.AI_MODEL || "gpt-4o-mini",
  imageModel: process.env.IMAGE_MODEL || "gpt-image-2",
  imageSize: process.env.IMAGE_SIZE || "1024x1024",
  systemPrompt: validateSystemPrompt(
    process.env.BOT_SYSTEM_PROMPT || "You are a concise and reliable Chinese assistant.",
  ),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES || 12),
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
  if (!message || !message.chat || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const from = message.from?.username || message.from?.first_name || "unknown";
  console.log(`Message from ${from} (${chatId}): ${text}`);

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, [
      "Bot is online.",
      "",
      "Send any question to call the AI API.",
      "/image prompt - generate an image",
      "/reset - clear chat memory",
      "/model - show current model",
    ].join("\n"));
    return;
  }

  if (text === "/reset") {
    chatHistories.delete(chatId);
    await sendMessage(chatId, "Chat memory cleared.");
    return;
  }

  if (text === "/model") {
    await sendMessage(chatId, `Chat model: ${config.model}\nImage model: ${config.imageModel}`);
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

  await telegram("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });

  try {
    const reply = await askAi(chatId, text);
    await sendMessage(chatId, reply);
  } catch (error) {
    console.error("AI error:", error);
    await sendMessage(chatId, formatAiError(error));
  }
}

async function askAi(chatId, text) {
  const history = chatHistories.get(chatId) || [];
  const messages = [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: text },
  ];

  const response = await fetchJson(`${config.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.7,
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

async function generateImage(prompt) {
  const response = await fetchJson(`${config.apiBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
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

function splitTelegramText(text) {
  const maxLength = 3900;
  const chunks = [];
  let rest = String(text || "");

  while (rest.length > maxLength) {
    chunks.push(rest.slice(0, maxLength));
    rest = rest.slice(maxLength);
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

function requiredTelegramToken(name) {
  const value = requiredEnv(name);
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
    throw new Error(`${name} is not a valid BotFather token.`);
  }
  return value;
}

function validateSystemPrompt(value) {
  const blockedPatterns = [
    /骚逼/,
    /发情/,
    /阴唇/,
    /鸡巴/,
    /操烂/,
    /母狗/,
  ];

  if (blockedPatterns.some((pattern) => pattern.test(value))) {
    throw new Error("BOT_SYSTEM_PROMPT contains explicit sexual content and will be blocked by the API.");
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

function trimTelegramCaption(text) {
  return String(text || "").slice(0, 1024);
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
