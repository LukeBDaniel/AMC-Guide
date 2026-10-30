const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAmcClient } = require('../amc-api');
const {
    buildSchedule,
    dateInTimeZone,
    fetchShowtimes,
    formatRuntime,
    formatTime,
    scheduleDate,
    showtimeAlert,
    showtimeFormats,
    theaters,
    toTheaterSchedule
} = require('../fetch-showtimes');

const attr = (code, name) => ({ code, name, description: name });
const AMENITIES = [
    attr('CLOSEDCAPTION', 'Closed Caption'),
    attr('DESCRIPTIVEVIDEO', 'Audio Description'),
    attr('RECLINERSEATING', 'AMC Signature Recliners'),
    attr('RESERVEDSEATING', 'Reserved Seating')
];

let nextId = 1000;
function apiShowtime(overrides = {}) {
    return {
        id: nextId++,
        movieId: 79697,
        movieName: 'Resident Evil',
        showDateTimeLocal: '2026-10-30T19:00:00',
        isSoldOut: false,
        isAlmostSoldOut: false,
        isCanceled: false,
        runTime: 94,
        mpaaRating: 'R',
        premiumFormat: '',
        movieUrl: 'https://www.amctheatres.com/movies/resident-evil-79697',
        discountMatineeMessage: null,
        attributes: AMENITIES,
        ...overrides
    };
}

// Minimal stand-in for fetch: routes requests to a handler and records URLs.
function fakeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const { status = 200, body } = await handler(url, calls.length);
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { fetchImpl, calls };
}

test('times, runtimes, and late-night dates match the scraped data format', () => {
    assert.equal(formatTime('2026-10-30T19:00:00'), '7:00pm');
    assert.equal(formatTime('2026-10-30T12:05:00'), '12:05pm');
    assert.equal(formatTime('2026-10-31T00:15:00'), '12:15am');
    assert.equal(formatTime('2026-10-30T09:30:00'), '9:30am');
    assert.equal(formatRuntime(116), '1 HR 56 MIN');
    assert.equal(formatRuntime(120), '2 HR 0 MIN');
    assert.equal(formatRuntime(0), null);
    assert.equal(formatRuntime(undefined), null);
    // Shows before 5am belong to the previous evening, as the frontend assumes.
    assert.equal(scheduleDate('2026-11-01T00:30:00'), '2026-10-31');
    assert.equal(scheduleDate('2026-11-01T04:59:00'), '2026-10-31');
    assert.equal(scheduleDate('2026-11-01T05:00:00'), '2026-11-01');
    assert.equal(scheduleDate('2026-01-01T01:00:00'), '2025-12-31');
});

test('the Eastern-time calendar date is used regardless of runner time zone', () => {
    // 02:00 UTC on Oct 30 is still the evening of Oct 29 in New York.
    assert.equal(dateInTimeZone(new Date('2026-10-30T02:00:00Z')), '2026-10-29');
    assert.equal(dateInTimeZone(new Date('2026-10-30T12:00:00Z')), '2026-10-30');
});

test('formats lead with the experience attribute, or Standard when only amenities exist', () => {
    assert.deepEqual(showtimeFormats(apiShowtime()), [
        'Standard', 'Closed Caption', 'Audio Description', 'AMC Signature Recliners', 'Reserved Seating'
    ]);

    const imax = showtimeFormats(apiShowtime({
        premiumFormat: 'IMAX at AMC',
        attributes: [attr('RESERVEDSEATING', 'Reserved Seating'), attr('IMAXWITHLASERATAMC', 'IMAX with Laser at AMC')]
    }));
    assert.deepEqual(imax, ['IMAX with Laser at AMC', 'Reserved Seating']);

    const language = showtimeFormats(apiShowtime({
        attributes: [attr('LASERATAMC', 'Laser at AMC'), attr('JAPANESEENGLISHSUBTITLE', 'Japanese Spoken with English Subtitles')]
    }));
    assert.deepEqual(language, ['Laser at AMC', 'Japanese Spoken with English Subtitles']);

    // A premium format without a matching attribute still is not Standard.
    assert.deepEqual(showtimeFormats(apiShowtime({ premiumFormat: 'XL at AMC', attributes: [] })), ['XL at AMC']);
});

