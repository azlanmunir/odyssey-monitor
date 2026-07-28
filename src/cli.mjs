#!/usr/bin/env node
import { loadConfig } from "./lib/config.mjs";
import { recordHardTimeoutSync } from "./lib/hard-timeout.mjs";
import { withFileLock } from "./lib/io.mjs";
import { describeRun, runCheck, runWatchdog } from "./lib/monitor.mjs";
import { LOCK_PATH } from "./lib/paths.mjs";
import { formatMonitorStatus, monitorStatus } from "./lib/status.mjs";
import { sendTelegram } from "./lib/telegram.mjs";

const [command = "check", ...args] = process.argv.slice(2);
const config = await loadConfig();
const flags = new Set(args);

if (command === "check") {
  const timeoutMinutes = config.polling.maxCheckRuntimeMinutes;
  const checkStartedAt = new Date().toISOString();
  const hardTimer = setTimeout(() => {
    try {
      recordHardTimeoutSync({
        pid: process.pid,
        timeoutMinutes,
        startedAt: checkStartedAt,
      });
    } catch (error) {
      console.error(`HARD TIMEOUT persistence failed — ${error.message}`);
    } finally {
      console.error(`HARD TIMEOUT — checker exceeded ${timeoutMinutes} minutes`);
      process.exit(124);
    }
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
