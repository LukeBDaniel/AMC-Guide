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
