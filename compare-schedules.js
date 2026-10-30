// Parity report between a published (scraped) data.json and an API-built
// schedule. Used by `node fetch-showtimes.js --compare` during the migration.

const MAX_EXAMPLES = 3;

function indexShowtimes(schedule, fromDate, throughDate) {
  const index = new Map();
  for (const theater of Object.values(schedule.theaters || {})) {
    for (const day of theater.schedule || []) {
      if (day.date < fromDate || day.date > throughDate) continue;
      for (const movie of day.movies) {
        for (const group of movie.formats) {
          for (const showtime of group.showtimes) {
            index.set(String(showtime.performanceId), {
              theater: theater.id,
              date: day.date,
              time: showtime.time,
              title: movie.title,
              link: movie.link,
              runtime: movie.runtime,
              rating: movie.rating,
              formats: group.formats
                .map((f) => (f === "undefined" || f === "" ? "Standard" : f))
                .sort()
                .join(" | "),
              standard: group.formats.some((f) => f === "Standard" || f === "undefined" || f === ""),
              alert: showtime.alert,
            });
          }
        }
      }
    }
  }
  return index;
}

function diffIndexes(baseline, candidate, fields) {
  const matched = [...baseline.keys()].filter((id) => candidate.has(id));
  const mismatches = Object.fromEntries(fields.map((field) => [field, { count: 0, examples: [] }]));
  for (const id of matched) {
    const before = baseline.get(id);
    const after = candidate.get(id);
    for (const field of fields) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      const entry = mismatches[field];
      entry.count++;
      if (entry.examples.length < MAX_EXAMPLES) {
        entry.examples.push(`${id} ${before.theater} ${before.date} ${before.title}: ${JSON.stringify(before[field])} -> ${JSON.stringify(after[field])}`);
      }
    }
  }
  return {
    baseline: baseline.size,
    candidate: candidate.size,
    matched: matched.length,
    onlyBaseline: [...baseline.keys()].filter((id) => !candidate.has(id)),
    onlyCandidate: [...candidate.keys()].filter((id) => !baseline.has(id)),
    mismatches,
  };
}

function compareRawSchedules(baseline, candidate, fromDate, throughDate) {
  return diffIndexes(
    indexShowtimes(baseline, fromDate, throughDate),
    indexShowtimes(candidate, fromDate, throughDate),
    ["date", "time", "title", "link", "runtime", "rating", "formats", "standard", "alert"],
  );
}

function indexFlattened(result, fromDate, throughDate) {
  const categoryByMovie = new Map();
  for (const [category, keys] of Object.entries(result.groupedMovies || {})) {
    for (const key of keys) categoryByMovie.set(key, category);
  }
  const index = new Map();
  for (const showtime of result.showtimes) {
    if (showtime.date < fromDate || showtime.date > throughDate) continue;
    index.set(showtime.id, {
      theater: showtime.theaterId,
      date: showtime.date,
      title: showtime.movieTitle,
      movieKey: showtime.movieKey,
      variant: showtime.variant,
      timeMinutes: showtime.timeMinutes,
      runtimeMinutes: showtime.runtimeMinutes,
      format: [...showtime.format].sort(),
      category: categoryByMovie.get(showtime.movieKey) || null,
      link: showtime.link,
      alert: showtime.alert,
    });
  }
  return index;
}

async function compareFrontendResults(baseline, candidate, fromDate, throughDate) {
  const { flattenScheduleData } = await import("./frontend/src/utils/dataProcessor.js");
  // flattenScheduleData mutates nothing, but clone defensively since both
  // inputs are reused by the caller.
  const before = flattenScheduleData(structuredClone(baseline));
  const after = flattenScheduleData(structuredClone(candidate));
  return diffIndexes(
    indexFlattened(before, fromDate, throughDate),
    indexFlattened(after, fromDate, throughDate),
    ["date", "title", "movieKey", "variant", "timeMinutes", "runtimeMinutes", "format", "category", "link", "alert"],
  );
}

function printReport(label, report) {
  const pct = report.baseline ? ((report.matched / report.baseline) * 100).toFixed(1) : "0";
  console.log(`\n=== ${label}`);
  console.log(
    `baseline ${report.baseline} | api ${report.candidate} | matched ${report.matched} (${pct}% of baseline) | ` +
      `baseline-only ${report.onlyBaseline.length} | api-only ${report.onlyCandidate.length}`,
  );
  for (const [field, { count, examples }] of Object.entries(report.mismatches)) {
    const share = report.matched ? ((count / report.matched) * 100).toFixed(1) : "0";
    console.log(`  ${count === 0 ? "✓" : "✗"} ${field.padEnd(15)} ${count} mismatches (${share}%)`);
    examples.forEach((example) => console.log(`      ${example}`));
  }
}

async function compareWithPublished(baseline, candidate) {
  const baselineDates = Object.values(baseline.theaters)
    .flatMap((theater) => theater.schedule.map((day) => day.date))
    .sort();
  const candidateDates = Object.values(candidate.theaters)
    .flatMap((theater) => theater.schedule.map((day) => day.date))
    .sort();
  // Only compare dates both sources could contain: the API never returns
  // showtimes that have already been purged, and the scrape stops at its horizon.
  const fromDate = candidateDates[0] > baselineDates[0] ? candidateDates[0] : baselineDates[0];
  const throughDate = baseline.nearTermThrough || baselineDates[baselineDates.length - 1];
  console.log(`Comparing ${fromDate} through ${throughDate} (baseline scraped ${baseline.scrapedAt}).`);

  const raw = compareRawSchedules(baseline, candidate, fromDate, throughDate);
  printReport("data.json fields", raw);
  const frontend = await compareFrontendResults(baseline, candidate, fromDate, throughDate);
  printReport("frontend flattenScheduleData output", frontend);

  const size = (value) => `${(Buffer.byteLength(JSON.stringify(value, null, 2)) / 1024).toFixed(0)} KB`;
  console.log(`\ndata.json size: baseline ${size(baseline)} -> api ${size(candidate)}`);
  console.log(`api horizon: ${candidateDates[0]} through ${candidateDates[candidateDates.length - 1]}`);
  return { raw, frontend };
}

module.exports = { compareRawSchedules, compareFrontendResults, compareWithPublished };
