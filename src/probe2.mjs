// Probe round 2: AMC dated showtimes page, AMC seat-map page, Regal with long settle.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROBE_DIR = path.join(ROOT, "data", "probe");
const PROFILE_DIR = path.join(ROOT, "data", "browser-profile");
const headless = !process.argv.includes("--headful");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless,
  channel: "chrome",
  viewport: { width: 1440, height: 950 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  args: ["--disable-blink-features=AutomationControlled"],
});

async function snap(name, url, settleMs) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(settleMs);
    const title = await page.title();
    const html = await page.content();
    await fs.writeFile(path.join(PROBE_DIR, `${name}.html`), html);
    await page.screenshot({ path: path.join(PROBE_DIR, `${name}.png`) });
    console.log(`[${name}] "${title}" html=${html.length}b url_now=${page.url().slice(0, 120)}`);
  } catch (error) {
    console.log(`[${name}] FAILED: ${error.message}`);
  }
  await page.close();
}

await snap("amc_aug19", "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2026-08-19", 9000);
await snap("amc_seat_145377437", "https://www.amctheatres.com/showtimes/145377437", 10000);
await snap("regal_retry", "https://www.regmovies.com/theatres/regal-hacienda-crossings-0347", 25000);

await context.close();
