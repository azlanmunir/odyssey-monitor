import { execFileSync } from "node:child_process";
import {
  assessSeatData,
  requiresCodexSeatFreshness,
} from "./codex-bridge.mjs";
import { readJson } from "./io.mjs";
import { STATE_PATH, WATCHDOG_STATE_PATH } from "./paths.mjs";
import { minutesSince } from "./time.mjs";

function launchAgent(label) {
  try {
    const domain = `gui/${process.getuid()}/${label}`;
    const output = execFileSync("/bin/launchctl", ["print", domain], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      loaded: true,
      state: output.match(/^\s*state = (.+)$/m)?.[1] || "unknown",
      runs: Number(output.match(/^\s*runs = (\d+)$/m)?.[1] || 0),
      lastExitCode:
        output.match(/^\s*last exit code = (.+)$/m)?.[1] || "unknown",
    };
  } catch {
    return { loaded: false, state: "unloaded", runs: 0, lastExitCode: "unknown" };
  }
}

function freshness(iso, limitMinutes, now) {
  const ageMinutes = Math.round(minutesSince(iso, now));
  return {
    at: iso || null,
    ageMinutes,
    limitMinutes: Math.round(limitMinutes),
    healthy: ageMinutes <= limitMinutes,
  };
}

export async function monitorStatus(config, now = new Date()) {
  const state = await readJson(STATE_PATH, {});
  const watchdog = await readJson(WATCHDOG_STATE_PATH, {});
  const grace = config.polling.watchdogGraceMultiplier;
  const checkerAgent = launchAgent("com.azlan.odyssey-monitor");
  const watchdogAgent = launchAgent("com.azlan.odyssey-monitor-watchdog");
  const scheduler = freshness(
    state.lastInvocationAt,
    config.polling.schedulerInvocationGraceMinutes,
    now,
  );
  const watchdogHeartbeat = freshness(
    watchdog.updatedAt,
    config.polling.schedulerInvocationGraceMinutes,
    now,
  );
  const amc = freshness(
    state.lastAmcSuccessAt,
    config.polling.normalMinutes * grace,
    now,
  );
  const seatMaps = freshness(
    state.lastSeatSuccessAt || state.lastSeatRefreshAt,
    config.polling.seatRefreshMinutes * grace,
    now,
  );
  const regalCodex = freshness(
    state.codexBridge?.sourceCheckedAt,
    config.polling.codexHeartbeatMinutes * grace,
    now,
  );
  const venueSeatData = Object.entries(state.codexBridge?.theaters || {})
    .filter(
      ([venueKey, theater]) =>
        requiresCodexSeatFreshness(venueKey) &&
        theater.horizon &&
        theater.status === "available" &&
        Object.keys(theater.latestDateShowtimes || {}).length > 0,
    )
    .map(([venueKey, theater]) => {
      const assessment = assessSeatData(
        theater.latestDateShowtimes,
        config.polling.venueSeatDataMaxAgeMinutes,
        now,
      );
      return {
        venueKey,
        horizon: theater.horizon,
        at: assessment.oldestCheckedAt,
        ageMinutes: Math.round(assessment.ageMinutes),
        limitMinutes: Math.round(assessment.limitMinutes),
        healthy: assessment.healthy,
        missingTimestampCount: assessment.missingTimestampCount,
        showtimeCount: assessment.showtimeCount,
      };
    });
  return {
    healthy:
      checkerAgent.loaded &&
      watchdogAgent.loaded &&
      checkerAgent.lastExitCode === "0" &&
      watchdogAgent.lastExitCode === "0" &&
      scheduler.healthy &&
      watchdogHeartbeat.healthy &&
      amc.healthy &&
      seatMaps.healthy &&
      regalCodex.healthy &&
      venueSeatData.every((value) => value.healthy),
    checkerAgent,
    watchdogAgent,
    scheduler,
    watchdogHeartbeat,
    amc,
    seatMaps,
    regalCodex,
    venueSeatData,
    lastDailyHealthOkDate: watchdog.lastHealthyPingDate || null,
  };
}

export function formatMonitorStatus(status) {
  const line = (name, value) =>
    `${name}: ${value.healthy ? "healthy" : "STALE"} — ${value.ageMinutes}m old (limit ${value.limitMinutes}m)`;
  const lines = [
    `OVERALL: ${status.healthy ? "HEALTHY" : "ATTENTION REQUIRED"}`,
    `Checker LaunchAgent: ${status.checkerAgent.loaded ? "loaded" : "UNLOADED"}; runs=${status.checkerAgent.runs}; last=${status.checkerAgent.lastExitCode}`,
    `Watchdog LaunchAgent: ${status.watchdogAgent.loaded ? "loaded" : "UNLOADED"}; runs=${status.watchdogAgent.runs}; last=${status.watchdogAgent.lastExitCode}`,
    line("Scheduler", status.scheduler),
    line("Independent watchdog", status.watchdogHeartbeat),
    line("AMC official check", status.amc),
    line("AMC seat maps", status.seatMaps),
    line("Regal/Codex", status.regalCodex),
  ];
  for (const venue of status.venueSeatData) {
    lines.push(
      `Venue seat data (${venue.venueKey}, ${venue.horizon}): ${venue.healthy ? "healthy" : "STALE"} — ${venue.ageMinutes}m old, ${venue.missingTimestampCount}/${venue.showtimeCount} timestamps missing (limit ${venue.limitMinutes}m)`,
    );
  }
  lines.push(`Last daily HEALTH OK: ${status.lastDailyHealthOkDate || "never"}`);
  return lines.join("\n");
}
