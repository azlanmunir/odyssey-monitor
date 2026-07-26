// One-off exploration tool: loads each theater page, captures the JSON the
// page fetches plus a settled DOM snapshot, and writes everything under
// data/probe/ so parser selectors can be designed against real payloads.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROBE_DIR = path.join(ROOT, "data", "probe");
const PROFILE_DIR = path.join(ROOT, "data", "browser-profile");

const TARGETS = [
  {
    key: "amc",
    url: "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    jsonMatch: /graph\.amctheatres\.com|\/api\/|showtimes/i,
  },
  {
    key: "regal",
    url: "https://www.regmovies.com/theatres/regal-hacienda-crossings-0347",
    jsonMatch: /getShowtimes|\/api\/|occupancy|showtime/i,
  },
];

const headless = !process.argv.includes("--headful");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless,
  channel: "chrome",
  viewport: { width: 1440, height: 950 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  args: ["--disable-blink-features=AutomationControlled"],
});

await fs.mkdir(PROBE_DIR, { recursive: true });

for (const target of TARGETS) {
  const page = await context.newPage();
  const captured = [];
  let counter = 0;

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const type = response.headers()["content-type"] || "";
      if (!type.includes("json") || !target.jsonMatch.test(url)) return;
      const body = await response.text();
      if (body.length < 50) return;
      counter += 1;
      const file = `${target.key}_res_${String(counter).padStart(2, "0")}.json`;
      captured.push({ file, url: url.slice(0, 300), status: response.status(), bytes: body.length });
      await fs.writeFile(path.join(PROBE_DIR, file), body);
    } catch {
      // response body may be unavailable after navigation; skip
    }
  });

  console.log(`[${target.key}] loading ${target.url}`);
  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(9000);
    const title = await page.title();
    const html = await page.content();
    await fs.writeFile(path.join(PROBE_DIR, `${target.key}_page.html`), html);
    await page.screenshot({ path: path.join(PROBE_DIR, `${target.key}_page.png`), fullPage: false });
    console.log(`[${target.key}] title: ${title}`);
    console.log(`[${target.key}] html bytes: ${html.length}, json responses: ${captured.length}`);
    for (const item of captured) console.log(`  ${item.file} <- [${item.status}] ${item.bytes}b ${item.url}`);
  } catch (error) {
    console.log(`[${target.key}] FAILED: ${error.message}`);
  }
  await page.close();
}

await context.close();
