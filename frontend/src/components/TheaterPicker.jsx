import { useEffect, useMemo, useState } from 'react';
import { LocateFixed, Search, Star, X } from 'lucide-react';
import {
    formatDistance,
    locateUser,
    matchesQuery,
    readSavedLocation,
    referencePoint,
    sortTheaters,
    writeSavedLocation
} from '../utils/theaters';

// Each favourite is one file of about 150 KB, which the app also keeps for offline use.
export const MAX_FAVORITES = 15;
// Rows shown before "Show more", so the full list of ~500 theatres isn't rendered at once.
const PAGE_SIZE = 50;

function TheaterRow({ theater, isFavorite, disabled, onToggle }) {
    return (
        <button
            type="button"
            className={`picker-row ${isFavorite ? 'favorite' : ''}`}
            onClick={() => onToggle(theater.id)}
            disabled={disabled}
            aria-pressed={isFavorite}
        >
            <Star className="picker-star" size={18} fill={isFavorite ? 'currentColor' : 'none'} />
            <span className="picker-row-text">
                <span className="picker-row-name">{theater.name}</span>
                <span className="picker-row-meta">
                    {theater.city}, {theater.state}
                    {theater.distance != null && ` · ${formatDistance(theater.distance)}`}
                </span>
            </span>
        </button>
    );
}

export default function TheaterPicker({ directory, favorites, onToggleFavorite, onClose }) {
    const [query, setQuery] = useState('');
    const [location, setLocation] = useState(readSavedLocation);
    const [locating, setLocating] = useState(false);
    const [locationError, setLocationError] = useState(null);
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

    const canClose = favorites.length > 0;

    useEffect(() => {
        if (!canClose) return undefined;
        const onKeyDown = event => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [canClose, onClose]);

    const findMe = () => {
        setLocating(true);
        setLocationError(null);
        locateUser()
            .then(point => {
                writeSavedLocation(point);
                setLocation(point);
            })
            .catch(error => setLocationError(error.message))
            .finally(() => setLocating(false));
    };

    const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
    const point = useMemo(() => referencePoint(
        location,
        (directory || []).filter(theater => favoriteSet.has(theater.id))
    ), [location, directory, favoriteSet]);
    const sorted = useMemo(() => sortTheaters(directory || [], point), [directory, point]);
    const yourTheaters = sorted.filter(theater => favoriteSet.has(theater.id));
    const otherTheaters = sorted.filter(theater => !favoriteSet.has(theater.id) && matchesQuery(theater, query));
    const atLimit = favorites.length >= MAX_FAVORITES;

    let sortNote = 'Use your location to see the theaters closest to you first.';
    if (point?.source === 'location') sortNote = 'Nearest to your location first.';
    else if (point?.source === 'favorites') sortNote = 'Nearest to your theaters first.';

    return (
        <div className="picker-backdrop" onClick={canClose ? onClose : undefined}>
            <div className="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" onClick={event => event.stopPropagation()}>
                <div className="picker-header">
                    <h2 id="picker-title">My Theaters</h2>
                    {canClose && (
                        <button type="button" className="picker-done-btn" onClick={onClose}>Done</button>
                    )}
                </div>

                <div className="picker-body">
                    {!canClose && (
                        <p className="picker-intro">
                            Star the AMC theaters you go to and their showtimes will show up here. You can change them anytime.
                        </p>
                    )}

                    <div className="picker-controls">
                        <button type="button" className="picker-locate-btn" onClick={findMe} disabled={locating}>
                            <LocateFixed size={16} />
                            {locating ? 'Locating…' : 'Use my location'}
                        </button>
                        <label className="picker-search">
                            <Search size={16} />
                            <input
                                type="search"
                                placeholder="Search by name, city, state or ZIP"
                                value={query}
                                onChange={event => {
                                    setQuery(event.target.value);
                                    setVisibleCount(PAGE_SIZE);
                                }}
                            />
                            {query && (
                                <button type="button" className="picker-clear-btn" onClick={() => setQuery('')} aria-label="Clear search">
                                    <X size={14} />
                                </button>
                            )}
                        </label>
                    </div>
                    <p className={`picker-note ${locationError ? 'error' : ''}`}>{locationError || sortNote}</p>

                    {!directory ? (
                        <p className="picker-empty">Loading theaters…</p>
                    ) : (
                        <>
                            {yourTheaters.length > 0 && (
                                <section className="picker-section">
                                    <h3>Your theaters ({yourTheaters.length}/{MAX_FAVORITES})</h3>
                                    {yourTheaters.map(theater => (
                                        <TheaterRow key={theater.id} theater={theater} isFavorite onToggle={onToggleFavorite} />
                                    ))}
                                </section>
                            )}

                            <section className="picker-section">
                                <h3>{query ? 'Results' : point ? 'Nearby' : 'All theaters'}</h3>
                                {atLimit && (
                                    <p className="picker-note">You can pick up to {MAX_FAVORITES} theaters. Unstar one to add another.</p>
                                )}
                                {otherTheaters.length === 0 && (
                                    <p className="picker-empty">No theaters match “{query}”.</p>
                                )}
                                {otherTheaters.slice(0, visibleCount).map(theater => (
                                    <TheaterRow key={theater.id} theater={theater} isFavorite={false} disabled={atLimit} onToggle={onToggleFavorite} />
                                ))}
                                {otherTheaters.length > visibleCount && (
                                    <button type="button" className="picker-more-btn" onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>
                                        Show more ({otherTheaters.length - visibleCount} more)
                                    </button>
                                )}
                            </section>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
