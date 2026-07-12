"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createFunReply,
  formatFortune,
  getShanghaiDateKey,
  parseChoices,
  parseDiceNotation,
} = require("../src/fun");

test("ignores normal chat messages", () => {
  assert.equal(createFunReply("hello"), null);
});

test("fortune is stable for the same chat and Shanghai calendar day", () => {
  const now = new Date("2026-07-12T08:00:00Z");
  const first = formatFortune(12345, now);
  const second = formatFortune(12345, now);

  assert.equal(first, second);
  assert.match(first, /2026-07-12/);
  assert.match(first, /\/100/);
});

test("Shanghai date key changes at Shanghai midnight", () => {
  assert.equal(getShanghaiDateKey(new Date("2026-07-11T15:59:59Z")), "2026-07-11");
  assert.equal(getShanghaiDateKey(new Date("2026-07-11T16:00:00Z")), "2026-07-12");
});

test("choose supports common Chinese and ASCII separators", () => {
  assert.deepEqual(parseChoices("A | B, C\uFF0CD\u3001E"), ["A", "B", "C", "D", "E"]);
  assert.equal(
    createFunReply("/choose A | B | C", { random: () => 0.5 }),
    "\u{1F3AF} \u6211\u9009\uFF1AB",
  );
});

test("choose requires at least two choices", () => {
  assert.match(createFunReply("/choose only-one"), /\/choose/);
});

test("dice notation accepts defaults and common forms", () => {
  assert.deepEqual(parseDiceNotation("20"), { count: 1, sides: 20 });
  assert.deepEqual(parseDiceNotation("d20"), { count: 1, sides: 20 });
  assert.deepEqual(parseDiceNotation("3d10"), { count: 3, sides: 10 });
  assert.equal(parseDiceNotation("21d6"), null);
  assert.equal(parseDiceNotation("2d1001"), null);
  assert.equal(parseDiceNotation("bad"), null);
});

test("roll uses the injected random source and reports the total", () => {
  const values = [0, 0.5, 0.999999];
  const reply = createFunReply("/roll 3d6", { random: () => values.shift() });
  assert.equal(reply, "\u{1F3B2} 3d6\uFF1A1 + 4 + 6 = 11");
});

test("Telegram command suffixes are supported", () => {
  assert.match(createFunReply("/roll@my_bot d8", { random: () => 0 }), /^\u{1F3B2}/u);
});
