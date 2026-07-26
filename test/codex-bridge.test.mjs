import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assessSeatData,
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
    notifications: { minimumAcceptableSeatsForTicketMessages: 1 },
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
    const unavailable = await readCodexBridge(config, prior);
    assert.equal(unavailable.alerts.length, 0);
    assert.equal(
      unavailable.bridge.pendingNewDates.regal_hacienda_crossings,
      "2026-08-20",
    );

    await fs.writeFile(statePath, JSON.stringify(sourceState(1)));
    const available = await readCodexBridge(config, unavailable.bridge);
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
    notifications: { minimumAcceptableSeatsForTicketMessages: 1 },
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
    const result = await readCodexBridge(config, prior);
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