test('internal attributes are dropped and kept attributes use their display labels', () => {
    const formats = showtimeFormats(apiShowtime({
        attributes: [
            ...AMENITIES,
            attr('AONELIVE', 'AOneLive'),
            attr('DCDCLIVE', 'DCDC Live'),
            attr('EVENT', 'Event'),
            attr('DISNEYRWDS', 'Pay with Disney Rewards Redemption Card'),
            attr('NOTRAILER', 'No Trailers'),
            attr('NOTRAILERS', 'NoTrailers'),
            attr('PARENTALESCORTPOLICYUNDER18AFTER6PM', 'Adult Supervision Required (Under 18 Starting 6pm)')
        ]
    }));
    for (const hidden of ['AOneLive', 'DCDC Live', 'NoTrailers', 'Pay with Disney Rewards Redemption Card']) {
        assert.ok(!formats.includes(hidden), hidden);
    }
    assert.ok(formats.includes('Event'));
    assert.ok(formats.includes('Adult Supervision Required (Under 18 Starting 6pm)'));
    assert.equal(formats.filter((f) => f === 'No Trailers').length, 1);

    // NOTRAILERS alone still produces the label the frontend uses to skip trailer padding.
    const alone = showtimeFormats(apiShowtime({ attributes: [attr('NOTRAILERS', 'NoTrailers')] }));
    assert.deepEqual(alone, ['Standard', 'No Trailers']);
});

test('frontend uses Event as a category signal and files new tags under Other', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const eventAttrs = [...AMENITIES, attr('EVENT', 'Event'), attr('INCLINTER', 'Includes Intermission')];
    const schedule = toTheaterSchedule([
        apiShowtime({ id: 20, movieId: 1, movieName: 'Heated Rivalry: Episode 1 & 2', attributes: eventAttrs }),
        apiShowtime({ id: 21, movieId: 1, movieName: 'Heated Rivalry: Episode 1 & 2', attributes: eventAttrs, showDateTimeLocal: '2026-10-30T21:00:00' }),
        apiShowtime({
            id: 22,
            attributes: [
                ...AMENITIES,
                attr('PARENTALESCORTPOLICYUNDER18AFTER6PM', 'Adult Supervision Required (Under 18 Starting 6pm)'),
                attr('LIVE', 'Live event'),
                attr('MOMMYME', 'Mommy & Me Movies')
            ]
        })
    ]);
    const result = flattenScheduleData({
        nearTermThrough: '2026-11-12',
        theaters: { 'amc-empire-25': { id: 'amc-empire-25', location: 'new-york', schedule } }
    });
    const eventKey = result.showtimes.find((s) => s.id === '20').movieKey;
    assert.ok(result.groupedMovies['Events'].includes(eventKey));
    assert.ok(result.groupedMovies['New Movies'].includes('Resident Evil'));
    assert.ok(!result.formats.includes('Event'));
    for (const tag of ['Adult Supervision Required (Under 18 Starting 6pm)', 'Includes Intermission', 'Live event', 'Mommy & Me Movies']) {
        assert.ok(result.others.includes(tag), tag);
        assert.ok(!result.formats.includes(tag), tag);
    }
});

test('alerts combine discounts with availability like the website badges', () => {
    assert.equal(showtimeAlert(apiShowtime()), null);
    assert.equal(showtimeAlert(apiShowtime({ discountMatineeMessage: '20% OFF' })), '20% OFF');
    assert.equal(showtimeAlert(apiShowtime({ isAlmostSoldOut: true })), 'Almost Full');
    assert.equal(
        showtimeAlert(apiShowtime({ discountMatineeMessage: '20% OFF', isAlmostSoldOut: true })),
        '20% OFF, Almost Full'
    );
    assert.equal(showtimeAlert(apiShowtime({ isSoldOut: true, isAlmostSoldOut: true })), 'Sold Out');
});

