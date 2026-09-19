const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    buildMovieShowtimesUrl,
    buildShowtimesUrl,
    emptyScraperState,
    getCandidateProbeDates,
    getDates,
    inspectScheduleHtml,
    isCandidateDue,
    loadShowtimesHtml,
    mergeAdvanceSchedule,
    parseAdvanceCatalogHtml,
    parseMovieShowtimesHtml,
    parseReleaseDateText,
    parseScheduleHtml,
    scrapeAMC,
    theaters,
    updateCandidatePerformances,
    validateAdvanceState,
    validateSchedule
} = require('../scraper');

const theater = { id: 'amc-test-1', location: 'new-york' };

const completeHtml = `
    <main>
        <section id="example-movie-1">
            <h1><a href="/movies/example-movie-1">Example Movie</a></h1>
            <ul>
                <li><span class="uppercase">2 HR 5 MIN</span></li>
                <li><span class="uppercase" aria-label="MPAA Rating: PG13">PG13</span></li>
            </ul>
            <li role="listitem" aria-label="IMAX with Laser at AMC Showtimes">
                <h3><span>IMAX with Laser at AMC</span></h3>
                <ul id="example-attributes"><li>Reserved Seating</li></ul>
                <ul aria-label="Showtime Group Results">
                    <li><a href="/showtimes/123"><time>7:30 pm</time><span class="sr-only">Almost Full</span></a></li>
                </ul>
            </li>
        </section>
    </main>
`;

function navigationPage(statuses) {
    const waits = [];
    let navigation = 0;
    return {
        waits,
        async goto(url) {
            if (url === 'about:blank') return null;
            const status = statuses[navigation++];
            return { status: () => status, headers: () => ({ 'cf-ray': 'test-ray' }) };
        },
        url: () => 'https://www.amctheatres.com/test',
        async evaluate(fn, selector) {
            return selector
                ? { html: completeHtml, documentReady: true }
                : { title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' };
        },
        async waitForTimeout(ms) { waits.push(ms); }
    };
}

test('navigation backs off after AMC access errors and recovers to parsed content', async () => {
    for (const status of [403, 429, 503]) {
        const page = navigationPage([status, status, 200]);
        const html = await loadShowtimesHtml(page, theater, '2026-09-18');
        assert.deepEqual(page.waits, [30000, 60000]);
        assert.equal(parseScheduleHtml(html, '2026-09-18').movies.length, 1);
    }
});

test('persistent access blocks fail with diagnostics rather than returning blocked HTML', async () => {
    const page = navigationPage([403, 403, 403]);
    await assert.rejects(
        loadShowtimesHtml(page, theater, '2026-09-18'),
        /HTTP 403.*Cloudflare.*Sorry, you have been blocked.*Cloudflare Ray ID: test-ray/
    );
    assert.deepEqual(page.waits, [30000, 60000]);
});

test('ordinary navigation errors retain the short retry delay', async () => {
    const page = navigationPage([404, 200]);
    await loadShowtimesHtml(page, theater, '2026-09-18');
    assert.deepEqual(page.waits, [2000]);
});

function fakeBrowser() {
    return {
        async newContext() {
            return {
                async route() {},
                async newPage() { return {}; }
            };
        },
        async close() {}
    };
}

test('partial scrape publishes fresh days and carries forward failed future days', async (t) => {
    const configuredTheater = theaters[0];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-partial-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const outputPath = path.join(directory, 'data.json');
    const statePath = path.join(directory, 'state.json');
    const previous = {
        scrapedAt: '2026-09-14T12:00:00Z',
        nearTermThrough: '2026-09-27',
        theaters: {
            [configuredTheater.id]: { ...configuredTheater, schedule: [
                parseScheduleHtml(completeHtml, '2026-09-14'),
                parseScheduleHtml(completeHtml, '2026-09-15'),
                parseScheduleHtml(completeHtml, '2026-09-18')
            ] }
        }
    };
    previous.theaters[configuredTheater.id].schedule[1].movies[0].title = 'Stale Tuesday';
    previous.theaters[configuredTheater.id].schedule[2].movies[0].title = 'Friday from Monday';
    fs.writeFileSync(outputPath, JSON.stringify(previous));

    await assert.rejects(scrapeAMC({
        browser: fakeBrowser(), theaterId: configuredTheater.id, days: 4,
        now: new Date('2026-09-15T12:00:00Z'), advanceEnabled: false,
        outputPaths: [outputPath], statePath,
        async loadShowtimesHtml(_page, _theater, date) {
            if (date === '2026-09-18') throw new Error('rate limited');
            return completeHtml;
        }
    }), /Partial scrape published with 1 theater-date failures/);

    const published = JSON.parse(fs.readFileSync(outputPath));
    assert.deepEqual(published.theaters[configuredTheater.id].schedule.map(day => day.date), [
        '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'
    ]);
    assert.equal(published.theaters[configuredTheater.id].schedule[0].movies[0].title, 'Example Movie');
    assert.equal(published.theaters[configuredTheater.id].schedule[3].movies[0].title, 'Friday from Monday');
});

test('all-blocked run retains future cached data and skips further requests', async (t) => {
    const configuredTheater = theaters[0];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-blocked-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const outputPath = path.join(directory, 'data.json');
    const previous = { theaters: { [configuredTheater.id]: { ...configuredTheater, schedule: [
        parseScheduleHtml(completeHtml, '2026-09-15'),
        parseScheduleHtml(completeHtml, '2026-09-18')
    ] } } };
    fs.writeFileSync(outputPath, JSON.stringify(previous));
    let requests = 0;
    await assert.rejects(scrapeAMC({
        browser: fakeBrowser(), theaterId: configuredTheater.id, days: 4,
        now: new Date('2026-09-16T12:00:00Z'), advanceEnabled: false,
        outputPaths: [outputPath], statePath: path.join(directory, 'state.json'),
        async loadShowtimesHtml() {
            requests++;
            const error = new Error('AMC returned HTTP 403');
            error.status = 403;
            throw error;
        }
    }), /Partial scrape published with 4 theater-date failures/);
    assert.equal(requests, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath)).theaters[configuredTheater.id].schedule.map(day => day.date), [
        '2026-09-18'
    ]);
});

