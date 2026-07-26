#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { withFileLock } from "./lib/io.mjs";
import { describeRun, runCheck, runWatchdog } from "./lib/monitor.mjs";
import { HARD_TIMEOUT_PATH, LOCK_PATH } from "./lib/paths.mjs";
import { formatMonitorStatus, monitorStatus } from "./lib/status.mjs";
import { sendTelegram } from "./lib/telegram.mjs";

const [command = "check", ...args] = process.argv.slice(2);
const config = await loadConfig();
const flags = new Set(args);

if (command === "check") {
  const timeoutMinutes = config.polling.maxCheckRuntimeMinutes;
  const hardTimer = setTimeout(() => {
    const event = {
      at: new Date().toISOString(),
      command: "check",
      timeoutMinutes,
      pid: process.pid,
    };
    fs.mkdirSync(path.dirname(HARD_TIMEOUT_PATH), { recursive: true });
    fs.writeFileSync(HARD_TIMEOUT_PATH, `${JSON.stringify(event, null, 2)}\n`, {
      mode: 0o600,
    });
    console.error(`HARD TIMEOUT — checker exceeded ${timeoutMinutes} minutes`);
    process.exit(124);
  }, timeoutMinutes * 60_000);
  hardTimer.unref();

  let result;
  try {
    result = await withFileLock(LOCK_PATH, () =>
      runCheck(config, {
        force: flags.has("--force"),
        baseline: flags.has("--baseline"),
        dryRun: flags.has("--dry-run"),
      }),
    );
  } finally {
    clearTimeout(hardTimer);
  }
  if (result.lockSkipped) {
    console.log(`SKIPPED — ${result.reason}`);
    process.exit(0);
  }
  console.log(describeRun(result));
  process.exitCode = ["failed", "partial"].includes(result.run.status) ? 1 : 0;
} else if (command === "watchdog") {
  const result = await runWatchdog(config, { dryRun: flags.has("--dry-run") });
  console.log(
    `WATCHDOG ${result.run.status.toUpperCase()} — ${result.run.notifications.length} notification(s)`,
  );
} else if (command === "test-telegram") {
  const result = await sendTelegram(config, "HEALTH — Odyssey monitor Telegram test");
  console.log(result.sent ? "Telegram test sent." : `Telegram test not sent: ${result.reason}`);
} else if (command === "status") {
  console.log(formatMonitorStatus(await monitorStatus(config)));
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 2;
}
