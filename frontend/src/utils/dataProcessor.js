import { buildTitleGroups } from './titleNormalizer.js';

// Helper to parse '3:00pm' or '11:00am' into minutes since midnight
function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.trim().toLowerCase().match(/(\d+):(\d+)(am|pm)/);
    if (!match) return 0;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const period = match[3];

    if (period === 'pm' && hours !== 12) {
        hours += 12;
    } else if (period === 'am' && hours === 12) {
        hours = 0;
    }

    // Treat anything before 5 AM as the late night of the current schedule day
    if (hours < 5) {
        return (hours * 60) + minutes + 1440;
    }

    return (hours * 60) + minutes;
}

// Helper to parse '2 HR 25 MIN' into total minutes
function parseRuntimeToMinutes(runtimeStr, formatsArray = []) {
    if (!runtimeStr) return 120; // default 2 hours if unknown
    let mins = 0;
    const hrMatch = runtimeStr.match(/(\d+)\s*HR/i);
    const minMatch = runtimeStr.match(/(\d+)\s*MIN/i);
    if (hrMatch) mins += parseInt(hrMatch[1], 10) * 60;
    if (minMatch) mins += parseInt(minMatch[1], 10);

    // Add 30 minutes for typical AMC trailers, unless 'No Trailers' tag exists
    const hasNoTrailers = formatsArray.some(f => f.toLowerCase().includes('no trailers'));
    if (!hasNoTrailers && mins > 0) {
        mins += 30;
    }

    return mins || 120;
}

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

    if (!rawData || !rawData.theaters) return { showtimes: [], movies: [], theaters: [], formats: [], movieDisplayTitles: {}, movieVariants: {} };

    // First pass: collect every distinct raw title so AMC's inconsistent event-naming
    // (e.g. "Moana" vs "MOANA IMAX Opening Night Fan Event") can be resolved into a
    // shared movie identity + optional variant (see titleNormalizer.js for the rules).
    const rawTitles = new Set();
    Object.values(rawData.theaters).forEach(theater => {
        theater.schedule.forEach(day => {
            day.movies.forEach(movie => rawTitles.add(movie.title));
        });
    });
    const titleGroups = buildTitleGroups(rawTitles);

    Object.values(rawData.theaters).forEach(theater => {
        // Pretty format the theater name and remove redundant "Amc"
        let theaterName = theater.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        theaterName = theaterName.replace(/^Amc\s+/i, '').replace(/\s+\d+$/, '').trim();
        const isNY = ['amc-empire-25', 'amc-lincoln-square-13', 'amc-34th-street-14', 'amc-kips-bay-15'].includes(theater.id);
        const location = theater.location === 'new-york' || isNY ? 'New York' : 'New Jersey';
        uniqueTheaters.set(theater.id, { name: theaterName, location });

        theater.schedule.forEach(day => {
            day.movies.forEach(movie => {
                // Aggregate showtimes by unique identifier to prevent duplicate React keys
                const uniqueShowtimes = new Map();
                const { movieKey, displayTitle, variant, isInformational } = titleGroups.get(movie.title) || { movieKey: movie.title, displayTitle: movie.title, variant: null, isInformational: false };
                movieDisplayTitles[movieKey] = displayTitle;
                if (variant) {
                    if (!movieVariantMaps[movieKey]) movieVariantMaps[movieKey] = new Map();
                    movieVariantMaps[movieKey].set(variant, isInformational);
                }

                movie.formats.forEach(formatObj => {
                    let rawFormats = formatObj.formats || [formatObj.format];
                    let parsedFormats = rawFormats.map(f => {
                        if (!f) return '';
                        let stripped = f.replace(/\s+at AMC$/i, '');
                        if (stripped.toLowerCase().includes('club rockers') || stripped.toLowerCase().includes('signature recliners')) {
                            stripped = stripped.replace(/^AMC\s+/i, '');
                        }
                        return stripped;
                    });

                    let finalFormatsSet = new Set();
                    parsedFormats.forEach(rawFormat => {
                        if (rawFormat === 'IMAX with Laser') {
                            finalFormatsSet.add('IMAX with Laser');
                            finalFormatsSet.add('IMAX');
                            finalFormatsSet.add('Laser');
                        } else if (rawFormat === 'undefined' || rawFormat === '') {
                            finalFormatsSet.add('Standard');
                        } else {
                            finalFormatsSet.add(rawFormat);
                        }
                    });

                    let hasExcludedFromAList = false;
                    for (const fmt of finalFormatsSet) {
                        if (fmt.toLowerCase() === 'excluded from a-list') {
                            hasExcludedFromAList = true;
                            break;
                        }
                    }

                    if (!hasExcludedFromAList) {
                        finalFormatsSet.add('Included in A-List');
                    }

                    if (variant) {
                        finalFormatsSet.add(variant);
                    }

                    let formatsArray = Array.from(finalFormatsSet).filter(f =>
                        !f.toLowerCase().includes('excluded from 50% off discount') &&
                        !f.toLowerCase().includes('choose from our available movie selection') &&
                        !f.toLowerCase().includes('no trailers') &&
                        !f.toLowerCase().includes('id required') &&
                        !f.toLowerCase().includes('no passes')
                    );

                    formatObj.showtimes.forEach(showtime => {
                        const showtimeId = showtime.performanceId || `${theater.id}-${movie.title}-${showtime.time}`;

                        if (uniqueShowtimes.has(showtimeId)) {
                            // Merge formats
                            const existing = uniqueShowtimes.get(showtimeId);
                            formatsArray.forEach(f => existing.formatsSet.add(f));
                        } else {
                            uniqueShowtimes.set(showtimeId, {
                                showtime,
                                formatsSet: new Set(formatsArray)
                            });
                        }
                    });
                });

                // Now push the deduplicated showtimes to flattened
                uniqueShowtimes.forEach(({ showtime, formatsSet }, showtimeId) => {
                    const finalFormatsArray = Array.from(formatsSet);
                    finalFormatsArray.forEach(f => uniqueFormats.add(f));

                    flattened.push({
                        id: showtime.performanceId ? showtime.performanceId.toString() : `${showtimeId}-${Math.random()}`,
                        date: day.date,
                        time: showtime.time,
                        timeMinutes: parseTimeToMinutes(showtime.time),
                        runtimeMinutes: parseRuntimeToMinutes(movie.runtime, finalFormatsArray),
                        movieTitle: displayTitle,
                        movieKey: movieKey,
                        variant: variant || null,
                        theaterId: theater.id,
                        theaterName: theaterName,
                        runtime: movie.runtime ? movie.runtime.toLowerCase().replace(/\s*hr\s*/g, 'h ').replace(/\s*min\s*/g, 'm').trim() : '',
                        rating: movie.rating,
                        format: finalFormatsArray,
                        alert: showtime.alert,
                        link: movie.link ? `https://www.amctheatres.com${movie.link}` : '#'
                    });
                });
            });
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
    // A movie's showtimes can be a mix of normal public showings and special ones (e.g.
    // "Toy Story 5" merges with "Toy Story 5: Private Theatre Rental"). Track how many of
    // each movie's showtimes carry a given special-showing signal so categorizeMovie can
    // require it be true of ALL showtimes (dominant) rather than just present in the union
    // of formats across some showtimes — otherwise one merged-in rental/livestream/
    // international/anniversary showing would reclassify an otherwise-normal movie out of
    // "New Movies".
    const movieShowtimeCounts = {};
    flattened.forEach(s => {
        if (!movieFormatsMap[s.movieKey]) movieFormatsMap[s.movieKey] = new Set();
        s.format.forEach(f => movieFormatsMap[s.movieKey].add(f));

        if (!movieShowtimeCounts[s.movieKey]) {
            movieShowtimeCounts[s.movieKey] = { total: 0, privateRental: 0, livestream: 0, event: 0, international: 0, informational: 0 };
        }
        const counts = movieShowtimeCounts[s.movieKey];
        counts.total += 1;
        const lowerFormats = s.format.map(f => f.toLowerCase());
        if (lowerFormats.some(f => f.includes('private theatre rental'))) counts.privateRental += 1;
        if (lowerFormats.some(f => f.includes('livestream event'))) counts.livestream += 1;
        if (lowerFormats.some(f => f.includes('alternative content') || f.includes('fan first screening') || f.includes('opening night event'))) counts.event += 1;
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
        if (lowerTitle.includes('private theatre rental') || isDominant(counts?.privateRental)) return 'Private Theatre Rentals';
        if (isDominant(counts?.livestream)) return 'Livestream Events';
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
        'International Films': [],
        'Fan Faves & Classics': [],
        'Events': [],
        'Livestream Events': [],
        'Private Theatre Rentals': []
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
               lower.includes('private theatre rental');
    };
    const isLanguage = f => f.includes('Spoken') || f.includes('Dubbed');

    const finalSeatings = allValidFormats.filter(isSeating).sort();
    const finalOthers = allValidFormats.filter(isOther).sort();
    const finalLanguages = allValidFormats.filter(isLanguage).sort();
    const finalFormats = allValidFormats.filter(f => !isLanguage(f) && !isSeating(f) && !isOther(f)).sort();

    return {
        showtimes: flattened,
        movies: Array.from(uniqueMovies).sort(),
        groupedMovies,
        theaters: {
            'New York': Array.from(uniqueTheaters.entries())
                .filter(([id, data]) => data.location === 'New York')
                .map(([id, data]) => ({ id, name: data.name }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            'New Jersey': Array.from(uniqueTheaters.entries())
                .filter(([id, data]) => data.location === 'New Jersey')
                .map(([id, data]) => ({ id, name: data.name }))
                .sort((a, b) => a.name.localeCompare(b.name))
        },
        formats: finalFormats,
        seatings: finalSeatings,
        others: finalOthers,
        languages: finalLanguages,
        movieDisplayTitles,
        movieVariants,
        dates: uniqueDates
    };
}
