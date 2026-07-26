function localShowtime(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function newDateAlert(date, showtimes, confirmation, acceptableCount) {
  const times = showtimes.map((show) => localShowtime(show.datetime)).join(", ");
  return {
    key: `urgent:new-date:amc:${date}`,
    tier: "URGENT",
    requiresAcceptableSeat: true,
    acceptableSeatCount: acceptableCount,
    text:
      `URGENT — NEW IMAX 70MM DATE\n` +
      `AMC Metreon 16: ${date}\n` +
      `Times: ${times}\n` +
      `${acceptableCount} acceptable seat${acceptableCount === 1 ? "" : "s"} across fresh official seat maps.\n` +
      `Official seat map verified (${confirmation.showtimeId}).\n` +
      `${confirmation.bookingUrl}`,
  };
}

export function seatAlerts(previous, current, preferences) {
  const alerts = [];
  if (!previous) return alerts;
  const threshold = preferences.urgentAcceptableSeatThreshold;
  const hasAcceptableSeat = current.acceptableAvailable >= 1;
  if (
    hasAcceptableSeat &&
    previous.acceptableAvailable > threshold &&
    current.acceptableAvailable <= threshold
  ) {
    alerts.push({
      key: `urgent:acceptable:${current.showtimeId}:${threshold}:${current.checkedAt || "unknown"}`,
      tier: "URGENT",
      requiresAcceptableSeat: true,
      acceptableSeatCount: current.acceptableAvailable,
      text:
        `URGENT — USABLE SEATS LOW\n` +
        `AMC Metreon 16, ${localShowtime(current.datetime)}\n` +
        `${current.acceptableAvailable} acceptable (${current.rawAvailable} raw); threshold ${threshold}.\n` +
        `${current.topSuggestions.length ? `Best blocks: ${current.topSuggestions.join("; ")}\n` : ""}` +
        `${current.bookingUrl}`,
    });
  }
  if (
    hasAcceptableSeat &&
    preferences.partySize != null &&
    previous.hasPartyBlock === true &&
    current.hasPartyBlock === false
  ) {
    alerts.push({
      key: `urgent:last-block:${current.showtimeId}:party-${preferences.partySize}:${current.checkedAt || "unknown"}`,
      tier: "URGENT",
      requiresAcceptableSeat: true,
      acceptableSeatCount: current.acceptableAvailable,
      text:
        `URGENT — LAST ADJACENT BLOCK GONE\n` +
        `AMC Metreon 16, ${localShowtime(current.datetime)}\n` +
        `No acceptable adjacent block for ${preferences.partySize} remains.\n` +
        `${current.bookingUrl}`,
    });
  }
  return alerts;
}

export function codexNewDateAlert(venueName, date, officialUrl, acceptableCount) {
  return {
    key: `urgent:new-date:codex:${venueName}:${date}`,
    tier: "URGENT",
    requiresAcceptableSeat: true,
    acceptableSeatCount: acceptableCount,
    text:
      `URGENT — NEW IMAX 70MM DATE\n` +
      `${venueName}: ${date}\n` +
      `${acceptableCount} acceptable seat${acceptableCount === 1 ? "" : "s"} confirmed.\n` +
      `Detected by the Codex official-site check; open the official page:\n${officialUrl}`,
  };
}

export function acceptableSeatCount(showtimes) {
  return Object.values(showtimes || {}).reduce((total, showtime) => {
    const count =
      showtime?.seatMap?.acceptableAvailable ??
      showtime?.acceptable_available ??
      showtime?.acceptable_seats_available ??
      showtime?.acceptableAvailable ??
      0;
    return total + (Number.isFinite(Number(count)) ? Number(count) : 0);
  }, 0);
}

export function healthAlert(key, message) {
  return {
    key: `health:${key}`,
    tier: "HEALTH",
    requiresAcceptableSeat: false,
    text: `HEALTH — ODYSSEY MONITOR\n${message}`,
  };
}

export function dedupeAlerts(alerts, sent = {}) {
  return alerts.filter((alert) => !sent[alert.key]);
}

export function telegramEligibleAlerts(
  alerts,
  minimumAcceptableSeats = 1,
  healthAlertsBypassSeatMinimum = true,
) {
  return alerts.filter((alert) => {
    if (alert.tier === "HEALTH") return healthAlertsBypassSeatMinimum;
    return (
      !alert.requiresAcceptableSeat ||
      alert.acceptableSeatCount >= minimumAcceptableSeats
    );
  });
}
