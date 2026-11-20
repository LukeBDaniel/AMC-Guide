const fs = require("fs");
const path = require("path");
const { createAmcClient } = require("./amc-api");

// Served by the frontend and bundled into the site at build time. A run writes
// into a staging directory and swaps it in only at the end, so a failed run
// leaves the previous files in place.
const OUTPUT_DIR = "frontend/public/data";
const DIRECTORY_FILE = "theaters.json";
// data/theaters.json: every AMC theatre, for the theatre picker.
// {
//   version, generatedAt,
//   theaters: [{ id, apiId, name, city, state, zip, location, latitude, longitude, timeZone }],
// }
// data/theaters/{id}.json: one theatre's schedule (read by frontend/src/utils/dataProcessor.js,
// which merges the files of a user's favourite theatres).
// {
//   version, generatedAt, nearTermThrough,      // nearTermThrough: last day of the 14-day window
//   theaters: [{ id, name, location, timeZone, purchaseUrlTemplate }],
//   movies: { [movieId]: { title, url, runtime, rating, poster } },  // runtime in minutes or null;
//                                               // poster: full-size image URL on AMC's Cloudinary, or null
//   tagSets: [[tag, ...], ...],                 // shared tag lists, in display form
//   tagGroups: { [tag]: group },                // format | seating | language | other | info
//   showtimes: [{
//     id, theater, movie, tags,                 // tags: index into tagSets
//     date,                                     // schedule day; shows before 5am belong to the previous day
//     startsAt,                                 // theatre local time, e.g. "2026-10-30T19:00:00"
//     alert?, noTrailers?,                      // omitted when there's no alert / trailers play
//     runtime?,                                 // only when it differs from the movie's
//     purchaseUrl?,                             // only when it doesn't match the theatre's template
//   }],
// }
// Bump when either shape changes; previous files with another version are not
// used as a fallback.
const DATA_VERSION = 4;
const NEAR_TERM_DAYS = 14;
const MIN_RECENT_DAYS = 7;
// Kept gentle on AMC's API: two requests in flight at most, and no more than
// two started per second. Every theatre takes one request, so a nightly run of
// ~520 theatres takes a little over four minutes.
const CONCURRENCY = 2;
const REQUEST_INTERVAL_MS = 500;
// A few theatres failing on a given night is expected; they keep their previous
// showtimes. The run is only marked failed beyond this share.
const MAX_FAILURE_SHARE = 0.05;
const DEFAULT_TIME_ZONE = "America/New_York";
// Shows that start before this hour belong to the previous evening's schedule.
const LATE_NIGHT_CUTOFF_HOUR = 5;

// AMC's time zone names. Arizona stays on standard time all year, so it's
// listed by state.
const TIME_ZONES = {
  "EASTERN TIME": "America/New_York",
  "CENTRAL TIME": "America/Chicago",
  "MOUNTAIN TIME": "America/Denver",
  "PACIFIC TIME": "America/Los_Angeles",
  "ALASKA TIME": "America/Anchorage",
  "HAWAII TIME": "Pacific/Honolulu",
};
const STATE_TIME_ZONES = { AZ: "America/Phoenix" };

