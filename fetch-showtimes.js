const fs = require("fs");
const { createAmcClient } = require("./amc-api");

// Served by the frontend and bundled into the site at build time. In CI the
// currently deployed copy is downloaded here first so it can serve as the
// previous schedule.
const OUTPUT_PATH = "frontend/public/data.json";
// data.json (read by frontend/src/utils/dataProcessor.js):
// {
//   version, generatedAt, nearTermThrough,      // nearTermThrough: last day of the 14-day window
//   theaters: [{ id, name, location, purchaseUrlTemplate }],
//   movies: { [movieId]: { title, url, runtime, rating } },  // runtime in minutes or null
//   tagSets: [[tag, ...], ...],                 // shared tag lists, in display form
//   showtimes: [{
//     id, theater, movie, tags,                 // tags: index into tagSets
//     date,                                     // schedule day; shows before 5am belong to the previous day
//     startsAt,                                 // AMC local time, e.g. "2026-10-30T19:00:00"
//     alert?, noTrailers?,                      // omitted when there's no alert / trailers play
//     runtime?,                                 // only when it differs from the movie's
//     purchaseUrl?,                             // only when it doesn't match the theatre's template
//   }],
// }
// Bump when this shape changes; a previous file with another version is not
// used as a fallback.
const DATA_VERSION = 2;
const NEAR_TERM_DAYS = 14;
const MIN_RECENT_DAYS = 7;
const CONCURRENCY = 4;
const TIME_ZONE = "America/New_York";
// Shows that start before this hour belong to the previous evening's schedule.
const LATE_NIGHT_CUTOFF_HOUR = 5;

// Tracked theatres. `apiId`, `name` and `location` match AMC's /v2/theatres/{apiId}
// (`name` and `location.stateUrlSuffixText`); `id` is the theatre's key in data.json.
const theaters = [
  { id: "amc-empire-25", apiId: 552, name: "AMC Empire 25", location: "new-york" },
  { id: "amc-lincoln-square-13", apiId: 2116, name: "AMC Lincoln Square 13", location: "new-york" },
  { id: "amc-34th-street-14", apiId: 2120, name: "AMC 34th Street 14", location: "new-york" },
  { id: "amc-kips-bay-15", apiId: 2195, name: "AMC Kips Bay 15", location: "new-york" },
  { id: "amc-magic-johnson-harlem-9", apiId: 2304, name: "AMC Magic Johnson Harlem 9", location: "new-york" },
  { id: "amc-84th-street-6", apiId: 2102, name: "AMC 84th Street 6", location: "new-york" },
  { id: "amc-orpheum-7", apiId: 2104, name: "AMC Orpheum 7", location: "new-york" },
  { id: "amc-19th-st-east-6", apiId: 2112, name: "AMC 19th St. East 6", location: "new-york" },
  { id: "amc-village-7", apiId: 2110, name: "AMC Village 7", location: "new-york" },
  { id: "amc-mountainside-10", apiId: 2183, name: "AMC Mountainside 10", location: "new-jersey" },
  { id: "amc-east-hanover-12", apiId: 2181, name: "AMC East Hanover 12", location: "new-jersey" },
  { id: "amc-aviation-12", apiId: 2249, name: "AMC Aviation 12", location: "new-jersey" },
  { id: "amc-jersey-gardens-20", apiId: 2198, name: "AMC Jersey Gardens 20", location: "new-jersey" },
  { id: "amc-clifton-commons-16", apiId: 865, name: "AMC Clifton Commons 16", location: "new-jersey" },
  { id: "amc-newport-centre-11", apiId: 2184, name: "AMC Newport Centre 11", location: "new-jersey" },
];

// Internal or payment-related attributes that amctheatres.com never displays.
const HIDDEN_ATTRIBUTE_CODES = new Set(["AONELIVE", "DCDCLIVE", "DISNEYRWDS"]);

// Attributes published as a showtime flag rather than a tag.
const NO_TRAILER_CODES = new Set(["NOTRAILER", "NOTRAILERS"]);

// Ticketing restrictions that are not useful as filters.
const RESTRICTION_ATTRIBUTE_CODES = new Set(["EXCLDISDAY", "NOGREENRED", "TREATASR"]);

// Private bookings are not public showtimes.
const EXCLUDED_ATTRIBUTE_CODES = new Set(["PRIVATE"]);

