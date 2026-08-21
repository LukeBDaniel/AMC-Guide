const fs = require('fs');

// Cheerio 1.2's HTTP stack expects File to exist. GitHub Actions uses Node 20,
// but this small shim also keeps parser tests working on Node 18.
if (typeof global.File === 'undefined') {
    global.File = class File {};
}

const cheerio = require('cheerio');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const DEFAULT_DAYS = 14;
const DEFAULT_CONTENT_TIMEOUT_MS = 120000;
const MAX_NAVIGATION_ATTEMPTS = 3;
const SHOWTIME_SELECTOR = 'ul[aria-label="Showtime Group Results"] a';
const OUTPUT_PATHS = ['data.json', 'frontend/public/data.json'];

const theaters = [
    { id: 'amc-empire-25', location: 'new-york' },
    { id: 'amc-lincoln-square-13', location: 'new-york' },
    { id: 'amc-34th-street-14', location: 'new-york' },
    { id: 'amc-kips-bay-15', location: 'new-york' },
    { id: 'amc-mountainside-10', location: 'new-jersey' },
    { id: 'amc-east-hanover-12', location: 'new-jersey' },
    { id: 'amc-aviation-12', location: 'new-jersey' },
    { id: 'amc-jersey-gardens-20', location: 'new-jersey' },
    { id: 'amc-clifton-commons-16', location: 'new-jersey' }
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
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        dates.push(`${date.getFullYear()}-${month}-${day}`);
    }
    return dates;
}

function buildShowtimesUrl(theater, date) {
    return `https://www.amctheatres.com/movie-theatres/${theater.location}/${theater.id}/showtimes?date=${date}`;
}