test('API showtimes become the day -> movie -> format group structure', () => {
    const imaxAttrs = [attr('IMAXWITHLASERATAMC', 'IMAX with Laser at AMC')];
    const schedule = toTheaterSchedule([
        apiShowtime({ id: 3, showDateTimeLocal: '2026-10-30T21:00:00' }),
        apiShowtime({ id: 1, showDateTimeLocal: '2026-10-30T13:00:00', discountMatineeMessage: '20% OFF' }),
        apiShowtime({ id: 2, showDateTimeLocal: '2026-10-30T16:00:00', premiumFormat: 'IMAX at AMC', attributes: imaxAttrs }),
        apiShowtime({ id: 4, showDateTimeLocal: '2026-10-31T00:30:00' }),
        apiShowtime({ id: 5, showDateTimeLocal: '2026-10-30T18:00:00', isCanceled: true }),
        apiShowtime({ id: 7, showDateTimeLocal: '2026-10-30T17:00:00', attributes: [...AMENITIES, attr('PRIVATE', 'Private Event')] }),
        apiShowtime({
            id: 6, movieId: 1, movieName: 'Club Kid with Q&A ', runTime: 120, mpaaRating: '',
            movieUrl: 'https://www.amctheatres.com/movies/club-kid-1', showDateTimeLocal: '2026-10-31T19:00:00'
        })
    ]);

    assert.deepEqual(schedule.map((day) => day.date), ['2026-10-30', '2026-10-31']);
    const [friday, saturday] = schedule;
    assert.equal(friday.movies.length, 1);
    const movie = friday.movies[0];
    assert.equal(movie.title, 'Resident Evil');
    assert.equal(movie.link, '/movies/resident-evil-79697');
    assert.equal(movie.runtime, '1 HR 34 MIN');
    assert.equal(movie.rating, 'R');
    assert.deepEqual(movie.formats.map((group) => group.formats[0]), ['Standard', 'IMAX with Laser at AMC']);
    assert.deepEqual(movie.formats[0].showtimes, [
        { time: '1:00pm', performanceId: '1', alert: '20% OFF' },
        { time: '9:00pm', performanceId: '3', alert: null },
        { time: '12:30am', performanceId: '4', alert: null }
    ]);
    assert.deepEqual(movie.formats[1].showtimes.map((s) => s.performanceId), ['2']);

    assert.equal(saturday.movies[0].title, 'Club Kid with Q&A');
    assert.equal(saturday.movies[0].rating, null);
});

test('frontend processes API-built data with the expected tags', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const schedule = toTheaterSchedule([
        apiShowtime({ id: 10, showDateTimeLocal: '2026-10-30T19:00:00' }),
        apiShowtime({
            id: 11, showDateTimeLocal: '2026-10-30T23:30:00', premiumFormat: 'IMAX at AMC',
            attributes: [attr('IMAXWITHLASERATAMC', 'IMAX with Laser at AMC'), attr('RESERVEDSEATING', 'Reserved Seating')]
        }),
        apiShowtime({ id: 12, showDateTimeLocal: '2026-10-31T01:00:00' })
    ]);
    const result = flattenScheduleData({
        nearTermThrough: '2026-11-12',
        theaters: { 'amc-empire-25': { id: 'amc-empire-25', location: 'new-york', schedule } }
    });
    const byId = Object.fromEntries(result.showtimes.map((s) => [s.id, s]));
    assert.ok(byId['10'].format.includes('Standard'));
    assert.ok(byId['10'].format.includes('Included in A-List'));
    assert.ok(byId['11'].format.includes('IMAX'));
    assert.ok(byId['11'].format.includes('Laser'));
    assert.ok(!byId['11'].format.includes('Standard'));
    assert.equal(byId['10'].runtimeMinutes, 94 + 30); // frontend pads for trailers
    // 1am stays on the Friday timeline, after midnight.
    assert.equal(byId['12'].date, '2026-10-30');
    assert.equal(byId['12'].timeMinutes, 25 * 60);
    assert.ok(result.groupedMovies['New Movies'].includes('Resident Evil'));
});

test('client sends the vendor key, follows pagination, and checks counts', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
        const page = new URL(url).searchParams.get('page-number') || '1';
        const showtimes = page === '1' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
        const next = page === '1'
            ? { href: 'https://api.amctheatres.com/v2/theatres/552/showtimes?page-number=2&page-size=10000' }
            : undefined;
        return { body: { count: 3, _links: { next }, _embedded: { showtimes } } };
    });
    const client = createAmcClient({ vendorKey: 'test-key', fetchImpl });
    const showtimes = await client.getTheatreShowtimes(552);
    assert.deepEqual(showtimes.map((s) => s.id), [1, 2, 3]);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/v2\/theatres\/552\/showtimes\?page-size=10000$/);
    assert.equal(calls[0].headers['X-AMC-Vendor-Key'], 'test-key');

    const short = createAmcClient({
        vendorKey: 'test-key',
        fetchImpl: fakeFetch(() => ({ body: { count: 5, _links: {}, _embedded: { showtimes: [{ id: 1 }] } } })).fetchImpl
    });
    await assert.rejects(short.getTheatreShowtimes(552), /expected 5 showtimes, received 1/);
});

