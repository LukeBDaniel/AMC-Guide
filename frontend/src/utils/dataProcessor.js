import { buildTitleGroups } from './titleNormalizer.js';

// Assumed length of the pre-show trailers when a showtime has them.
const TRAILER_MINUTES = 30;
// Used for the timeline when AMC has not published a runtime.
const DEFAULT_RUNTIME_MINUTES = 120;

// 'new-york' -> 'New York'
function titleCaseSlug(slug) {
    return slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Minutes from midnight of the showtime's schedule day. Late-night shows belong to the
// previous day's schedule, so a 1:00am start on the following calendar day is 25 * 60.
function minutesIntoScheduleDay(startsAt, scheduleDate) {
    const minutes = Number(startsAt.slice(11, 13)) * 60 + Number(startsAt.slice(14, 16));
    return startsAt.slice(0, 10) === scheduleDate ? minutes : minutes + 1440;
}

// "2026-10-30T19:05:00" -> "7:05pm"
function formatClockTime(startsAt) {
    const hour = Number(startsAt.slice(11, 13));
    return `${hour % 12 || 12}:${startsAt.slice(14, 16)}${hour >= 12 ? 'pm' : 'am'}`;
}

// 94 -> "1h 34m"
function formatRuntime(minutes) {
    return minutes ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : '';
}

// The showtime's own URL when it has one, otherwise its theatre's template.
function purchaseUrl(showtime, theater) {
    if (showtime.purchaseUrl !== undefined) return showtime.purchaseUrl;
    if (!theater.purchaseUrlTemplate) return null;
    return theater.purchaseUrlTemplate
        .replace('{startDate}', showtime.startsAt.slice(0, 10))
        .replace('{id}', showtime.id);
}

// "AMC 19th St. East 6" -> "19th St. East"
function theaterDisplayName(name) {
    return name.replace(/^AMC\s+/i, '').replace(/\s+\d+$/, '').trim();
}

// Turns data.json (see fetch-showtimes.js) into the showtime list, filter options and
// movie groupings the UI renders.
export function flattenScheduleData(rawData) {
    const flattened = [];
    const uniqueMovies = new Set();
    const uniqueTheaters = new Map();
    const uniqueFormats = new Set();
    const movieDisplayTitles = {};
    // movieKey -> Map(variant text -> isInformational). A movie's event/anniversary
    // variants (e.g. "Fan Event Screening", "85th Anniversary") are tracked per movie
    // rather than merged into the movie's own identity, so the UI can offer them as
    // per-movie sub-filters instead of separate top-level list items.
    const movieVariantMaps = {};

    if (!Array.isArray(rawData?.showtimes)) {
        return { showtimes: [], movies: [], groupedMovies: {}, theaters: {}, formats: [], seatings: [], others: [], languages: [], movieDisplayTitles: {}, movieVariants: {}, dates: [] };
    }

    rawData.theaters.forEach(theater => {
        uniqueTheaters.set(theater.id, {
            name: theaterDisplayName(theater.name),
            location: titleCaseSlug(theater.location),
            purchaseUrlTemplate: theater.purchaseUrlTemplate
        });
    });

    // AMC's inconsistent event naming (e.g. "Moana" vs "MOANA IMAX Opening Night Fan
    // Event") is resolved into a shared movie identity + optional variant (see
    // titleNormalizer.js for the rules).
    const titleGroups = buildTitleGroups(new Set(Object.values(rawData.movies).map(movie => movie.title)));

    rawData.showtimes.forEach(showtime => {
        const movie = rawData.movies[showtime.movie];
        const theater = uniqueTheaters.get(showtime.theater);
        if (!movie || !theater) return;

        const { movieKey, displayTitle, variant, isInformational, isEvent = false } = titleGroups.get(movie.title) || { movieKey: movie.title, displayTitle: movie.title, variant: null, isInformational: false };
        movieDisplayTitles[movieKey] = displayTitle;
        if (variant) {
            if (!movieVariantMaps[movieKey]) movieVariantMaps[movieKey] = new Map();
            movieVariantMaps[movieKey].set(variant, isInformational);
        }

        const tags = rawData.tagSets[showtime.tags];
        const format = variant ? Array.from(new Set([...tags, variant])) : tags;
        format.forEach(f => uniqueFormats.add(f));
        const runtime = showtime.runtime !== undefined ? showtime.runtime : movie.runtime;

        flattened.push({
            id: showtime.id,
            date: showtime.date,
            time: formatClockTime(showtime.startsAt),
            timeMinutes: minutesIntoScheduleDay(showtime.startsAt, showtime.date),
            runtimeMinutes: runtime ? runtime + (showtime.noTrailers ? 0 : TRAILER_MINUTES) : DEFAULT_RUNTIME_MINUTES,
            movieTitle: displayTitle,
            movieKey: movieKey,
            variant: variant || null,
            _isEventTitle: isEvent,
            theaterId: showtime.theater,
            theaterName: theater.name,
            runtime: formatRuntime(runtime),
            rating: movie.rating,
            format,
            alert: showtime.alert ?? null,
            link: movie.url || '#',
            ticketLink: purchaseUrl(showtime, theater)
        });
    });

    // Sort chronologically by date and then by timeMinutes
    flattened.sort((a, b) => {
        if (a.date !== b.date) {
            return new Date(a.date) - new Date(b.date);
        }
        return a.timeMinutes - b.timeMinutes;
    });

    // Extract unique dates
    const uniqueDates = Array.from(new Set(flattened.map(s => s.date))).sort();

    const movieFormatsMap = {};
    const movieDatesMap = {};
    // A movie's showtimes can be a mix of normal public showings and special ones (e.g.
    // "Moana" merges with "MOANA IMAX Opening Night Fan Event"). Track how many of
    // each movie's showtimes carry a given special-showing signal so categorizeMovie can
    // require it be true of ALL showtimes (dominant) rather than just present in the union
    // of formats across some showtimes — otherwise one merged-in livestream/
    // international/anniversary showing would reclassify an otherwise-normal movie out of
    // "New Movies".
    const movieShowtimeCounts = {};
    flattened.forEach(s => {
        if (!movieFormatsMap[s.movieKey]) movieFormatsMap[s.movieKey] = new Set();
        s.format.forEach(f => movieFormatsMap[s.movieKey].add(f));
        if (!movieDatesMap[s.movieKey]) movieDatesMap[s.movieKey] = new Set();
        movieDatesMap[s.movieKey].add(s.date);

        if (!movieShowtimeCounts[s.movieKey]) {
            movieShowtimeCounts[s.movieKey] = { total: 0, livestream: 0, titleEvent: 0, event: 0, international: 0, informational: 0 };
        }
        const counts = movieShowtimeCounts[s.movieKey];
        counts.total += 1;
        const lowerFormats = s.format.map(f => f.toLowerCase());
        if (lowerFormats.some(f => f.includes('livestream event'))) counts.livestream += 1;
        if (s._isEventTitle) counts.titleEvent += 1;
        if (lowerFormats.some(f => f === 'event' || f.includes('alternative content') || f.includes('fan first screening') || f.includes('opening night event'))) counts.event += 1;
        if (lowerFormats.some(f => f.includes('international films'))) counts.international += 1;
        if (s.variant && movieVariantMaps[s.movieKey]?.get(s.variant)) counts.informational += 1;
    });

    const movieHasVariantMatching = (key, regex) => {
        const variants = movieVariantMaps[key];
        return !!variants && Array.from(variants.keys()).some(v => regex.test(v));
    };

    const categorizeMovie = (key, title, formatsList, counts) => {
        const lowerTitle = title.toLowerCase();
        const isDominant = (n) => counts && counts.total > 0 && n === counts.total;
        const showtimeDates = Array.from(movieDatesMap[key] || []);
        if (rawData.nearTermThrough
            && showtimeDates.length > 0
            && showtimeDates.every(date => date > rawData.nearTermThrough)) return 'Coming Soon';
        if (isDominant(counts?.livestream)) return 'Livestream Events';
        if (isDominant(counts?.titleEvent)) return 'Events';
        // Anniversary re-releases and Ghibli Fest screenings take priority over the generic
        // "Events" signal (AMC often also tags these revival screenings with a genuine
        // "Alternative Content" format).
        if (isDominant(counts?.informational) || formatsList.some(f => f.toLowerCase().includes('fan faves')) || lowerTitle.includes('fan faves') || /studio ghibli/i.test(title) || movieHasVariantMatching(key, /studio ghibli/i)) return 'Fan Faves & Classics';
        if (isDominant(counts?.event)) return 'Events';
        if (isDominant(counts?.international)) return 'International Films';

        if (/\bamc\b/i.test(title) || /crunchyroll/i.test(title) || /fan first screening/i.test(title) || /opening night event/i.test(title)) return 'Events';

        return 'New Movies';
    };

    flattened.forEach(s => uniqueMovies.add(s.movieKey));

    const groupedMovies = {
        'New Movies': [],
        'Coming Soon': [],
        'International Films': [],
        'Fan Faves & Classics': [],
        'Events': [],
        'Livestream Events': []
    };

    Array.from(uniqueMovies).sort().forEach(key => {
        const formatsList = Array.from(movieFormatsMap[key] || []);
        const cat = categorizeMovie(key, movieDisplayTitles[key] || key, formatsList, movieShowtimeCounts[key]);
        if (groupedMovies[cat]) {
            groupedMovies[cat].push(key);
        }
    });

    // Convert the internal variant maps into a plain, sorted structure for the UI:
    // { [movieKey]: [{ variant, isInformational }, ...] }
    const movieVariants = {};
    Object.entries(movieVariantMaps).forEach(([key, variantMap]) => {
        movieVariants[key] = Array.from(variantMap.entries())
            .map(([variant, isInformational]) => ({ variant, isInformational }))
            .sort((a, b) => a.variant.localeCompare(b.variant));
    });

    // Variant text (anniversary labels, special-showing tags) is per-movie informational/
    // sub-filter text, not a shared filter value, so it's excluded from the format filter lists.
    const variantValues = new Set(
        Object.values(movieVariantMaps).flatMap(variantMap => Array.from(variantMap.keys()))
    );

    const allValidFormats = Array.from(uniqueFormats)
        .filter(f => !f.toLowerCase().includes('fan faves') &&
                     !f.toLowerCase().includes('amc artisan films') &&
                     !f.toLowerCase().includes('thrills & chills') &&
                     !f.toLowerCase().includes('livestream event') &&
                     !f.toLowerCase().includes('alternative content') &&
                     f.toLowerCase() !== 'event' &&
                     !f.toLowerCase().includes('international films') &&
                     !f.toLowerCase().includes('reserved seating') &&
                     !f.toLowerCase().includes('fan first screening') &&
                     !f.toLowerCase().includes('opening night event') &&
                     !f.toLowerCase().includes('excluded from a-list') &&
                     !variantValues.has(f));

    const isSeating = f => {
        const lower = f.toLowerCase();
        return lower.includes('club rockers') || lower.includes('signature recliners') || lower.includes('prime');
    };
    const isOther = f => {
        const lower = f.toLowerCase();
        return lower.includes('audio description') ||
               lower.includes('closed caption') ||
               lower.includes('included in a-list') ||
               lower.includes('sensory friendly film') ||
               lower.includes('open caption') ||
               lower.includes('adult supervision') ||
               lower.includes('includes intermission') ||
               lower.includes('live event') ||
               lower.includes('mommy & me');
    };
    const isLanguage = f => f.includes('Spoken') || f.includes('Dubbed');

    const finalSeatings = allValidFormats.filter(isSeating).sort();
    const finalOthers = allValidFormats.filter(isOther).sort();
    const finalLanguages = allValidFormats.filter(isLanguage).sort();
    const finalFormats = allValidFormats.filter(f => !isLanguage(f) && !isSeating(f) && !isOther(f)).sort();
    flattened.forEach(showtime => delete showtime._isEventTitle);

    // Grouped by state, in the order states first appear in the data file.
    const theatersByLocation = {};
    uniqueTheaters.forEach(({ name, location }, id) => {
        (theatersByLocation[location] ||= []).push({ id, name });
    });
    Object.values(theatersByLocation).forEach(list => list.sort((a, b) => a.name.localeCompare(b.name)));

    return {
        showtimes: flattened,
        movies: Array.from(uniqueMovies).sort(),
        groupedMovies,
        theaters: theatersByLocation,
        formats: finalFormats,
        seatings: finalSeatings,
        others: finalOthers,
        languages: finalLanguages,
        movieDisplayTitles,
        movieVariants,
        dates: uniqueDates
    };
}
