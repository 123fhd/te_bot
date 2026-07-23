"use strict";

function splitTelegramText(text) {
  const maxLength = 3900;
  const chunks = [];
  let rest = String(text || "");

  while (rest.length > maxLength) {
    let breakAt = rest.lastIndexOf("\n", maxLength);
    if (breakAt < maxLength * 0.5) breakAt = maxLength;
    chunks.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt);
  }

  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [" "];
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

/** Pick the largest Telegram photo size entry. */
function pickLargestPhoto(photoSizes) {
  if (!Array.isArray(photoSizes) || photoSizes.length === 0) return null;
  return photoSizes.reduce((best, item) => {
    const bestArea = (best.width || 0) * (best.height || 0);
    const area = (item.width || 0) * (item.height || 0);
    if (area > bestArea) return item;
    if (area === bestArea && (item.file_size || 0) > (best.file_size || 0)) return item;
    return best;
  });
}

function isImageDocument(document) {
  if (!document) return false;
  const mime = String(document.mime_type || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  const name = String(document.file_name || "").toLowerCase();
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name);
}

function mimeTypeFromPath(filePath, fallbackMime = "image/jpeg") {
  const value = String(filePath || "").toLowerCase();
  if (value.endsWith(".png")) return "image/png";
  if (value.endsWith(".webp")) return "image/webp";
  if (value.endsWith(".gif")) return "image/gif";
  if (value.endsWith(".bmp")) return "image/bmp";
  if (value.endsWith(".jpg") || value.endsWith(".jpeg")) return "image/jpeg";
  if (fallbackMime && String(fallbackMime).startsWith("image/")) return fallbackMime;
  return "image/jpeg";
}

/** Text stored in chat history when user sent an image (no base64). */
function historyTextForVision(caption) {
  const text = String(caption || "").trim();
  return text ? `[用户发送了一张图片] ${text}` : "[用户发送了一张图片]";
}

const DEFAULT_VISION_PROMPT = "请描述这张图片的内容，并简要说说你的看法。";

/**
 * Build OpenAI-compatible user content for text or vision messages.
 * @param {string} text
 * @param {{ base64: string, mimeType: string } | null | undefined} image
 */
function buildUserContent(text, image) {
  if (!image) return text;

  const prompt = String(text || "").trim() || DEFAULT_VISION_PROMPT;
  return [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64}`,
      },
    },
  ];
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(signal) {
  console.log(`Received ${signal}, exiting.`);
  process.exit(0);
}

module.exports = {
  splitTelegramText,
  parseImagePrompt,
  parseTtsPrompt,
  pickLargestPhoto,
  isImageDocument,
  mimeTypeFromPath,
  historyTextForVision,
  buildUserContent,
  DEFAULT_VISION_PROMPT,
  formatAiError,
  formatAzureTtsError,
  formatAzureSttError,
  trimTelegramCaption,
  sleep,
  shutdown,
};
