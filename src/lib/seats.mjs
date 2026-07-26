const SPECIAL_WHEELCHAIR = /wheelchair/i;
const SPECIAL_COMPANION = /companion/i;

function normalizeSeat(raw, index) {
  const label = String(raw.label || raw.ariaLabel || "").trim();
  const match = label.match(/\b([A-Z]{1,3})(\d{1,3})\b/i);
  return {
    row: raw.row || match?.[1]?.toUpperCase() || null,
    number: Number.isFinite(raw.number) ? raw.number : Number(match?.[2] || NaN),
    label,
    available: Boolean(raw.available),
    childIndex: Number.isInteger(raw.childIndex) ? raw.childIndex : index,
    wheelchair: raw.wheelchair ?? SPECIAL_WHEELCHAIR.test(label),
    companion: raw.companion ?? SPECIAL_COMPANION.test(label),
  };
}
function qualifies(seat, rowIndex, preferences) {
  if (!seat.available || rowIndex < preferences.excludedFrontRows) return false;
  if (preferences.excludeWheelchair && seat.wheelchair) return false;
  if (preferences.excludeCompanion && seat.companion) return false;
  return true;
}

function contiguous(left, right) {
  return (
    right.childIndex === left.childIndex + 1 &&
    Number.isFinite(left.number) &&
    Number.isFinite(right.number) &&
    Math.abs(right.number - left.number) === 1
  );
}

export function analyzeSeatRows(rawRows, preferences) {
  const rows = rawRows.map((rawRow, rowIndex) => {
    const seats = (rawRow.seats || []).map(normalizeSeat);
    const rawAvailable = seats.filter((seat) => seat.available).length;
    const acceptableSeats = seats.filter((seat) => qualifies(seat, rowIndex, preferences));
    const runs = [];
    let current = [];

    for (const seat of seats) {
      if (!qualifies(seat, rowIndex, preferences)) {
        if (current.length) runs.push(current);
        current = [];
        continue;
      }
      if (current.length && !contiguous(current.at(-1), seat)) {
        runs.push(current);
        current = [];
      }
      current.push(seat);
    }
    if (current.length) runs.push(current);

    const rowName = rawRow.row || seats.find((seat) => seat.row)?.row || `row-${rowIndex + 1}`;
    return {
      row: rowName,
      rowIndex,
      excludedFrontRow: rowIndex < preferences.excludedFrontRows,
      rawAvailable,
      acceptableAvailable: acceptableSeats.length,
      availableLabels: acceptableSeats.map((seat) => seat.label),
      adjacentRuns: runs.map((run) => ({
        size: run.length,
        labels: run.map((seat) => seat.label),
        suggestion: `${rowName}: ${run[0].row || rowName}${run[0].number}–${run.at(-1).row || rowName}${run.at(-1).number}`,
      })),
    };
  });

  const allRuns = rows.flatMap((row) => row.adjacentRuns).sort((a, b) => b.size - a.size);
  const partySize = preferences.partySize;
  return {
    rawAvailable: rows.reduce((sum, row) => sum + row.rawAvailable, 0),
    acceptableAvailable: rows.reduce((sum, row) => sum + row.acceptableAvailable, 0),
    excludedFrontRows: rows.slice(0, preferences.excludedFrontRows).map((row) => row.row),
    rows,
    largestAdjacentRun: allRuns[0]?.size || 0,
    hasPartyBlock: partySize == null ? null : allRuns.some((run) => run.size >= partySize),
    topSuggestions: allRuns
      .filter((run) => partySize == null || run.size >= partySize)
      .slice(0, 3)
      .map((run) => run.suggestion),
  };
}
