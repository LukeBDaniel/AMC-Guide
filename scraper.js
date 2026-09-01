const fs = require("fs");

// Cheerio 1.2's HTTP stack expects File to exist. GitHub Actions uses Node 20,
// but this small shim also keeps parser tests working on Node 18.
if (typeof global.File === "undefined") {
  global.File = class File {};
}

const cheerio = require("cheerio");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

const DEFAULT_DAYS = 14;
const DEFAULT_CONTENT_TIMEOUT_MS = 120000;
const DEFAULT_ADVANCE_TIMEOUT_MS = 45000;
const MAX_NAVIGATION_ATTEMPTS = 3;
const ADVANCE_RECHECK_DAYS = 7;
const ADVANCE_DAILY_THRESHOLD_DAYS = 21;
const ADVANCE_REMOVAL_MISSES = 2;
const SHOWTIME_SELECTOR = 'ul[aria-label="Showtime Group Results"] a';
const OUTPUT_PATHS = ["data.json", "frontend/public/data.json"];
const STATE_PATH = "scraper-state.json";
const ADVANCE_CATALOGS = [
  "https://www.amctheatres.com/movies?availability=COMING_SOON",
  "https://www.amctheatres.com/movies?availability=EVENTS",
];

const theaters = [
  { id: "amc-empire-25", location: "new-york" },
  { id: "amc-lincoln-square-13", location: "new-york" },
  { id: "amc-34th-street-14", location: "new-york" },
  { id: "amc-kips-bay-15", location: "new-york" },
  { id: "amc-magic-johnson-harlem-9", location: "new-york" },
  { id: "amc-84th-street-6", location: "new-york" },
  { id: "amc-orpheum-7", location: "new-york" },
  { id: "amc-19th-st-east-6", location: "new-york" },
  { id: "amc-village-7", location: "new-york" },
  { id: "amc-mountainside-10", location: "new-jersey" },
  { id: "amc-east-hanover-12", location: "new-jersey" },
  { id: "amc-aviation-12", location: "new-jersey" },
  { id: "amc-jersey-gardens-20", location: "new-jersey" },
  { id: "amc-clifton-commons-16", location: "new-jersey" },
  { id: "amc-newport-centre-11", location: "new-jersey" },
];

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getDates(days = DEFAULT_DAYS, now = new Date()) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dates.push(`${date.getFullYear()}-${month}-${day}`);
  }
  return dates;
}

function buildShowtimesUrl(theater, date) {
  return `https://www.amctheatres.com/movie-theatres/${theater.location}/${theater.id}/showtimes?date=${date}`;
}

