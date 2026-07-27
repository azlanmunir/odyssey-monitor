import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assessSeatData,
  officialDateUrl,
  readCodexBridge,
  requiresCodexSeatFreshness,
  summarizeSeatData,
} from "../src/lib/codex-bridge.mjs";

function sourceState(acceptable, field = "acceptable_seats_available") {
  return {
    snapshot: {
      checked_at: "2026-07-29T12:00:00-07:00",
      theaters: {
        regal_hacienda_crossings: {
          last_bookable_date: "2026-08-20",
          status: "available",
          format_label: "IMAX 70mm",
          official_url:
            "https://www.regmovies.com/theatres/regal-hacienda-crossings-0347",
          latest_date_showtimes: {
            "2026-08-20T11:20:00-07:00": {
              [field]: acceptable,
              seat_count_checked_at: "2026-07-29T11:55:00-07:00",
            },
          },
        },
      },
    },
  };
}

test("Codex new-date Telegram alert waits for one acceptable seat", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odyssey-bridge-"));
  const statePath = path.join(directory, "codex-state.json");
  const config = {
    paths: { codexState: statePath },
    notifications: {
      minimumAcceptableSeatsForTicketMessages: 1,
      pendingSeatVerificationEscalationMinutes: 60,
    },
  };
  const prior = {
    theaters: {
      regal_hacienda_crossings: {
        horizon: "2026-08-19",
      },
    },
    pendingNewDates: {},
  };
  try {
    await fs.writeFile(statePath, JSON.stringify(sourceState(0)));
    const unavailable = await readCodexBridge(
      config,
      prior,
      new Date("2026-07-29T19:00:00Z"),
    );
    assert.equal(unavailable.alerts.length, 0);
    assert.deepEqual(
      unavailable.bridge.pendingNewDates.regal_hacienda_crossings,
      {
        date: "2026-08-20",
        firstPendingAt: "2026-07-29T19:00:00.000Z",
      },
    );

    await fs.writeFile(statePath, JSON.stringify(sourceState(1)));
    const available = await readCodexBridge(
      config,
      unavailable.bridge,
      new Date("2026-07-29T19:30:00Z"),
    );
    assert.equal(available.alerts.length, 1);
    assert.equal(available.alerts[0].acceptableSeatCount, 1);
    assert.equal(available.bridge.pendingNewDates.regal_hacienda_crossings, undefined);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("automation acceptable_available schema reaches the Regal Telegram alert", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odyssey-bridge-schema-"));
  const statePath = path.join(directory, "codex-state.json");
  const config = {
    paths: { codexState: statePath },
    notifications: {
      minimumAcceptableSeatsForTicketMessages: 1,
      pendingSeatVerificationEscalationMinutes: 60,
    },
  };
  const prior = {
    theaters: {
      regal_hacienda_crossings: {
        horizon: "2026-08-19",
      },
    },
    pendingNewDates: {},
  };
  try {
    await fs.writeFile(
      statePath,
      JSON.stringify(sourceState(1, "acceptable_available")),
    );
    const result = await readCodexBridge(
      config,
      prior,
      new Date("2026-07-29T19:00:00Z"),
    );
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].acceptableSeatCount, 1);
    assert.equal(
      result.bridge.pendingNewDates.regal_hacienda_crossings,
      undefined,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pending Regal new date escalates after 60 minutes without claiming seat confirmation", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odyssey-bridge-pending-escalation-"),
  );
  const statePath = path.join(directory, "codex-state.json");
  const config = {
    paths: { codexState: statePath },
    notifications: {
      minimumAcceptableSeatsForTicketMessages: 1,
      pendingSeatVerificationEscalationMinutes: 60,
    },
  };
  const prior = {
    theaters: {
      regal_hacienda_crossings: {
        horizon: "2026-08-19",
      },
    },
    pendingNewDates: {},
  };
  try {
    await fs.writeFile(statePath, JSON.stringify(sourceState(null)));
    const detected = await readCodexBridge(
      config,
      prior,
      new Date("2026-07-29T19:00:00Z"),
    );
    assert.equal(detected.alerts.length, 0);

    const stillWaiting = await readCodexBridge(
      config,
      detected.bridge,
      new Date("2026-07-29T19:59:59Z"),
    );
    assert.equal(stillWaiting.alerts.length, 0);

    const escalated = await readCodexBridge(
      config,
      stillWaiting.bridge,
      new Date("2026-07-29T20:00:00Z"),
    );
    assert.equal(escalated.alerts.length, 1);
    assert.equal(escalated.alerts[0].tier, "HEALTH");
    assert.equal(escalated.alerts[0].requiresAcceptableSeat, false);
    assert.match(escalated.alerts[0].text, /seat inventory has remained unknown/i);
    assert.match(escalated.alerts[0].text, /not a seat-confirmed ticket alert/i);
    assert.match(
      escalated.alerts[0].text,
      /date=08-20-2026/,
    );
    assert.deepEqual(
      escalated.bridge.pendingNewDates.regal_hacienda_crossings,
      {
        date: "2026-08-20",
        firstPendingAt: "2026-07-29T19:00:00.000Z",
      },
    );

    const repeated = await readCodexBridge(
      config,
      escalated.bridge,
      new Date("2026-07-29T20:15:00Z"),
    );
    assert.equal(repeated.alerts[0].key, escalated.alerts[0].key);

    await fs.writeFile(statePath, JSON.stringify(sourceState(1)));
    const confirmed = await readCodexBridge(
      config,
      repeated.bridge,
      new Date("2026-07-29T20:30:00Z"),
    );
    assert.equal(confirmed.alerts.length, 1);
    assert.equal(confirmed.alerts[0].tier, "URGENT");
    assert.equal(
      confirmed.bridge.pendingNewDates.regal_hacienda_crossings,
      undefined,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("official date links use each chain's expected date format", () => {
  assert.equal(
    officialDateUrl(
      "regal_hacienda_crossings",
      "https://www.regmovies.com/theatres/regal-hacienda-crossings-0347",
      "2026-08-20",
    ),
    "https://www.regmovies.com/theatres/regal-hacienda-crossings-0347?date=08-20-2026",
  );
  assert.equal(
    officialDateUrl(
      "amc_metreon_16",
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16",
      "2026-08-20",
    ),
    "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16?date=2026-08-20",
  );
});

test("seat-data summary exposes the oldest and missing timestamps", () => {
  assert.deepEqual(
    summarizeSeatData({
      one: { seat_count_checked_at: "2026-07-29T12:00:00Z" },
      two: { seatMap: { checkedAt: "2026-07-29T13:00:00Z" } },
      three: {},
    }),
    {
      showtimeCount: 3,
      timestampedShowtimeCount: 2,
      missingTimestampCount: 1,
      oldestCheckedAt: "2026-07-29T12:00:00Z",
      newestCheckedAt: "2026-07-29T13:00:00Z",
    },
  );
});

test("venue seat data becomes unhealthy when any horizon showtime is stale", () => {
  const result = assessSeatData(
    {
      one: { seat_count_checked_at: "2026-07-28T12:00:00Z" },
      two: { seat_count_checked_at: "2026-07-29T11:00:00Z" },
    },
    1_440,
    new Date("2026-07-29T13:00:01Z"),
  );
  assert.equal(result.healthy, false);
  assert.equal(result.oldestCheckedAt, "2026-07-28T12:00:00Z");
  assert.ok(result.ageMinutes > 1_440);
});

test("Codex seat freshness governs Regal only because standalone AMC has its own clock", () => {
  assert.equal(requiresCodexSeatFreshness("regal_hacienda_crossings"), true);
  assert.equal(requiresCodexSeatFreshness("amc_metreon_16"), false);
});
