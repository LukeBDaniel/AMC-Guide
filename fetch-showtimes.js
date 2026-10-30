const fs = require("fs");
const { createAmcClient } = require("./amc-api");

const OUTPUT_PATHS = ["data.json", "frontend/public/data.json"];
const NEAR_TERM_DAYS = 14;
const MIN_RECENT_DAYS = 7;
const CONCURRENCY = 4;
const TIME_ZONE = "America/New_York";
// Shows that start before this hour belong to the previous evening's schedule.
// Matches the late-night handling in frontend/src/utils/dataProcessor.js.
const LATE_NIGHT_CUTOFF_HOUR = 5;

const theaters = [
  { id: "amc-empire-25", apiId: 552, location: "new-york" },
  { id: "amc-lincoln-square-13", apiId: 2116, location: "new-york" },
  { id: "amc-34th-street-14", apiId: 2120, location: "new-york" },
  { id: "amc-kips-bay-15", apiId: 2195, location: "new-york" },
  { id: "amc-magic-johnson-harlem-9", apiId: 2304, location: "new-york" },
  { id: "amc-84th-street-6", apiId: 2102, location: "new-york" },
  { id: "amc-orpheum-7", apiId: 2104, location: "new-york" },
  { id: "amc-19th-st-east-6", apiId: 2112, location: "new-york" },
  { id: "amc-village-7", apiId: 2110, location: "new-york" },
  { id: "amc-mountainside-10", apiId: 2183, location: "new-jersey" },
  { id: "amc-east-hanover-12", apiId: 2181, location: "new-jersey" },
  { id: "amc-aviation-12", apiId: 2249, location: "new-jersey" },
  { id: "amc-jersey-gardens-20", apiId: 2198, location: "new-jersey" },
  { id: "amc-clifton-commons-16", apiId: 865, location: "new-jersey" },
  { id: "amc-newport-centre-11", apiId: 2184, location: "new-jersey" },
];

// Internal or payment-related attributes that amctheatres.com never displays.
const HIDDEN_ATTRIBUTE_CODES = new Set(["AONELIVE", "DCDCLIVE", "DISNEYRWDS"]);

// Display names for attributes whose API name differs from the label used elsewhere.
const ATTRIBUTE_NAME_OVERRIDES = {
  NOTRAILERS: "No Trailers", // variant of NOTRAILER; the frontend keys trailer padding off this label
};

// Private bookings are not public showtimes.
const EXCLUDED_ATTRIBUTE_CODES = new Set(["PRIVATE"]);

// The website groups each showtime under its first "experience" attribute
// (premium format, Laser, Open Caption, language, curated series). Showtimes
// with only amenity attributes are grouped as the standard presentation.
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

function formatTime(showDateTimeLocal) {
  const hour = Number(showDateTimeLocal.slice(11, 13));
  const minute = showDateTimeLocal.slice(14, 16);
  const period = hour >= 12 ? "pm" : "am";
  return `${hour % 12 || 12}:${minute}${period}`;
}

function formatRuntime(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return `${Math.floor(minutes / 60)} HR ${minutes % 60} MIN`;
}

function moviePath(movieUrl) {
  if (!movieUrl) return null;
  try {
    return new URL(movieUrl).pathname;
  } catch (_) {
    return null;
  }
}

function showtimeFormats(showtime) {
  const attributes = (showtime.attributes || []).filter(
    (attribute) => !HIDDEN_ATTRIBUTE_CODES.has(attribute.code),
  );
  const header = attributes.find((attribute) =>
    EXPERIENCE_ATTRIBUTE_CODE.test(attribute.code),
  );
  const names = attributes
    .filter((attribute) => attribute !== header)
    .map((attribute) => ATTRIBUTE_NAME_OVERRIDES[attribute.code] || attribute.name);
  const lead = header ? header.name : showtime.premiumFormat || "Standard";
  return Array.from(new Set([lead, ...names].filter(Boolean)));
}

function showtimeAlert(showtime) {
  const parts = [];
  if (showtime.discountMatineeMessage) parts.push(showtime.discountMatineeMessage);
  if (showtime.isSoldOut) parts.push("Sold Out");
  else if (showtime.isAlmostSoldOut) parts.push("Almost Full");
  return parts.length ? parts.join(", ") : null;
}

