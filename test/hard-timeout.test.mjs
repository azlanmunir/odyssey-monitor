import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { recordHardTimeoutSync } from "../src/lib/hard-timeout.mjs";

test("hard timeout removes only its own lock and appends run history", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odyssey-hard-timeout-"),
  );
  const lockPath = path.join(directory, "locks", "monitor.lock");
  const hardTimeoutPath = path.join(directory, "last-hard-timeout.json");
  const runsPath = path.join(directory, "runs.jsonl");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "4242\n");
  try {
    const result = recordHardTimeoutSync({
      pid: 4242,
      timeoutMinutes: 8,
      startedAt: "2026-07-27T20:52:00.000Z",
      finishedAt: "2026-07-27T21:00:00.000Z",
      hardTimeoutPath,
      lockPath,
      runsPath,
    });
    assert.equal(result.lockRemoved, true);
    await assert.rejects(fs.access(lockPath));
    assert.deepEqual(
      JSON.parse(await fs.readFile(hardTimeoutPath, "utf8")),
      result.event,
    );
    const runs = (await fs.readFile(runsPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "hard_timeout");
    assert.equal(runs[0].amcCheck, "timed_out");
    assert.equal(runs[0].pid, 4242);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("hard timeout never removes a lock owned by another process", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odyssey-foreign-lock-"),
  );
  const lockPath = path.join(directory, "monitor.lock");
  try {
    await fs.writeFile(lockPath, "9999\n");
    const result = recordHardTimeoutSync({
      pid: 4242,
      timeoutMinutes: 8,
      startedAt: "2026-07-27T20:52:00.000Z",
      finishedAt: "2026-07-27T21:00:00.000Z",
      hardTimeoutPath: path.join(directory, "timeout.json"),
      lockPath,
      runsPath: path.join(directory, "runs.jsonl"),
    });
    assert.equal(result.lockRemoved, false);
    assert.equal((await fs.readFile(lockPath, "utf8")).trim(), "9999");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
