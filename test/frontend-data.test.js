const assert = require('node:assert/strict');
const test = require('node:test');

// Builds a theatre file (data/theaters/{id}.json) with one showtime per entry.
function dataFile(entries, extra = {}) {
    const movies = {};
    const showtimes = entries.map(({ date, title, id }) => {
        movies[title] = { title, url: `https://www.amctheatres.com/movies/${id}`, runtime: 120, rating: 'PG13' };
        return { id, theater: 'amc-empire-25', movie: title, date, startsAt: `${date}T19:00:00`, tags: 0 };
    });
    return {
        version: 4,
        theaters: [{ id: 'amc-empire-25', name: 'AMC Empire 25', location: 'new-york', purchaseUrlTemplate: null }],
        movies,
        tagSets: [['Standard', 'Included in A-List']],
        tagGroups: { Standard: 'format', 'Included in A-List': 'other' },
        showtimes,
        ...extra
    };
}

test('frontend groups only exclusively far-future titles under Coming Soon', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = dataFile([
        { date: '2026-08-22', title: 'Current Film', id: 'current-1' },
        { date: '2026-08-22', title: 'Mixed Film', id: 'mixed-1' },
        { date: '2026-11-06', title: 'Future Film', id: 'future-1' },
        { date: '2026-11-06', title: 'Mixed Film', id: 'mixed-2' }
    ], { nearTermThrough: '2026-09-03' });
    const result = flattenScheduleData(raw);
    assert.deepEqual(result.groupedMovies['Coming Soon'], ['Future Film']);
    assert.ok(result.groupedMovies['New Movies'].includes('Current Film'));
    assert.ok(result.groupedMovies['New Movies'].includes('Mixed Film'));
    assert.equal(Object.values(result.groupedMovies).flat().filter(key => key === 'Mixed Film').length, 1);
    assert.deepEqual(result.dates, ['2026-08-22', '2026-11-06']);
});

test('frontend remains backward compatible when nearTermThrough is absent', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = dataFile([{ date: '2026-11-06', title: 'Future Film', id: 'future-1' }]);
    const result = flattenScheduleData(raw);
    assert.deepEqual(result.groupedMovies['Coming Soon'], []);
    assert.deepEqual(result.groupedMovies['New Movies'], ['Future Film']);
});

test('title normalization recognizes anniversary event suffixes', async () => {
    const { stripEventDescriptor } = await import('../frontend/src/utils/titleNormalizer.js');
    assert.deepEqual(stripEventDescriptor('The Matrix 25th Anniversary Event'), {
        base: 'The Matrix',
        tags: [],
        infoLabel: '25th Anniversary Event'
    });
});

test('special-screening title containment is case-insensitive', async () => {
    const { buildTitleGroups } = await import('../frontend/src/utils/titleNormalizer.js');
    const groups = buildTitleGroups(new Set([
        'The Conversation',
        'THE CONVERSATION: One-Night Q&A'
    ]));

    assert.deepEqual(groups.get('THE CONVERSATION: One-Night Q&A'), {
        movieKey: 'The Conversation',
        displayTitle: 'The Conversation',
        variant: 'One-Night Q&A',
        isInformational: false
    });
});

test('parenthesized year events are categorized without becoming showing formats', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = dataFile([{ date: '2026-09-01', title: 'The Passion of the Christ (2026 Event)', id: 'passion-event' }]);
    const result = flattenScheduleData(raw);
    assert.equal(result.showtimes[0].movieTitle, 'The Passion of the Christ');
    assert.equal(result.showtimes[0].variant, null);
    assert.ok(!result.showtimes[0].format.includes('(2026 Event)'));
    assert.equal(result.movieVariants['The Passion of the Christ'], undefined);
    assert.deepEqual(result.groupedMovies.Events, ['The Passion of the Christ']);
    assert.ok(!result.groupedMovies['New Movies'].includes('The Passion of the Christ'));
    assert.equal('_isEventTitle' in result.showtimes[0], false);
});