// Converts API showtimes into the day -> movie -> format group structure that
// the frontend has always consumed from data.json.
function toTheaterSchedule(apiShowtimes) {
  const days = new Map();
  const sorted = apiShowtimes
    .filter(
      (showtime) =>
        !showtime.isCanceled &&
        showtime.showDateTimeLocal &&
        !(showtime.attributes || []).some((attribute) => EXCLUDED_ATTRIBUTE_CODES.has(attribute.code)),
    )
    .sort((a, b) => a.showDateTimeLocal.localeCompare(b.showDateTimeLocal));

  for (const showtime of sorted) {
    const date = scheduleDate(showtime.showDateTimeLocal);
    if (!days.has(date)) days.set(date, new Map());
    const movies = days.get(date);

    const movieKey = showtime.movieId ?? showtime.movieName;
    if (!movies.has(movieKey)) {
      movies.set(movieKey, {
        title: (showtime.movieName || "").trim(),
        link: moviePath(showtime.movieUrl),
        runtime: formatRuntime(showtime.runTime),
        rating: showtime.mpaaRating || null,
        groups: new Map(),
      });
    }
    const movie = movies.get(movieKey);

    const formats = showtimeFormats(showtime);
    const groupKey = formats.join("|");
    if (!movie.groups.has(groupKey)) movie.groups.set(groupKey, { formats, showtimes: [] });
    movie.groups.get(groupKey).showtimes.push({
      time: formatTime(showtime.showDateTimeLocal),
      performanceId: String(showtime.id),
      alert: showtimeAlert(showtime),
    });
  }

  return Array.from(days.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, movies]) => ({
      date,
      movies: Array.from(movies.values()).map(({ groups, ...movie }) => ({
        ...movie,
        formats: Array.from(groups.values()),
      })),
    }));
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
        for (const format of movie.formats) showtimes += format.showtimes.length;
      }
    }
  }
  return { days, movies, showtimes };
}

function validateTheaterSchedule(theater, schedule, today) {
  const recentThrough = addDays(today, MIN_RECENT_DAYS - 1);
  const recentDays = schedule.filter(
    (day) => day.date >= today && day.date <= recentThrough && day.movies.length > 0,
  );
  if (recentDays.length === 0) {
    throw new Error(`${theater.id}: no showtimes between ${today} and ${recentThrough}`);
  }
}

function loadPreviousSchedule(path = OUTPUT_PATHS[0]) {
  if (!fs.existsSync(path)) return null;
  try {
    const schedule = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!schedule.theaters || typeof schedule.theaters !== "object")
      throw new Error("missing theaters");
    return schedule;
  } catch (error) {
    console.warn(`Could not load previous schedule from ${path}: ${error.message}`);
    return null;
  }
}

function writeScheduleAtomically(schedule, outputPaths = OUTPUT_PATHS) {
  const json = JSON.stringify(schedule, null, 2);
  const temporaryFiles = outputPaths.map((outputPath) => `${outputPath}.${process.pid}.tmp`);
  try {
    temporaryFiles.forEach((tempPath) => fs.writeFileSync(tempPath, json));
    outputPaths.forEach((outputPath, index) => fs.renameSync(temporaryFiles[index], outputPath));
  } finally {
    temporaryFiles.forEach((tempPath) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
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
    scrapedAt: now.toISOString(),
    nearTermThrough: addDays(today, NEAR_TERM_DAYS - 1),
    theaters: {},
  };
  const failures = [];

  const results = await mapWithConcurrency(selectedTheaters, CONCURRENCY, async (theater) => {
    try {
      const showtimes = await client.getTheatreShowtimes(theater.apiId);
      const theaterSchedule = toTheaterSchedule(showtimes);
      validateTheaterSchedule(theater, theaterSchedule, today);
      console.log(`${theater.id}: ${showtimes.length} showtimes across ${theaterSchedule.length} days`);
      return { theaterSchedule };
    } catch (error) {
      console.warn(`${theater.id}: ${error.message}`);
      return { error };
    }
  });

  selectedTheaters.forEach((theater, index) => {
    let { theaterSchedule, error } = results[index];
    if (error) {
      failures.push(`${theater.id}: ${error.message}`);
      // Keep this theatre's previously published future showtimes rather than
      // dropping it from the site for a day.
      theaterSchedule = (previous?.theaters?.[theater.id]?.schedule || []).filter(
        (day) => typeof day.date === "string" && day.date >= today,
      );
    }
    schedule.theaters[theater.id] = {
      id: theater.id,
      location: theater.location,
      schedule: theaterSchedule,
    };
  });

  return { schedule, failures };
}

async function fetchShowtimes(options = {}) {
  const outputPaths = options.outputPaths || OUTPUT_PATHS;
  const previousSchedule = loadPreviousSchedule(outputPaths[0]);
  const { schedule, failures } = await buildSchedule({ ...options, previousSchedule });

  const stats = getScheduleStats(schedule);
  if (failures.length === Object.keys(schedule.theaters).length || stats.showtimes === 0) {
    throw new Error(
      `No usable showtimes; existing data files were preserved.\n- ${failures.join("\n- ")}`,
    );
  }

  const dates = Object.values(schedule.theaters).flatMap((theater) => theater.schedule.map((day) => day.date));
  console.log(
    `Prepared ${stats.days} theater-days, ${stats.movies} movies, and ${stats.showtimes} showtimes ` +
      `from ${dates.sort()[0]} through ${dates.pop()} (${failures.length} theater failures).`,
  );

  if (options.dryRun) {
    console.log("Dry run complete; data files were not changed.");
  } else {
    writeScheduleAtomically(schedule, outputPaths);
    console.log(`Saved ${outputPaths.join(" and ")}.`);
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
  HIDDEN_ATTRIBUTE_CODES,
  addDays,
  buildSchedule,
  dateInTimeZone,
  fetchShowtimes,
  formatRuntime,
  formatTime,
  getScheduleStats,
  loadEnvFile,
  scheduleDate,
  showtimeAlert,
  showtimeFormats,
  theaters,
  toTheaterSchedule,
};
