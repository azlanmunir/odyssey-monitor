import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptableSeatCount,
  healthAlert,
  seatAlerts,
  telegramEligibleAlerts,
} from "../src/lib/alerts.mjs";

const preferences = {
  urgentAcceptableSeatThreshold: 20,
  partySize: 2,
};

function seatMap(overrides) {
  return {
    showtimeId: "123",
    datetime: "2026-08-19T18:00:00-07:00",
    bookingUrl: "https://www.amctheatres.com/showtimes/123/seats",
    rawAvailable: 50,
    acceptableAvailable: 21,
    hasPartyBlock: true,
    topSuggestions: ["N: N12–N13"],
    ...overrides,
  };
}

test("urgent threshold is based on acceptable seats, not raw seats", () => {
  const alerts = seatAlerts(
    seatMap({ acceptableAvailable: 21 }),
    seatMap({ rawAvailable: 49, acceptableAvailable: 20 }),
    preferences,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /20 acceptable \(49 raw\)/);
});

test("no repeated threshold alert when already below threshold", () => {
  const alerts = seatAlerts(
    seatMap({ acceptableAvailable: 20 }),
    seatMap({ acceptableAvailable: 19 }),
    preferences,
  );
  assert.equal(alerts.length, 0);
});

test("a recovered showtime can alert on a later threshold crossing", () => {
  const first = seatAlerts(
    seatMap({ acceptableAvailable: 21 }),
    seatMap({
      acceptableAvailable: 20,
      checkedAt: "2026-07-26T10:00:00Z",
    }),
    preferences,
  );
  const second = seatAlerts(
    seatMap({ acceptableAvailable: 21 }),
    seatMap({
      acceptableAvailable: 20,
      checkedAt: "2026-07-27T10:00:00Z",
    }),
    preferences,
  );
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].key, second[0].key);
});

test("acceptable seat count accepts the automation field name", () => {
  assert.equal(
    acceptableSeatCount({
      first: { acceptable_available: 2 },
      second: { acceptable_seats_available: 3 },
      third: { acceptableAvailable: 4 },
    }),
    9,
  );
});

test("last adjacent party block disappearing is urgent", () => {
  const alerts = seatAlerts(
    seatMap({ acceptableAvailable: 30, hasPartyBlock: true }),
    seatMap({ acceptableAvailable: 29, hasPartyBlock: false }),
    preferences,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /LAST ADJACENT BLOCK GONE/);
});

test("zero acceptable seats suppress ticket alerts", () => {
  const alerts = seatAlerts(
    seatMap({ acceptableAvailable: 21 }),
    seatMap({ acceptableAvailable: 0 }),
    preferences,
  );
  assert.equal(alerts.length, 0);
});

test("central Telegram gate preserves HEALTH alerts at zero seats", () => {
  const eligible = telegramEligibleAlerts(
    [
      {
        key: "ticket",
        tier: "URGENT",
        requiresAcceptableSeat: true,
        acceptableSeatCount: 0,
      },
      healthAlert("stale", "Monitor is stale."),
    ],
    1,
  );
  assert.deepEqual(eligible.map((alert) => alert.key), ["health:stale"]);
});
