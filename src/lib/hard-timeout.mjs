import fs from "node:fs";
import path from "node:path";
import {
  HARD_TIMEOUT_PATH,
  LOCK_PATH,
  RUNS_PATH,
} from "./paths.mjs";

function ignoreMissing(error) {
  if (error?.code !== "ENOENT") throw error;
}

export function recordHardTimeoutSync({
  pid,
  timeoutMinutes,
  startedAt,
  finishedAt = new Date().toISOString(),
  hardTimeoutPath = HARD_TIMEOUT_PATH,
  lockPath = LOCK_PATH,
  runsPath = RUNS_PATH,
}) {
  const event = {
    at: finishedAt,
    command: "check",
    timeoutMinutes,
    pid,
  };
  fs.mkdirSync(path.dirname(hardTimeoutPath), { recursive: true });
  fs.writeFileSync(hardTimeoutPath, `${JSON.stringify(event, null, 2)}\n`, {
    mode: 0o600,
  });

  let lockRemoved = false;
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() === String(pid)) {
      fs.unlinkSync(lockPath);
      lockRemoved = true;
    }
  } catch (error) {
    ignoreMissing(error);
  }

  const run = {
    kind: "check",
    startedAt,
    finishedAt,
    status: "hard_timeout",
    amcCheck: "timed_out",
    failures: [
      `Checker exceeded its ${timeoutMinutes}-minute hard runtime limit.`,
    ],
    changes: [],
    notifications: [],
    timeoutMinutes,
    pid,
  };
  fs.mkdirSync(path.dirname(runsPath), { recursive: true });
  fs.appendFileSync(runsPath, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  return { event, run, lockRemoved };
}
