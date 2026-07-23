"use strict";

const { config } = require("./config");
const { createFunReply } = require("./fun");
const { clearChatHistory, replyWithAi } = require("./chat");
const { generateImage } = require("./image");
const { handleVoiceMessage, synthesizeAzureTts } = require("./speech");
const { telegram, sendMessage, sendVoiceMessage, sendGeneratedImage } = require("./telegram");
const {
  parseImagePrompt,
  parseTtsPrompt,
  formatAiError,
  formatAzureTtsError,
} = require("./util");

const HELP_TEXT = [
  "Bot is online.",
  "",
  "Send any question to call the AI API.",
  "Send a voice message - I'll transcribe and reply (Azure STT)",
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
    await sendMessage(
      chatId,
      `Chat model: ${config.model}\nImage model: ${config.imageModel}\nStream: ${streamStatus}`,
    );
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

module.exports = {
  handleUpdate,
  HELP_TEXT,
};
