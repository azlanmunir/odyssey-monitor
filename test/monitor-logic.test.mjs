import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateConfirmationHealthAlert,
  digestAlert,
  newTrackedShowtimeAlert,
  recordCandidateConfirmationFailure,
  recordTrackedDateMissing,
  trackedBookableDates,
  trackedDateRetirementHealthAlert,
  trackedDateRetirementStatus,
} from "../src/lib/monitor.mjs";

function showtime(id, datetime, acceptableAvailable) {
  return {
    id,
    datetime,
    seatMap: {
      showtimeId: id,
      datetime,
      checkedAt: "2026-07-29T18:00:00Z",
      rawAvailable: acceptableAvailable + 5,
      acceptableAvailable,
    },
  };
}

test("all future bookable AMC dates remain actively tracked", () => {
  const state = {
    amc: {
      dates: {
        "2026-07-28": { status: "bookable", showtimes: { old: {} } },
        "2026-08-20": { status: "bookable", showtimes: { one: {} } },
        "2026-08-21": { status: "bookable", showtimes: { two: {} } },
        "2026-08-22": { status: "not_yet_listed", showtimes: {} },
      },
    },
  };
  assert.deepEqual(
    trackedBookableDates(state, "2026-08-21", "2026-07-29"),
    ["2026-08-20", "2026-08-21"],
  );
});

test("retired AMC dates with preserved historical showtimes are not actively tracked", () => {
  const state = {
    amc: {
      dates: {
        "2026-08-20": {
          status: "delisted",
          showtimes: { historical: {} },
        },
        "2026-08-21": {
          status: "sold_out",
          showtimes: { historical: {} },
        },
        "2026-08-22": {
          status: "bookable",
          showtimes: { active: {} },
        },
      },
    },
  };
  assert.deepEqual(
    trackedBookableDates(state, "2026-08-21", "2026-08-20"),
    ["2026-08-22"],
  );
});

test("an added showtime on a tracked date creates an URGENT after seat verification", () => {
  const added = {
    id: "new",
    datetime: "2026-08-20T18:00:00-07:00",
    bookingUrl: "https://www.amctheatres.com/showtimes/new/seats",
  };
  const alert = newTrackedShowtimeAlert(
    { showtimes: { existing: {} } },
    "2026-08-20",
    added,
    showtime("new", added.datetime, 8).seatMap,
  );
  assert.equal(alert?.tier, "URGENT");
  assert.equal(alert?.acceptableSeatCount, 8);
  assert.match(alert?.text, /NEW IMAX 70MM SHOWTIME/);
});

test("new-showtime alert is suppressed for baseline and unverified inventory", () => {
  const added = {
    id: "new",
    datetime: "2026-08-20T18:00:00-07:00",
  };
  const previous = { showtimes: { existing: {} } };
  assert.equal(
    newTrackedShowtimeAlert(previous, "2026-08-20", added, null),
    null,
  );
  assert.equal(
    newTrackedShowtimeAlert(
      previous,
      "2026-08-20",
      added,
      showtime("new", added.datetime, 8).seatMap,
      { baseline: true },
    ),
    null,
  );
});

test("a missing tracked date retires only after three double-read observations", () => {
  const state = {
    amc: { trackedDateMissingObservations: {} },
  };
  const config = {
    polling: { trackedDateMissingConfirmationThreshold: 3 },
  };
  const notListed = { soldOut: false };
  let observation;
  for (let count = 1; count <= 3; count += 1) {
    observation = recordTrackedDateMissing(
      state,
      "2026-08-20",
      notListed,
      notListed,
      new Date(`2026-07-29T1${count}:00:00Z`),
    );
    assert.equal(
      trackedDateRetirementStatus(observation, config),
      count === 3 ? "delisted" : null,
    );
  }
  const alert = trackedDateRetirementHealthAlert(
    "2026-08-20",
    observation,
    "delisted",
  );
  assert.match(alert.text, /two settled official reads/);
  assert.match(alert.text, /removed from active polling/);
});

test("a tracked date is called sold out only when both settled reads say so", () => {
  const config = {
    polling: { trackedDateMissingConfirmationThreshold: 3 },
  };
  assert.equal(
    trackedDateRetirementStatus(
      { count: 3, firstStatus: "sold_out", secondStatus: "sold_out" },
      config,
    ),
    "sold_out",
  );
  assert.equal(
    trackedDateRetirementStatus(
      { count: 3, firstStatus: "sold_out", secondStatus: "not_listed" },
      config,
    ),
    "delisted",
  );
});

test("daily digest includes acceptable seats from every tracked date", () => {
  const state = {
    lastDigestDate: null,
    amc: {
      horizon: "2026-08-21",
      dates: {
        "2026-08-20": {
          status: "bookable",
          showtimes: {
            one: showtime("one", "2026-08-20T18:00:00Z", 2),
          },
        },
        "2026-08-21": {
          status: "bookable",
          showtimes: {
            two: showtime("two", "2026-08-21T18:00:00Z", 3),
          },
        },
      },
    },
    codexBridge: {
      theaters: {
        regal_hacienda_crossings: { horizon: "2026-08-21" },
      },
    },
  };
  const config = {
    timezone: "America/Los_Angeles",
    notifications: {
      dailyDigestHour: 19,
      minimumAcceptableSeatsForTicketMessages: 1,
    },
  };
  const alert = digestAlert(
    state,
    config,
    new Date("2026-07-30T03:00:00Z"),
  );
  assert.equal(alert.acceptableSeatCount, 5);
  assert.match(alert.text, /2026-08-20, 2026-08-21/);
  assert.match(alert.text, /Aug 20/);
  assert.match(alert.text, /Aug 21/);
});

test("visible candidate becomes a HEALTH alert on the third failed confirmation", () => {
  const state = {
    amc: { candidateConfirmationFailures: {} },
  };
  const config = {
    polling: { candidateConfirmationFailureAlertThreshold: 3 },
  };
  const show = {
    id: "candidate",
    bookingUrl: "https://www.amctheatres.com/showtimes/candidate",
  };
  let failure;
  for (let count = 1; count <= 3; count += 1) {
    failure = recordCandidateConfirmationFailure(
      state,
      "2026-08-20",
      show,
      new Error("identity mismatch"),
      new Date(`2026-07-29T1${count}:00:00Z`),
    );
    const alert = candidateConfirmationHealthAlert(
      "2026-08-20",
      failure,
      config,
    );
    assert.equal(Boolean(alert), count === 3);
  }
  const alert = candidateConfirmationHealthAlert(
    "2026-08-20",
    failure,
    config,
  );
  assert.match(alert.text, /failed identity\/seat-map confirmation 3 consecutive times/);
  assert.match(alert.text, /amctheatres\.com\/showtimes\/candidate/);
});
