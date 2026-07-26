import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  extractAmcSeatRows,
  normalizedChromeUserAgent,
} from "../src/lib/amc.mjs";
import { analyzeSeatRows } from "../src/lib/seats.mjs";
import { ROOT } from "../src/lib/paths.mjs";

const fixture = path.join(ROOT, "data", "probe", "amc_seat_145377437.html");

test("AMC user agent matches the installed Chrome version without HeadlessChrome", () => {
  const userAgent = normalizedChromeUserAgent("150.0.1234.56");
  assert.match(userAgent, /Chrome\/150\.0\.1234\.56/);
  assert.doesNotMatch(userAgent, /HeadlessChrome/);
});

test(
  "captured AMC fixture yields zero acceptable non-accessible seats",
  { skip: !fs.existsSync(fixture), timeout: 30_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(fs.readFileSync(fixture, "utf8"), { waitUntil: "domcontentloaded" });
      const rows = (await extractAmcSeatRows(page)).filter((row) => row.seats.length);
      const analysis = analyzeSeatRows(rows, {
        excludedFrontRows: 6,
        excludeWheelchair: true,
        excludeCompanion: true,
        partySize: null,
      });
      assert.equal(analysis.rawAvailable, 51);
      assert.equal(analysis.acceptableAvailable, 0);
      assert.deepEqual(
        analysis.excludedFrontRows,
        ["A", "B", "C", "D", "E", "F"],
      );
      assert.deepEqual(
        analysis.rows.filter((row) => row.acceptableAvailable > 0),
        [],
      );
    } finally {
      await browser.close();
    }
  },
);
