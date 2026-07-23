"use strict";

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

module.exports = {
  fetchJson,
};