function normalizeMoviePath(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://www.amctheatres.com");
    const match = url.pathname.match(
      /^(\/movies\/[^/]+?)(?:\/showtimes)?\/?$/i,
    );
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function buildMovieShowtimesUrl(moviePath, theater, date) {
  const url = new URL(
    `${normalizeMoviePath(moviePath)}/showtimes`,
    "https://www.amctheatres.com",
  );
  url.searchParams.set("theatre", theater.id);
  if (date) url.searchParams.set("date", date);
  return url.toString();
}

function parseAdvanceCatalogHtml(html) {
  const $ = cheerio.load(html);
  const candidates = new Map();

  $("a").each((_, anchorEl) => {
    const $anchor = $(anchorEl);
    const moviePath = normalizeMoviePath($anchor.attr("href"));
    if (!moviePath) return;

    let $container = $anchor.closest(
      'article, li, [data-testid*="card"], [class*="card"]',
    );
    if ($container.length === 0) {
      $container = $anchor;
      for (let depth = 0; depth < 3 && $container.parent().length; depth++) {
        const text = $container.text().replace(/\s+/g, " ").trim();
        if (/(?:advance|get)\s+tickets?\b/i.test(text)) break;
        if ($container.is("main, body")) break;
        $container = $container.parent();
      }
    }

    const containerText = $container.text().replace(/\s+/g, " ").trim();
    if (!/(?:advance|get)\s+tickets?\b/i.test(containerText)) return;

    const rawTitle =
      $anchor.attr("aria-label") ||
      $anchor.find("h2, h3, h4").first().text().trim() ||
      $anchor.text().replace(/\s+/g, " ").trim() ||
      moviePath.split("/").pop().replace(/-\d+$/, "").replace(/-/g, " ");
    const title = rawTitle
      .replace(/^Get(?: Advance)? Tickets? for\s+/i, "")
      .trim();
    const releaseDateMatch = containerText.match(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+20\d{2}/i,
    );

    const existing = candidates.get(moviePath);
    if (!existing || title.length > existing.title.length) {
      candidates.set(moviePath, {
        moviePath,
        title,
        releaseDateText: releaseDateMatch ? releaseDateMatch[0] : null,
      });
    }
  });

  return Array.from(candidates.values());
}

function parseReleaseDateText(value) {
  if (!value) return null;
  const match = value.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})$/i,
  );
  if (!match) return null;
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = String(months.indexOf(match[1].toLowerCase()) + 1).padStart(
    2,
    "0",
  );
  return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, "0")}`;
}

function getCandidateProbeDates(candidate, nearTermThrough) {
  const releaseDate = parseReleaseDateText(candidate.releaseDateText);
  if (!releaseDate) return [];
  const releaseNoon = new Date(`${releaseDate}T12:00:00Z`);
  return [-1, 0, 1, 2]
    .map((offset) => {
      const date = new Date(releaseNoon);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    })
    .filter((date) => date > nearTermThrough);
}

function findTheaterId($section, configuredTheaters) {
  const haystack = [
    $section.attr("id"),
    $section.attr("data-theatre"),
    $section
      .find('a[href*="/movie-theatres/"]')
      .map((_, el) => $section.find(el).attr("href"))
      .get()
      .join(" "),
    $section.text().slice(0, 500),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    configuredTheaters.find((theater) =>
      haystack.includes(theater.id.toLowerCase()),
    )?.id || null
  );
}

function parseMovieShowtimesHtml(html, candidate, date, configuredTheaters) {
  const $ = cheerio.load(html);
  const performances = new Map();
  const observedTheaters = new Set();

  $("section, article, [data-theatre], [data-theater]").each((_, sectionEl) => {
    const $section = $(sectionEl);
    const theaterId = findTheaterId($section, configuredTheaters);
    if (!theaterId) return;
    observedTheaters.add(theaterId);

    const metadataText = $("main").find("ul").first().text();
    const runtimeMatch = metadataText.match(/\b\d+\s*HR(?:\s*\d+\s*MIN)?\b/i);
    const ratingNode = $("main")
      .find('span[aria-label^="MPAA Rating"]')
      .first();

    $section
      .find(
        'li[role="listitem"][aria-label$="Showtimes"], [aria-label$="Showtimes"]',
      )
      .each((__, formatEl) => {
        const $format = $(formatEl);
        const ariaLabel = $format.attr("aria-label") || "";
        const formatName =
          $format.find("h3 span, h4 span").first().text().trim() ||
          ariaLabel.replace(/ Showtimes$/, "");
        const attributes = [];
        $format.find('ul[id$="-attributes"] li').each((___, liEl) => {
          const text = $(liEl).text().replace(/\s+/g, " ").trim();
          if (text) attributes.push(text);
        });
        const formats = Array.from(
          new Set([formatName, ...attributes].filter(Boolean)),
        );

        $format
          .find(
            'ul[aria-label="Showtime Group Results"] a, a[href*="/showtimes/"]',
          )
          .each((___, timeEl) => {
            const $time = $(timeEl);
            const time =
              $time.find("time").first().text().trim() ||
              $time.clone().children().remove().end().text().trim();
            if (!time || !/\d/.test(time)) return;
            const href = $time.attr("href") || "";
            const performanceId =
              href.match(/\/showtimes\/([^/?#]+)/i)?.[1] || null;
            const fallbackKey = `${theaterId}|${candidate.moviePath}|${date}|${time}|${formats.join("|")}`;
            const key = performanceId || fallbackKey;
            const existing = performances.get(key);
            if (existing) {
              existing.formats = Array.from(
                new Set([...existing.formats, ...formats]),
              );
              return;
            }
            performances.set(key, {
              key,
              performanceId,
              theaterId,
              date,
              time,
              alert: $time.find("span.sr-only").first().text().trim() || null,
              formats,
              movie: {
                title: candidate.title,
                link: candidate.moviePath,
                runtime: runtimeMatch ? runtimeMatch[0] : null,
                rating: ratingNode.length ? ratingNode.text().trim() : null,
              },
            });
          });
      });
  });

  return {
    performances: Array.from(performances.values()),
    observedTheaters: Array.from(observedTheaters),
  };
}

function parseScheduleHtml(mainHtml, date) {
  const $ = cheerio.load(mainHtml);
  const dailyData = { date, movies: [] };

  $("section[id]").each((_, sectionEl) => {
    const $section = $(sectionEl);
    const titleNode = $section.find("h1 a").first();
    if (titleNode.length === 0) return;

    const metadataList = $section.find("ul").first().find("li span.uppercase");
    const ratingNode = $section.find('span[aria-label^="MPAA Rating"]');
    const movieObj = {
      title: titleNode.text().trim(),
      link: titleNode.attr("href"),
      runtime: metadataList.eq(0).text().trim() || null,
      rating: ratingNode.length ? ratingNode.text().trim() : null,
      formats: [],
    };

    $section
      .find('li[role="listitem"][aria-label$="Showtimes"]')
      .each((__, formatEl) => {
        const $format = $(formatEl);
        const ariaLabel = $format.attr("aria-label") || "";
        const formatName =
          $format.find("h3 span").first().text().trim() ||
          ariaLabel.replace(/ Showtimes$/, "");
        const additionalTags = [];

        $format.find('ul[id$="-attributes"] li').each((___, liEl) => {
          const text = $(liEl).text().trim();
          if (text) additionalTags.push(text);
        });

        const showtimes = [];
        $format
          .find('ul[aria-label="Showtime Group Results"] a')
          .each((___, timeEl) => {
            const $time = $(timeEl);
            let time = $time.find("time").text().trim();
            if (!time) {
              time = $time
                .contents()
                .filter(function filterTextNodes() {
                  return this.nodeType === 3;
                })
                .text()
                .trim();
            }

            if (!time) return;
            const timeLink = $time.attr("href");
            const alertNode = $time.find("span.sr-only");
            showtimes.push({
              time,
              performanceId: timeLink ? timeLink.split("/").pop() : null,
              alert: alertNode.length ? alertNode.text().trim() : null,
            });
          });

        if (showtimes.length > 0) {
          movieObj.formats.push({
            formats: Array.from(
              new Set([formatName, ...additionalTags].filter(Boolean)),
            ),
            showtimes,
          });
        }
      });

    // A movie header can render before its showtime groups. Do not treat that
    // intermediate DOM state as successfully scraped data.
    if (movieObj.formats.length > 0) dailyData.movies.push(movieObj);
  });

  return dailyData;
}

function inspectScheduleHtml(mainHtml) {
  const $ = cheerio.load(mainHtml);
  const totalShowtimeLinks = $(SHOWTIME_SELECTOR).length;
  const nestedShowtimeLinks = $(`section[id] ${SHOWTIME_SELECTOR}`).length;
  const parsed = parseScheduleHtml(mainHtml, null);
  const parsedShowtimes = parsed.movies.reduce(
    (count, movie) =>
      count +
      movie.formats.reduce(
        (formatCount, format) => formatCount + format.showtimes.length,
        0,
      ),
    0,
  );

  return {
    ready:
      totalShowtimeLinks > 0 &&
      nestedShowtimeLinks === totalShowtimeLinks &&
      parsed.movies.length > 0 &&
      parsedShowtimes > 0,
    totalShowtimeLinks,
    nestedShowtimeLinks,
    parsedMovies: parsed.movies.length,
    parsedShowtimes,
  };
}

function getScheduleStats(schedule) {
  let days = 0;
  let movies = 0;
  let showtimes = 0;

  for (const theater of Object.values(schedule.theaters || {})) {
    for (const day of theater.schedule || []) {
      days++;
      movies += day.movies.length;
      for (const movie of day.movies) {
        for (const format of movie.formats)
          showtimes += format.showtimes.length;
      }
    }
  }

  return { days, movies, showtimes };
}

function validateSchedule(schedule, expectedTheaters, expectedDates) {
  const errors = [];
  const theaterEntries = Object.entries(schedule.theaters || {});

  if (theaterEntries.length !== expectedTheaters.length) {
    errors.push(
      `expected ${expectedTheaters.length} theaters, got ${theaterEntries.length}`,
    );
  }

  for (const theater of expectedTheaters) {
    const result = schedule.theaters?.[theater.id];
    if (!result) {
      errors.push(`${theater.id}: missing theater result`);
      continue;
    }
    if (result.schedule.length !== expectedDates.length) {
      errors.push(
        `${theater.id}: expected ${expectedDates.length} days, got ${result.schedule.length}`,
      );
    }

    const returnedDates = new Set(result.schedule.map((day) => day.date));
    for (const date of expectedDates) {
      if (!returnedDates.has(date))
        errors.push(`${theater.id} ${date}: missing result`);
    }

    for (const day of result.schedule) {
      const dayShowtimes = day.movies.reduce(
        (count, movie) =>
          count +
          movie.formats.reduce(
            (formatCount, format) => formatCount + format.showtimes.length,
            0,
          ),
        0,
      );
      if (day.movies.length === 0 || dayShowtimes === 0) {
        errors.push(`${theater.id} ${day.date}: no usable movie/showtime data`);
      }
    }
  }

  const stats = getScheduleStats(schedule);
  if (stats.movies === 0 || stats.showtimes === 0) {
    errors.push("the complete scrape contains no usable data");
  }

  if (errors.length > 0) {
    throw new Error(
      `Scrape validation failed; existing data files were preserved:\n- ${errors.join("\n- ")}`,
    );
  }

  return stats;
}

function emptyScraperState() {
  return { version: 1, updatedAt: null, candidates: {}, performances: {} };
}

function loadScraperState(statePath = STATE_PATH) {
  if (!fs.existsSync(statePath)) return emptyScraperState();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed.version !== 1 || !parsed.candidates || !parsed.performances) {
      throw new Error("unsupported or incomplete state schema");
    }
    return parsed;
  } catch (error) {
    console.warn(
      `Could not load ${statePath}; starting with empty advance state: ${error.message}`,
    );
    return emptyScraperState();
  }
}

function daysBetween(dateA, dateB) {
  return Math.floor(
    (new Date(`${dateA}T12:00:00Z`) - new Date(`${dateB}T12:00:00Z`)) /
      86400000,
  );
}

function isCandidateDue(candidate, state, today, nowMs = Date.now()) {
  if (
    !candidate.lastSuccessfulCheckAt ||
    candidate.status === "pending" ||
    candidate.status === "error"
  )
    return true;
  const candidatePerformances = Object.values(state.performances).filter(
    (performance) => performance.movie?.link === candidate.moviePath,
  );
  const earliestDate = candidatePerformances
    .map((performance) => performance.date)
    .sort()[0];
  const intervalDays =
    earliestDate &&
    daysBetween(earliestDate, today) <= ADVANCE_DAILY_THRESHOLD_DAYS
      ? 1
      : ADVANCE_RECHECK_DAYS;
  return (
    nowMs - new Date(candidate.lastSuccessfulCheckAt).getTime() >=
    intervalDays * 86400000
  );
}

function updateCandidatePerformances(
  state,
  candidate,
  performances,
  checkedAt,
  nearTermThrough,
) {
  const seenKeys = new Set();

  for (const performance of performances) {
    if (performance.date <= nearTermThrough) continue;
    const key = performance.performanceId || performance.key;
    seenKeys.add(key);
    state.performances[key] = {
      ...performance,
      key,
      firstSeenAt: state.performances[key]?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
      missCount: 0,
    };
  }

  for (const [key, performance] of Object.entries(state.performances)) {
    if (
      performance.movie?.link !== candidate.moviePath ||
      performance.date <= nearTermThrough
    )
      continue;
    if (seenKeys.has(key)) continue;
    performance.missCount = (performance.missCount || 0) + 1;
    if (performance.missCount >= ADVANCE_REMOVAL_MISSES)
      delete state.performances[key];
  }
}

function cleanAdvanceState(state, today, nearTermThrough) {
  for (const [key, performance] of Object.entries(state.performances)) {
    if (
      !performance.date ||
      performance.date < today ||
      performance.date <= nearTermThrough
    ) {
      delete state.performances[key];
    }
  }
}

function mergeAdvanceSchedule(
  nearTermSchedule,
  state,
  configuredTheaters,
  nearTermThrough,
) {
  const configuredById = new Map(
    configuredTheaters.map((theater) => [theater.id, theater]),
  );
  const dayMaps = new Map();

  for (const [theaterId, theaterData] of Object.entries(
    nearTermSchedule.theaters,
  )) {
    dayMaps.set(
      theaterId,
      new Map(theaterData.schedule.map((day) => [day.date, day])),
    );
  }

  for (const performance of Object.values(state.performances)) {
    if (
      performance.date <= nearTermThrough ||
      !configuredById.has(performance.theaterId)
    )
      continue;
    const theaterData = nearTermSchedule.theaters[performance.theaterId];
    if (!theaterData) continue;
    const theaterDays = dayMaps.get(performance.theaterId);
    if (!theaterDays.has(performance.date)) {
      const day = { date: performance.date, movies: [] };
      theaterDays.set(performance.date, day);
      theaterData.schedule.push(day);
    }

    const day = theaterDays.get(performance.date);
    let movie = day.movies.find(
      (item) =>
        item.link === performance.movie.link ||
        item.title === performance.movie.title,
    );
    if (!movie) {
      movie = { ...performance.movie, formats: [] };
      day.movies.push(movie);
    }

    const formatNames = Array.from(
      new Set((performance.formats || ["Standard"]).filter(Boolean)),
    ).sort();
    let format = movie.formats.find((item) => {
      const existing = Array.from(new Set(item.formats || [item.format]))
        .filter(Boolean)
        .sort();
      return JSON.stringify(existing) === JSON.stringify(formatNames);
    });
    if (!format) {
      format = {
        formats: formatNames.length ? formatNames : ["Standard"],
        showtimes: [],
      };
      movie.formats.push(format);
    }
    if (
      !format.showtimes.some((showtime) =>
        performance.performanceId
          ? showtime.performanceId === performance.performanceId
          : showtime.time === performance.time,
      )
    ) {
      format.showtimes.push({
        time: performance.time,
        performanceId: performance.performanceId,
        alert: performance.alert || null,
      });
    }
  }

  Object.values(nearTermSchedule.theaters).forEach((theaterData) => {
    theaterData.schedule.sort((a, b) => a.date.localeCompare(b.date));
  });
  nearTermSchedule.nearTermThrough = nearTermThrough;
  return nearTermSchedule;
}

function validateAdvanceState(state, configuredTheaters, nearTermThrough) {
  const configuredIds = new Set(
    configuredTheaters.map((theater) => theater.id),
  );
  const errors = [];
  for (const [key, performance] of Object.entries(state.performances)) {
    if (!configuredIds.has(performance.theaterId))
      errors.push(`${key}: unknown theater`);
    if (!performance.date || performance.date <= nearTermThrough)
      errors.push(`${key}: date is not beyond near-term window`);
    if (!performance.movie?.title || !performance.movie?.link)
      errors.push(`${key}: missing movie metadata`);
    if (!performance.time) errors.push(`${key}: missing time`);
    if (!Array.isArray(performance.formats) || performance.formats.length === 0)
      errors.push(`${key}: missing formats`);
  }
  if (errors.length)
    throw new Error(
      `Advance state validation failed:\n- ${errors.join("\n- ")}`,
    );
  return {
    candidates: Object.keys(state.candidates).length,
    performances: Object.keys(state.performances).length,
  };
}

async function waitForShowtimesHtml(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let nextProgressLog = Date.now() + 30000;
  let lastInspection = null;

  while (Date.now() < deadline) {
    try {
      // AMC streams showtime groups into hidden staging nodes before React
      // attaches them to their movie sections. Capture the DOM atomically,
      // then verify that every detected showtime link has reached the hierarchy
      // expected by parseScheduleHtml.
      const snapshot = await page.evaluate((selector) => {
        if (!document.querySelector(selector)) return null;
        const main = document.querySelector("main");
        return {
          html: main ? main.innerHTML : document.body.innerHTML,
          documentReady: document.readyState === "complete",
        };
      }, SHOWTIME_SELECTOR);
      if (snapshot?.html) {
        lastInspection = inspectScheduleHtml(snapshot.html);
        if (snapshot.documentReady && lastInspection.ready)
          return snapshot.html;
      }
    } catch (_) {
      // Navigation can replace the execution context while Queue-it returns
      // the visitor to AMC. Poll again until the overall timeout expires.
    }

    if (Date.now() >= nextProgressLog) {
      console.log(`Still waiting for AMC showtime content (${page.url()})...`);
      nextProgressLog += 30000;
    }
    await page.waitForTimeout(1000);
  }

  const diagnostic = await page
    .evaluate(() => ({
      title: document.title,
      text: document.body?.innerText?.slice(0, 300) || "",
    }))
    .catch(() => ({ title: "", text: "" }));
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for showtimes. ` +
      `Final URL: ${page.url()}; title: ${diagnostic.title}; ` +
      `DOM stats: ${JSON.stringify(lastInspection)}; page text: ${diagnostic.text}`,
  );
}

