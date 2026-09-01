const assert = require('node:assert/strict');
const test = require('node:test');

function movie(title, id) {
    return {
        title,
        link: `/movies/${id}`,
        runtime: '2 HR',
        rating: 'PG13',
        formats: [{ formats: ['Standard'], showtimes: [{ time: '7:00pm', performanceId: id }] }]
    };
}

test('frontend groups only exclusively far-future titles under Coming Soon', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = {
        nearTermThrough: '2026-09-03',
        theaters: {
            'amc-empire-25': {
                id: 'amc-empire-25',
                location: 'new-york',
                schedule: [
                    { date: '2026-08-22', movies: [movie('Current Film', 'current-1'), movie('Mixed Film', 'mixed-1')] },
                    { date: '2026-11-06', movies: [movie('Future Film', 'future-1'), movie('Mixed Film', 'mixed-2')] }
                ]
            }
        }
    };
    const result = flattenScheduleData(raw);
    assert.deepEqual(result.groupedMovies['Coming Soon'], ['Future Film']);
    assert.ok(result.groupedMovies['New Movies'].includes('Current Film'));
    assert.ok(result.groupedMovies['New Movies'].includes('Mixed Film'));
    assert.equal(Object.values(result.groupedMovies).flat().filter(key => key === 'Mixed Film').length, 1);
    assert.deepEqual(result.dates, ['2026-08-22', '2026-11-06']);
});

test('frontend remains backward compatible when nearTermThrough is absent', async () => {
    const { flattenScheduleData } = await import('../frontend/src/utils/dataProcessor.js');
    const raw = {
        theaters: {
            'amc-empire-25': {
                id: 'amc-empire-25', location: 'new-york',
                schedule: [{ date: '2026-11-06', movies: [movie('Future Film', 'future-1')] }]
            }
        }
    };
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
    const raw = {
        theaters: {
            'amc-empire-25': {
                id: 'amc-empire-25',
                location: 'new-york',
                schedule: [{
                    date: '2026-09-01',
                    movies: [movie('The Passion of the Christ (2026 Event)', 'passion-event')]
                }]
            }
        }
    };

    const result = flattenScheduleData(raw);
    assert.equal(result.showtimes[0].movieTitle, 'The Passion of the Christ');
    assert.equal(result.showtimes[0].variant, null);
    assert.ok(!result.showtimes[0].format.includes('(2026 Event)'));
    assert.equal(result.movieVariants['The Passion of the Christ'], undefined);
    assert.deepEqual(result.groupedMovies.Events, ['The Passion of the Christ']);
    assert.ok(!result.groupedMovies['New Movies'].includes('The Passion of the Christ'));
    assert.equal('_isEventTitle' in result.showtimes[0], false);
});
