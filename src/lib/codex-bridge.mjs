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

export async function readCodexBridge(config, previousBridge = null) {
  const source = await readJson(config.paths.codexState);
  if (!source?.snapshot) {
    const now = new Date().toISOString();
    const unreadableSince =
      previousBridge?.status === "unreadable" && previousBridge.unreadableSince
        ? previousBridge.unreadableSince
        : now;
    return {
      bridge: {
        status: "unreadable",
        checkedAt: now,
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
  for (const [key, theater] of Object.entries(snapshot.theaters || {})) {
    theaters[key] = {
      horizon: theater.last_bookable_date || null,
      status: theater.status || "unknown",
      formatLabel: theater.format_label || null,
      officialUrl: theater.official_url || null,
      latestDateShowtimes: theater.latest_date_showtimes || {},
    };
    theaters[key].seatData = summarizeSeatData(theaters[key].latestDateShowtimes);
    const priorHorizon = previousBridge?.theaters?.[key]?.horizon;
    const nextHorizon = theaters[key].horizon;
    if (priorHorizon && nextHorizon && nextHorizon > priorHorizon) {
      pendingNewDates[key] = nextHorizon;
    }
    const horizonShowtimes = Object.fromEntries(
      Object.entries(theaters[key].latestDateShowtimes).filter(([showtimeKey]) =>
        showtimeKey.startsWith(nextHorizon || ""),
      ),
    );
    const available = nextHorizon ? acceptableSeatCount(horizonShowtimes) : 0;
    if (
      pendingNewDates[key] &&
      pendingNewDates[key] === nextHorizon &&
      available >= minimumAcceptable
    ) {
      alerts.push(
        codexNewDateAlert(
          NAMES[key] || key,
          nextHorizon,
          theaters[key].officialUrl,
          available,
        ),
      );
      delete pendingNewDates[key];
    }
  }

  return {
    bridge: {
      status: "available",
      checkedAt: new Date().toISOString(),
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
