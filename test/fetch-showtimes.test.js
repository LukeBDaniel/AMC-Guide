const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAmcClient } = require('../amc-api');
const {
    DATA_VERSION,
    buildSchedule,
    compactSchedule,
    dateInTimeZone,
    fetchShowtimes,
    scheduleDate,
    showtimeAlert,
    showtimeTags,
    theaters,
    toTheaterShowtimes
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
    const showtime = {
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
    return {
        purchaseUrl: `https://www.amctheatres.com/showtimes/all/${showtime.showDateTimeLocal.slice(0, 10)}/empire/all/${showtime.id}`,
        ...showtime
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

test('late-night shows belong to the previous evening', () => {
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

test('tags use display labels, with Standard when only amenities exist', () => {
    assert.deepEqual(showtimeTags(apiShowtime()), [
        'Standard', 'Closed Caption', 'Audio Description', 'Signature Recliners', 'Reserved Seating', 'Included in A-List'
    ]);

    const imax = showtimeTags(apiShowtime({
        premiumFormat: 'IMAX at AMC',
        attributes: [attr('RESERVEDSEATING', 'Reserved Seating'), attr('IMAXWITHLASERATAMC', 'IMAX with Laser at AMC')]
    }));
    assert.deepEqual(imax, ['Reserved Seating', 'IMAX with Laser', 'IMAX', 'Laser', 'Included in A-List']);

    const language = showtimeTags(apiShowtime({
        attributes: [attr('LASERATAMC', 'Laser at AMC'), attr('JAPANESEENGLISHSUBTITLE', 'Japanese Spoken with English Subtitles')]
    }));
    assert.deepEqual(language, ['Laser', 'Japanese Spoken with English Subtitles', 'Included in A-List']);

    // A premium format without a matching attribute is still not Standard.
    assert.deepEqual(showtimeTags(apiShowtime({ premiumFormat: 'XL at AMC', attributes: [] })), ['Included in A-List']);
    assert.deepEqual(
        showtimeTags(apiShowtime({ attributes: [attr('AMCCLUBROCKERS', 'AMC Club Rockers'), attr('NOALIST', 'Excluded from A-List')] })),
        ['Standard', 'Club Rockers', 'Excluded from A-List']
    );
});

test('internal, restriction, and trailer attributes are not tags', () => {
    const tags = showtimeTags(apiShowtime({
        attributes: [
            ...AMENITIES,
            attr('AONELIVE', 'AOneLive'),
            attr('DCDCLIVE', 'DCDC Live'),
            attr('DISNEYRWDS', 'Pay with Disney Rewards Redemption Card'),
            attr('EXCLDISDAY', 'Excluded from 50% off Discount'),
            attr('NOGREENRED', 'No Passes'),
            attr('TREATASR', 'ID Required'),
            attr('NOTRAILER', 'No Trailers'),
            attr('NOTRAILERS', 'NoTrailers'),
            attr('EVENT', 'Event'),
            attr('PARENTALESCORTPOLICYUNDER18AFTER6PM', 'Adult Supervision Required (Under 18 Starting 6pm)')
        ]
    }));
    for (const hidden of ['AOneLive', 'DCDC Live', 'Pay with Disney Rewards Redemption Card', 'Excluded from 50% off Discount',
        'No Passes', 'ID Required', 'No Trailers', 'NoTrailers']) {
        assert.ok(!tags.includes(hidden), hidden);
    }
    assert.ok(tags.includes('Event'));
    assert.ok(tags.includes('Adult Supervision Required (Under 18 Starting 6pm)'));
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

test('API showtimes become movie entries and showtime rows', () => {
    const { movies, showtimes } = toTheaterShowtimes('amc-empire-25', [
        apiShowtime({ id: 1, showDateTimeLocal: '2026-10-30T13:00:00', discountMatineeMessage: '20% OFF' }),
        apiShowtime({ id: 2, showDateTimeLocal: '2026-10-31T00:30:00', attributes: [...AMENITIES, attr('NOTRAILERS', 'NoTrailers')] }),
        apiShowtime({ id: 3, showDateTimeLocal: '2026-10-30T18:00:00', isCanceled: true }),
        apiShowtime({ id: 4, showDateTimeLocal: '2026-10-30T17:00:00', attributes: [...AMENITIES, attr('PRIVATE', 'Private Event')] }),
        apiShowtime({ id: 5, movieId: 1, movieName: 'Club Kid with Q&A ', runTime: 0, mpaaRating: '', movieUrl: undefined })
    ]);

    assert.deepEqual(movies, {
        79697: { title: 'Resident Evil', url: 'https://www.amctheatres.com/movies/resident-evil-79697', runtime: 94, rating: 'R' },
        1: { title: 'Club Kid with Q&A', url: null, runtime: null, rating: null }
    });
    assert.deepEqual(showtimes.map((row) => row.id), ['1', '2', '5']);
    assert.deepEqual(showtimes[0], {
        id: '1',
        theater: 'amc-empire-25',
        movie: '79697',
        date: '2026-10-30',
        startsAt: '2026-10-30T13:00:00',
        runtime: 94,
        tags: showtimeTags(apiShowtime()),
        noTrailers: false,
        alert: '20% OFF',
        purchaseUrl: 'https://www.amctheatres.com/showtimes/all/2026-10-30/empire/all/1'
    });
    assert.equal(showtimes[1].date, '2026-10-30');
    assert.equal(showtimes[1].noTrailers, true);
});

test('compaction shares tag lists, derives purchase URLs, and drops defaults', () => {
    const rows = toTheaterShowtimes('amc-empire-25', [
        apiShowtime({ id: 10, showDateTimeLocal: '2026-10-30T19:00:00' }),
        apiShowtime({ id: 11, showDateTimeLocal: '2026-10-31T01:00:00', isAlmostSoldOut: true }),
        apiShowtime({ id: 12, showDateTimeLocal: '2026-10-30T21:00:00', runTime: 99, purchaseUrl: 'https://www.amctheatres.com/other/12' }),
        apiShowtime({ id: 13, showDateTimeLocal: '2026-10-30T22:00:00', purchaseUrl: undefined })
    ]);
    const data = compactSchedule({
        theaters: [{ id: 'amc-empire-25', name: 'AMC Empire 25', location: 'new-york' }],
        movies: rows.movies,
        showtimes: rows.showtimes
    });

    assert.equal(data.theaters[0].purchaseUrlTemplate, 'https://www.amctheatres.com/showtimes/all/{startDate}/empire/all/{id}');
    assert.deepEqual(data.tagSets, [showtimeTags(apiShowtime())]);
    assert.equal(data.movies['79697'].runtime, 94);
    const [a, b, c, d] = data.showtimes;
    // Fully described by shared data: only the core fields remain.
    assert.deepEqual(a, { id: '10', theater: 'amc-empire-25', movie: '79697', date: '2026-10-30', startsAt: '2026-10-30T19:00:00', tags: 0 });
    assert.equal(b.alert, 'Almost Full');
    assert.equal(b.date, '2026-10-30');
    assert.equal(c.runtime, 99);
    assert.equal(c.purchaseUrl, 'https://www.amctheatres.com/other/12');
    assert.equal(d.purchaseUrl, null);
});

test('frontend output from compact data matches the API', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const api = [
        apiShowtime({ id: 20, showDateTimeLocal: '2026-10-30T19:00:00' }),
        apiShowtime({
            id: 21, showDateTimeLocal: '2026-10-30T23:30:00', premiumFormat: 'IMAX at AMC',
            attributes: [attr('IMAXWITHLASERATAMC', 'IMAX with Laser at AMC'), attr('NOTRAILER', 'No Trailers')]
        }),
        apiShowtime({ id: 22, showDateTimeLocal: '2026-10-31T01:05:00', runTime: 100, isSoldOut: true }),
        apiShowtime({ id: 23, movieId: 2, movieName: 'Mystery Film', runTime: null, showDateTimeLocal: '2026-10-30T20:00:00' })
    ];
    const rows = toTheaterShowtimes('amc-empire-25', api);
    const data = compactSchedule({
        version: DATA_VERSION,
        nearTermThrough: '2026-11-12',
        theaters: [{ id: 'amc-empire-25', name: 'AMC Empire 25', location: 'new-york' }],
        movies: rows.movies,
        showtimes: rows.showtimes
    });
    const result = flattenScheduleData(data);
    const byId = Object.fromEntries(result.showtimes.map((s) => [s.id, s]));

    assert.equal(byId['20'].time, '7:00pm');
    assert.equal(byId['20'].timeMinutes, 19 * 60);
    assert.equal(byId['20'].runtime, '1h 34m');
    assert.equal(byId['20'].runtimeMinutes, 94 + 30); // padded for trailers
    assert.ok(byId['20'].format.includes('Standard'));
    assert.equal(byId['20'].alert, null);
    assert.equal(byId['20'].link, 'https://www.amctheatres.com/movies/resident-evil-79697');
    assert.equal(byId['21'].runtimeMinutes, 94); // No Trailers: no padding
    assert.ok(byId['21'].format.includes('IMAX') && byId['21'].format.includes('Laser'));
    assert.ok(!byId['21'].format.includes('Standard'));
    // 1:05am stays on the Friday timeline, after midnight, with its own runtime.
    assert.equal(byId['22'].date, '2026-10-30');
    assert.equal(byId['22'].time, '1:05am');
    assert.equal(byId['22'].timeMinutes, 25 * 60 + 5);
    assert.equal(byId['22'].runtime, '1h 40m');
    assert.equal(byId['22'].alert, 'Sold Out');
    assert.equal(byId['23'].runtime, '');
    assert.equal(byId['23'].runtimeMinutes, 120);
    for (const showtime of api) {
        assert.equal(byId[String(showtime.id)].ticketLink, showtime.purchaseUrl);
    }
    assert.deepEqual(result.theaters, { 'New York': [{ id: 'amc-empire-25', name: 'Empire' }] });
    assert.ok(result.groupedMovies['New Movies'].includes('Resident Evil'));
});

test('frontend uses Event as a category signal and files new tags under Other', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const eventAttrs = [...AMENITIES, attr('EVENT', 'Event'), attr('INCLINTER', 'Includes Intermission')];
    const rows = toTheaterShowtimes('amc-empire-25', [
        apiShowtime({ id: 30, movieId: 1, movieName: 'Heated Rivalry: Episode 1 & 2', attributes: eventAttrs }),
        apiShowtime({ id: 31, movieId: 1, movieName: 'Heated Rivalry: Episode 1 & 2', attributes: eventAttrs, showDateTimeLocal: '2026-10-30T21:00:00' }),
        apiShowtime({
            id: 32,
            attributes: [
                ...AMENITIES,
                attr('PARENTALESCORTPOLICYUNDER18AFTER6PM', 'Adult Supervision Required (Under 18 Starting 6pm)'),
                attr('LIVE', 'Live event'),
                attr('MOMMYME', 'Mommy & Me Movies')
            ]
        })
    ]);
    const result = flattenScheduleData(compactSchedule({
        version: DATA_VERSION,
        nearTermThrough: '2026-11-12',
        theaters: [{ id: 'amc-empire-25', name: 'AMC Empire 25', location: 'new-york' }],
        movies: rows.movies,
        showtimes: rows.showtimes
    }));
    const eventKey = result.showtimes.find((s) => s.id === '30').movieKey;
    assert.ok(result.groupedMovies['Events'].includes(eventKey));
    assert.ok(result.groupedMovies['New Movies'].includes('Resident Evil'));
    assert.ok(!result.formats.includes('Event'));
    for (const tag of ['Adult Supervision Required (Under 18 Starting 6pm)', 'Includes Intermission', 'Live event', 'Mommy & Me Movies']) {
        assert.ok(result.others.includes(tag), tag);
        assert.ok(!result.formats.includes(tag), tag);
    }
});

test('frontend groups theatres by state using their display names', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const theaterList = [
        { id: 'amc-19th-st-east-6', name: 'AMC 19th St. East 6', location: 'new-york' },
        { id: 'amc-clifton-commons-16', name: 'AMC Clifton Commons 16', location: 'new-jersey' },
        { id: 'amc-kips-bay-15', name: 'AMC Kips Bay 15', location: 'new-york' }
    ];
    const rows = theaterList.flatMap((theater, index) =>
        toTheaterShowtimes(theater.id, [apiShowtime({ id: 40 + index })]).showtimes);
    const result = flattenScheduleData(compactSchedule({
        version: DATA_VERSION,
        theaters: theaterList,
        movies: toTheaterShowtimes('x', [apiShowtime()]).movies,
        showtimes: rows
    }));
    assert.deepEqual(result.theaters, {
        'New York': [{ id: 'amc-19th-st-east-6', name: '19th St. East' }, { id: 'amc-kips-bay-15', name: 'Kips Bay' }],
        'New Jersey': [{ id: 'amc-clifton-commons-16', name: 'Clifton Commons' }]
    });
    assert.equal(result.showtimes.find((s) => s.theaterId === 'amc-19th-st-east-6').theaterName, '19th St. East');
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

test('published data lists configured theatres, sorted showtimes, and the format version', async () => {
    const { schedule } = await buildSchedule({
        now: NOW,
        theaters: twoTheaters,
        client: stubClient({
            [twoTheaters[0].apiId]: [apiShowtime({ id: 2, showDateTimeLocal: '2026-10-30T21:00:00' })],
            [twoTheaters[1].apiId]: [apiShowtime({ id: 1, showDateTimeLocal: '2026-10-30T19:00:00' })]
        })
    });
    assert.equal(schedule.version, DATA_VERSION);
    assert.equal(schedule.nearTermThrough, '2026-11-12');
    assert.deepEqual(schedule.theaters.map(({ purchaseUrlTemplate, ...theater }) => theater), [
        { id: 'amc-empire-25', name: 'AMC Empire 25', location: 'new-york' },
        { id: 'amc-lincoln-square-13', name: 'AMC Lincoln Square 13', location: 'new-york' }
    ]);
    assert.deepEqual(schedule.showtimes.map((row) => row.id), ['1', '2']);
    for (const theater of theaters) {
        assert.match(theater.name, /^AMC .+ \d+$/, theater.id);
        assert.match(theater.location, /^new-(york|jersey)$/, theater.id);
    }
});

test('a theatre with no showtimes in the coming week is treated as a failure', async () => {
    const { failures } = await buildSchedule({
        now: NOW,
        theaters: twoTheaters.slice(0, 1),
        client: stubClient({ [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-12-25T19:00:00' })] })
    });
    assert.match(failures[0], /no showtimes between 2026-10-30 and 2026-11-05/);
});

test('a failed theatre keeps its future showtimes from the previous data file', async () => {
    const [ok, failing] = twoTheaters;
    const previousRows = toTheaterShowtimes(failing.id, [
        apiShowtime({ id: 50, showDateTimeLocal: '2026-10-29T19:00:00' }),
        apiShowtime({ id: 51, showDateTimeLocal: '2026-10-31T19:00:00', movieId: 7, movieName: 'Kept', runTime: 100, isAlmostSoldOut: true }),
        apiShowtime({ id: 52, showDateTimeLocal: '2026-10-31T21:00:00', movieId: 7, movieName: 'Kept', runTime: 105 })
    ]);
    const previousSchedule = compactSchedule({
        version: DATA_VERSION,
        theaters: [{ id: failing.id, name: failing.name, location: failing.location }],
        movies: previousRows.movies,
        showtimes: previousRows.showtimes
    });
    const { schedule, failures } = await buildSchedule({
        now: NOW,
        theaters: twoTheaters,
        previousSchedule: structuredClone(previousSchedule),
        client: stubClient({
            [ok.apiId]: [apiShowtime({ id: 60, showDateTimeLocal: '2026-10-30T19:00:00' })],
            [failing.apiId]: new Error('HTTP 500')
        })
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /HTTP 500/);
    const kept = schedule.showtimes.filter((row) => row.theater === failing.id);
    assert.deepEqual(kept.map((row) => row.id), ['51', '52']);
    assert.equal(schedule.movies['7'].title, 'Kept');
    assert.equal(kept[0].alert, 'Almost Full');
    // Per-showtime runtimes survive the round trip through the compact form.
    assert.deepEqual([kept[0].runtime ?? schedule.movies['7'].runtime, kept[1].runtime ?? schedule.movies['7'].runtime], [100, 105]);
    assert.deepEqual(schedule.tagSets[kept[0].tags], showtimeTags(apiShowtime()));
    assert.equal(
        schedule.theaters.find((theater) => theater.id === failing.id).purchaseUrlTemplate,
        'https://www.amctheatres.com/showtimes/all/{startDate}/empire/all/{id}'
    );
});

test('fetchShowtimes writes minified output, and preserves it when everything fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-api-'));
    const outputPath = path.join(dir, 'data.json');
    const ok = stubClient({
        [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-30T19:00:00' })],
        [twoTheaters[1].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-31T19:00:00' })]
    });

    await fetchShowtimes({ now: NOW, theaters: twoTheaters, client: ok, outputPath, dryRun: true });
    assert.ok(!fs.existsSync(outputPath));

    const schedule = await fetchShowtimes({ now: NOW, theaters: twoTheaters, client: ok, outputPath });
    const written = fs.readFileSync(outputPath, 'utf8');
    assert.deepEqual(JSON.parse(written), schedule);
    assert.ok(!written.includes('\n'), 'output should be minified');

    const down = stubClient({ [twoTheaters[0].apiId]: new Error('down'), [twoTheaters[1].apiId]: new Error('down') });
    await assert.rejects(
        fetchShowtimes({ now: new Date('2027-03-01T12:00:00Z'), theaters: twoTheaters, client: down, outputPath }),
        /No usable showtimes; the existing data file was preserved/
    );
    assert.equal(fs.readFileSync(outputPath, 'utf8'), written);
    assert.deepEqual(fs.readdirSync(dir), ['data.json']);
});

test('a previous data file in another format is not used as a fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-api-'));
    const outputPath = path.join(dir, 'data.json');
    fs.writeFileSync(outputPath, JSON.stringify({ theaters: { [twoTheaters[1].id]: { schedule: [] } } }));
    const client = stubClient({
        [twoTheaters[0].apiId]: [apiShowtime({ showDateTimeLocal: '2026-10-30T19:00:00' })],
        [twoTheaters[1].apiId]: new Error('HTTP 500')
    });
    await assert.rejects(
        fetchShowtimes({ now: NOW, theaters: twoTheaters, client, outputPath }),
        /Partial update published with 1 theater failures/
    );
    const published = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(published.version, DATA_VERSION);
    assert.deepEqual(published.showtimes.map((row) => row.theater), [twoTheaters[0].id]);
});
