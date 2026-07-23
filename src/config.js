"use strict";

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

function trimRightSlash(value) {
  return value.replace(/\/+$/, "");
}

module.exports = {
  config,
  loadEnv,
  requiredEnv,
  loadSystemPrompt,
  requiredTelegramToken,
  trimRightSlash,
};
