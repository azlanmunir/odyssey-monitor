import test from "node:test";
import assert from "node:assert/strict";
import { requiredCheckIntervalMinutes } from "../src/lib/time.mjs";

const config = {
  polling: {
    normalMinutes: 120,
    wednesdayBurstMinutes: 15,
    wednesdayBurstStartHour: 9,
    wednesdayBurstEndHour: 18,
  },
};

test("uses 15-minute cadence during Wednesday Pacific posting window", () => {
  assert.equal(
    requiredCheckIntervalMinutes(config, new Date("2026-07-29T19:00:00Z")),
    15,
  );
});
test("uses normal cadence outside Wednesday posting window", () => {
  assert.equal(
    requiredCheckIntervalMinutes(config, new Date("2026-07-30T19:00:00Z")),
    120,
  );
});
