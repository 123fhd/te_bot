"use strict";

const { config } = require("./config");
const { replyWithAi } = require("./chat");
const {
  telegram,
  sendMessage,
  sendVoiceMessage,
  downloadTelegramFile,
} = require("./telegram");
const { formatAzureTtsError, formatAzureSttError, formatAiError } = require("./util");

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

  let aiReply = "";
  try {
    aiReply = await replyWithAi(chatId, transcript);
  } catch (error) {
    console.error("AI error:", error);
    await sendMessage(chatId, formatAiError(error));
    return;
  }

  if (aiReply) {
    try {
      await telegram("sendChatAction", { chat_id: chatId, action: "record_voice" });
      const audio = await synthesizeAzureTts(aiReply);
      await sendVoiceMessage(chatId, audio);
    } catch (error) {
      console.error("Auto-TTS error:", error);
    }
  }
}

module.exports = {
  synthesizeAzureTts,
  buildSsml,
  transcribeAzureStt,
  handleVoiceMessage,
};
