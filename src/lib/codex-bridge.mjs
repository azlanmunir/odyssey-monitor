import { readJson } from "./io.mjs";
import { acceptableSeatCount, codexNewDateAlert, healthAlert } from "./alerts.mjs";
import { minutesSince } from "./time.mjs";

const NAMES = {
  amc_metreon_16: "AMC Metreon 16",
  regal_hacienda_crossings: "Regal Hacienda Crossings",
};

export function requiresCodexSeatFreshness(venueKey) {
  return venueKey === "regal_hacienda_crossings";
}

export function officialDateUrl(venueKey, officialUrl, date) {
  if (!officialUrl || !date) return officialUrl || null;
  try {
    const url = new URL(officialUrl);
    if (venueKey === "regal_hacienda_crossings") {
      const [year, month, day] = date.split("-");
      url.searchParams.set("date", `${month}-${day}-${year}`);
    } else {
      url.searchParams.set("date", date);
    }
    return url.toString();
  } catch {
    return officialUrl;
  }
}

function pendingRecord(value, nowIso) {
  if (!value) return null;
  if (typeof value === "string") {
    return { date: value, firstPendingAt: nowIso };
  }
  if (typeof value === "object" && value.date) {
    return {
      date: value.date,
      firstPendingAt: value.firstPendingAt || nowIso,
    };
  }
  return null;
}

export function summarizeSeatData(showtimes = {}) {
  const records = Object.values(showtimes);
  const timestamps = records
    .map(
      (showtime) =>
        showtime?.seatMap?.checkedAt ??
        showtime?.seat_count_checked_at ??
        showtime?.seatCountCheckedAt ??
        null,
    )
    .filter((value) => value && !Number.isNaN(new Date(value).getTime()))
    .sort();
  return {
    showtimeCount: records.length,
    timestampedShowtimeCount: timestamps.length,
    missingTimestampCount: records.length - timestamps.length,
    oldestCheckedAt: timestamps[0] || null,
    newestCheckedAt: timestamps.at(-1) || null,
  };
}

export function assessSeatData(
  showtimes,
  limitMinutes,
  now = new Date(),
) {
  const summary = summarizeSeatData(showtimes);
  const ageMinutes = minutesSince(summary.oldestCheckedAt, now);
  return {
    ...summary,
    ageMinutes,
    limitMinutes,
    healthy:
      summary.showtimeCount > 0 &&
      summary.missingTimestampCount === 0 &&
      ageMinutes <= limitMinutes,
  };
}

export async function readCodexBridge(
  config,
  previousBridge = null,
  now = new Date(),
) {
  const source = await readJson(config.paths.codexState);
  if (!source?.snapshot) {
    const nowIso = now.toISOString();
    const unreadableSince =
      previousBridge?.status === "unreadable" && previousBridge.unreadableSince
        ? previousBridge.unreadableSince
        : nowIso;
    return {
      bridge: {
        status: "unreadable",
        checkedAt: nowIso,
        sourceCheckedAt: null,
        theaters: previousBridge?.theaters || {},
        pendingNewDates: previousBridge?.pendingNewDates || {},
        unreadableSince,
      },
      alerts: [
        healthAlert(
          `codex-state-unreadable:${unreadableSince}`,
          "The Codex state file is missing or invalid.",
        ),
      ],
    };
  }

  const snapshot = source.snapshot;
  const theaters = {};
  const alerts = [];
  const pendingNewDates = { ...(previousBridge?.pendingNewDates || {}) };
  const minimumAcceptable =
    config.notifications.minimumAcceptableSeatsForTicketMessages ?? 1;
  const pendingEscalationMinutes =
    config.notifications.pendingSeatVerificationEscalationMinutes ?? 60;
  const nowIso = now.toISOString();
  for (const [key, theater] of Object.entries(snapshot.theaters || {})) {
    const nextHorizon = theater.last_bookable_date || null;
    theaters[key] = {
      horizon: nextHorizon,
      status: theater.status || "unknown",
      formatLabel: theater.format_label || null,
      officialUrl: theater.official_url || null,
      officialDateUrl: officialDateUrl(key, theater.official_url, nextHorizon),
      latestDateShowtimes: theater.latest_date_showtimes || {},
    };
    theaters[key].seatData = summarizeSeatData(theaters[key].latestDateShowtimes);
    const priorHorizon = previousBridge?.theaters?.[key]?.horizon;
    let pending = pendingRecord(pendingNewDates[key], nowIso);
    if (priorHorizon && nextHorizon && nextHorizon > priorHorizon) {
      pending = { date: nextHorizon, firstPendingAt: nowIso };
      pendingNewDates[key] = pending;
    } else if (pending) {
      pendingNewDates[key] = pending;
    }
    const horizonShowtimes = Object.fromEntries(
      Object.entries(theaters[key].latestDateShowtimes).filter(([showtimeKey]) =>
        showtimeKey.startsWith(nextHorizon || ""),
      ),
    );
    const available = nextHorizon ? acceptableSeatCount(horizonShowtimes) : 0;
    if (
      pending &&
      pending.date === nextHorizon &&
      available >= minimumAcceptable
    ) {
      alerts.push(
        codexNewDateAlert(
          NAMES[key] || key,
          nextHorizon,
          theaters[key].officialDateUrl,
          available,
        ),
      );
      delete pendingNewDates[key];
    } else if (
      pending &&
      pending.date === nextHorizon &&
      minutesSince(pending.firstPendingAt, now) >= pendingEscalationMinutes
    ) {
      alerts.push(
        healthAlert(
          `new-date-seat-unverified:${key}:${nextHorizon}:${pending.firstPendingAt}`,
          `ACTION REQUIRED — CONFIRMED NEW IMAX 70MM DATE\n` +
            `${NAMES[key] || key}: ${nextHorizon}\n` +
            `The official listing is confirmed, but acceptable-seat inventory has remained unknown for at least ${pendingEscalationMinutes} minutes. This is not a seat-confirmed ticket alert. Check the official page manually now:\n` +
            `${theaters[key].officialDateUrl}`,
        ),
      );
    }
  }

  return {
    bridge: {
      status: "available",
      checkedAt: nowIso,
      sourceCheckedAt: snapshot.checked_at || null,
      theaters,
      pendingNewDates,
      consecutiveDaysNeitherListed: snapshot.consecutive_days_neither_theater_listed ?? null,
      failures: snapshot.site_failures_this_run || [],
      unreadableSince: null,
    },
    alerts,
  };
}
