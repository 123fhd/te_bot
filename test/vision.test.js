"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pickLargestPhoto,
  isImageDocument,
  mimeTypeFromPath,
  historyTextForVision,
  buildUserContent,
  DEFAULT_VISION_PROMPT,
} = require("../src/util");

test("pickLargestPhoto prefers larger dimensions", () => {
  const photo = pickLargestPhoto([
    { file_id: "a", width: 90, height: 90, file_size: 100 },
    { file_id: "b", width: 1280, height: 720, file_size: 80000 },
    { file_id: "c", width: 320, height: 180, file_size: 5000 },
  ]);
  assert.equal(photo.file_id, "b");
});

test("pickLargestPhoto returns null for empty input", () => {
  assert.equal(pickLargestPhoto([]), null);
  assert.equal(pickLargestPhoto(null), null);
});

test("isImageDocument accepts mime and extension", () => {
  assert.equal(isImageDocument({ mime_type: "image/png", file_name: "x.bin" }), true);
  assert.equal(isImageDocument({ mime_type: "application/pdf", file_name: "a.pdf" }), false);
  assert.equal(isImageDocument({ mime_type: "application/octet-stream", file_name: "pic.WEBP" }), true);
});

test("mimeTypeFromPath maps common extensions", () => {
  assert.equal(mimeTypeFromPath("photos/file_1.png"), "image/png");
  assert.equal(mimeTypeFromPath("a.webp"), "image/webp");
  assert.equal(mimeTypeFromPath("noext", "image/gif"), "image/gif");
  assert.equal(mimeTypeFromPath("unknown"), "image/jpeg");
});

test("historyTextForVision never embeds base64", () => {
  assert.equal(historyTextForVision(""), "[用户发送了一张图片]");
  assert.equal(historyTextForVision("这是什么"), "[用户发送了一张图片] 这是什么");
});

test("buildUserContent builds multimodal parts for vision", () => {
  const content = buildUserContent("图上有什么", {
    base64: "abc123",
    mimeType: "image/jpeg",
  });
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "图上有什么");
  assert.equal(content[1].type, "image_url");
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,abc123$/);
});

test("buildUserContent uses default prompt when caption empty", () => {
  const content = buildUserContent("", {
    base64: "x",
    mimeType: "image/png",
  });
  assert.equal(content[0].text, DEFAULT_VISION_PROMPT);
});

test("buildUserContent returns plain text without image", () => {
  assert.equal(buildUserContent("hello"), "hello");
});
