import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const STATE_PATH = path.join(DATA_DIR, "state.json");
export const RUNS_PATH = path.join(DATA_DIR, "runs.jsonl");
export const WATCHDOG_STATE_PATH = path.join(DATA_DIR, "watchdog-state.json");
export const WATCHDOG_RUNS_PATH = path.join(DATA_DIR, "watchdog-runs.jsonl");
export const HARD_TIMEOUT_PATH = path.join(DATA_DIR, "last-hard-timeout.json");
export const LOCK_PATH = path.join(DATA_DIR, "locks", "monitor.lock");
export const ENV_PATH = path.join(ROOT, ".env");
export const CONFIG_PATH = path.join(ROOT, "config.json");
