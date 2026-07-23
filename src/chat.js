"use strict";

const { config } = require("./config");
const { fetchJson } = require("./http");
const { telegram, sendMessage } = require("./telegram");
const {
  formatAiError,
  splitTelegramText,
  historyTextForVision,
  buildUserContent,
} = require("./util");

const chatHistories = new Map();

function clearChatHistory(chatId) {
  chatHistories.delete(chatId);
}

function resolveModel(hasImage) {
  return hasImage ? config.visionModel : config.model;
}

function appendHistory(chatId, userText, assistantText) {
  const history = chatHistories.get(chatId) || [];
  const nextHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ].slice(-config.maxHistoryMessages);
  chatHistories.set(chatId, nextHistory);
}

/**
 * @param {string} chatId
 * @param {string} text
 * @param {{ image?: { base64: string, mimeType: string } }} [options]
 */
async function askAi(chatId, text, options = {}) {
  const image = options.image || null;
  const history = chatHistories.get(chatId) || [];
  const userContent = buildUserContent(text, image);
  const historyUserText = image ? historyTextForVision(text) : text;

  const messages = [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: userContent },
  ];

  const response = await fetchJson(`${config.chatApiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.chatApiKey}`,
    },
    body: JSON.stringify({
      model: resolveModel(Boolean(image)),
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

  // History keeps a text placeholder only — never store base64 payloads.
  appendHistory(chatId, historyUserText, content);
  return content;
}

/**
 * @param {string} chatId
 * @param {string} text
 * @param {(full: string) => void} onChunk
 * @param {{ image?: { base64: string, mimeType: string } }} [options]
 */
async function askAiStream(chatId, text, onChunk, options = {}) {
  const image = options.image || null;
  const history = chatHistories.get(chatId) || [];
  const userContent = buildUserContent(text, image);
  const historyUserText = image ? historyTextForVision(text) : text;

  const messages = [
    { role: "system", content: config.systemPrompt },
    ...history,
    { role: "user", content: userContent },
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
        model: resolveModel(Boolean(image)),
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

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
          // ignore malformed SSE lines
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (fullContent) {
    appendHistory(chatId, historyUserText, fullContent);
  }

  return fullContent;
}

/**
 * @param {string} chatId
 * @param {string} text
 * @param {{ image?: { base64: string, mimeType: string } }} [options]
 */
async function sendMessageStream(chatId, text, options = {}) {
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
      if (String(error.message).includes("429")) {
        console.warn("Telegram edit rate limited, skipping chunk");
      } else {
        console.error("Edit message error:", error.message);
      }
    }
  };

  try {
    await askAiStream(chatId, text, throttledEdit, options);
  } catch (error) {
    console.error("Stream AI error:", error);
    await doEdit(formatAiError(error));
    return;
  }

  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
  }

  if (finalContent !== lastEditedText) {
    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: finalContent,
        disable_web_page_preview: true,
      });
    } catch {
      // ignore final edit failure
    }
  }

  if (finalContent.length > 4096) {
    const chunks = splitTelegramText(finalContent);
    await doEdit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await sendMessage(chatId, chunks[i]);
    }
  }

  return finalContent;
}

/**
 * @param {string} chatId
 * @param {string} text
 * @param {{ image?: { base64: string, mimeType: string } }} [options]
 */
async function replyWithAi(chatId, text, options = {}) {
  if (config.streamEnabled) {
    return sendMessageStream(chatId, text, options);
  }

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
  const reply = await askAi(chatId, text, options);
  await sendMessage(chatId, reply);
  return reply;
}

module.exports = {
  clearChatHistory,
  askAi,
  askAiStream,
  sendMessageStream,
  replyWithAi,
};