test('frontend drops showtimes that started more than 30 minutes ago', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = dataFile([
        { date: '2026-11-08', title: 'Yesterday Film', id: 'yesterday-1' },
        { date: '2026-11-09', title: 'Started Film', id: 'started-1' },
        { date: '2026-11-09', title: 'Just Started Film', id: 'just-started-1' },
        { date: '2026-11-09', title: 'Tonight Film', id: 'tonight-1' }
    ]);
    raw.showtimes[1].startsAt = '2026-11-09T11:29:00';
    raw.showtimes[2].startsAt = '2026-11-09T11:30:00';
    // 12:00pm in New York (EST)
    const result = flattenScheduleData(raw, { now: new Date('2026-11-09T17:00:00Z') });
    assert.deepEqual(result.showtimes.map(s => s.id), ['just-started-1', 'tonight-1']);
    assert.deepEqual(result.dates, ['2026-11-09']);
    assert.deepEqual(result.movies, ['Just Started Film', 'Tonight Film']);
});

test('frontend keeps the previous day while its late-night showtimes are upcoming', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = dataFile([
        { date: '2026-11-08', title: 'Evening Film', id: 'evening-1' },
        { date: '2026-11-08', title: 'Late Film', id: 'late-1' }
    ]);
    raw.showtimes[1].startsAt = '2026-11-09T01:15:00';
    // 1:00am on Monday in New York
    const result = flattenScheduleData(raw, { now: new Date('2026-11-09T06:00:00Z') });
    assert.deepEqual(result.showtimes.map(s => s.id), ['late-1']);
    assert.deepEqual(result.dates, ['2026-11-08']);
});

test('merging theatre files remaps their tag lists onto one shared list', async () => {
    const { mergeSchedules, flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const empire = dataFile([{ date: '2026-11-09', title: 'Shared Film', id: 'e-1' }], { nearTermThrough: '2026-11-22' });
    const century = dataFile([{ date: '2026-11-09', title: 'Shared Film', id: 'c-1' }], { nearTermThrough: '2026-11-21' });
    century.theaters = [{ id: 'amc-century-city-15', name: 'AMC Century City 15', location: 'california', timeZone: 'America/Los_Angeles', purchaseUrlTemplate: null }];
    century.tagSets = [['IMAX', 'Included in A-List'], ['Standard', 'Included in A-List']];
    century.tagGroups = { IMAX: 'format', Standard: 'format', 'Included in A-List': 'other' };
    century.showtimes[0].theater = 'amc-century-city-15';
    century.showtimes[0].tags = 0;

    const merged = mergeSchedules([empire, century, null]);
    assert.deepEqual(merged.tagSets, [['Standard', 'Included in A-List'], ['IMAX', 'Included in A-List']]);
    assert.deepEqual(merged.showtimes.map(s => merged.tagSets[s.tags][0]), ['Standard', 'IMAX']);
    assert.equal(merged.nearTermThrough, '2026-11-22');
    assert.deepEqual(merged.theaters.map(t => t.id), ['amc-empire-25', 'amc-century-city-15']);

    const result = flattenScheduleData(merged);
    assert.deepEqual(Object.keys(result.theaters), ['New York', 'California']);
    assert.deepEqual(result.formats, ['IMAX', 'Standard']);
    // The original files are left untouched.
    assert.equal(century.showtimes[0].tags, 0);
});

test('past showtimes are judged in each theatre\'s own time zone', async () => {
    const { mergeSchedules, flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const empire = dataFile([{ date: '2026-11-09', title: 'East Film', id: 'east-1' }]);
    const century = dataFile([{ date: '2026-11-09', title: 'West Film', id: 'west-1' }]);
    century.theaters = [{ id: 'amc-century-city-15', name: 'AMC Century City 15', location: 'california', timeZone: 'America/Los_Angeles' }];
    century.showtimes[0].theater = 'amc-century-city-15';
    // Both at 7:00pm local; 9:00pm in New York is 6:00pm in Los Angeles.
    const result = flattenScheduleData(mergeSchedules([empire, century]), { now: new Date('2026-11-10T02:00:00Z') });
    assert.deepEqual(result.showtimes.map(s => s.id), ['west-1']);
});