function parseScheduleHtml(mainHtml, date) {
    const $ = cheerio.load(mainHtml);
    const dailyData = { date, movies: [] };

    $('section[id]').each((_, sectionEl) => {
        const $section = $(sectionEl);
        const titleNode = $section.find('h1 a').first();
        if (titleNode.length === 0) return;

        const metadataList = $section.find('ul').first().find('li span.uppercase');
        const ratingNode = $section.find('span[aria-label^="MPAA Rating"]');
        const movieObj = {
            title: titleNode.text().trim(),
            link: titleNode.attr('href'),
            runtime: metadataList.eq(0).text().trim() || null,
            rating: ratingNode.length ? ratingNode.text().trim() : null,
            formats: []
        };

        $section.find('li[role="listitem"][aria-label$="Showtimes"]').each((__, formatEl) => {
            const $format = $(formatEl);
            const ariaLabel = $format.attr('aria-label') || '';
            const formatName = $format.find('h3 span').first().text().trim()
                || ariaLabel.replace(/ Showtimes$/, '');
            const additionalTags = [];

            $format.find('ul[id$="-attributes"] li').each((___, liEl) => {
                const text = $(liEl).text().trim();
                if (text) additionalTags.push(text);
            });

            const showtimes = [];
            $format.find('ul[aria-label="Showtime Group Results"] a').each((___, timeEl) => {
                const $time = $(timeEl);
                let time = $time.find('time').text().trim();
                if (!time) {
                    time = $time.contents().filter(function filterTextNodes() {
                        return this.nodeType === 3;
                    }).text().trim();
                }

                if (!time) return;
                const timeLink = $time.attr('href');
                const alertNode = $time.find('span.sr-only');
                showtimes.push({
                    time,
                    performanceId: timeLink ? timeLink.split('/').pop() : null,
                    alert: alertNode.length ? alertNode.text().trim() : null
                });
            });

            if (showtimes.length > 0) {
                movieObj.formats.push({
                    formats: Array.from(new Set([formatName, ...additionalTags].filter(Boolean))),
                    showtimes
                });
            }
        });

        // A movie header can render before its showtime groups. Do not treat that
        // intermediate DOM state as successfully scraped data.
        if (movieObj.formats.length > 0) dailyData.movies.push(movieObj);
    });

    return dailyData;
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

function validateSchedule(schedule, expectedTheaters, expectedDates) {
    const errors = [];
    const theaterEntries = Object.entries(schedule.theaters || {});

    if (theaterEntries.length !== expectedTheaters.length) {
        errors.push(`expected ${expectedTheaters.length} theaters, got ${theaterEntries.length}`);
    }

    for (const theater of expectedTheaters) {
        const result = schedule.theaters?.[theater.id];
        if (!result) {
            errors.push(`${theater.id}: missing theater result`);
            continue;
        }
        if (result.schedule.length !== expectedDates.length) {
            errors.push(`${theater.id}: expected ${expectedDates.length} days, got ${result.schedule.length}`);
        }

        const returnedDates = new Set(result.schedule.map(day => day.date));
        for (const date of expectedDates) {
            if (!returnedDates.has(date)) errors.push(`${theater.id} ${date}: missing result`);
        }

        for (const day of result.schedule) {
            const dayShowtimes = day.movies.reduce((count, movie) => (
                count + movie.formats.reduce((formatCount, format) => formatCount + format.showtimes.length, 0)
            ), 0);
            if (day.movies.length === 0 || dayShowtimes === 0) {
                errors.push(`${theater.id} ${day.date}: no usable movie/showtime data`);
            }
        }
    }

    const stats = getScheduleStats(schedule);
    if (stats.movies === 0 || stats.showtimes === 0) {
        errors.push('the complete scrape contains no usable data');
    }

    if (errors.length > 0) {
        throw new Error(`Scrape validation failed; existing data files were preserved:\n- ${errors.join('\n- ')}`);
    }

    return stats;
}

async function waitForShowtimesHtml(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let nextProgressLog = Date.now() + 30000;

    while (Date.now() < deadline) {
        try {
            // Check readiness and capture the document in one browser evaluation.
            // Queue-it can redirect a fully rendered AMC page away moments later.
            const html = await page.evaluate(selector => {
                if (!document.querySelector(selector)) return null;
                const main = document.querySelector('main');
                return main ? main.innerHTML : document.body.innerHTML;
            }, SHOWTIME_SELECTOR);
            if (html) return html;
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

    const diagnostic = await page.evaluate(() => ({
        title: document.title,
        text: document.body?.innerText?.slice(0, 300) || ''
    })).catch(() => ({ title: '', text: '' }));
    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for showtimes. `
        + `Final URL: ${page.url()}; title: ${diagnostic.title}; page text: ${diagnostic.text}`
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
            await page.goto('about:blank');
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            if (response && response.status() >= 400) {
                throw new Error(`AMC returned HTTP ${response.status()}`);
            }

            return await waitForShowtimesHtml(page, timeoutMs);
        } catch (error) {
            lastError = error;
            console.warn(`Attempt ${attempt}/${attempts} failed for ${theater.id} ${date}: ${error.message}`);
            if (attempt < attempts) await page.waitForTimeout(attempt * 2000);
        }
    }

    throw new Error(`Unable to load ${theater.id} ${date}: ${lastError?.message || 'unknown error'}`);
}

function writeScheduleAtomically(schedule, outputPaths = OUTPUT_PATHS) {
    const json = JSON.stringify(schedule, null, 2);
    const temporaryFiles = outputPaths.map(outputPath => `${outputPath}.${process.pid}.tmp`);

    try {
        temporaryFiles.forEach(tempPath => fs.writeFileSync(tempPath, json));
        outputPaths.forEach((outputPath, index) => fs.renameSync(temporaryFiles[index], outputPath));
    } finally {
        temporaryFiles.forEach(tempPath => {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        });
    }
}

async function scrapeAMC(options = {}) {
    const days = options.days || positiveInteger(process.env.SCRAPER_DAYS, DEFAULT_DAYS);
    const timeoutMs = options.timeoutMs
        || positiveInteger(process.env.SCRAPER_CONTENT_TIMEOUT_MS, DEFAULT_CONTENT_TIMEOUT_MS);
    const theaterFilter = options.theaterId || process.env.SCRAPER_THEATER;
    const selectedTheaters = theaterFilter
        ? theaters.filter(theater => theater.id === theaterFilter)
        : theaters;
    const dryRun = options.dryRun ?? process.env.SCRAPER_DRY_RUN === '1';
    const headless = options.headless ?? process.env.HEADLESS === 'true';
    const dates = getDates(days, options.now);

    if (selectedTheaters.length === 0) throw new Error(`Unknown theater: ${theaterFilter}`);

    console.log('Starting AMC Scraper...');
    console.log('Calendar dates to scrape:', dates);

    const browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    // Images and fonts are not needed for DOM parsing and make the daily run much slower.
    await context.route('**/*', route => {
        const resourceType = route.request().resourceType();
        return ['image', 'media', 'font'].includes(resourceType) ? route.abort() : route.continue();
    });

    const page = await context.newPage();
    const fullSchedule = { scrapedAt: new Date().toISOString(), theaters: {} };

    try {
        for (const theater of selectedTheaters) {
            fullSchedule.theaters[theater.id] = {
                id: theater.id,
                location: theater.location,
                schedule: []
            };

            for (const date of dates) {
                console.log(`Navigating to ${theater.id} for ${date}...`);
                const mainHtml = await loadShowtimesHtml(page, theater, date, { timeoutMs });
                const dailyData = parseScheduleHtml(mainHtml, date);
                const showtimeCount = dailyData.movies.reduce((count, movie) => (
                    count + movie.formats.reduce((formatCount, format) => formatCount + format.showtimes.length, 0)
                ), 0);

                if (dailyData.movies.length === 0 || showtimeCount === 0) {
                    throw new Error(`${theater.id} ${date}: rendered page contained no usable showtime data`);
                }

                console.log(`Extracted ${dailyData.movies.length} movies and ${showtimeCount} showtimes`);
                fullSchedule.theaters[theater.id].schedule.push(dailyData);
            }
        }

        const stats = validateSchedule(fullSchedule, selectedTheaters, dates);
        console.log(`Validated ${stats.days} days, ${stats.movies} movies, and ${stats.showtimes} showtimes.`);

        if (!dryRun) {
            writeScheduleAtomically(fullSchedule);
            console.log(`Successfully saved schedule data to ${OUTPUT_PATHS.join(' and ')}.`);
        } else {
            console.log('Dry run complete; data files were not changed.');
        }

        return fullSchedule;
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    scrapeAMC().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    buildShowtimesUrl,
    getDates,
    getScheduleStats,
    loadShowtimesHtml,
    parseScheduleHtml,
    scrapeAMC,
    validateSchedule,
    writeScheduleAtomically
};
