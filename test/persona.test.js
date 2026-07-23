"use strict";

// Allow loading config/persona without a real .env during unit tests.
process.env.TELEGRAM_BOT_TOKEN ||= "123456:ABCDEFGHIJKLMNOPQRSTUVWX";
process.env.AI_API_BASE_URL ||= "https://example.com/v1";
process.env.AI_API_KEY ||= "test-key-for-unit-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePersonaContent,
  resolvePersona,
  parsePersonaCommand,
  setChatPersona,
  getChatPersonaId,
  getSystemPrompt,
  listPersonas,
  defaultPersonaId,
} = require("../src/persona");

test("parsePersonaContent reads metadata and body", () => {
  const persona = parsePersonaContent(
    "demo",
    [
      "#name: 演示",
      "#desc: 测试用",
      "#aliases: 演示, demo-role",
      "",
      "你是演示角色。",
      "第二行。",
    ].join("\n"),
  );

  assert.equal(persona.id, "demo");
  assert.equal(persona.name, "演示");
  assert.equal(persona.desc, "测试用");
  assert.ok(persona.aliases.includes("demo"));
  assert.ok(persona.aliases.includes("演示"));
  assert.ok(persona.aliases.includes("demo-role"));
  assert.match(persona.prompt, /你是演示角色/);
  assert.match(persona.prompt, /第二行/);
});

test("parsePersonaContent rejects empty body", () => {
  assert.throws(() => parsePersonaContent("empty", "#name: x\n\n"), /empty prompt/i);
});

test("built-in prompts are loaded", () => {
  const ids = listPersonas().map((p) => p.id);
  assert.ok(ids.includes("tuanzi"));
  assert.ok(ids.includes("assistant"));
  assert.ok(ids.includes("translator"));
  assert.ok(ids.includes("coder"));
  assert.ok(defaultPersonaId);
});

test("resolvePersona matches id name and aliases", () => {
  const map = new Map([
    [
      "tuanzi",
      {
        id: "tuanzi",
        name: "团子",
        desc: "",
        aliases: ["tuanzi", "团子"],
        prompt: "p",
      },
    ],
  ]);

  assert.equal(resolvePersona("tuanzi", map)?.id, "tuanzi");
  assert.equal(resolvePersona("团子", map)?.id, "tuanzi");
  assert.equal(resolvePersona("TUANZI", map)?.id, "tuanzi");
  assert.equal(resolvePersona("nope", map), null);
});

test("parsePersonaCommand supports aliases and args", () => {
  assert.deepEqual(parsePersonaCommand("/prompt"), { type: "list" });
  assert.deepEqual(parsePersonaCommand("/prompt list"), { type: "list" });
  assert.deepEqual(parsePersonaCommand("/人设 列表"), { type: "list" });
  assert.deepEqual(parsePersonaCommand("/persona current"), { type: "show" });
  assert.deepEqual(parsePersonaCommand("/prompt@my_bot 团子"), { type: "set", query: "团子" });
  assert.equal(parsePersonaCommand("hello"), null);
});

test("setChatPersona switches per chat and updates system prompt", () => {
  const chatId = 900001;
  const first = setChatPersona(chatId, "assistant");
  assert.equal(first.ok, true);
  assert.equal(getChatPersonaId(chatId), "assistant");
  assert.match(getSystemPrompt(chatId), /简洁|助手/);

  const second = setChatPersona(chatId, "翻译官");
  assert.equal(second.ok, true);
  assert.equal(getChatPersonaId(chatId), "translator");
  assert.match(getSystemPrompt(chatId), /翻译/);

  const missing = setChatPersona(chatId, "不存在的人设xyz");
  assert.equal(missing.ok, false);
});
