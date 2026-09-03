// Server entry — mirrors old server/index.js startup (listen, backup restore
// + loop, history GC interval, bot start).
import { PORT } from "./config/env";
import { createApp } from "./app";
import { bootstrapProcessHandlers } from "./middleware/error";
import { startHistoryGc } from "./services/history";
import { redis } from "./services/redis";
import { restoreFromBackup, startBackupLoop } from "./services/backup";
import { isBotEnabled, startBot } from "./services/telegram";

const app = createApp();

bootstrapProcessHandlers();

app.listen(PORT, async () => {
  console.log("Server listening on http://localhost:" + PORT);
  try {
    await restoreFromBackup(redis);
    startBackupLoop(redis);
  } catch (e) {
    console.error("[Backup] Init error: " + (e as Error).message);
  }
});

// History GC sweep interval (best-effort)
startHistoryGc();

// Telegram bot (webhook or polling)
if (isBotEnabled()) {
  void startBot();
}
