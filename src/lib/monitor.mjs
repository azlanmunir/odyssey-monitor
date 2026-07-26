import {
  amcListingUrl,
  openAmcBrowser,
  readAmcListing,
  readAmcSeatMap,
} from "./amc.mjs";
import {
  acceptableSeatCount,
  dedupeAlerts,
  healthAlert,
  newDateAlert,
  seatAlerts,
  telegramEligibleAlerts,
} from "./alerts.mjs";
import { assessSeatData, readCodexBridge } from "./codex-bridge.mjs";
import {
  appendJsonLine,
  readFileLockStatus,
  readJson,
  writeJsonAtomic,
} from "./io.mjs";
import {
  HARD_TIMEOUT_PATH,
  LOCK_PATH,
  RUNS_PATH,
  STATE_PATH,
  WATCHDOG_RUNS_PATH,
  WATCHDOG_STATE_PATH,
} from "./paths.mjs";
import {
  addDays,
  minutesSince,
  pacificDate,
  pacificParts,
  requiredCheckIntervalMinutes,
} from "./time.mjs";
import { sendTelegram } from "./telegram.mjs";

function initialState() {
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    lastInvocationAt: null,
    lastSuccessAt: null,
    lastAmcSuccessAt: null,
    lastAmcFailureAt: null,
    lastFullListingCheckAt: null,
    lastSeatRefreshAt: null,
    lastSeatSuccessAt: null,
    lastDigestDate: null,
    amc: {
      horizon: null,
      dates: {},
      consecutiveFailures: 0,
      failureOpen: false,
      failureGenerationAt: null,
      consecutivePartialChecks: 0,
      partialFailureGenerationAt: null,
      candidateConfirmationFailures: {},
    },
    codexBridge: null,
    alerts: { sent: {} },
  };
}

function initialWatchdogState() {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    lastHealthyPingDate: null,
    lastHardTimeoutAcknowledgedAt: null,
    alerts: { sent: {} },
  };
}

function showtimeMap(listing) {
  return Object.fromEntries(
    listing.showtimes.map((showtime) => [
      showtime.id,
      {
        ...showtime,
        date: listing.date,
        formatLabel: "IMAX 70MM",
        listingCheckedAt: listing.checkedAt,
      },
    ]),
  );
}

function mergeListing(state, listing) {
  const previous = state.amc.dates[listing.date] || {};
  const priorShowtimes = previous.showtimes || {};
  const nextShowtimes = showtimeMap(listing);
  return {
    date: listing.date,
    source: listing.source,
    officialUrl: listing.url,
    checkedAt: listing.checkedAt,
    moviePresent: listing.moviePresent,
    formatPresent: listing.formatPresent,
    status: listing.showtimes.length ? "bookable" : listing.soldOut ? "sold_out" : "not_yet_listed",
    showtimes: Object.fromEntries(
      Object.entries(nextShowtimes).map(([id, showtime]) => [
        id,
        { ...priorShowtimes[id], ...showtime, seatMap: priorShowtimes[id]?.seatMap || null },
      ]),
    ),
  };
}

function listingChanged(previous, listing) {
  const priorIds = Object.keys(previous?.showtimes || {}).sort();
  const nextIds = listing.showtimes.map((show) => show.id).sort();
  return JSON.stringify(priorIds) !== JSON.stringify(nextIds);
}

function showtimeSignature(listing) {
  return listing.showtimes.map((show) => `${show.id}:${show.datetime}`).sort().join("|");
}

export function trackedBookableDates(state, knownHorizon, today = pacificDate()) {
  const dates = Object.entries(state.amc?.dates || {})
    .filter(
      ([date, record]) =>
        date >= today &&
        (record?.status === "bookable" ||
          Object.keys(record?.showtimes || {}).length > 0),
    )
    .map(([date]) => date);
  if (knownHorizon && knownHorizon >= today) dates.push(knownHorizon);
  return [...new Set(dates)].sort();
}

function shouldRefreshSeats(state, config, force) {
  return (
    force ||
    minutesSince(state.lastSeatRefreshAt) >= config.polling.seatRefreshMinutes
  );
}

export function recordCandidateConfirmationFailure(
  state,
  date,
  showtime,
  error,
  now = new Date(),
) {
  state.amc.candidateConfirmationFailures ||= {};
  const previous = state.amc.candidateConfirmationFailures[date];
  const record = {
    count: (previous?.count || 0) + 1,
    firstSeenAt: previous?.firstSeenAt || now.toISOString(),
    lastFailureAt: now.toISOString(),
    showtimeId: showtime.id,
    officialUrl: showtime.bookingUrl || amcListingUrl(date),
    error: error.message,
  };
  state.amc.candidateConfirmationFailures[date] = record;
  return record;
}

