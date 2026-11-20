// Helpers for the theatre directory (data/theaters.json) and the user's favourites.

const FAVORITES_KEY = 'amc-guide:favorite-theaters';
const LOCATION_KEY = 'amc-guide:location';
const EARTH_RADIUS_MILES = 3958.8;

// Kept in this browser (or the app's WebView) only.
function readStored(key, fallback) {
    try {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : fallback;
    } catch {
        return fallback;
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage full or unavailable; the choice just won't be remembered.
    }
}

export function readFavorites() {
    const ids = readStored(FAVORITES_KEY, []);
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
}

export function writeFavorites(ids) {
    writeStored(FAVORITES_KEY, ids);
}

// The last position the user shared, rounded to about 100 metres: enough to order
// theatres, without keeping a precise location around.
export function readSavedLocation() {
    const point = readStored(LOCATION_KEY, null);
    return Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) ? point : null;
}

export function writeSavedLocation({ latitude, longitude }) {
    const round = value => Math.round(value * 1000) / 1000;
    writeStored(LOCATION_KEY, { latitude: round(latitude), longitude: round(longitude) });
}

// Great-circle distance between two { latitude, longitude } points.
export function distanceMiles(a, b) {
    const toRadians = degrees => degrees * Math.PI / 180;
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

// 0.43 -> "0.4 mi", 12.6 -> "13 mi"
export function formatDistance(miles) {
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toLocaleString('en-US')} mi`;
}

// Where to measure distances from: the user's location, or failing that the middle of
// their favourite theatres, so nearby theatres still come first without location access.
export function referencePoint(location, favoriteTheaters) {
    if (location) return { ...location, source: 'location' };
    if (!favoriteTheaters.length) return null;
    const sum = favoriteTheaters.reduce((total, theater) => ({
        latitude: total.latitude + theater.latitude,
        longitude: total.longitude + theater.longitude
    }), { latitude: 0, longitude: 0 });
    return {
        latitude: sum.latitude / favoriteTheaters.length,
        longitude: sum.longitude / favoriteTheaters.length,
        source: 'favorites'
    };
}

// Theatres with their distance from `point`, nearest first; alphabetical by state,
// city and name when there's no point to measure from.
export function sortTheaters(theaters, point) {
    const withDistance = theaters.map(theater => ({
        ...theater,
        distance: point ? distanceMiles(point, theater) : null
    }));
    return withDistance.sort((a, b) => (point
        ? a.distance - b.distance
        : a.state.localeCompare(b.state) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name)));
}

// Matches every word of the query against the theatre's name, city, state and ZIP.
export function matchesQuery(theater, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = `${theater.name} ${theater.city} ${theater.state} ${theater.zip}`.toLowerCase();
    return words.every(word => text.includes(word));
}

// The browser's (or app's) location as { latitude, longitude }.
export function locateUser() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Location isn’t available on this device.'));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
            error => reject(new Error(error.code === error.PERMISSION_DENIED
                ? 'Location access is off. Search by city or ZIP instead.'
                : 'Couldn’t find your location. Search by city or ZIP instead.')),
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 }
        );
    });
}
