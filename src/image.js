"use strict";

const { config } = require("./config");
const { fetchJson } = require("./http");

async function generateImage(prompt) {
  if (config.imageEndpoint === "chat") {
    return generateImageWithChat(prompt);
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
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
    } catch (error) {
      lastError = error;
      const is500 = String(error.message).includes("500");
      if (is500 && attempt < 2) {
        console.log(`Image generation failed (500), retrying in 2s... (${attempt}/2)`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function generateImageWithChat(prompt) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
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
    } catch (error) {
      lastError = error;
      const is500 = String(error.message).includes("500");
      if (is500 && attempt < 2) {
        console.log(`Image generation failed (500), retrying in 2s... (${attempt}/2)`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function extractImageUrl(text) {
  const value = String(text || "");
  const markdownMatch = value.match(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (markdownMatch) return markdownMatch[1];

  const plainMatch = value.match(/https?:\/\/\S+/);
  if (plainMatch) return plainMatch[0].replace(/[).,，。]+$/, "");

  return "";
}

module.exports = {
  generateImage,
  generateImageWithChat,
  extractImageUrl,
};
