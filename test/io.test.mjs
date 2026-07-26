import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileLockStatus, withFileLock } from "../src/lib/io.mjs";

test("shared lock prevents checker and watchdog state races", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odyssey-lock-"));
  const lock = path.join(directory, "monitor.lock");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const first = withFileLock(lock, async () => {
      await held;
      return "first-complete";
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await withFileLock(lock, async () => "should-not-run");
    assert.equal(second.lockSkipped, true);
    release();
    assert.equal(await first, "first-complete");
    assert.equal(await withFileLock(lock, async () => "third-complete"), "third-complete");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("dead checker locks are recovered immediately", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odyssey-dead-lock-"));
  const lock = path.join(directory, "monitor.lock");
  try {
    await fs.writeFile(lock, "99999999\n");
    const before = await readFileLockStatus(lock);
    assert.equal(before.exists, true);
    assert.equal(before.ownerAlive, false);
    assert.equal(await withFileLock(lock, async () => "recovered"), "recovered");
    const after = await readFileLockStatus(lock);
    assert.equal(after.exists, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