// What each AMC attribute code contributes to a showtime: the tags it is
// published as, and the filter group of each tag. Codes map to tags rather than
// using AMC's display names, so a renamed attribute keeps its filter, and a
// variant like "IMAX with Laser 3D" matches the IMAX, Laser and 3D filters.
//   format, seating, language, other: shown in that filter section
//   info: kept on the showtime (badges, movie categories) but not a filter
const ATTRIBUTE_TAGS = {
  // Formats
  IMAX: { format: ["IMAX"] },
  IMAX3D: { format: ["IMAX", "3D"] },
  IMAX70MM: { format: ["IMAX", "70MM"] },
  IMAXWITHLASERATAMC: { format: ["IMAX", "Laser"] },
  IMAXWITHLASER3D: { format: ["IMAX", "Laser", "3D"] },
  DOLBYCINEMAATAMCPRIME: { format: ["Dolby Cinema"] },
  DOLBY3D: { format: ["Dolby Cinema", "3D"] },
  AMCPRIME: { format: ["PRIME"] },
  PRIME3D: { format: ["PRIME", "3D"] },
  XL: { format: ["XL"] },
  REALD3D: { format: ["3D"] },
  "70MM": { format: ["70MM"] },
  LASERATAMC: { format: ["Laser"] },
  INFINITYVI: { format: ["Infinity Vision"] },
  "4DX": { format: ["4DX"] },
  SCREENX: { format: ["ScreenX"] },
  VISTVISION: { format: ["VistaVision"] },
  "35MM": { format: ["35MM"] },
  BIGD: { format: ["BigD"] },
  BIGD3D: { format: ["BigD", "3D"] },
  GXL: { format: ["GXL"] },
  GDX: { format: ["GDX"] },
  // Seating
  RECLINERSEATING: { seating: ["Signature Recliners"] },
  HEATEDSEATS: { seating: ["Heated Signature Recliners"] },
  AMCCLUBROCKERS: { seating: ["Club Rockers"] },
  AMCSIGNATUREPLUSHROCKERS: { seating: ["Plush Rockers"] },
  LUXURYSEATSWITHOTTOMANS: { seating: ["Luxury Seats with Ottomans"] },
  MOVIEPARLORSEATING: { seating: ["Movie Parlor Seating"] },
  BALCONY: { seating: ["Balcony"] },
  // Accessibility and special showings
  CLOSEDCAPTION: { other: ["Closed Caption"] },
  OPENCAPTION: { other: ["Open Caption (On-screen Subtitles)"] },
  DESCRIPTIVEVIDEO: { other: ["Audio Description"] },
  SENSORYFRIENDLY: { other: ["Sensory Friendly Film"] },
  MOMMYME: { other: ["Mommy & Me Movies"] },
  PARENTALESCORTPOLICYUNDER18AFTER6PM: { other: ["Adult Supervision Required (Under 18 Starting 6pm)"] },
  INCLINTER: { other: ["Includes Intermission"] },
  INPERSNQA: { other: ["Special Guest In-Person Q&A"] },
  INPERSNINT: { other: ["Special Guest In-Person Intro"] },
  LIVEQA: { other: ["AMC Live Q&A"] },
  LIVESTRQA: { other: ["Livestream - Q&A"] },
  LIVE: { other: ["Live event"] },
  DINEINDELIVERYTOSEAT: { other: ["Dine-In Delivery to Seat"] },
  MEMEXCLUSV: { other: ["AMC Stubs Member Exclusive"] },
  // Curated series and event markers: drive the movie categories
  AMCARTISANFILMS: { info: ["AMC Artisan Films"] },
  THRLSCHLS: { info: ["Thrills & Chills"] },
  FANFAVES: { info: ["Fan Faves"] },
  INTFILMS: { info: ["International Films"] },
  EVENT: { info: ["Event"] },
  ALTERNATIVECONTENT: { info: ["Alternative Content"] },
  NOALIST: { info: ["Excluded from A-List"] },
  LIVESTREAM: { info: ["Livestream Event"] },
  DIRECTV: { info: ["DirecTV Live"] },
  LIVFOOTBAL: { info: ["Live Football"] },
  NONREFUND: { info: ["Non-refundable"] },
  // Not published: on every showtime, ticketing restrictions, payment options,
  // and internal markers amctheatres.com never displays
  RESERVEDSEATING: {},
  EXCLDISDAY: {},
  EXCLDISMAT: {},
  NOGREENRED: {},
  TREATASR: {},
  DISNEYRWDS: {},
  AONELIVE: {},
  DCDCLIVE: {},
  "4DXPOLICY": {},
  // Published as the showtime's `noTrailers` flag instead
  NOTRAILER: {},
  NOTRAILERS: {},
};

// e.g. JAPANESEENGLISHSUBTITLE, KOREANSPOKEN, SPANISHDUBBED. New languages
// appear often enough that these are recognised by pattern.
const LANGUAGE_CODE = /(SPOKEN|SUBTITLE|DUBBED)$/;

// Each theatre sets its own unaccompanied-minor policy, e.g.
// PARENTALESCORTPOLICYUNDER17AFTER9PM or ...UNDER18AFTER8PMFRISAT. Like the
// 6pm policy above, each is filed under Other with AMC's name.
const ESCORT_POLICY_CODE = /^PARENTALESCORTPOLICY/;

const NO_TRAILER_CODES = new Set(["NOTRAILER", "NOTRAILERS"]);