test('buildShowtimesUrl uses AMC current canonical date query', () => {
    assert.equal(
        buildShowtimesUrl(theater, '2026-08-21'),
        'https://www.amctheatres.com/movie-theatres/new-york/amc-test-1/showtimes?date=2026-08-21'
    );
    assert.equal(
        buildShowtimesUrl({ id: 'amc-newport-centre-11', location: 'jersey-city' }, '2026-08-23'),
        'https://www.amctheatres.com/movie-theatres/jersey-city/amc-newport-centre-11/showtimes?date=2026-08-23'
    );
});

test('scraper includes all supported Manhattan theaters', () => {
    const configured = new Map(theaters.map(item => [item.id, item.location]));
    [
        'amc-magic-johnson-harlem-9',
        'amc-84th-street-6',
        'amc-orpheum-7',
        'amc-19th-st-east-6',
        'amc-village-7'
    ].forEach(id => assert.equal(configured.get(id), 'new-york'));
});

test('buildMovieShowtimesUrl scopes a movie to a theater and optional date', () => {
    assert.equal(
        buildMovieShowtimesUrl('/movies/example-movie-123', theater, '2026-11-06'),
        'https://www.amctheatres.com/movies/example-movie-123/showtimes?theatre=amc-test-1&date=2026-11-06'
    );
});

test('getDates returns a rolling date window', () => {
    assert.deepEqual(
        getDates(3, new Date(2026, 7, 31, 12)),
        ['2026-08-31', '2026-09-01', '2026-09-02']
    );
});

