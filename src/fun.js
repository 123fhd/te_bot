"use strict";

const MAX_CHOICES = 20;
const MAX_DICE = 20;
const MAX_SIDES = 1000;

const fortuneLevels = [
  "\u5927\u5409",
  "\u4E2D\u5409",
  "\u5C0F\u5409",
  "\u5409",
  "\u5E73",
];
const luckyColors = [
  "\u5929\u7A7A\u84DD",
  "\u8584\u8377\u7EFF",
  "\u5976\u6CB9\u767D",
  "\u6A31\u82B1\u7C89",
  "\u8461\u8404\u7D2B",
  "\u67E0\u6AAC\u9EC4",
];
const luckyActivities = [
  "\u5C1D\u8BD5\u4E00\u4EF6\u62D6\u4E86\u5F88\u4E45\u7684\u5C0F\u4E8B",
  "\u8054\u7CFB\u4E00\u4F4D\u597D\u4E45\u6CA1\u804A\u7684\u670B\u53CB",
  "\u51FA\u95E8\u8D70\u8D70\uFF0C\u6362\u4E2A\u5FC3\u60C5",
  "\u7ED9\u81EA\u5DF1\u4E00\u70B9\u4E0D\u5E26\u5185\u759A\u7684\u4F11\u606F",
  "\u8BB0\u5F55\u4ECA\u5929\u7684\u4E00\u4E2A\u5C0F\u7075\u611F",
  "\u8BA4\u771F\u5403\u4E00\u987F\u559C\u6B22\u7684\u996D",
];
const fortuneMessages = [
  "\u4ECA\u5929\u7684\u597D\u8FD0\u85CF\u5728\u4E3B\u52A8\u8FC8\u51FA\u7684\u4E00\u5C0F\u6B65\u91CC\u3002",
  "\u6162\u4E00\u70B9\u6CA1\u5173\u7CFB\uFF0C\u7A33\u7A33\u5F53\u5F53\u4E5F\u662F\u8FDB\u5EA6\u3002",
  "\u4ECA\u5929\u9002\u5408\u76F8\u4FE1\u7B2C\u4E00\u76F4\u89C9\uFF0C\u4F46\u522B\u5FD8\u4E86\u518D\u68C0\u67E5\u4E00\u904D\u3002",
  "\u4E00\u4E2A\u610F\u5916\u7684\u5C0F\u60CA\u559C\uFF0C\u53EF\u80FD\u6B63\u5728\u8DEF\u4E0A\u3002",
  "\u628A\u6CE8\u610F\u529B\u653E\u5728\u80FD\u63A7\u5236\u7684\u4E8B\u4E0A\uFF0C\u4F1A\u8F7B\u677E\u5F88\u591A\u3002",
];

function createFunReply(text, context = {}) {
  const match = String(text || "").trim().match(/^\/(fortune|choose|pick|roll)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const argument = (match[2] || "").trim();
  const random = context.random || Math.random;

  if (command === "fortune") {
    return formatFortune(context.chatId, context.now || new Date());
  }

  if (command === "choose" || command === "pick") {
    const choices = parseChoices(argument);
    if (choices.length < 2) {
      return "\u7528\u6CD5: /choose \u706B\u9505 | \u70E7\u70E4 | \u7092\u83DC\uFF08\u81F3\u5C11\u4E24\u4E2A\u9009\u9879\uFF09";
    }
    if (choices.length > MAX_CHOICES) {
      return `\u9009\u9879\u592A\u591A\u5566\uFF0C\u6700\u591A ${MAX_CHOICES} \u4E2A\u3002`;
    }
    return `\u{1F3AF} \u6211\u9009\uFF1A${chooseOne(choices, random)}`;
  }

  const notation = argument || "1d6";
  const dice = parseDiceNotation(notation);
  if (!dice) {
    return `\u7528\u6CD5: /roll 2d6\uFF08\u6700\u591A ${MAX_DICE} \u9897\u9AB0\u5B50\uFF0C\u6BCF\u9897\u6700\u591A ${MAX_SIDES} \u9762\uFF09`;
  }

  return formatDiceRoll(dice, random);
}

function parseChoices(argument) {
  if (!argument) return [];
  return argument
    .split(/\s*(?:\||,|\uFF0C|\u3001)\s*/u)
    .map((choice) => choice.trim())
    .filter(Boolean);
}

function chooseOne(choices, random = Math.random) {
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return choices[Math.floor(normalized * choices.length)];
}

function parseDiceNotation(notation) {
  const normalized = String(notation || "").trim();
  const match = normalized.match(/^(?:(\d{1,2})?d)?(\d{1,4})$/i);
  if (!match) return null;

  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  if (count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) return null;
  return { count, sides };
}

function formatDiceRoll({ count, sides }, random = Math.random) {
  const rolls = [];
  for (let index = 0; index < count; index += 1) {
    const value = Number(random());
    const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
    rolls.push(Math.floor(normalized * sides) + 1);
  }

  const notation = `${count === 1 ? "" : count}d${sides}`;
  if (rolls.length === 1) return `\u{1F3B2} ${notation}\uFF1A${rolls[0]}`;
  const total = rolls.reduce((sum, value) => sum + value, 0);
  return `\u{1F3B2} ${notation}\uFF1A${rolls.join(" + ")} = ${total}`;
}

function formatFortune(chatId, now) {
  const dateKey = getShanghaiDateKey(now);
  const seed = hashString(`${chatId ?? "anonymous"}|${dateKey}`);
  const score = 60 + seededIndex(seed, "score", 40);
  const level = fortuneLevels[seededIndex(seed, "level", fortuneLevels.length)];
  const color = luckyColors[seededIndex(seed, "color", luckyColors.length)];
  const activity = luckyActivities[seededIndex(seed, "activity", luckyActivities.length)];
  const message = fortuneMessages[seededIndex(seed, "message", fortuneMessages.length)];

  return [
    `\u{1F52E} \u4ECA\u65E5\u8FD0\u52BF\uFF08${dateKey}\uFF09`,
    `\u7B7E\u4F4D\uFF1A${level}`,
    `\u5E78\u8FD0\u6307\u6570\uFF1A${score}/100`,
    `\u5E78\u8FD0\u8272\uFF1A${color}`,
    `\u5B9C\uFF1A${activity}`,
    `\u4E00\u53E5\u8BDD\uFF1A${message}`,
  ].join("\n");
}

function getShanghaiDateKey(now) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function seededIndex(seed, salt, length) {
  return hashString(`${seed}|${salt}`) % length;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

module.exports = {
  chooseOne,
  createFunReply,
  formatDiceRoll,
  formatFortune,
  getShanghaiDateKey,
  parseChoices,
  parseDiceNotation,
};
