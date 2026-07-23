"use strict";

require("./config");

const { handleUpdate } = require("./handlers");
const { telegram } = require("./telegram");
const { sleep, shutdown } = require("./util");

let offset = 0;

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Bot failed to start:", error);
  process.exit(1);
});

async function main() {
  const me = await telegram("getMe");
  console.log(`Bot started: @${me.username}`);

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(2000);
    }
  }
}
