import { chromium } from "playwright";
import { analyzeSeatRows } from "./seats.mjs";

const THEATRE_NAME = "AMC Metreon 16";
const THEATRE_SLUG = "san-francisco/amc-metreon-16";
const BASE = "https://www.amctheatres.com";

export function amcListingUrl(date) {
  return `${BASE}/movie-theatres/${THEATRE_SLUG}/showtimes?date=${date}`;
}

export function amcSeatUrl(showtimeId) {
  return `${BASE}/showtimes/${showtimeId}/seats`;
}

export async function openAmcBrowser() {
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export function normalizedChromeUserAgent(browserVersion) {
  const version = String(browserVersion || "").match(/\d+(?:\.\d+){0,3}/)?.[0];
  if (!version) return undefined;
  return (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${version} Safari/537.36`
  );
}

function amcPageOptions(browser, config) {
  return {
    viewport: { width: 1440, height: 950 },
    locale: "en-US",
    timezoneId: config.timezone,
    userAgent: normalizedChromeUserAgent(browser.version()),
  };
}

async function settledGoto(page, url, settleMs = 3_500) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(settleMs);
}

export async function readAmcListing(browser, date, config, { secondPass = false } = {}) {
  const page = await browser.newPage(amcPageOptions(browser, config));
  try {
    await settledGoto(page, amcListingUrl(date));
    const first = await extractListing(page, date, config);
    if (!secondPass) return first;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_500);
    const second = await extractListing(page, date, config);
    return {
      ...second,
      settledRecheck: true,
      transientMismatch: JSON.stringify(first.showtimes) !== JSON.stringify(second.showtimes),
    };
  } finally {
    await page.close();
  }
}

async function extractListing(page, date, config) {
  const result = await page.evaluate(
    ({ moviePath, requiredFormat }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const movieLink = [...document.querySelectorAll("a[href]")].find(
        (anchor) => new URL(anchor.href, location.href).pathname === moviePath,
      );
      const section =
        movieLink?.closest('section[aria-label^="Showtimes for"]') ||
        movieLink?.closest("section") ||
        null;
      const bodyText = normalize(document.body?.innerText);
      const blocked = /captcha|access denied|verify you are human|too many requests/i.test(bodyText);
      if (!section) {
        return {
          pageReadable: Boolean(document.body && bodyText.length > 100),
          blocked,
          moviePresent: false,
          formatPresent: false,
          showtimes: [],
          soldOut: false,
          pageTitle: document.title,
        };
      }

      const formatLabels = [...section.querySelectorAll("*")].filter(
        (element) =>
          element.children.length === 0 &&
          normalize(element.textContent).toUpperCase() === requiredFormat.toUpperCase(),
      );
      const anchors = new Map();
      for (const label of formatLabels) {
        let group = label.parentElement;
        while (group && group !== section) {
          const matches = [...group.querySelectorAll('a[href*="/showtimes/"]')];
          if (matches.length) {
            for (const anchor of matches) {
              const id = anchor.href.match(/\/showtimes\/(?:all\/[^/]+\/[^/]+\/[^/]+\/)?(\d+)/)?.[1];
              const time = anchor.querySelector("time");
              if (!id || !time?.dateTime) continue;
              anchors.set(id, {
                id,
                datetime: time.dateTime,
                label: normalize(anchor.innerText),
                bookingUrl: anchor.href,
                statusLabel: /almost full/i.test(anchor.innerText) ? "Almost Full" : null,
              });
            }
            break;
          }
          group = group.parentElement;
        }
      }
      const sectionText = normalize(section.innerText);
      return {
        pageReadable: true,
        blocked,
        moviePresent: true,
        formatPresent: formatLabels.length > 0,
        showtimes: [...anchors.values()].sort((a, b) => a.datetime.localeCompare(b.datetime)),
        soldOut: formatLabels.length > 0 && /sold out/i.test(sectionText) && anchors.size === 0,
        sectionText: sectionText.slice(0, 1_000),
        pageTitle: document.title,
      };
    },
    {
      moviePath: config.movie.amcMoviePath,
      requiredFormat: config.movie.requiredFormat,
    },
  );

  if (result.blocked) throw new Error(`AMC blocked or challenge page on ${date}`);
  if (!result.pageReadable) throw new Error(`AMC page did not render readable content on ${date}`);
  return {
    source: "AMC official",
    venue: THEATRE_NAME,
    date,
    url: amcListingUrl(date),
    checkedAt: new Date().toISOString(),
    ...result,
  };
}

function expectedLocalTime(iso, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function expectedLocalDate(iso, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function readAmcSeatMap(browser, showtime, config) {
  const page = await browser.newPage(amcPageOptions(browser, config));
  const url = amcSeatUrl(showtime.id);
  try {
    await settledGoto(page, url, 4_000);
    await page.locator('[role="grid"][aria-label="Seat Selection Map"]').waitFor({
      state: "attached",
      timeout: 30_000,
    });
    const evidence = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const ogUrl = document.querySelector('meta[property="og:url"]')?.content || "";
      const listItems = [...document.querySelectorAll("li")].map((item) => item.textContent?.trim());
      return { text, ogUrl, listItems };
    });

    const expectedDate = expectedLocalDate(showtime.datetime, config.timezone);
    const expectedTime = expectedLocalTime(showtime.datetime, config.timezone);
    const formatOkay = evidence.listItems.some(
      (item) => item?.toUpperCase() === config.movie.requiredFormat.toUpperCase(),
    );
    const venueOkay = evidence.listItems.includes(THEATRE_NAME) || evidence.text.includes(THEATRE_NAME);
    const idOkay = page.url().includes(showtime.id) || evidence.ogUrl.includes(showtime.id);
    const dateOkay = evidence.ogUrl.includes(`/${expectedDate}/`) || evidence.text.includes(longDate(showtime.datetime));
    const timeOkay = evidence.listItems.some((item) => item?.toLowerCase() === expectedTime);

    if (!formatOkay || !venueOkay || !idOkay || !dateOkay || !timeOkay) {
      throw new Error(
        `AMC seat-map identity mismatch for ${showtime.id} ` +
          `(format=${formatOkay}, venue=${venueOkay}, id=${idOkay}, date=${dateOkay}, time=${timeOkay})`,
      );
    }

    const rows = await extractAmcSeatRows(page);
    const nonEmptyRows = rows.filter((row) => row.seats.length);
    const analysis = analyzeSeatRows(nonEmptyRows, config.seatPreferences);
    return {
      showtimeId: showtime.id,
      datetime: showtime.datetime,
      bookingUrl: showtime.bookingUrl || url,
      seatMapUrl: url,
      source: "AMC official seat map",
      checkedAt: new Date().toISOString(),
      identityVerified: true,
      ...analysis,
    };
  } finally {
    await page.close();
  }
}

export async function extractAmcSeatRows(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('[role="grid"][aria-label="Seat Selection Map"]');
    if (!grid) throw new Error("AMC seat-selection grid was not found");
    return [...grid.querySelectorAll(':scope > [role="row"]')].map((row) => {
        const seats = [...row.children].flatMap((child, childIndex) => {
          const input = child.matches('input[type="checkbox"]')
            ? child
            : child.querySelector('input[type="checkbox"]');
          if (!input) return [];
          const label = input.getAttribute("aria-label") || "";
          const match = label.match(/\b([A-Z]{1,3})(\d{1,3})\b/i);
          return [
            {
              label,
              row: match?.[1]?.toUpperCase() || null,
              number: Number(match?.[2] || NaN),
              childIndex,
              available: !input.disabled && input.getAttribute("aria-disabled") !== "true",
              wheelchair: /wheelchair/i.test(label),
              companion: /companion/i.test(label),
            },
          ];
        });
        return { row: seats.find((seat) => seat.row)?.row || null, seats };
      });
  });
}

function longDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}
