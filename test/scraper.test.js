const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildShowtimesUrl,
    getDates,
    parseScheduleHtml,
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

test('buildShowtimesUrl uses AMC current canonical date query', () => {
    assert.equal(
        buildShowtimesUrl(theater, '2026-08-21'),
        'https://www.amctheatres.com/movie-theatres/new-york/amc-test-1/showtimes?date=2026-08-21'
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