async function loadShowtimesHtml(page, theater, date, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_CONTENT_TIMEOUT_MS;
  const attempts = options.attempts || MAX_NAVIGATION_ATTEMPTS;
  const url = buildShowtimesUrl(theater, date);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Navigating between dates keeps the same Next.js route. Clear the old
      // document first so showtime links from the previous date cannot make
      // the readiness check pass while the requested date is still streaming.
      await page.goto("about:blank");
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      if (response && response.status() >= 400) {
        throw new Error(`AMC returned HTTP ${response.status()}`);
      }

      return await waitForShowtimesHtml(page, timeoutMs);
    } catch (error) {
      lastError = error;
      console.warn(
        `Attempt ${attempt}/${attempts} failed for ${theater.id} ${date}: ${error.message}`,
      );
      if (attempt < attempts) await page.waitForTimeout(attempt * 2000);
    }
  }

  throw new Error(
    `Unable to load ${theater.id} ${date}: ${lastError?.message || "unknown error"}`,
  );
}

async function waitForRenderedAdvanceHtml(page, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostic = { title: "", text: "" };

  while (Date.now() < deadline) {
    const result = await page
      .evaluate((pageKind) => {
        const title = document.title || "";
        const bodyText = document.body?.innerText || "";
        const text = bodyText.slice(0, 500);
        const main = document.querySelector("main");
        const hasMovieLinks = !!document.querySelector('a[href*="/movies/"]');
        const hasShowtimes = !!document.querySelector(
          'ul[aria-label="Showtime Group Results"] a',
        );
        const hasVerifiedEmptyState =
          /no showtimes have been announced|no showtimes available|no showtimes found/i.test(
            bodyText,
          );
        const ready =
          main &&
          (pageKind === "catalog"
            ? hasMovieLinks
            : hasShowtimes || hasVerifiedEmptyState);
        return {
          ready,
          title,
          text,
          html: ready ? document.documentElement.outerHTML : null,
        };
      }, kind)
      .catch(() => null);

    if (result) {
      lastDiagnostic = result;
      const interceptionText = `${result.title} ${result.text}`;
      if (
        /attention required|cloudflare|you are now in line|queue-it|verify you are human/i.test(
          interceptionText,
        )
      ) {
        await page.waitForTimeout(1000);
        continue;
      }
      if (result.ready && result.html) return result.html;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(
    `Timed out waiting for ${kind} content. Final URL: ${page.url()}; ` +
      `title: ${lastDiagnostic.title}; page text: ${lastDiagnostic.text}`,
  );
}

async function loadRenderedAdvanceHtml(page, url, kind, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_ADVANCE_TIMEOUT_MS;
  const attempts = options.attempts || MAX_NAVIGATION_ATTEMPTS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto("about:blank");
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      if (response && response.status() >= 400)
        throw new Error(`AMC returned HTTP ${response.status()}`);
      return await waitForRenderedAdvanceHtml(page, kind, timeoutMs);
    } catch (error) {
      lastError = error;
      console.warn(
        `Advance ${kind} attempt ${attempt}/${attempts} failed for ${url}: ${error.message}`,
      );
      if (attempt < attempts) await page.waitForTimeout(attempt * 2000);
    }
  }
  throw lastError || new Error(`Unable to load ${url}`);
}

