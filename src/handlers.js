"use strict";

const { config } = require("./config");
const { createFunReply } = require("./fun");
const { clearChatHistory, replyWithAi } = require("./chat");
const { generateImage } = require("./image");
const {
  parsePersonaCommand,
  formatPersonaList,
  formatCurrentPersona,
  setChatPersona,
  getChatPersona,
} = require("./persona");
const { handleVoiceMessage, synthesizeAzureTts } = require("./speech");
const {
  telegram,
  sendMessage,
  sendVoiceMessage,
  sendGeneratedImage,
  getTelegramFile,
} = require("./telegram");
const {
  parseImagePrompt,
  parseTtsPrompt,
  formatAiError,
  formatAzureTtsError,
  pickLargestPhoto,
  isImageDocument,
  mimeTypeFromPath,
} = require("./util");

const HELP_TEXT = [
  "Bot is online.",
  "",
  "Send any question to call the AI API.",
  "Send a photo - I'll look at it and reply (Vision)",
  "Send a voice message - I'll transcribe and reply (Azure STT)",
  "/prompt - list personas / switch character",
  "/prompt 团子 - switch persona (also /persona /人设)",
  "/image prompt - generate an image",
  "/fortune - daily fortune",
  "/choose A | B | C - pick one option",
  "/roll 2d6 - roll dice",
  "/tts text - text-to-speech (Azure)",
  "/reset - clear chat memory",
  "/model - show current model",
  "/stream on|off - toggle streaming",
].join("\n");

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat) return;

  if (message.voice && !message.text) {
    await handleVoiceMessage(message);
    return;
  }

  if (message.photo && message.photo.length) {
    const photo = pickLargestPhoto(message.photo);
    await handleVisionMessage(message, {
      fileId: photo?.file_id,
      reportedSize: photo?.file_size,
      caption: message.caption || "",
      mimeHint: "image/jpeg",
    });
    return;
  }

  if (message.document && isImageDocument(message.document)) {
    await handleVisionMessage(message, {
      fileId: message.document.file_id,
      reportedSize: message.document.file_size,
      caption: message.caption || "",
      mimeHint: message.document.mime_type || "image/jpeg",
      fileName: message.document.file_name,
    });
    return;
  }

  if (!message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const from = message.from?.username || message.from?.first_name || "unknown";
  console.log(`Message from ${from} (${chatId}): ${text}`);

  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, HELP_TEXT);
    return;
  }

  if (text === "/reset") {
    clearChatHistory(chatId);
    await sendMessage(chatId, "Chat memory cleared.");
    return;
  }

  if (text === "/model") {
    const streamStatus = config.streamEnabled ? "ON" : "OFF";
    const visionStatus = config.visionEnabled ? "ON" : "OFF";
    const persona = getChatPersona(chatId);
    await sendMessage(
      chatId,
      [
        `Chat model: ${config.model}`,
        `Vision model: ${config.visionModel} (${visionStatus})`,
        `Image model: ${config.imageModel}`,
        `Persona: ${persona ? `${persona.name} (${persona.id})` : "unknown"}`,
        `Stream: ${streamStatus}`,
      ].join("\n"),
    );
    return;
  }

  const personaCommand = parsePersonaCommand(text);
  if (personaCommand) {
    await handlePersonaCommand(chatId, personaCommand);
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

  const funReply = createFunReply(text, { chatId });
  if (funReply !== null) {
    await sendMessage(chatId, funReply);
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

  try {
    await replyWithAi(chatId, text);
  } catch (error) {
    console.error("AI error:", error);
    await sendMessage(chatId, formatAiError(error));
  }
}

/**
 * @param {string | number} chatId
 * @param {{ type: 'list' } | { type: 'show' } | { type: 'set', query: string }} command
 */
async function handlePersonaCommand(chatId, command) {
  if (command.type === "list") {
    await sendMessage(chatId, formatPersonaList(chatId));
    return;
  }

  if (command.type === "show") {
    await sendMessage(chatId, formatCurrentPersona(chatId));
    return;
  }

  const result = setChatPersona(chatId, command.query);
  if (!result.ok) {
    await sendMessage(chatId, result.error);
    return;
  }

  // Avoid previous persona leaking into the new roleplay.
  clearChatHistory(chatId);
  const { persona, changed } = result;
  const tip = changed ? "已切换人设，聊天记忆已清空。" : "已经是这个人设了（仍已刷新记忆）。";
  await sendMessage(
    chatId,
    [
      `✅ ${tip}`,
      `当前：${persona.name}（${persona.id}）`,
      persona.desc ? `简介：${persona.desc}` : "",
    ].filter(Boolean).join("\n"),
  );
}

/**
 * Download a Telegram image and ask the vision-capable chat model.
 * @param {object} message
 * @param {{ fileId?: string, reportedSize?: number, caption?: string, mimeHint?: string, fileName?: string }} meta
 */
async function handleVisionMessage(message, meta) {
  const chatId = message.chat.id;
  const from = message.from?.username || message.from?.first_name || "unknown";
  const caption = String(meta.caption || "").trim();
  console.log(`Photo from ${from} (${chatId}): ${caption || "(no caption)"}`);

  if (!config.visionEnabled) {
    await sendMessage(chatId, "看图功能已关闭。可在 .env 设置 VISION_ENABLED=true。");
    return;
  }

  if (!meta.fileId) {
    await sendMessage(chatId, "没读到图片，请再发一次。");
    return;
  }

  if (meta.reportedSize && meta.reportedSize > config.visionMaxBytes) {
    await sendMessage(
      chatId,
      `图片太大了（上限约 ${Math.round(config.visionMaxBytes / (1024 * 1024))}MB），请压缩后再发。`,
    );
    return;
  }

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });

  let file;
  try {
    file = await getTelegramFile(meta.fileId);
  } catch (error) {
    console.error("Vision download error:", error);
    await sendMessage(chatId, `下载图片失败: ${error.message || error}`);
    return;
  }

  if (file.buffer.length > config.visionMaxBytes) {
    await sendMessage(
      chatId,
      `图片太大了（上限约 ${Math.round(config.visionMaxBytes / (1024 * 1024))}MB），请压缩后再发。`,
    );
    return;
  }

  const mimeType = mimeTypeFromPath(file.filePath || meta.fileName, meta.mimeHint);
  const image = {
    base64: file.buffer.toString("base64"),
    mimeType,
  };

  try {
    await replyWithAi(chatId, caption, { image });
  } catch (error) {
    console.error("Vision AI error:", error);
    await sendMessage(chatId, formatAiError(error));
  }
}

module.exports = {
  handleUpdate,
  handleVisionMessage,
  HELP_TEXT,
};
