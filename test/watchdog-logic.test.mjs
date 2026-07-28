import test from "node:test";
import assert from "node:assert/strict";
import { healthAlert } from "../src/lib/alerts.mjs";
import {
  activeHungLock,
  batchedHealthText,
  dispatchHealthAlertBatch,
  latestRecoveryEpisode,
  timeoutFamilyPlan,
} from "../src/lib/monitor.mjs";

test("only an old lock with a live owner is called hung", () => {
  const limit = 8 * 60_000;
  assert.equal(
    activeHungLock(
      { exists: true, ownerAlive: true, ageMs: limit + 1 },
      limit,
    ),
    true,
  );
  assert.equal(
    activeHungLock(
      { exists: true, ownerAlive: false, ageMs: limit * 10 },
      limit,
    ),
    false,
  );
  assert.equal(
    activeHungLock(
      { exists: true, ownerAlive: true, ageMs: limit - 1 },
      limit,
    ),
    false,
  );
});

test("watchdog health findings are rendered as one bulleted message", () => {
  const text = batchedHealthText([
    healthAlert("one", "First finding."),
    healthAlert("two", "Second finding.\nMore detail."),
  ]);
  assert.equal((text.match(/HEALTH — ODYSSEY MONITOR/g) || []).length, 1);
  assert.match(text, /• First finding\./);
  assert.match(text, /• Second finding\.\n  More detail\./);
});

test("a watchdog batch sends once and dedupes by every individual key", async () => {
  const sentTexts = [];
  const state = { alerts: { sent: {} } };
  const notifications = [];
  const config = {
    notifications: {
      minimumAcceptableSeatsForTicketMessages: 1,
      healthAlertsBypassSeatMinimum: true,
    },
  };
  const alerts = [
    healthAlert("scheduler", "Scheduler stale."),
    healthAlert("timeout", "Checker timed out."),
  ];
  const sender = async (_config, text) => {
    sentTexts.push(text);
    return { sent: true, messageId: 42 };
  };
  const result = await dispatchHealthAlertBatch(
    config,
    state,
    alerts,
    false,
    notifications,
    { sender, now: new Date("2026-07-28T03:00:00Z") },
  );
  assert.equal(sentTexts.length, 1);
  assert.deepEqual(result.keys, alerts.map((alert) => alert.key));
  assert.equal(notifications.length, 1);
  assert.ok(state.alerts.sent[alerts[0].key]);
  assert.ok(state.alerts.sent[alerts[1].key]);

  await dispatchHealthAlertBatch(
    config,
    state,
    alerts,
    false,
    notifications,
    { sender, now: new Date("2026-07-28T03:01:00Z") },
  );
  assert.equal(sentTexts.length, 1);
  assert.equal(notifications.length, 1);
});

test("timeout-family cooldown suppresses new storms and counts timeout events", () => {
  const hardTimeout = healthAlert("hard-timeout:event-2", "Timed out.");
  const hung = healthAlert("checker-hung:200", "Checker is hung.");
  const state = {
    lastHardTimeoutFamilyAlertAt: "2026-07-28T02:00:00Z",
    suppressedHardTimeoutFamilyCount: 2,
  };
  const plan = timeoutFamilyPlan(state, [hung, hardTimeout], {
    hardTimeoutAlert: hardTimeout,
    hardTimeoutAt: "2026-07-28T02:59:00Z",
    now: new Date("2026-07-28T03:00:00Z"),
    cooldownMinutes: 120,
  });
  assert.equal(plan.cooldownActive, true);
  assert.equal(plan.allowedAlerts.length, 0);
  assert.equal(plan.suppressedCount, 3);
  assert.equal(plan.acknowledgeHardTimeout, true);
  assert.deepEqual(plan.suppressedKeys, [hung.key, hardTimeout.key]);
});

test("next timeout after cooldown includes the suppressed tally", () => {
  const hardTimeout = healthAlert("hard-timeout:event-3", "Timed out again.");
  const state = {
    lastHardTimeoutFamilyAlertAt: "2026-07-28T02:00:00Z",
    suppressedHardTimeoutFamilyCount: 4,
  };
  const plan = timeoutFamilyPlan(state, [hardTimeout], {
    hardTimeoutAlert: hardTimeout,
    hardTimeoutAt: "2026-07-28T04:01:00Z",
    now: new Date("2026-07-28T04:01:00Z"),
    cooldownMinutes: 120,
  });
  assert.equal(plan.cooldownActive, false);
  assert.equal(plan.allowedAlerts.length, 2);
  assert.match(plan.allowedAlerts[1].text, /4 further hard timeouts/);
});

test("recovery episode counts failed and hard-timeout runs before success", () => {
  const episode = latestRecoveryEpisode([
    {
      kind: "check",
      status: "success",
      finishedAt: "2026-07-28T00:00:00Z",
    },
    {
      kind: "check",
      status: "hard_timeout",
      startedAt: "2026-07-28T01:00:00Z",
    },
    {
      kind: "check",
      status: "failed",
      startedAt: "2026-07-28T01:30:00Z",
    },
    {
      kind: "check",
      status: "skipped_not_due",
      startedAt: "2026-07-28T01:45:00Z",
    },
    {
      kind: "check",
      status: "success",
      finishedAt: "2026-07-28T02:00:00Z",
    },
  ]);
  assert.equal(episode.count, 2);
  assert.equal(episode.hardTimeouts, 1);
  assert.equal(episode.failures, 1);
  assert.equal(episode.firstFailureAt, "2026-07-28T01:00:00Z");
  assert.equal(episode.recoveredAt, "2026-07-28T02:00:00Z");
});

test("recovery is not declared while the latest full check is failing", () => {
  assert.equal(
    latestRecoveryEpisode([
      { kind: "check", status: "hard_timeout" },
      { kind: "check", status: "failed" },
    ]),
    null,
  );
});

test("a successful check recovers a timeout streak even with a history gap", () => {
  const episode = latestRecoveryEpisode(
    [
      {
        kind: "check",
        status: "success",
        finishedAt: "2026-07-28T03:00:00Z",
      },
    ],
    {
      suppressedTimeouts: 3,
      fallbackFailureAt: "2026-07-28T01:00:00Z",
    },
  );
  assert.equal(episode.count, 3);
  assert.equal(episode.hardTimeouts, 3);
  assert.equal(episode.firstFailureAt, "2026-07-28T01:00:00Z");
});

test("a timeout streak is not recovered by an older successful check", () => {
  assert.equal(
    latestRecoveryEpisode(
      [
        {
          kind: "check",
          status: "success",
          finishedAt: "2026-07-28T00:30:00Z",
        },
      ],
      {
        suppressedTimeouts: 1,
        fallbackFailureAt: "2026-07-28T01:00:00Z",
      },
    ),
    null,
  );
});