async function loadExpandedCatalogHtml(page, url, options = {}) {
  await loadRenderedAdvanceHtml(page, url, "catalog", options);
  for (let pass = 0; pass < 10; pass++) {
    const loadMore = page
      .getByRole("button", { name: /load more|show more/i })
      .first();
    if (!(await loadMore.isVisible().catch(() => false))) break;
    await loadMore.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  await page
    .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    .catch(() => {});
  await page.waitForTimeout(1000);
  return page.content();
}

async function discoverAdvanceShowtimes(
  page,
  state,
  configuredTheaters,
  nearTermThrough,
  options = {},
) {
  const now = options.now || new Date();
  const checkedAt = now.toISOString();
  const today = getDates(1, now)[0];
  const timeoutMs =
    options.advanceTimeoutMs ||
    positiveInteger(
      process.env.SCRAPER_ADVANCE_TIMEOUT_MS,
      DEFAULT_ADVANCE_TIMEOUT_MS,
    );
  const catalogs = options.catalogs || ADVANCE_CATALOGS;
  const discovered = new Map();
  let catalogFailures = 0;
  let pageLoads = 0;

  for (const catalogUrl of catalogs) {
    try {
      console.log(`Discovering advance tickets from ${catalogUrl}...`);
      const html = await loadExpandedCatalogHtml(page, catalogUrl, {
        timeoutMs,
      });
      pageLoads++;
      parseAdvanceCatalogHtml(html).forEach((candidate) =>
        discovered.set(candidate.moviePath, candidate),
      );
    } catch (error) {
      catalogFailures++;
      console.warn(
        `Advance catalog unavailable; cached results will be retained: ${error.message}`,
      );
    }
  }

  for (const candidate of discovered.values()) {
    state.candidates[candidate.moviePath] = {
      ...state.candidates[candidate.moviePath],
      ...candidate,
      lastCatalogSeenAt: checkedAt,
      status: state.candidates[candidate.moviePath]?.status || "pending",
    };
  }

  const pathsWithCachedPerformances = new Set(
    Object.values(state.performances)
      .map((performance) => performance.movie?.link)
      .filter(Boolean),
  );
  const candidatesToCheck = Object.values(state.candidates).filter(
    (candidate) =>
      (discovered.has(candidate.moviePath) ||
        pathsWithCachedPerformances.has(candidate.moviePath)) &&
      isCandidateDue(candidate, state, today, now.getTime()),
  );

  let checkedCandidates = 0;
  let failedCandidates = 0;
  for (const candidate of candidatesToCheck) {
    console.log(`Checking advance showtimes for ${candidate.title}...`);
    candidate.lastAttemptAt = checkedAt;
    const probeDates = getCandidateProbeDates(candidate, nearTermThrough);
    if (probeDates.length === 0) {
      candidate.status = parseReleaseDateText(candidate.releaseDateText)
        ? "covered-by-near-term"
        : "pending";
      candidate.lastSuccessfulCheckAt = checkedAt;
      checkedCandidates++;
      continue;
    }

    const performances = new Map();
    let complete = true;
    for (const date of probeDates) {
      const coveredTheaters = new Set();
      for (const theater of configuredTheaters) {
        if (coveredTheaters.has(theater.id)) continue;
        try {
          const url = buildMovieShowtimesUrl(
            candidate.moviePath,
            theater,
            date,
          );
          const html = await loadRenderedAdvanceHtml(page, url, "movie", {
            timeoutMs,
          });
          pageLoads++;
          const parsed = parseMovieShowtimesHtml(
            html,
            candidate,
            date,
            configuredTheaters,
          );
          if (
            html.includes("Showtime Group Results") &&
            parsed.observedTheaters.length === 0
          ) {
            throw new Error(
              "showtimes rendered but no configured theater sections could be identified",
            );
          }
          parsed.observedTheaters.forEach((id) => coveredTheaters.add(id));
          parsed.performances.forEach((performance) =>
            performances.set(performance.key, performance),
          );
        } catch (error) {
          complete = false;
          console.warn(
            `Could not verify ${candidate.title} at ${theater.id} on ${date}: ${error.message}`,
          );
        }
      }
    }

    if (!complete) {
      candidate.status = "error";
      failedCandidates++;
      continue;
    }

    updateCandidatePerformances(
      state,
      candidate,
      Array.from(performances.values()),
      checkedAt,
      nearTermThrough,
    );
    candidate.status = performances.size > 0 ? "active" : "pending";
    candidate.lastSuccessfulCheckAt = checkedAt;
    checkedCandidates++;
  }

  cleanAdvanceState(state, today, nearTermThrough);
  state.updatedAt = checkedAt;
  return {
    catalogFailures,
    discoveredCandidates: discovered.size,
    checkedCandidates,
    failedCandidates,
    cachedPerformances: Object.keys(state.performances).length,
    pageLoads,
  };
}

function writeScheduleAtomically(schedule, outputPaths = OUTPUT_PATHS) {
  const json = JSON.stringify(schedule, null, 2);
  const temporaryFiles = outputPaths.map(
    (outputPath) => `${outputPath}.${process.pid}.tmp`,
  );

  try {
    temporaryFiles.forEach((tempPath) => fs.writeFileSync(tempPath, json));
    outputPaths.forEach((outputPath, index) =>
      fs.renameSync(temporaryFiles[index], outputPath),
    );
  } finally {
    temporaryFiles.forEach((tempPath) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  }
}

function writeScrapeResultsAtomically(
  schedule,
  state,
  outputPaths = OUTPUT_PATHS,
  statePath = STATE_PATH,
) {
  const entries = [
    ...outputPaths.map((outputPath) => ({
      path: outputPath,
      json: JSON.stringify(schedule, null, 2),
    })),
    { path: statePath, json: JSON.stringify(state, null, 2) },
  ];
  const temporaryFiles = entries.map(
    (entry) => `${entry.path}.${process.pid}.tmp`,
  );
  try {
    entries.forEach((entry, index) =>
      fs.writeFileSync(temporaryFiles[index], entry.json),
    );
    entries.forEach((entry, index) =>
      fs.renameSync(temporaryFiles[index], entry.path),
    );
  } finally {
    temporaryFiles.forEach((tempPath) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  }
}

async function scrapeAMC(options = {}) {
  const days =
    options.days || positiveInteger(process.env.SCRAPER_DAYS, DEFAULT_DAYS);
  const timeoutMs =
    options.timeoutMs ||
    positiveInteger(
      process.env.SCRAPER_CONTENT_TIMEOUT_MS,
      DEFAULT_CONTENT_TIMEOUT_MS,
    );
  const theaterFilter = options.theaterId || process.env.SCRAPER_THEATER;
  const selectedTheaters = theaterFilter
    ? theaters.filter((theater) => theater.id === theaterFilter)
    : theaters;
  const dryRun = options.dryRun ?? process.env.SCRAPER_DRY_RUN === "1";
  const headless = options.headless ?? process.env.HEADLESS === "true";
  const scrapeNow = options.now || new Date();
  const dates = getDates(days, scrapeNow);
  const nearTermThrough = dates[dates.length - 1];
  const advanceEnabled =
    options.advanceEnabled ??
    (process.env.SCRAPER_ADVANCE !== "0" && !theaterFilter);

  if (selectedTheaters.length === 0)
    throw new Error(`Unknown theater: ${theaterFilter}`);

  console.log("Starting AMC Scraper...");
  console.log("Calendar dates to scrape:", dates);

  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // Images and fonts are not needed for DOM parsing and make the daily run much slower.
  await context.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    return ["image", "media", "font"].includes(resourceType)
      ? route.abort()
      : route.continue();
  });

  const page = await context.newPage();
  const fullSchedule = {
    scrapedAt: scrapeNow.toISOString(),
    nearTermThrough,
    theaters: {},
  };

  try {
    for (const theater of selectedTheaters) {
      fullSchedule.theaters[theater.id] = {
        id: theater.id,
        location: theater.location,
        schedule: [],
      };

      for (const date of dates) {
        console.log(`Navigating to ${theater.id} for ${date}...`);
        const mainHtml = await loadShowtimesHtml(page, theater, date, {
          timeoutMs,
        });
        const dailyData = parseScheduleHtml(mainHtml, date);
        const showtimeCount = dailyData.movies.reduce(
          (count, movie) =>
            count +
            movie.formats.reduce(
              (formatCount, format) => formatCount + format.showtimes.length,
              0,
            ),
          0,
        );

        if (dailyData.movies.length === 0 || showtimeCount === 0) {
          throw new Error(
            `${theater.id} ${date}: rendered page contained no usable showtime data`,
          );
        }

        console.log(
          `Extracted ${dailyData.movies.length} movies and ${showtimeCount} showtimes`,
        );
        fullSchedule.theaters[theater.id].schedule.push(dailyData);
      }
    }

    const stats = validateSchedule(fullSchedule, selectedTheaters, dates);
    console.log(
      `Validated ${stats.days} days, ${stats.movies} movies, and ${stats.showtimes} showtimes.`,
    );

    const advanceState = loadScraperState(options.statePath || STATE_PATH);
    let advanceStats = {
      catalogFailures: 0,
      discoveredCandidates: 0,
      checkedCandidates: 0,
      failedCandidates: 0,
      cachedPerformances: Object.keys(advanceState.performances).length,
      pageLoads: 0,
    };
    if (advanceEnabled) {
      try {
        advanceStats = await discoverAdvanceShowtimes(
          page,
          advanceState,
          selectedTheaters,
          nearTermThrough,
          {
            now: scrapeNow,
            advanceTimeoutMs: options.advanceTimeoutMs,
            catalogs: options.catalogs,
          },
        );
      } catch (error) {
        console.warn(
          `Advance discovery degraded; retaining cached results: ${error.message}`,
        );
      }
    } else {
      console.log(
        "Advance discovery disabled; retaining valid cached advance showtimes.",
      );
      cleanAdvanceState(advanceState, dates[0], nearTermThrough);
    }

    const advanceValidation = validateAdvanceState(
      advanceState,
      theaters,
      nearTermThrough,
    );
    mergeAdvanceSchedule(
      fullSchedule,
      advanceState,
      selectedTheaters,
      nearTermThrough,
    );
    const mergedStats = getScheduleStats(fullSchedule);
    console.log(
      `Advance discovery: ${advanceStats.discoveredCandidates} candidates discovered, ` +
        `${advanceStats.checkedCandidates} checked, ${advanceStats.failedCandidates} failed, ` +
        `${advanceValidation.performances} future performances retained across ${advanceStats.pageLoads} page loads.`,
    );
    if (advanceStats.catalogFailures > 0) {
      console.warn(
        `${advanceStats.catalogFailures} advance catalog source(s) were unavailable; cached results were retained.`,
      );
    }
    console.log(
      `Merged schedule contains ${mergedStats.showtimes} showtimes from ${dates[0]} through ` +
        `${Object.values(fullSchedule.theaters)
          .flatMap((theater) => theater.schedule)
          .map((day) => day.date)
          .sort()
          .pop()}.`,
    );

    if (!dryRun) {
      writeScrapeResultsAtomically(
        fullSchedule,
        advanceState,
        options.outputPaths || OUTPUT_PATHS,
        options.statePath || STATE_PATH,
      );
      console.log(
        `Successfully saved schedule data and ${options.statePath || STATE_PATH}.`,
      );
    } else {
      console.log("Dry run complete; data files were not changed.");
    }

    return fullSchedule;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  scrapeAMC().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildMovieShowtimesUrl,
  buildShowtimesUrl,
  cleanAdvanceState,
  discoverAdvanceShowtimes,
  emptyScraperState,
  getDates,
  getCandidateProbeDates,
  getScheduleStats,
  isCandidateDue,
  loadShowtimesHtml,
  loadScraperState,
  mergeAdvanceSchedule,
  normalizeMoviePath,
  parseAdvanceCatalogHtml,
  parseMovieShowtimesHtml,
  parseReleaseDateText,
  parseScheduleHtml,
  inspectScheduleHtml,
  scrapeAMC,
  theaters,
  updateCandidatePerformances,
  validateAdvanceState,
  validateSchedule,
  writeScrapeResultsAtomically,
  writeScheduleAtomically,
};