test('parseScheduleHtml extracts movie metadata, formats, and showtimes', () => {
    assert.deepEqual(parseScheduleHtml(completeHtml, '2026-08-21'), {
        date: '2026-08-21',
        movies: [{
            title: 'Example Movie',
            link: '/movies/example-movie-1',
            runtime: '2 HR 5 MIN',
            rating: 'PG13',
            formats: [{
                formats: ['IMAX with Laser at AMC', 'Reserved Seating'],
                showtimes: [{ time: '7:30 pm', performanceId: '123', alert: 'Almost Full' }]
            }]
        }]
    });
});

test('parseScheduleHtml rejects a partially rendered movie header', () => {
    const parsed = parseScheduleHtml('<section id="movie"><h1><a href="/movie">Movie</a></h1></section>', '2026-08-21');
    assert.deepEqual(parsed.movies, []);
});

test('schedule readiness rejects streamed showtimes before they join their movie section', () => {
    const partialHtml = `
        <main>
            <section id="example-movie-1">
                <h1><a href="/movies/example-movie-1">Example Movie</a></h1>
            </section>
            <div hidden>
                <ul aria-label="Showtime Group Results">
                    <li><a href="/showtimes/123"><time>7:30 pm</time></a></li>
                </ul>
            </div>
        </main>`;

    assert.deepEqual(inspectScheduleHtml(partialHtml), {
        ready: false,
        totalShowtimeLinks: 1,
        nestedShowtimeLinks: 0,
        parsedMovies: 0,
        parsedShowtimes: 0
    });
    assert.deepEqual(inspectScheduleHtml(completeHtml), {
        ready: true,
        totalShowtimeLinks: 1,
        nestedShowtimeLinks: 1,
        parsedMovies: 1,
        parsedShowtimes: 1
    });
});

test('validateSchedule accepts complete data and rejects blank data', () => {
    const date = '2026-08-21';
    const dailyData = parseScheduleHtml(completeHtml, date);
    const complete = {
        theaters: {
            [theater.id]: { ...theater, schedule: [dailyData] }
        }
    };
    assert.deepEqual(validateSchedule(complete, [theater], [date]), {
        days: 1,
        movies: 1,
        showtimes: 1
    });

    const blank = {
        theaters: {
            [theater.id]: { ...theater, schedule: [{ date, movies: [] }] }
        }
    };
    assert.throws(
        () => validateSchedule(blank, [theater], [date]),
        /existing data files were preserved/
    );
});

test('advance catalog parser keeps only ticketable movie cards', () => {
    const html = `
        <main>
            <article>
                <a href="/movies/future-film-123" aria-label="Get Tickets for Future Film"><h3>Future Film</h3></a>
                <p>November 6, 2026</p><button>Advance Tickets</button>
            </article>
            <article>
                <a href="/movies/not-on-sale-456"><h3>Not On Sale</h3></a>
                <button>Learn More</button>
            </article>
        </main>`;
    assert.deepEqual(parseAdvanceCatalogHtml(html), [{
        moviePath: '/movies/future-film-123',
        title: 'Future Film',
        releaseDateText: 'November 6, 2026'
    }]);
});

test('candidate probing is bounded to the published opening window', () => {
    assert.equal(parseReleaseDateText('November 6, 2026'), '2026-11-06');
    assert.deepEqual(
        getCandidateProbeDates({ releaseDateText: 'November 6, 2026' }, '2026-09-03'),
        ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']
    );
    assert.deepEqual(getCandidateProbeDates({ releaseDateText: null }, '2026-09-03'), []);
});

