"use strict";

const { config } = require("./config");
const { fetchJson } = require("./http");
const { getSystemPrompt } = require("./persona");
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
    { role: "system", content: getSystemPrompt(chatId) },
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
    { role: "system", content: getSystemPrompt(chatId) },
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

/** Shown while waiting for the first stream tokens. */
const STREAM_PLACEHOLDER = "思考中…";
/** When the model returns no text. */
const STREAM_EMPTY_REPLY = "没有生成内容，请再试一次。";
/** Placeholder after edit failed and full reply was sent below. */
const STREAM_PLACEHOLDER_FALLBACK = "↓ 完整回复见下方";
/** Extra notice when live edits failed and content was re-sent. */
const STREAM_FALLBACK_HINT = "⚠️ 消息刷新受阻，已改为完整发送。";
/** Notice when mid-stream edits failed but the final edit recovered. */
const STREAM_RECOVERED_HINT = "⚠️ 流式显示曾卡顿，完整内容已更新在上方。";

/**
 * @param {string} chatId
 * @param {string} text
 * @param {{ image?: { base64: string, mimeType: string } }} [options]
 */
async function sendMessageStream(chatId, text, options = {}) {
  const placeholder = await telegram("sendMessage", {
    chat_id: chatId,
    text: STREAM_PLACEHOLDER,
    disable_web_page_preview: true,
  });

  const messageId = placeholder.message_id;
  /** Last text successfully written to the placeholder message. */
  let lastEditedText = STREAM_PLACEHOLDER;
  let lastEditTime = 0;
  let editTimer = null;
  let finalContent = "";
  let editFailureCount = 0;
  let fallbackUsed = false;

  const throttledEdit = (content) => {
    finalContent = content;
    const now = Date.now();
    const elapsed = now - lastEditTime;

    if (elapsed >= config.streamEditIntervalMs) {
      void doEdit(content);
    } else if (!editTimer) {
      editTimer = setTimeout(() => {
        editTimer = null;
        if (finalContent !== lastEditedText) {
          void doEdit(finalContent);
        }
      }, config.streamEditIntervalMs - elapsed);
    }
  };

  /**
   * @param {string} content
   * @returns {Promise<boolean>} true if Telegram accepted the edit
   */
  const doEdit = async (content) => {
    const textToShow = content || STREAM_PLACEHOLDER;
    if (textToShow === lastEditedText) return true;

    try {
      await telegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: textToShow,
        disable_web_page_preview: true,
      });
      lastEditedText = textToShow;
      lastEditTime = Date.now();
      return true;
    } catch (error) {
      editFailureCount += 1;
      const message = String(error?.message || error);
      if (message.includes("429")) {
        console.warn("Telegram edit rate limited, will retry later");
      } else {
        console.error("Edit message error:", message);
      }
      // Do not update lastEditedText — same content can be retried.
      return false;
    }
  };

  /**
   * Make sure the user can see `content` even if editMessageText keeps failing.
   * @param {string} content
   */
  const deliverVisibleText = async (content) => {
    const textToShow = content || STREAM_EMPTY_REPLY;
    const chunks = splitTelegramText(textToShow);
    const edited = await doEdit(chunks[0]);

    if (edited) {
      for (let i = 1; i < chunks.length; i += 1) {
        await sendMessage(chatId, chunks[i]);
      }
      return true;
    }

    // Keep the old bubble informative; put the full reply in new messages.
    fallbackUsed = true;
    await doEdit(STREAM_PLACEHOLDER_FALLBACK);
    await sendMessage(chatId, chunks[0]);
    for (let i = 1; i < chunks.length; i += 1) {
      await sendMessage(chatId, chunks[i]);
    }
    return false;
  };

  try {
    await askAiStream(chatId, text, throttledEdit, options);
  } catch (error) {
    console.error("Stream AI error:", error);
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    const errorText = formatAiError(error);
    // Failures before this error edit should still count toward feedback.
    const failuresBeforeError = editFailureCount;
    const ok = await doEdit(errorText);
    if (!ok) {
      fallbackUsed = true;
      await doEdit(STREAM_PLACEHOLDER_FALLBACK);
      await sendMessage(chatId, errorText);
      await sendMessage(chatId, STREAM_FALLBACK_HINT);
    } else if (failuresBeforeError > 0) {
      await sendMessage(chatId, STREAM_RECOVERED_HINT);
    }
    return errorText;
  }

  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
  }

  const trimmed = String(finalContent || "").trim();
  if (!trimmed) {
    const failuresBefore = editFailureCount;
    await deliverVisibleText(STREAM_EMPTY_REPLY);
    if (fallbackUsed) {
      await sendMessage(chatId, STREAM_FALLBACK_HINT);
    } else if (failuresBefore > 0) {
      await sendMessage(chatId, STREAM_RECOVERED_HINT);
    }
    return "";
  }

  const failuresBeforeFinal = editFailureCount;
  await deliverVisibleText(trimmed);

  if (fallbackUsed) {
    await sendMessage(chatId, STREAM_FALLBACK_HINT);
  } else if (failuresBeforeFinal > 0) {
    await sendMessage(chatId, STREAM_RECOVERED_HINT);
  }

  return trimmed;
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
  STREAM_PLACEHOLDER,
  STREAM_EMPTY_REPLY,
  STREAM_PLACEHOLDER_FALLBACK,
  STREAM_FALLBACK_HINT,
  STREAM_RECOVERED_HINT,
};
