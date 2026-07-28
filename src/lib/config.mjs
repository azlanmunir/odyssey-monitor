import { CONFIG_PATH, ENV_PATH } from "./paths.mjs";
import { loadEnv, readJson } from "./io.mjs";

export async function loadConfig() {
  const config = await readJson(CONFIG_PATH);
  if (!config) throw new Error(`Missing config: ${CONFIG_PATH}`);
  validateConfig(config);
  const fileEnv = await loadEnv(ENV_PATH);
  return {
    ...config,
    secrets: {
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN || null,
      telegramChatId: process.env.TELEGRAM_CHAT_ID || fileEnv.TELEGRAM_CHAT_ID || null,
    },
  };
}

function validateConfig(config) {
  const preferences = config.seatPreferences;
  if (!preferences || !Number.isInteger(preferences.excludedFrontRows) || preferences.excludedFrontRows < 0) {
    throw new Error("seatPreferences.excludedFrontRows must be a non-negative integer");
  }
  if (
    preferences.partySize !== null &&
    (!Number.isInteger(preferences.partySize) || preferences.partySize < 1)
  ) {
    throw new Error("seatPreferences.partySize must be null or a positive integer");
  }
  if (
    !Number.isInteger(preferences.urgentAcceptableSeatThreshold) ||
    preferences.urgentAcceptableSeatThreshold < 1
  ) {
    throw new Error("seatPreferences.urgentAcceptableSeatThreshold must be a positive integer");
  }
  const minimum = config.notifications?.minimumAcceptableSeatsForTicketMessages;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error(
      "notifications.minimumAcceptableSeatsForTicketMessages must be a positive integer",
    );
  }
  if (config.notifications.healthAlertsBypassSeatMinimum !== true) {
    throw new Error(
      "notifications.healthAlertsBypassSeatMinimum must remain true so monitor failures cannot be silenced",
    );
  }
  if (
    !Number.isFinite(
      config.notifications.pendingSeatVerificationEscalationMinutes,
    ) ||
    config.notifications.pendingSeatVerificationEscalationMinutes < 15
  ) {
    throw new Error(
      "notifications.pendingSeatVerificationEscalationMinutes must be at least 15",
    );
  }
  if (
    !Number.isFinite(config.notifications.timeoutFamilyCooldownMinutes) ||
    config.notifications.timeoutFamilyCooldownMinutes < 30
  ) {
    throw new Error(
      "notifications.timeoutFamilyCooldownMinutes must be at least 30",
    );
  }
  if (
    !Number.isFinite(config.polling?.maxCheckRuntimeMinutes) ||
    config.polling.maxCheckRuntimeMinutes < 1
  ) {
    throw new Error("polling.maxCheckRuntimeMinutes must be at least 1");
  }
  if (
    !Number.isFinite(config.polling.schedulerInvocationGraceMinutes) ||
    config.polling.schedulerInvocationGraceMinutes <
      config.polling.wednesdayBurstMinutes * 2
  ) {
    throw new Error(
      "polling.schedulerInvocationGraceMinutes must allow at least two scheduler intervals",
    );
  }
  if (
    !Number.isFinite(config.polling.venueSeatDataMaxAgeMinutes) ||
    config.polling.venueSeatDataMaxAgeMinutes < config.polling.codexHeartbeatMinutes
  ) {
    throw new Error(
      "polling.venueSeatDataMaxAgeMinutes must be at least one Codex heartbeat interval",
    );
  }
  for (const field of [
    "partialFailureAlertThreshold",
    "candidateConfirmationFailureAlertThreshold",
    "trackedDateMissingConfirmationThreshold",
  ]) {
    if (!Number.isInteger(config.polling[field]) || config.polling[field] < 2) {
      throw new Error(`polling.${field} must be an integer of at least 2`);
    }
  }
  if (
    config.notifications.dailyHealthOkEnabled !== true ||
    !Number.isInteger(config.notifications.dailyHealthOkHour) ||
    config.notifications.dailyHealthOkHour < 0 ||
    config.notifications.dailyHealthOkHour > 23
  ) {
    throw new Error(
      "daily HEALTH OK must stay enabled with dailyHealthOkHour between 0 and 23",
    );
  }
}