export function candidateConfirmationHealthAlert(date, failure, config) {
  if (
    failure.count <
    config.polling.candidateConfirmationFailureAlertThreshold
  ) {
    return null;
  }
  return healthAlert(
    `candidate-unconfirmable:${date}:${failure.firstSeenAt}`,
    `AMC shows a potential IMAX 70MM date ${date}, but its official seat page has failed identity/seat-map confirmation ${failure.count} consecutive times. Fail-closed ticket alerting remains active. Check manually: ${failure.officialUrl}`,
  );
}

function attachVelocity(previous, current) {
  if (!previous?.checkedAt) return current;
  const hours = (new Date(current.checkedAt) - new Date(previous.checkedAt)) / 3_600_000;
  if (!(hours > 0)) return current;
  return {
    ...current,
    acceptableDelta: current.acceptableAvailable - previous.acceptableAvailable,
    acceptableVelocityPerHour:
      Math.round(((current.acceptableAvailable - previous.acceptableAvailable) / hours) * 10) / 10,
  };
}

async function refreshSeatMap(browser, state, date, showtime, config, alerts, failures) {
  const prior = state.amc.dates[date]?.showtimes?.[showtime.id]?.seatMap || null;
  try {
    const result = attachVelocity(prior, await readAmcSeatMap(browser, showtime, config));
    state.amc.dates[date].showtimes[showtime.id].seatMap = result;
    alerts.push(...seatAlerts(prior, result, config.seatPreferences));
    return result;
  } catch (error) {
    failures.push(`AMC seat map ${showtime.id}: ${error.message}`);
    return null;
  }
}

async function dispatchAlerts(config, state, alerts, dryRun, notificationResults) {
  const minimumAcceptable =
    config.notifications.minimumAcceptableSeatsForTicketMessages ?? 1;
  const eligible = telegramEligibleAlerts(
    alerts,
    minimumAcceptable,
    config.notifications.healthAlertsBypassSeatMinimum,
  );
  const unique = dedupeAlerts(eligible, state.alerts.sent);
  for (const alert of unique) {
    try {
      const result = await sendTelegram(config, alert.text, { dryRun });
      notificationResults.push({ key: alert.key, tier: alert.tier, ...result });
      if (result.sent) state.alerts.sent[alert.key] = new Date().toISOString();
    } catch (error) {
      notificationResults.push({ key: alert.key, tier: alert.tier, sent: false, error: error.message });
    }
  }
}

export function digestAlert(state, config, now) {
  const parts = pacificParts(now);
  const today = pacificDate(now);
  if (
    Number(parts.hour) < config.notifications.dailyDigestHour ||
    state.lastDigestDate === today
  ) {
    return null;
  }
  const horizon = state.amc.horizon;
  const minimumAcceptable =
    config.notifications.minimumAcceptableSeatsForTicketMessages ?? 1;
  const activeDates = trackedBookableDates(state, horizon, today);
  const showtimes = activeDates
    .flatMap((date) => Object.values(state.amc.dates[date]?.showtimes || {}))
    .filter(
      (show) => (show.seatMap?.acceptableAvailable || 0) >= minimumAcceptable,
    )
    .sort((left, right) => left.datetime.localeCompare(right.datetime));
  if (!showtimes.length) return null;
  const lines = showtimes.map((show) => {
    const localTime = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(show.datetime));
    const seats = show.seatMap;
    if (!seats) return `${localTime} — seat map not refreshed`;
    const velocity =
      seats.acceptableVelocityPerHour == null
        ? ""
        : `, ${seats.acceptableVelocityPerHour}/hour`;
    return `${localTime} — ${seats.acceptableAvailable} acceptable (${seats.rawAvailable} raw${velocity})`;
  });
  return {
    key: `digest:${today}`,
    tier: "DIGEST",
    requiresAcceptableSeat: true,
    acceptableSeatCount: showtimes.reduce(
      (total, showtime) => total + showtime.seatMap.acceptableAvailable,
      0,
    ),
    text:
      `DIGEST — ODYSSEY IMAX 70MM\n` +
      `AMC horizon: ${horizon || "unknown"}\n` +
      `Tracked AMC dates: ${activeDates.join(", ") || "none"}\n` +
      `${lines.length ? lines.join("\n") : "No fresh AMC seat counts."}\n` +
      `Regal horizon: ${state.codexBridge?.theaters?.regal_hacienda_crossings?.horizon || "unknown"}`,
  };
}