// Private bookings are not public showtimes.
const EXCLUDED_ATTRIBUTE_CODES = new Set(["PRIVATE"]);

// Showtimes with none of these attributes (premium format, Laser, Open Caption,
// language, curated series) are tagged as the standard presentation.
const EXPERIENCE_ATTRIBUTE_CODE =
  /LASER|IMAX|DOLBY|PRIME|^XL$|3D|70MM|35MM|BIGD|GXL|GDX|INFINITYVI|OPENCAPTION|SPOKEN|SUBTITLE|DUBBED|ARTISAN|FANFAVES|THRLSCHLS|INTERNATIONAL/;

function loadEnvFile(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

function dateInTimeZone(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
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

// "SAINT LOUIS" -> "Saint Louis"
function titleCase(text) {
  return (text || "").toLowerCase().replace(/(^|[\s-])\S/g, (letter) => letter.toUpperCase());
}

function theatreTimeZone(theatre) {
  return STATE_TIME_ZONES[theatre.location?.state] || TIME_ZONES[theatre.timezone] || null;
}

function isListedTheatre(theatre) {
  return (
    !theatre.isClosed &&
    Boolean(theatre.slug) &&
    Number.isFinite(theatre.location?.latitude) &&
    Number.isFinite(theatre.location?.longitude)
  );
}

// A theatre from /v2/theatres as a data/theaters.json entry. `id` is AMC's slug,
// e.g. "amc-empire-25", which is also how the frontend remembers favourites.
function directoryEntry(theatre) {
  const { location } = theatre;
  return {
    id: theatre.slug,
    apiId: theatre.id,
    name: theatre.name.trim(),
    city: titleCase(location.city),
    state: location.state,
    zip: (location.postalCode || "").slice(0, 5),
    location: location.stateUrlSuffixText,
    latitude: location.latitude,
    longitude: location.longitude,
    timeZone: theatreTimeZone(theatre) || DEFAULT_TIME_ZONE,
  };
}

// Tags for one attribute as { group: [tag, ...] }. Codes missing from
// ATTRIBUTE_TAGS fall back to AMC's name under "other" and are reported.
function attributeTags(attribute, unknownCodes) {
  if (ATTRIBUTE_TAGS[attribute.code]) return ATTRIBUTE_TAGS[attribute.code];
  if (LANGUAGE_CODE.test(attribute.code)) return { language: [attribute.name] };
  if (ESCORT_POLICY_CODE.test(attribute.code)) return { other: [attribute.name] };
  unknownCodes?.set(attribute.code, attribute.name);
  return { other: [attribute.name.replace(/\s+at AMC$/i, "")] };
}

// The showtime's tags and the filter group of each.
function classifyShowtime(showtime, unknownCodes) {
  const groups = new Map();
  const add = (group, tag) => {
    if (!groups.has(tag)) groups.set(tag, group);
  };
  const attributes = showtime.attributes || [];
  const isStandard =
    !showtime.premiumFormat && !attributes.some((attribute) => EXPERIENCE_ATTRIBUTE_CODE.test(attribute.code));
  if (isStandard) add("format", "Standard");
  for (const attribute of attributes) {
    for (const [group, tags] of Object.entries(attributeTags(attribute, unknownCodes))) {
      tags.forEach((tag) => add(group, tag));
    }
  }
  if (!groups.has("Excluded from A-List")) add("other", "Included in A-List");
  return { tags: Array.from(groups.keys()), groups };
}

function showtimeTags(showtime) {
  return classifyShowtime(showtime).tags;
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
  const tagGroups = {};
  const unknownCodes = new Map();
  for (const showtime of apiShowtimes.filter(isPublicShowtime)) {
    const { tags, groups } = classifyShowtime(showtime, unknownCodes);
    groups.forEach((group, tag) => {
      tagGroups[tag] = group;
    });
    const movie = movieKey(showtime);
    movies[movie] ??= {
      title: (showtime.movieName || "").trim(),
      url: showtime.movieUrl || null,
      runtime: runtimeMinutes(showtime.runTime),
      rating: showtime.mpaaRating || null,
      poster: showtime.media?.posterDynamic || null,
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
      tags,
      noTrailers: (showtime.attributes || []).some((attribute) => NO_TRAILER_CODES.has(attribute.code)),
      alert: showtimeAlert(showtime),
      purchaseUrl: showtime.purchaseUrl || null,
    });
  }
  return { movies, showtimes, tagGroups, unknownCodes };
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
  const tagGroups = {};
  for (const row of showtimes) {
    for (const tag of row.tags) {
      if (previous.tagGroups?.[tag]) tagGroups[tag] = previous.tagGroups[tag];
    }
  }
  return { movies, showtimes, tagGroups };
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

// Reads previously published files: from the output directory when they're on
// disk (local runs), otherwise from the live site at `baseUrl` (CI, where only
// the files actually needed are downloaded).
function createPreviousLoader({ dir = OUTPUT_DIR, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  return async function loadPrevious(relativePath) {
    try {
      let file;
      const localPath = path.join(dir, relativePath);
      if (fs.existsSync(localPath)) {
        file = JSON.parse(fs.readFileSync(localPath, "utf8"));
      } else if (baseUrl) {
        const response = await fetchImpl(new URL(relativePath, baseUrl.replace(/\/?$/, "/")).toString());
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        file = await response.json();
      } else {
        return null;
      }
      if (file?.version !== DATA_VERSION) throw new Error(`data version ${file?.version ?? 1} is not ${DATA_VERSION}`);
      if (!Array.isArray(file.theaters)) throw new Error("missing theaters");
      if (relativePath !== DIRECTORY_FILE && (!Array.isArray(file.showtimes) || !Array.isArray(file.tagSets) || !file.tagGroups)) {
        throw new Error("missing showtimes");
      }
      return file;
    } catch (error) {
      console.warn(`Could not load previous ${relativePath}: ${error.message}`);
      return null;
    }
  };
}

function theaterFile(theaterId) {
  return `theaters/${theaterId}.json`;
}

function writeJson(filePath, value) {
  // Minified: the files are only read by the frontend, never diffed.
  fs.writeFileSync(filePath, JSON.stringify(value));
}

// Swaps the staged files in for the published ones in two renames, so the site is
// never built from a mix of old and new files.
function replaceDirectory(stagingDir, outputDir) {
  const oldDir = `${outputDir}.${process.pid}.old`;
  if (fs.existsSync(outputDir)) fs.renameSync(outputDir, oldDir);
  fs.renameSync(stagingDir, outputDir);
  fs.rmSync(oldDir, { recursive: true, force: true });
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

// Every open AMC theatre. When the list can't be fetched, the previously
// published one is used, so the night's showtimes still update.
async function loadDirectory({ client, loadPrevious }) {
  try {
    const theaters = (await client.getTheatres())
      .filter(isListedTheatre)
      .map((theatre) => {
        if (!theatreTimeZone(theatre)) {
          console.warn(`${theatre.slug}: unknown time zone "${theatre.timezone}"; using ${DEFAULT_TIME_ZONE}`);
        }
        return directoryEntry(theatre);
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!theaters.length) throw new Error("the API listed no open theatres");
    return { theaters, error: null };
  } catch (error) {
    const previous = await loadPrevious(DIRECTORY_FILE);
    if (!previous) throw new Error(`Could not list theatres: ${error.message}`);
    console.warn(`Theatre list: ${error.message}; using the previous list`);
    return { theaters: previous.theaters, error };
  }
}

// A theatre with nothing on sale (newly opened, closed for renovation) is
// answered with a 404 rather than an empty list.
async function theaterApiShowtimes(client, apiId) {
  try {
    return await client.getTheatreShowtimes(apiId);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

// One theatre's published file. When its showtimes can't be fetched, or look
// wrong, its future showtimes from the previous file are kept instead.
async function buildTheaterSchedule(theater, { now, client, loadPrevious }) {
  const today = dateInTimeZone(now, theater.timeZone);
  let result;
  let error = null;
  try {
    result = toTheaterShowtimes(theater.id, await theaterApiShowtimes(client, theater.apiId));
    if (result.showtimes.length) validateTheaterShowtimes(theater, result.showtimes, today);
  } catch (caught) {
    error = caught;
    result = previousTheaterShowtimes(await loadPrevious(theaterFile(theater.id)), theater.id, today);
  }
  result.showtimes.sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt));
  const schedule = compactSchedule({
    version: DATA_VERSION,
    generatedAt: now.toISOString(),
    nearTermThrough: addDays(today, NEAR_TERM_DAYS - 1),
    theaters: [{ id: theater.id, name: theater.name, location: theater.location, timeZone: theater.timeZone }],
    movies: result.movies,
    tagGroups: result.tagGroups,
    showtimes: result.showtimes,
  });
  return { schedule, error, unknownCodes: result.unknownCodes };
}

async function fetchShowtimes(options = {}) {
  const now = options.now || new Date();
  const outputDir = options.outputDir || OUTPUT_DIR;
  const client =
    options.client ||
    createAmcClient({
      vendorKey: options.vendorKey ?? process.env.AMC_VENDOR_KEY,
      minIntervalMs: REQUEST_INTERVAL_MS,
    });
  const loadPrevious =
    options.loadPrevious ||
    createPreviousLoader({ dir: outputDir, baseUrl: options.previousDataUrl ?? process.env.PREVIOUS_DATA_URL });

  const directory = options.theaters
    ? { theaters: options.theaters, error: null }
    : await loadDirectory({ client, loadPrevious });
  const { theaters } = directory;

  const stagingDir = `${outputDir}.${process.pid}.tmp`;
  const failures = [];
  const unknownCodes = new Map();
  const stats = { showtimes: 0, empty: 0, first: null, last: null };
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingDir, "theaters"), { recursive: true });
  try {
    await mapWithConcurrency(theaters, CONCURRENCY, async (theater) => {
      const { schedule, error, unknownCodes: codes } = await buildTheaterSchedule(theater, { now, client, loadPrevious });
      const { showtimes } = schedule;
      if (error) {
        failures.push(`${theater.id}: ${error.message}`);
        console.warn(`${theater.id}: ${error.message} (kept ${showtimes.length} previous showtimes)`);
      } else {
        console.log(`${theater.id}: ${showtimes.length} showtimes`);
      }
      codes?.forEach((name, code) => unknownCodes.set(code, name));
      stats.showtimes += showtimes.length;
      if (!showtimes.length) stats.empty += 1;
      else {
        if (!stats.first || showtimes[0].date < stats.first) stats.first = showtimes[0].date;
        const last = showtimes[showtimes.length - 1].date;
        if (!stats.last || last > stats.last) stats.last = last;
      }
      writeJson(path.join(stagingDir, theaterFile(theater.id)), schedule);
    });
    writeJson(path.join(stagingDir, DIRECTORY_FILE), {
      version: DATA_VERSION,
      generatedAt: now.toISOString(),
      theaters,
    });

    if (failures.length === theaters.length || stats.showtimes === 0) {
      throw new Error(
        `No usable showtimes; the existing data files were preserved.\n- ${failures.slice(0, 20).join("\n- ")}`,
      );
    }

    console.log(
      `Prepared ${stats.showtimes} showtimes at ${theaters.length - stats.empty} of ${theaters.length} theaters, ` +
        `from ${stats.first} through ${stats.last} (${failures.length} theater failures).`,
    );

    if (options.dryRun) {
      console.log("Dry run complete; the data files were not changed.");
    } else {
      replaceDirectory(stagingDir, outputDir);
      console.log(`Saved ${outputDir}/.`);
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // Shown as annotations on the GitHub Actions run.
  const annotation = process.env.GITHUB_ACTIONS ? "::warning::" : "";
  unknownCodes.forEach((name, code) => {
    console.warn(`${annotation}Unmapped AMC attribute ${code} ("${name}") was filed under Other; add it to ATTRIBUTE_TAGS.`);
  });
  if (directory.error) failures.unshift(`theatre list: ${directory.error.message}`);
  if (annotation) failures.forEach((failure) => console.warn(`${annotation}${failure}`));

  const allowedFailures = Math.max(1, Math.floor(theaters.length * MAX_FAILURE_SHARE));
  if (failures.length > allowedFailures) {
    throw new Error(
      `Partial update published with ${failures.length} failures (more than ${allowedFailures}); ` +
        `previous showtimes were retained for failed theaters. First failure: ${failures[0]}`,
    );
  }
  return { theaters: theaters.length, showtimes: stats.showtimes, failures };
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
  buildTheaterSchedule,
  compactSchedule,
  createPreviousLoader,
  dateInTimeZone,
  directoryEntry,
  fetchShowtimes,
  loadDirectory,
  scheduleDate,
  ATTRIBUTE_TAGS,
  showtimeAlert,
  showtimeTags,
  toTheaterShowtimes,
};
