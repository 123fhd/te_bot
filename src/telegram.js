"use strict";

const { config } = require("./config");
const { fetchJson } = require("./http");
const { splitTelegramText, trimTelegramCaption } = require("./util");

const telegramApi = `https://api.telegram.org/bot${config.telegramToken}`;

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

module.exports = {
  sendMessage,
  sendVoiceMessage,
  sendGeneratedImage,
  downloadTelegramFile,
  telegram,
  telegramMultipart,
};