export async function runCheck(config, options = {}) {
  const now = new Date();
  const existing = await readJson(STATE_PATH);
  const state = existing || initialState();
  const run = {
    kind: "check",
    startedAt: now.toISOString(),
    finishedAt: null,
    status: "running",
    amcCheck: "not_started",
    intervalMinutes: requiredCheckIntervalMinutes(config, now),
    failures: [],
    changes: [],
    notifications: [],
  };
  state.lastInvocationAt = now.toISOString();

  try {
    const bridgeResult = await readCodexBridge(config, state.codexBridge);
    const bridgeAlerts = state.codexBridge ? bridgeResult.alerts : [];
    state.codexBridge = bridgeResult.bridge;
    await dispatchAlerts(config, state, bridgeAlerts, options.dryRun, run.notifications);

    const due =
      options.force ||
      minutesSince(state.lastFullListingCheckAt, now) >= run.intervalMinutes;
    if (!due) {
      run.status = "skipped_not_due";
      run.amcCheck = "skipped";
      const digest = digestAlert(state, config, now);
      if (digest) {
        await dispatchAlerts(config, state, [digest], options.dryRun, run.notifications);
        if (run.notifications.some((item) => item.key === digest.key && item.sent)) {
          state.lastDigestDate = pacificDate(now);
        }
      }
      state.lastSuccessAt = new Date().toISOString();
      return await finishRun(state, run);
    }

    const knownHorizon =
      state.amc.horizon ||
      state.codexBridge?.theaters?.amc_metreon_16?.horizon ||
      null;
    if (!knownHorizon) throw new Error("No AMC horizon is available to anchor the forward check");

    const browser = await openAmcBrowser();
    let fullCheckSucceeded = false;
    try {
      run.amcCheck = "running";
      const refreshSeats = shouldRefreshSeats(state, config, options.force);
      const alertCandidates = [];
      let refreshedAnySeat = false;
      const activeDates = trackedBookableDates(
        state,
        knownHorizon,
        pacificDate(now),
      );
      for (const date of activeDates) {
        const listing = await readAmcListing(browser, date, config);
        const previous = state.amc.dates[date] || null;
        const changed = listingChanged(previous, listing);
        if (!listing.showtimes.length) {
          const meaning = listing.soldOut ? "sold out" : "not currently listed";
          run.failures.push(
            `AMC tracked date ${date} is ${meaning}; prior data was preserved as stale.`,
          );
          continue;
        }

        if (changed) run.changes.push(`AMC showtime set changed on ${date}`);
        state.amc.dates[date] = mergeListing(state, listing);
        if (!state.amc.horizon || date > state.amc.horizon) {
          state.amc.horizon = date;
        }

        const hasWatchedShowtime = listing.showtimes.some((showtime) =>
          config.watch.showtimeIds.includes(showtime.id),
        );
        if (refreshSeats || changed || hasWatchedShowtime) {
          for (const showtime of listing.showtimes) {
            const watched = config.watch.showtimeIds.includes(showtime.id);
            const newShowtime = !previous?.showtimes?.[showtime.id];
            if (refreshSeats || watched || newShowtime) {
              const seatMap = await refreshSeatMap(
                browser,
                state,
                date,
                showtime,
                config,
                alertCandidates,
                run.failures,
              );
              refreshedAnySeat ||= Boolean(seatMap);
            }
          }
        }
      }
      if (refreshedAnySeat) {
        state.lastSeatRefreshAt = new Date().toISOString();
        state.lastSeatSuccessAt = state.lastSeatRefreshAt;
      }

      let candidateDate = addDays(state.amc.horizon || knownHorizon, 1);
      let addedAnyDate = false;
      for (let index = 0; index < 14; index += 1) {
        const first = await readAmcListing(browser, candidateDate, config);
        if (!first.showtimes.length) {
          state.amc.nextDateChecked = candidateDate;
          state.amc.nextDateStatus = first.soldOut ? "sold_out" : "not_yet_listed";
          delete state.amc.candidateConfirmationFailures?.[candidateDate];
          break;
        }
        const second = await readAmcListing(browser, candidateDate, config);
        if (showtimeSignature(first) !== showtimeSignature(second)) {
          run.failures.push(
            `AMC ${candidateDate} changed during the settled recheck; transient data discarded.`,
          );
          break;
        }

        const firstShow = second.showtimes[0];
        let confirmation;
        try {
          confirmation = await readAmcSeatMap(browser, firstShow, config);
        } catch (error) {
          const failure = recordCandidateConfirmationFailure(
            state,
            candidateDate,
            firstShow,
            error,
          );
          run.failures.push(`AMC ${candidateDate} could not be confirmed: ${error.message}`);
          const confirmationHealth = candidateConfirmationHealthAlert(
            candidateDate,
            failure,
            config,
          );
          if (confirmationHealth) alertCandidates.push(confirmationHealth);
          break;
        }
        delete state.amc.candidateConfirmationFailures?.[candidateDate];
        state.amc.dates[candidateDate] = mergeListing(state, second);
        state.amc.dates[candidateDate].showtimes[firstShow.id].seatMap = confirmation;
        refreshedAnySeat = true;
        state.amc.horizon = candidateDate;
        addedAnyDate = true;
        run.changes.push(`Confirmed new AMC IMAX 70MM date ${candidateDate}`);
        for (const showtime of second.showtimes.slice(1)) {
          const seatMap = await refreshSeatMap(
            browser,
            state,
            candidateDate,
            showtime,
            config,
            alertCandidates,
            run.failures,
          );
          refreshedAnySeat ||= Boolean(seatMap);
        }
        if (!options.baseline) {
          const storedShowtimes = state.amc.dates[candidateDate].showtimes;
          const available = acceptableSeatCount(storedShowtimes);
          const minimumAcceptable =
            config.notifications.minimumAcceptableSeatsForTicketMessages ?? 1;
          const eligibleConfirmation = Object.values(storedShowtimes)
            .map((showtime) => showtime.seatMap)
            .find((seatMap) => seatMap?.acceptableAvailable >= minimumAcceptable);
          if (available >= minimumAcceptable && eligibleConfirmation) {
            alertCandidates.push(
              newDateAlert(candidateDate, second.showtimes, eligibleConfirmation, available),
            );
          }
        }
        candidateDate = addDays(candidateDate, 1);
      }
      if (addedAnyDate && refreshedAnySeat) {
        state.lastSeatRefreshAt = new Date().toISOString();
        state.lastSeatSuccessAt = state.lastSeatRefreshAt;
      }

      await dispatchAlerts(config, state, alertCandidates, options.dryRun, run.notifications);
      state.lastFullListingCheckAt = new Date().toISOString();
      state.lastAmcSuccessAt = new Date().toISOString();
      state.amc.consecutiveFailures = 0;
      state.amc.failureOpen = false;
      state.amc.failureGenerationAt = null;
      fullCheckSucceeded = true;
      run.amcCheck = "success";
    } finally {
      await browser.close();
    }

    if (fullCheckSucceeded) {
      state.lastSuccessAt = new Date().toISOString();
      const digest = digestAlert(state, config, now);
      if (digest) {
        await dispatchAlerts(config, state, [digest], options.dryRun, run.notifications);
        if (run.notifications.some((item) => item.key === digest.key && item.sent)) {
          state.lastDigestDate = pacificDate(now);
        }
      }
    }
    run.status = run.failures.length ? "partial" : "success";
    if (run.status === "partial") {
      if (!(state.amc.consecutivePartialChecks > 0)) {
        state.amc.partialFailureGenerationAt = now.toISOString();
      }
      state.amc.consecutivePartialChecks =
        (state.amc.consecutivePartialChecks || 0) + 1;
      const activeCandidateFailure = Object.values(
        state.amc.candidateConfirmationFailures || {},
      ).some(
        (failure) =>
          failure.count >=
          config.polling.candidateConfirmationFailureAlertThreshold,
      );
      if (
        state.amc.consecutivePartialChecks >=
          config.polling.partialFailureAlertThreshold &&
        !activeCandidateFailure
      ) {
        const alert = healthAlert(
          `amc-repeated-partial:${state.amc.partialFailureGenerationAt}`,
          `AMC has completed ${state.amc.consecutivePartialChecks} consecutive partial checks. Listings may still be readable, but at least one required verification is repeatedly failing. Latest: ${run.failures.slice(-3).join("; ")} Official horizon: ${amcListingUrl(state.amc.horizon)}`,
        );
        await dispatchAlerts(
          config,
          state,
          [alert],
          options.dryRun,
          run.notifications,
        );
      }
    } else {
      state.amc.consecutivePartialChecks = 0;
      state.amc.partialFailureGenerationAt = null;
    }
  } catch (error) {
    state.lastAmcFailureAt = new Date().toISOString();
    if (!(state.amc.consecutiveFailures > 0)) {
      state.amc.failureGenerationAt = state.lastAmcFailureAt;
    }
    state.amc.consecutiveFailures = (state.amc.consecutiveFailures || 0) + 1;
    run.failures.push(error.message);
    run.amcCheck = "failed";
    run.status = "failed";
    if (state.amc.consecutiveFailures >= 2 && !state.amc.failureOpen) {
      const alert = healthAlert(
        `amc-repeated-failure:${state.amc.failureGenerationAt}`,
        `AMC has failed ${state.amc.consecutiveFailures} consecutive checks. Latest: ${error.message}`,
      );
      await dispatchAlerts(config, state, [alert], options.dryRun, run.notifications);
      if (run.notifications.some((item) => item.key === alert.key && item.sent)) {
        state.amc.failureOpen = true;
      }
    }
  }
  return finishRun(state, run);
}