test('client retries transient failures but not client errors', async () => {
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };

    const flaky = fakeFetch((url, attempt) => (attempt < 3
        ? { status: 503, body: {} }
        : { body: { count: 0, _links: {}, _embedded: { showtimes: [] } } }));
    const client = createAmcClient({ vendorKey: 'k', fetchImpl: flaky.fetchImpl, sleep });
    assert.deepEqual(await client.getTheatreShowtimes(1), []);
    assert.equal(flaky.calls.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);

    const missing = fakeFetch(() => ({ status: 404, body: { errors: [{ message: 'No showtimes found.' }] } }));
    const strict = createAmcClient({ vendorKey: 'k', fetchImpl: missing.fetchImpl, sleep });
    await assert.rejects(strict.getTheatreShowtimes(1), (error) => error.status === 404 && /No showtimes found/.test(error.message));
    assert.equal(missing.calls.length, 1);
});

test('client refuses to run without a key or to send it to another host', async () => {
    assert.throws(() => createAmcClient({ vendorKey: '' }), /AMC_VENDOR_KEY is not set/);
    const { fetchImpl, calls } = fakeFetch(() => ({ body: {} }));
    const client = createAmcClient({ vendorKey: 'k', fetchImpl });
    await assert.rejects(client.apiGet('https://example.com/steal'), /Refusing to send vendor key/);
    assert.equal(calls.length, 0);
});

const NOW = new Date('2026-10-30T12:00:00Z');
const twoTheaters = theaters.slice(0, 2);

function stubClient(byApiId) {
    return {
        getTheatreShowtimes: async (apiId) => {
            const result = byApiId[apiId];
            if (result instanceof Error) throw result;
            return result;
        }
    };
}

test('a failed theatre keeps its previously published future days', async () => {
    const previousSchedule = {
        theaters: {
            [twoTheaters[1].id]: {
                schedule: [
                    { date: '2026-10-29', movies: [{ title: 'Old' }] },
                    { date: '2026-10-31', movies: [{ title: 'Kept' }] }
                ]
            }
        }
    };
    const { schedule, failures } = await buildSchedule({
        now: NOW,
        theaters: twoTheaters,
        previousSchedule,
        client: stubClient({
            [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-30T19:00:00' })],
            [twoTheaters[1].apiId]: new Error('HTTP 500')
        })
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /HTTP 500/);
    assert.equal(schedule.nearTermThrough, '2026-11-12');
    assert.equal(schedule.theaters[twoTheaters[0].id].schedule[0].movies[0].title, 'Resident Evil');
    assert.deepEqual(schedule.theaters[twoTheaters[1].id].schedule.map((d) => d.date), ['2026-10-31']);
});

test('a theatre with no showtimes in the coming week is treated as a failure', async () => {
    const { failures } = await buildSchedule({
        now: NOW,
        theaters: twoTheaters.slice(0, 1),
        client: stubClient({ [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-12-25T19:00:00' })] })
    });
    assert.match(failures[0], /no showtimes between 2026-10-30 and 2026-11-05/);
});

test('fetchShowtimes writes all outputs, and preserves them when everything fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-api-'));
    const outputPaths = [path.join(dir, 'data.json'), path.join(dir, 'public.json')];
    const ok = stubClient({
        [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-30T19:00:00' })],
        [twoTheaters[1].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-31T19:00:00' })]
    });

    await fetchShowtimes({ now: NOW, theaters: twoTheaters, client: ok, outputPaths, dryRun: true });
    assert.ok(!fs.existsSync(outputPaths[0]));

    const schedule = await fetchShowtimes({ now: NOW, theaters: twoTheaters, client: ok, outputPaths });
    for (const outputPath of outputPaths) {
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), schedule);
    }

    const before = fs.readFileSync(outputPaths[0], 'utf8');
    const down = stubClient({ [twoTheaters[0].apiId]: new Error('down'), [twoTheaters[1].apiId]: new Error('down') });
    await assert.rejects(
        fetchShowtimes({ now: new Date('2027-03-01T12:00:00Z'), theaters: twoTheaters, client: down, outputPaths }),
        /No usable showtimes; existing data files were preserved/
    );
    assert.equal(fs.readFileSync(outputPaths[0], 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'public.json']);
});
