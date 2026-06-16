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
    
    if (!rawData || !rawData.theaters) return { showtimes: [], movies: [], theaters: [], formats: [] };

    Object.values(rawData.theaters).forEach(theater => {
        // Pretty format the theater name and remove redundant "Amc"
        let theaterName = theater.id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        theaterName = theaterName.replace(/^Amc\s+/i, '').replace(/\s+\d+$/, '').trim();
        const isNY = ['amc-empire-25', 'amc-lincoln-square-13', 'amc-34th-street-14', 'amc-kips-bay-15'].includes(theater.id);
        const location = theater.location === 'new-york' || isNY ? 'New York' : 'New Jersey';
        uniqueTheaters.set(theater.id, { name: theaterName, location });

        theater.schedule.forEach(day => {
            day.movies.forEach(movie => {
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

                    let formatsArray = Array.from(finalFormatsSet).filter(f => 
                        !f.toLowerCase().includes('excluded from 50% off discount') &&
                        !f.toLowerCase().includes('choose from our available movie selection') &&
                        !f.toLowerCase().includes('no trailers') &&
                        !f.toLowerCase().includes('id required') &&
                        !f.toLowerCase().includes('no passes')
                    );

                    formatsArray.forEach(f => uniqueFormats.add(f));

                    formatObj.showtimes.forEach(showtime => {
                            flattened.push({
                                id: showtime.performanceId || `${theater.id}-${movie.title}-${showtime.time}-${Math.random()}`,
                                date: day.date,
                                time: showtime.time,
                                timeMinutes: parseTimeToMinutes(showtime.time),
                                runtimeMinutes: parseRuntimeToMinutes(movie.runtime, Array.from(finalFormatsSet)),
                                movieTitle: movie.title,
                                theaterId: theater.id,
                                theaterName: theaterName,
                                runtime: movie.runtime ? movie.runtime.toLowerCase().replace(/\s*hr\s*/g, 'h ').replace(/\s*min\s*/g, 'm').trim() : '',
                                rating: movie.rating,
                                format: formatsArray,
                                alert: showtime.alert,
                                link: movie.link ? `https://www.amctheatres.com${movie.link}` : '#'
                            });
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
    flattened.forEach(s => {
        if (!movieFormatsMap[s.movieTitle]) movieFormatsMap[s.movieTitle] = new Set();
        s.format.forEach(f => movieFormatsMap[s.movieTitle].add(f));
    });

    const categorizeMovie = (title, formatsList) => {
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes('private theatre rental') || formatsList.some(f => f.toLowerCase().includes('private theatre rental'))) return 'Private Theatre Rentals';
        if (formatsList.some(f => f.toLowerCase().includes('livestream event'))) return 'Livestream Events';
        if (formatsList.some(f => f.toLowerCase().includes('alternative content') || f.toLowerCase().includes('fan first screening') || f.toLowerCase().includes('opening night event'))) return 'Events';
        if (formatsList.some(f => f.toLowerCase().includes('international films'))) return 'International Films';
        if (formatsList.some(f => f.toLowerCase().includes('fan faves')) || lowerTitle.includes('fan faves') || /studio ghibli/i.test(title)) return 'Fan Faves & Classics';
        
        if (/\bamc\b/i.test(title) || /crunchyroll/i.test(title) || /fan first screening/i.test(title) || /opening night event/i.test(title)) return 'Events';
        
        return 'New Movies';
    };

    flattened.forEach(s => uniqueMovies.add(s.movieTitle));

    const groupedMovies = {
        'New Movies': [],
        'International Films': [],
        'Fan Faves & Classics': [],
        'Events': [],
        'Livestream Events': [],
        'Private Theatre Rentals': []
    };

    Array.from(uniqueMovies).sort().forEach(title => {
        const formatsList = Array.from(movieFormatsMap[title] || []);
        const cat = categorizeMovie(title, formatsList);
        if (groupedMovies[cat]) {
            groupedMovies[cat].push(title);
        }
    });

    const allValidFormats = Array.from(uniqueFormats)
        .filter(f => !f.toLowerCase().includes('fan faves') && 
                     !f.toLowerCase().includes('amc artisan films') && 
                     !f.toLowerCase().includes('thrills & chills') &&
                     !f.toLowerCase().includes('livestream event') &&
                     !f.toLowerCase().includes('alternative content') &&
                     !f.toLowerCase().includes('international films') &&
                     !f.toLowerCase().includes('reserved seating') &&
                     !f.toLowerCase().includes('private theatre rental') &&
                     !f.toLowerCase().includes('fan first screening') &&
                     !f.toLowerCase().includes('opening night event') &&
                     !f.toLowerCase().includes('excluded from a-list'));

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
               lower.includes('open caption');
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
        dates: uniqueDates
    };
}