test('movie showtime parser extracts configured theaters and performance IDs', () => {
    const html = `
        <main>
            <ul><li>2 HR 5 MIN</li></ul>
            <span aria-label="MPAA Rating: PG13">PG13</span>
            <section id="amc-test-1">
                <a href="/movie-theatres/new-york/amc-test-1">AMC Test 1</a>
                <li role="listitem" aria-label="Dolby Cinema at AMC Showtimes">
                    <h3><span>Dolby Cinema at AMC</span></h3>
                    <ul id="dolby-attributes"><li>Reserved Seating</li></ul>
                    <ul aria-label="Showtime Group Results">
                        <li><a href="/showtimes/987"><time>7:00pm</time></a></li>
                    </ul>
                </li>
            </section>
        </main>`;
    const parsed = parseMovieShowtimesHtml(
        html,
        { moviePath: '/movies/future-film-123', title: 'Future Film' },
        '2026-11-06',
        [theater]
    );
    assert.deepEqual(parsed.observedTheaters, ['amc-test-1']);
    assert.equal(parsed.performances.length, 1);
    assert.deepEqual(parsed.performances[0], {
        key: '987',
        performanceId: '987',
        theaterId: 'amc-test-1',
        date: '2026-11-06',
        time: '7:00pm',
        alert: null,
        formats: ['Dolby Cinema at AMC', 'Reserved Seating'],
        movie: {
            title: 'Future Film',
            link: '/movies/future-film-123',
            runtime: '2 HR 5 MIN',
            rating: 'PG13'
        }
    });
});

test('advance state retains one verified miss, removes the second, and validates future records', () => {
    const state = emptyScraperState();
    const candidate = { moviePath: '/movies/future-film-123', title: 'Future Film' };
    const performance = {
        key: '987', performanceId: '987', theaterId: theater.id,
        date: '2026-11-06', time: '7:00pm', alert: null,
        formats: ['Dolby Cinema'],
        movie: { title: candidate.title, link: candidate.moviePath, runtime: null, rating: null }
    };
    updateCandidatePerformances(state, candidate, [performance], '2026-08-21T12:00:00Z', '2026-09-03');
    assert.equal(state.performances['987'].missCount, 0);
    assert.deepEqual(validateAdvanceState(state, [theater], '2026-09-03'), { candidates: 0, performances: 1 });

    updateCandidatePerformances(state, candidate, [], '2026-08-28T12:00:00Z', '2026-09-03');
    assert.equal(state.performances['987'].missCount, 1);
    updateCandidatePerformances(state, candidate, [], '2026-09-04T12:00:00Z', '2026-09-03');
    assert.equal(state.performances['987'], undefined);
});

test('merge keeps the authoritative near window and appends sparse advance dates', () => {
    const near = {
        scrapedAt: '2026-08-21T12:00:00Z',
        theaters: {
            [theater.id]: { ...theater, schedule: [parseScheduleHtml(completeHtml, '2026-08-21')] }
        }
    };
    const state = emptyScraperState();
    state.performances['987'] = {
        key: '987', performanceId: '987', theaterId: theater.id,
        date: '2026-11-06', time: '7:00pm', alert: null,
        formats: ['Dolby Cinema'], missCount: 0,
        movie: { title: 'Future Film', link: '/movies/future-film-123', runtime: '2 HR', rating: 'PG13' }
    };
    const merged = mergeAdvanceSchedule(near, state, [theater], '2026-09-03');
    assert.equal(merged.nearTermThrough, '2026-09-03');
    assert.deepEqual(merged.theaters[theater.id].schedule.map(day => day.date), ['2026-08-21', '2026-11-06']);
    assert.equal(merged.theaters[theater.id].schedule[1].movies[0].formats[0].showtimes[0].performanceId, '987');
});

test('candidate cadence is daily near showtime dates and weekly farther out', () => {
    const state = emptyScraperState();
    const candidate = {
        moviePath: '/movies/future-film-123',
        status: 'active',
        lastSuccessfulCheckAt: '2026-08-20T12:00:00Z'
    };
    state.performances['987'] = {
        movie: { link: candidate.moviePath }, date: '2026-09-05'
    };
    assert.equal(isCandidateDue(candidate, state, '2026-08-21', Date.parse('2026-08-21T12:00:00Z')), true);
    state.performances['987'].date = '2026-11-06';
    assert.equal(isCandidateDue(candidate, state, '2026-08-21', Date.parse('2026-08-21T12:00:00Z')), false);
});
