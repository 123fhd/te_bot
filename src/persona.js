"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { config } = require("./config");

/**
 * Persona file format (UTF-8):
 *   #name: 显示名
 *   #desc: 一句话简介
 *   #aliases: 别名1,别名2
 *
 *   （空行后）system prompt 正文
 */

/**
 * @typedef {{ id: string, name: string, desc: string, aliases: string[], prompt: string, source?: string }} Persona
 */

/**
 * Parse a persona text file body into structured fields.
 * @param {string} id
 * @param {string} raw
 * @returns {Persona}
 */
function parsePersonaContent(id, raw) {
  const lines = String(raw || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let name = id;
  let desc = "";
  const aliases = [];
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      bodyStart = i + 1;
      continue;
    }
    const meta = line.match(/^#\s*(name|desc|aliases)\s*[:：]\s*(.+)$/i);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      if (key === "name") name = value;
      else if (key === "desc") desc = value;
      else if (key === "aliases") {
        for (const part of value.split(/[,，、]/u)) {
          const alias = part.trim();
          if (alias) aliases.push(alias);
        }
      }
      bodyStart = i + 1;
      continue;
    }
    bodyStart = i;
    break;
  }

  const prompt = lines.slice(bodyStart).join("\n").trim();
  if (!prompt) {
    throw new Error(`Persona "${id}" has empty prompt body`);
  }

  const normalizedAliases = uniqueStrings([
    id,
    name,
    ...aliases,
  ].map(normalizeKey).filter(Boolean));

  return {
    id,
    name,
    desc,
    aliases: normalizedAliases,
    prompt,
  };
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Load all `*.txt` personas from a directory.
 * @param {string} directory
 * @returns {Map<string, Persona>}
 */
function loadPersonasFromDir(directory) {
  /** @type {Map<string, Persona>} */
  const map = new Map();
  if (!fs.existsSync(directory)) return map;

  const files = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".txt"));
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    const fullPath = path.join(directory, file);
    const raw = fs.readFileSync(fullPath, "utf8");
    const persona = parsePersonaContent(id, raw);
    persona.source = fullPath;
    map.set(persona.id, persona);
  }
  return map;
}

function pickDefaultPersonaId(personas, preferred) {
  const preferredId = normalizeKey(preferred);
  if (preferredId) {
    for (const persona of personas.values()) {
      if (persona.aliases.includes(preferredId) || persona.id === preferredId) {
        return persona.id;
      }
    }
  }
  if (personas.has("tuanzi")) return "tuanzi";
  const first = personas.keys().next();
  if (!first.done) return first.value;
  return "default";
}

const promptsDir = path.resolve(
  __dirname,
  "..",
  process.env.PROMPTS_DIR || "prompts",
);

/** @type {Map<string, Persona>} */
const personas = loadPersonasFromDir(promptsDir);

if (personas.size === 0) {
  personas.set("default", {
    id: "default",
    name: "默认",
    desc: "来自 BOT_SYSTEM_PROMPT / BOT_SYSTEM_PROMPT_FILE",
    aliases: ["default", "默认"],
    prompt: config.systemPrompt,
    source: "config",
  });
}

const defaultPersonaId = pickDefaultPersonaId(
  personas,
  process.env.DEFAULT_PERSONA || "",
);

/** @type {Map<string | number, string>} chatId -> personaId */
const chatPersonas = new Map();

function listPersonas() {
  return [...personas.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function getPersona(id) {
  return personas.get(id) || null;
}

function getChatPersonaId(chatId) {
  return chatPersonas.get(chatId) || defaultPersonaId;
}

function getChatPersona(chatId) {
  return getPersona(getChatPersonaId(chatId)) || getPersona(defaultPersonaId);
}

function getSystemPrompt(chatId) {
  return getChatPersona(chatId)?.prompt || config.systemPrompt;
}

/**
 * Resolve by id, name, or alias (case-insensitive).
 * @param {string} query
 * @returns {Persona | null}
 */
function resolvePersona(query, personaMap = personas) {
  const key = normalizeKey(query);
  if (!key) return null;

  if (personaMap.has(key)) return personaMap.get(key);

  for (const persona of personaMap.values()) {
    if (persona.aliases.includes(key)) return persona;
    if (normalizeKey(persona.name) === key) return persona;
  }
  return null;
}

/**
 * @param {string | number} chatId
 * @param {string} query
 * @returns {{ ok: true, persona: Persona, changed: boolean } | { ok: false, error: string }}
 */
function setChatPersona(chatId, query) {
  const persona = resolvePersona(query);
  if (!persona) {
    return {
      ok: false,
      error: `找不到人设「${query}」。发送 /prompt list 查看可用列表。`,
    };
  }

  const prev = getChatPersonaId(chatId);
  chatPersonas.set(chatId, persona.id);
  return {
    ok: true,
    persona,
    changed: prev !== persona.id,
  };
}

function clearChatPersona(chatId) {
  chatPersonas.delete(chatId);
}

/**
 * Format list message for Telegram.
 * @param {string | number} chatId
 */
function formatPersonaList(chatId) {
  const currentId = getChatPersonaId(chatId);
  const lines = ["🎭 可用人设：", ""];

  for (const persona of listPersonas()) {
    const mark = persona.id === currentId ? " ← 当前" : "";
    const desc = persona.desc ? ` — ${persona.desc}` : "";
    lines.push(`• ${persona.id}（${persona.name}）${desc}${mark}`);
  }

  lines.push("");
  lines.push("切换：/prompt <id 或 名称>");
  lines.push("例如：/prompt tuanzi  或  /prompt 翻译官");
  lines.push("切换后会清空本聊天记忆，避免人设串戏。");
  return lines.join("\n");
}

/**
 * Parse /prompt | /persona | /人设 commands.
 * @returns {null | { type: 'list' } | { type: 'show' } | { type: 'set', query: string }}
 */
function parsePersonaCommand(text) {
  const match = String(text || "")
    .trim()
    .match(/^\/(prompt|persona|人设)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const arg = (match[2] || "").trim();
  if (!arg || /^(list|ls|全部|列表)$/i.test(arg)) {
    return { type: "list" };
  }
  if (/^(show|current|当前|status)$/i.test(arg)) {
    return { type: "show" };
  }
  return { type: "set", query: arg };
}

function formatCurrentPersona(chatId) {
  const persona = getChatPersona(chatId);
  if (!persona) return "当前人设：未知";
  const desc = persona.desc ? `\n简介：${persona.desc}` : "";
  return `当前人设：${persona.name}（${persona.id}）${desc}`;
}

module.exports = {
  parsePersonaContent,
  loadPersonasFromDir,
  pickDefaultPersonaId,
  normalizeKey,
  resolvePersona,
  listPersonas,
  getPersona,
  getChatPersonaId,
  getChatPersona,
  getSystemPrompt,
  setChatPersona,
  clearChatPersona,
  formatPersonaList,
  formatCurrentPersona,
  parsePersonaCommand,
  defaultPersonaId,
  promptsDir,
};
