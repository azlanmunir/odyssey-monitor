import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSeatRows } from "../src/lib/seats.mjs";

const preferences = {
  excludedFrontRows: 3,
  excludeWheelchair: true,
  excludeCompanion: true,
  partySize: 2,
  urgentAcceptableSeatThreshold: 20,
};

function row(name, available, options = {}) {
  return {
    row: name,
    seats: Array.from({ length: available }, (_, index) => ({
      label: `${options.labelPrefix || "AMC Club Rocker"} ${name}${available - index}`,
      row: name,
      number: available - index,
      childIndex: index,
      available: true,
      wheelchair: options.wheelchair || false,
      companion: options.companion || false,
    })),
  };
}

test("acceptable counts exclude front rows and accessibility spaces", () => {
  const analysis = analyzeSeatRows(
    [
      row("A", 20),
      row("B", 15),
      row("C", 10),
      row("D", 0),
      row("N", 6, { labelPrefix: "Wheelchair", wheelchair: true }),
    ],
    preferences,
  );
  assert.equal(analysis.rawAvailable, 51);
  assert.equal(analysis.acceptableAvailable, 0);
  assert.equal(analysis.hasPartyBlock, false);
  assert.deepEqual(analysis.excludedFrontRows, ["A", "B", "C"]);
});
test("adjacency requires consecutive DOM positions and seat numbers", () => {
  const analysis = analyzeSeatRows(
    [
      row("A", 0),
      row("B", 0),
      row("C", 0),
      {
        row: "N",
        seats: [
          { label: "Seat N14", row: "N", number: 14, childIndex: 0, available: true },
          { label: "Seat N13", row: "N", number: 13, childIndex: 1, available: true },
          { label: "Seat N12", row: "N", number: 12, childIndex: 3, available: true },
          { label: "Companion N11", row: "N", number: 11, childIndex: 4, available: true, companion: true },
          { label: "Seat N10", row: "N", number: 10, childIndex: 5, available: true },
        ],
      },
    ],
    preferences,
  );
  assert.equal(analysis.acceptableAvailable, 4);
  assert.equal(analysis.largestAdjacentRun, 2);
  assert.equal(analysis.hasPartyBlock, true);
  assert.deepEqual(analysis.topSuggestions, ["N: N14–N13"]);
});

test("party adjacency stays disabled when party size is unknown", () => {
  const analysis = analyzeSeatRows(
    [row("A", 0), row("B", 0), row("C", 0), row("D", 3)],
    { ...preferences, partySize: null },
  );
  assert.equal(analysis.hasPartyBlock, null);
  assert.equal(analysis.largestAdjacentRun, 3);
});
