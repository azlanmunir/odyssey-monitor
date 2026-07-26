const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export function pacificParts(date = new Date()) {
  return Object.fromEntries(PARTS.formatToParts(date).map(({ type, value }) => [type, value]));
}
export function pacificDate(date = new Date()) {
  const parts = pacificParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function pacificTimestamp(date = new Date()) {
  const parts = pacificParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} PT`;
}

export function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function minutesSince(iso, now = new Date()) {
  if (!iso) return Infinity;
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60_000);
}

export function requiredCheckIntervalMinutes(config, now = new Date()) {
  const parts = pacificParts(now);
  const hour = Number(parts.hour);
  const polling = config.polling;
  const inBurst =
    parts.weekday === "Wed" &&
    hour >= polling.wednesdayBurstStartHour &&
    hour < polling.wednesdayBurstEndHour;
  return inBurst ? polling.wednesdayBurstMinutes : polling.normalMinutes;
}