async function finishRun(state, run) {
  state.updatedAt = new Date().toISOString();
  run.finishedAt = state.updatedAt;
  await writeJsonAtomic(STATE_PATH, state);
  await appendJsonLine(RUNS_PATH, run);
  return { state, run };
}

export async function runWatchdog(config, { dryRun = false } = {}) {
  const now = new Date();
  const state = (await readJson(STATE_PATH)) || initialState();
  const watchdogState =
    (await readJson(WATCHDOG_STATE_PATH)) || initialWatchdogState();
  const run = {
    kind: "watchdog",
    startedAt: now.toISOString(),
    status: "success",
    failures: [],
    notifications: [],
  };
  const alerts = [];
  const invocationLimit = config.polling.schedulerInvocationGraceMinutes;
  if (minutesSince(state.lastInvocationAt, now) > invocationLimit) {
    alerts.push(
      healthAlert(
        `scheduler-stale:${state.lastInvocationAt || "never"}`,
        `The local checker scheduler is stale. Last invocation: ${state.lastInvocationAt || "never"}; limit: ${invocationLimit} minutes.`,
      ),
    );
  }
  const ownLimit =
    requiredCheckIntervalMinutes(config, now) * config.polling.watchdogGraceMultiplier;
  if (minutesSince(state.lastAmcSuccessAt, now) > ownLimit) {
    alerts.push(
      healthAlert(
        `amc-stale:${state.lastAmcSuccessAt || "never"}`,
        `Standalone AMC checks are stale. Last success: ${state.lastAmcSuccessAt || "never"}; limit: ${Math.round(ownLimit)} minutes.`,
      ),
    );
  }
  const seatLimit =
    config.polling.seatRefreshMinutes * config.polling.watchdogGraceMultiplier;
  if (minutesSince(state.lastSeatSuccessAt || state.lastSeatRefreshAt, now) > seatLimit) {
    alerts.push(
      healthAlert(
        `seatmaps-stale:${state.lastSeatSuccessAt || state.lastSeatRefreshAt || "never"}`,
        `AMC seat-map reads are stale. Last success: ${state.lastSeatSuccessAt || state.lastSeatRefreshAt || "never"}; limit: ${Math.round(seatLimit)} minutes.`,
      ),
    );
  }
  const codexLimit =
    config.polling.codexHeartbeatMinutes * config.polling.watchdogGraceMultiplier;
  if (minutesSince(state.codexBridge?.sourceCheckedAt, now) > codexLimit) {
    alerts.push(
      healthAlert(
        `codex-stale:${state.codexBridge?.sourceCheckedAt || "never"}`,
        `Codex AMC/Regal state is stale. Last source check: ${state.codexBridge?.sourceCheckedAt || "never"}; limit: ${Math.round(codexLimit)} minutes.`,
      ),
    );
  }
  const venueSeatLimit = config.polling.venueSeatDataMaxAgeMinutes;
  for (const [venueKey, theater] of Object.entries(
    state.codexBridge?.theaters || {},
  )) {
    const showtimes = theater.latestDateShowtimes || {};
    if (
      !theater.horizon ||
      theater.status !== "available" ||
      Object.keys(showtimes).length === 0
    ) {
      continue;
    }
    const seatData = assessSeatData(showtimes, venueSeatLimit, now);
    if (seatData.healthy) continue;
    const venueName =
      venueKey === "amc_metreon_16"
        ? "AMC Metreon 16"
        : venueKey === "regal_hacienda_crossings"
          ? "Regal Hacienda Crossings"
          : venueKey;
    alerts.push(
      healthAlert(
        `venue-seat-data-stale:${venueKey}:${theater.horizon}:${seatData.oldestCheckedAt || "never"}`,
        `${venueName} ${theater.horizon} seat data is stale or incomplete. Oldest checked time: ${seatData.oldestCheckedAt || "never"}; ${seatData.missingTimestampCount} of ${seatData.showtimeCount} showtimes lack a seat-check timestamp; limit: ${venueSeatLimit} minutes.`,
      ),
    );
  }
  const lockStatus = await readFileLockStatus(LOCK_PATH);
  const maximumRuntimeMs = config.polling.maxCheckRuntimeMinutes * 60_000;
  if (lockStatus.exists && lockStatus.ageMs > maximumRuntimeMs) {
    alerts.push(
      healthAlert(
        `checker-hung:${lockStatus.ownerPid || "unknown"}`,
        `The AMC checker lock has been held for ${Math.round(lockStatus.ageMs / 60_000)} minutes; maximum expected runtime is ${config.polling.maxCheckRuntimeMinutes} minutes.`,
      ),
    );
  }
  const hardTimeout = await readJson(HARD_TIMEOUT_PATH);
  let hardTimeoutAlertKey = null;
  if (
    hardTimeout?.at &&
    hardTimeout.at !== watchdogState.lastHardTimeoutAcknowledgedAt
  ) {
    hardTimeoutAlertKey = `health:hard-timeout:${hardTimeout.at}`;
    alerts.push(
      healthAlert(
        `hard-timeout:${hardTimeout.at}`,
        `A local ${hardTimeout.command || "monitor"} process exceeded its ${hardTimeout.timeoutMinutes || config.polling.maxCheckRuntimeMinutes}-minute hard runtime limit at ${hardTimeout.at}.`,
      ),
    );
  }

  await dispatchAlerts(
    config,
    watchdogState,
    alerts,
    dryRun,
    run.notifications,
  );
  if (
    hardTimeoutAlertKey &&
    run.notifications.some(
      (item) => item.key === hardTimeoutAlertKey && item.sent,
    )
  ) {
    watchdogState.lastHardTimeoutAcknowledgedAt = hardTimeout.at;
  }

  const today = pacificDate(now);
  const parts = pacificParts(now);
  const healthy =
    alerts.length === 0 &&
    Number(parts.hour) >= config.notifications.dailyHealthOkHour &&
    watchdogState.lastHealthyPingDate !== today;
  if (healthy && config.notifications.dailyHealthOkEnabled) {
    const healthyAlert = healthAlert(
      `daily-ok:${today}`,
      `All monitoring paths are healthy. AMC last succeeded ${state.lastAmcSuccessAt}; Regal/Codex state last succeeded ${state.codexBridge?.sourceCheckedAt}.`,
    );
    await dispatchAlerts(
      config,
      watchdogState,
      [healthyAlert],
      dryRun,
      run.notifications,
    );
    if (
      run.notifications.some(
        (item) => item.key === healthyAlert.key && item.sent,
      )
    ) {
      watchdogState.lastHealthyPingDate = today;
    }
  }

  watchdogState.updatedAt = new Date().toISOString();
  run.finishedAt = watchdogState.updatedAt;
  await writeJsonAtomic(WATCHDOG_STATE_PATH, watchdogState);
  await appendJsonLine(WATCHDOG_RUNS_PATH, run);
  return { state, watchdogState, run };
}

export function describeRun(result) {
  const { state, run } = result;
  const horizon = state.amc.horizon || "unknown";
  const lines = [
    `${run.status.toUpperCase()} — AMC horizon ${horizon}`,
    `AMC check: ${run.amcCheck || "n/a"}`,
  ];
  if (run.changes?.length) lines.push(`Changes: ${run.changes.join("; ")}`);
  if (run.failures?.length) lines.push(`Failures: ${run.failures.join("; ")}`);
  if (run.notifications?.length) {
    lines.push(
      `Notifications: ${run.notifications
        .map((item) => `${item.tier}:${item.sent ? "sent" : item.reason || item.error || "not sent"}`)
        .join(", ")}`,
    );
  }
  lines.push(`Official: ${amcListingUrl(horizon)}`);
  return lines.join("\n");
}