// Showtimes with none of these "experience" attributes (premium format, Laser,
// Open Caption, language, curated series) are tagged as the standard presentation.
const EXPERIENCE_ATTRIBUTE_CODE =
  /LASER|IMAX|DOLBY|PRIME|^XL$|3D|70MM|INFINITYVI|OPENCAPTION|SPOKEN|SUBTITLE|DUBBED|ARTISAN|FANFAVES|THRLSCHLS|INTERNATIONAL/;

function loadEnvFile(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

function dateInTimeZone(now = new Date(), timeZone = TIME_ZONE) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scheduleDate(showDateTimeLocal) {
  const date = showDateTimeLocal.slice(0, 10);
  const hour = Number(showDateTimeLocal.slice(11, 13));
  return hour < LATE_NIGHT_CUTOFF_HOUR ? addDays(date, -1) : date;
}

// Display label for an attribute: "IMAX with Laser at AMC" -> "IMAX with Laser",
// "AMC Signature Recliners" -> "Signature Recliners".
function tagLabel(name) {
  const label = name.replace(/\s+at AMC$/i, "");
  return /club rockers|signature recliners/i.test(label) ? label.replace(/^AMC\s+/i, "") : label;
}

// The filterable tags for a showtime, already in their display form.
function showtimeTags(showtime) {
  const attributes = (showtime.attributes || []).filter(
    (attribute) =>
      !HIDDEN_ATTRIBUTE_CODES.has(attribute.code) &&
      !NO_TRAILER_CODES.has(attribute.code) &&
      !RESTRICTION_ATTRIBUTE_CODES.has(attribute.code),
  );
  const tags = new Set();
  const isStandard =
    !showtime.premiumFormat && !attributes.some((attribute) => EXPERIENCE_ATTRIBUTE_CODE.test(attribute.code));
  if (isStandard) tags.add("Standard");
  for (const attribute of attributes) {
    const label = tagLabel(attribute.name);
    tags.add(label);
    // Let "IMAX" and "Laser" filters both match IMAX with Laser showings.
    if (label === "IMAX with Laser") {
      tags.add("IMAX");
      tags.add("Laser");
    }
  }
  if (!tags.has("Excluded from A-List")) tags.add("Included in A-List");
  return Array.from(tags);
}

function showtimeAlert(showtime) {
  const parts = [];
  if (showtime.discountMatineeMessage) parts.push(showtime.discountMatineeMessage);
  if (showtime.isSoldOut) parts.push("Sold Out");
  else if (showtime.isAlmostSoldOut) parts.push("Almost Full");
  return parts.length ? parts.join(", ") : null;
}

function isPublicShowtime(showtime) {
  return (
    !showtime.isCanceled &&
    Boolean(showtime.showDateTimeLocal) &&
    !(showtime.attributes || []).some((attribute) => EXCLUDED_ATTRIBUTE_CODES.has(attribute.code))
  );
}

function movieKey(showtime) {
  return showtime.movieId != null ? String(showtime.movieId) : `name:${showtime.movieName}`;
}

function runtimeMinutes(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Converts one theatre's API showtimes into movie entries and full showtime rows.
function toTheaterShowtimes(theaterId, apiShowtimes) {
  const movies = {};
  const showtimes = [];
  for (const showtime of apiShowtimes.filter(isPublicShowtime)) {
    const movie = movieKey(showtime);
    movies[movie] ??= {
      title: (showtime.movieName || "").trim(),
      url: showtime.movieUrl || null,
      runtime: runtimeMinutes(showtime.runTime),
      rating: showtime.mpaaRating || null,
    };
    showtimes.push({
      id: String(showtime.id),
      theater: theaterId,
      movie,
      date: scheduleDate(showtime.showDateTimeLocal),
      // AMC's local time, without an offset, e.g. "2026-10-30T19:00:00".
      startsAt: showtime.showDateTimeLocal,
      // AMC occasionally lists a different runtime for the same movie at one theatre.
      runtime: runtimeMinutes(showtime.runTime),
      tags: showtimeTags(showtime),
      noTrailers: (showtime.attributes || []).some((attribute) => NO_TRAILER_CODES.has(attribute.code)),
      alert: showtimeAlert(showtime),
      purchaseUrl: showtime.purchaseUrl || null,
    });
  }
  return { movies, showtimes };
}

function getScheduleStats(schedule) {
  const days = new Set(schedule.showtimes.map((showtime) => `${showtime.theater} ${showtime.date}`));
  return {
    days: days.size,
    movies: Object.keys(schedule.movies).length,
    showtimes: schedule.showtimes.length,
  };
}

function validateTheaterShowtimes(theater, showtimes, today) {
  const recentThrough = addDays(today, MIN_RECENT_DAYS - 1);
  if (!showtimes.some((showtime) => showtime.date >= today && showtime.date <= recentThrough)) {
    throw new Error(`${theater.id}: no showtimes between ${today} and ${recentThrough}`);
  }
}

const PURCHASE_URL = /^(https:\/\/www\.amctheatres\.com\/showtimes\/all\/)(\d{4}-\d{2}-\d{2})(\/[^/]+\/all\/)(\d+)$/;

function fillPurchaseUrl(template, row) {
  return template.replace("{startDate}", row.startsAt.slice(0, 10)).replace("{id}", row.id);
}

// "https://www.amctheatres.com/showtimes/all/2026-10-30/empire/all/147375309"
//   -> "https://www.amctheatres.com/showtimes/all/{startDate}/empire/all/{id}"
function purchaseUrlTemplate(rows) {
  for (const row of rows) {
    const match = row.purchaseUrl?.match(PURCHASE_URL);
    if (match) return `${match[1]}{startDate}${match[3]}{id}`;
  }
  return null;
}

// A failed theatre's future showtimes from the previously published file, as full rows.
function previousTheaterShowtimes(previous, theaterId, today) {
  const template = previous?.theaters?.find((theater) => theater.id === theaterId)?.purchaseUrlTemplate;
  const movies = {};
  const showtimes = [];
  for (const row of previous?.showtimes || []) {
    if (row.theater !== theaterId || row.date < today) continue;
    if (previous.movies?.[row.movie]) movies[row.movie] = previous.movies[row.movie];
    showtimes.push({
      ...row,
      tags: previous.tagSets[row.tags],
      runtime: row.runtime !== undefined ? row.runtime : previous.movies?.[row.movie]?.runtime ?? null,
      purchaseUrl: row.purchaseUrl !== undefined ? row.purchaseUrl : template ? fillPurchaseUrl(template, row) : null,
    });
  }
  return { movies, showtimes };
}

// Shrinks full rows into the published form: tag lists are shared through
// `tagSets`, purchase URLs come from each theatre's `purchaseUrlTemplate`, and
// fields at their default (no alert, has trailers, the movie's usual runtime)
// are left out. Values that don't fit the shared form stay on the row.
function compactSchedule(schedule) {
  const runtimeCounts = {};
  for (const row of schedule.showtimes) {
    const counts = (runtimeCounts[row.movie] ??= new Map());
    counts.set(row.runtime, (counts.get(row.runtime) || 0) + 1);
  }
  for (const [movie, counts] of Object.entries(runtimeCounts)) {
    schedule.movies[movie].runtime = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  const tagSetIndex = new Map();
  schedule.tagSets = [];
  for (const theater of schedule.theaters) {
    theater.purchaseUrlTemplate = purchaseUrlTemplate(
      schedule.showtimes.filter((row) => row.theater === theater.id),
    );
  }
  const templates = new Map(schedule.theaters.map((theater) => [theater.id, theater.purchaseUrlTemplate]));

  for (const row of schedule.showtimes) {
    const key = JSON.stringify(row.tags);
    if (!tagSetIndex.has(key)) {
      tagSetIndex.set(key, schedule.tagSets.length);
      schedule.tagSets.push(row.tags);
    }
    row.tags = tagSetIndex.get(key);

    const template = templates.get(row.theater);
    if (row.purchaseUrl && template && fillPurchaseUrl(template, row) === row.purchaseUrl) delete row.purchaseUrl;
    else if (!template && !row.purchaseUrl) delete row.purchaseUrl;
    if (row.alert == null) delete row.alert;
    if (!row.noTrailers) delete row.noTrailers;
    if (row.runtime === schedule.movies[row.movie].runtime) delete row.runtime;
  }
  return schedule;
}

function loadPreviousSchedule(path = OUTPUT_PATH) {
  if (!fs.existsSync(path)) return null;
  try {
    const schedule = JSON.parse(fs.readFileSync(path, "utf8"));
    if (schedule.version !== DATA_VERSION) {
      throw new Error(`data version ${schedule.version ?? 1} is not ${DATA_VERSION}`);
    }
    if (!Array.isArray(schedule.showtimes) || !Array.isArray(schedule.tagSets)) {
      throw new Error("missing showtimes");
    }
    return schedule;
  } catch (error) {
    console.warn(`Could not load previous schedule from ${path}: ${error.message}`);
    return null;
  }
}

function writeScheduleAtomically(schedule, outputPath = OUTPUT_PATH) {
  // Minified: the file is only read by the frontend, never diffed.
  const json = JSON.stringify(schedule);
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, json);
    fs.renameSync(tempPath, outputPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function buildSchedule(options = {}) {
  const now = options.now || new Date();
  const today = dateInTimeZone(now);
  const selectedTheaters = options.theaters || theaters;
  const client =
    options.client || createAmcClient({ vendorKey: options.vendorKey ?? process.env.AMC_VENDOR_KEY });
  const previous = options.previousSchedule;

  const schedule = {
    version: DATA_VERSION,
    generatedAt: now.toISOString(),
    nearTermThrough: addDays(today, NEAR_TERM_DAYS - 1),
    theaters: selectedTheaters.map(({ id, name, location }) => ({ id, name, location })),
    movies: {},
    showtimes: [],
  };
  const failures = [];

  const results = await mapWithConcurrency(selectedTheaters, CONCURRENCY, async (theater) => {
    try {
      const apiShowtimes = await client.getTheatreShowtimes(theater.apiId);
      const result = toTheaterShowtimes(theater.id, apiShowtimes);
      validateTheaterShowtimes(theater, result.showtimes, today);
      console.log(`${theater.id}: ${result.showtimes.length} showtimes`);
      return result;
    } catch (error) {
      console.warn(`${theater.id}: ${error.message}`);
      return { error };
    }
  });

  selectedTheaters.forEach((theater, index) => {
    let result = results[index];
    if (result.error) {
      failures.push(`${theater.id}: ${result.error.message}`);
      // Keep this theatre's previously published future showtimes rather than
      // dropping it from the site for a day.
      result = previousTheaterShowtimes(previous, theater.id, today);
    }
    Object.assign(schedule.movies, result.movies);
    schedule.showtimes.push(...result.showtimes);
  });

  const theaterOrder = new Map(selectedTheaters.map((theater, index) => [theater.id, index]));
  schedule.showtimes.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startsAt.localeCompare(b.startsAt) ||
      theaterOrder.get(a.theater) - theaterOrder.get(b.theater),
  );
  compactSchedule(schedule);

  return { schedule, failures };
}

async function fetchShowtimes(options = {}) {
  const outputPath = options.outputPath || OUTPUT_PATH;
  const previousSchedule = loadPreviousSchedule(outputPath);
  const { schedule, failures } = await buildSchedule({ ...options, previousSchedule });

  const stats = getScheduleStats(schedule);
  if (failures.length === schedule.theaters.length || stats.showtimes === 0) {
    throw new Error(
      `No usable showtimes; the existing data file was preserved.\n- ${failures.join("\n- ")}`,
    );
  }

  const { showtimes } = schedule;
  console.log(
    `Prepared ${stats.days} theater-days, ${stats.movies} movies, and ${stats.showtimes} showtimes ` +
      `from ${showtimes[0].date} through ${showtimes[showtimes.length - 1].date} (${failures.length} theater failures).`,
  );

  if (options.dryRun) {
    console.log("Dry run complete; the data file was not changed.");
  } else {
    writeScheduleAtomically(schedule, outputPath);
    console.log(`Saved ${outputPath}.`);
  }

  if (failures.length) {
    throw new Error(
      `Partial update published with ${failures.length} theater failures; ` +
        `previous showtimes were retained for them. First failure: ${failures[0]}`,
    );
  }
  return schedule;
}

async function main(argv = process.argv.slice(2)) {
  loadEnvFile();
  await fetchShowtimes({ dryRun: argv.includes("--dry-run") });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DATA_VERSION,
  addDays,
  buildSchedule,
  compactSchedule,
  dateInTimeZone,
  fetchShowtimes,
  getScheduleStats,
  loadEnvFile,
  scheduleDate,
  showtimeAlert,
  showtimeTags,
  theaters,
  toTheaterShowtimes,
};
