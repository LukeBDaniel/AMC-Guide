import { useState } from 'react';
import { Check, Film } from 'lucide-react';
import { posterUrl } from '../utils/dataProcessor';

// Shown at about 80px wide; requested at twice that for high-density screens (about 10 KB each).
const POSTER_WIDTH = 160;
const POSTER_HEIGHT = 240;

// A movie's poster with its title beneath; selecting it filters to that movie. Keeps a
// placeholder when AMC has no poster, or it fails to load.
const PosterTile = ({ title, poster, note, selected, onToggle }) => {
    const [failed, setFailed] = useState(false);
    const src = posterUrl(poster, POSTER_WIDTH, POSTER_HEIGHT);
    return (
        <button type="button" className={`poster-tile ${selected ? 'selected' : ''}`} onClick={onToggle} aria-pressed={selected}>
            <span className="poster-tile-image">
                {src && !failed
                    ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
                    : <Film size={22} />}
                {selected && (
                    <span className="poster-tile-check">
                        <Check size={14} strokeWidth={3} />
                    </span>
                )}
            </span>
            <span className="poster-tile-title">{title}</span>
            {note && <span className="poster-tile-note" title={note}>{note}</span>}
        </button>
    );
};

const Chevron = ({ isOpen }) => (
    <span style={{
        fontSize: '0.6rem',
        transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.2s ease',
        opacity: 0.6
    }}>
        ▼
    </span>
);

export default function Filters({
    groupedMovies,
    movieDisplayTitles,
    moviePosters,
    movieVariants,
    availableMovies,
    availableVariantKeys,
    theaters,
    formats,
    languages,
    selectedMovies,
    setSelectedMovies,
    selectedVariants,
    setSelectedVariants,
    selectedTheaters,
    setSelectedTheaters,
    selectedFormats,
    setSelectedFormats,
    seatings,
    selectedSeatings,
    setSelectedSeatings,
    others,
    selectedOthers,
    setSelectedOthers,
    selectedLanguages,
    setSelectedLanguages,
    onDone,
    onEditTheaters,
}) {
    const [openSections, setOpenSections] = useState({
        theaters: true,
        formats: false,
        seatings: false,
        others: false,
        language: false,
        movies: true
    });

    const [openSubGenres, setOpenSubGenres] = useState({
        'New Movies': true,
        'Coming Soon': true,
        'International Films': false,
        'Fan Faves & Classics': false,
        'Events': false,
        'Livestream Events': false
    });

    const toggleSection = (section) => {
        setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const toggleSubGenre = (genre) => {
        setOpenSubGenres(prev => ({ ...prev, [genre]: !prev[genre] }));
    };

    const handleCheckboxChange = (setFn, currentSelection, value) => {
        const newSelection = new Set(currentSelection);
        if (newSelection.has(value)) {
            newSelection.delete(value);
        } else {
            newSelection.add(value);
        }
        setFn(newSelection);
    };

    // Deselecting a movie also clears its special-screening checkboxes, which are only
    // shown while the movie is selected.
    // Built on the latest selection, so taps in quick succession all count.
    const toggleMovie = (movie) => {
        if (selectedMovies.has(movie)) {
            const prefix = `${movie}::`;
            setSelectedVariants(prev => ([...prev].some(v => v.startsWith(prefix))
                ? new Set([...prev].filter(v => !v.startsWith(prefix)))
                : prev));
        }
        setSelectedMovies(prev => {
            const next = new Set(prev);
            if (next.has(movie)) next.delete(movie);
            else next.add(movie);
            return next;
        });
    };

    const clearFilters = () => {
        setSelectedMovies(new Set());
        setSelectedVariants(new Set());
        setSelectedTheaters(new Set());
        setSelectedFormats(new Set());
        setSelectedSeatings(new Set());
        setSelectedOthers(new Set());
        setSelectedLanguages(new Set());
    };

    const hasFilters = selectedMovies.size > 0 || selectedVariants.size > 0 || selectedTheaters.size > 0 || selectedFormats.size > 0 || selectedSeatings.size > 0 || selectedOthers.size > 0 || selectedLanguages.size > 0;

    return (
        <aside className="filters-sidebar">
            <div className="filters-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Filters</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    {hasFilters && (
                        <button className="filter-clear-btn" onClick={clearFilters}>
                            Clear All
                        </button>
                    )}
                    {onDone && (
                        <button className="filters-done-btn" onClick={onDone}>
                            Done
                        </button>
                    )}
                </div>
            </div>

            <div className="filter-section">
                <div className={`filter-title ${!openSections.theaters ? 'collapsed' : ''}`} onClick={() => toggleSection('theaters')}>
                    <span>Theaters</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <button
                            className="filter-edit-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onEditTheaters();
                            }}
                        >
                            Edit
                        </button>
                        <Chevron isOpen={openSections.theaters} />
                    </span>
                </div>
                {openSections.theaters && (
                    <div className="filter-content">
                        {(() => {
                            const allTheaterIds = theaters ? Object.values(theaters).flat().map(t => t.id) : [];
                            if (allTheaterIds.length === 0) {
                                return (
                                    <button className="filter-add-theaters-btn" onClick={onEditTheaters}>
                                        Choose your theaters
                                    </button>
                                );
                            }
                            return (
                                <>
                                    <label className="filter-label" style={{ fontWeight: 500, paddingBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', marginBottom: '0.5rem' }}>
                                        <input 
                                            type="checkbox" 
                                            className="filter-checkbox"
                                            checked={selectedTheaters.size === allTheaterIds.length && allTheaterIds.length > 0}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setSelectedTheaters(new Set(allTheaterIds));
                                                } else {
                                                    setSelectedTheaters(new Set());
                                                }
                                            }}
                                        />
                                        <span>Select All Theaters</span>
                                    </label>
                                    {Object.keys(theaters || {}).map(state => {
                                        const stateTheaters = theaters[state];
                                        if (!stateTheaters || stateTheaters.length === 0) return null;
                                        
                                        return (
                                            <div key={state} style={{ marginBottom: '1rem' }}>
                                                <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', opacity: 0.8, fontWeight: 700, marginBottom: '0.5rem', marginTop: '0.5rem' }}>
                                                    {state}
                                                </div>
                                                {stateTheaters.map(theater => (
                                                    <label key={theater.id} className="filter-label" style={{ marginLeft: '0.5rem' }}>
                                                        <input 
                                                            type="checkbox" 
                                                            className="filter-checkbox"
                                                            checked={selectedTheaters.has(theater.id)}
                                                            onChange={() => handleCheckboxChange(setSelectedTheaters, selectedTheaters, theater.id)}
                                                        />
                                                        <span>{theater.name}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </>
                            );
                        })()}
                    </div>
                )}
            </div>

            {formats && formats.length > 0 && (
                <div className="filter-section">
                    <div className={`filter-title ${!openSections.formats ? 'collapsed' : ''}`} onClick={() => toggleSection('formats')}>
                        <span>Formats</span>
                        <Chevron isOpen={openSections.formats} />
                    </div>
                    {openSections.formats && (
                        <div className="filter-content">
                            {formats.map(format => (
                                <label key={format} className="filter-label">
                                    <input 
                                        type="checkbox" 
                                        className="filter-checkbox"
                                        checked={selectedFormats.has(format)}
                                        onChange={() => handleCheckboxChange(setSelectedFormats, selectedFormats, format)}
                                    />
                                    <span>{format}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {seatings && seatings.length > 0 && (
                <div className="filter-section">
                    <div className={`filter-title ${!openSections.seatings ? 'collapsed' : ''}`} onClick={() => toggleSection('seatings')}>
                        <span>Seating</span>
                        <Chevron isOpen={openSections.seatings} />
                    </div>
                    {openSections.seatings && (
                        <div className="filter-content">
                            {seatings.map(seating => (
                                <label key={seating} className="filter-label">
                                    <input 
                                        type="checkbox" 
                                        className="filter-checkbox"
                                        checked={selectedSeatings.has(seating)}
                                        onChange={() => handleCheckboxChange(setSelectedSeatings, selectedSeatings, seating)}
                                    />
                                    <span>{seating}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {languages && languages.length > 0 && (
                <div className="filter-section">
                    <div className={`filter-title ${!openSections.language ? 'collapsed' : ''}`} onClick={() => toggleSection('language')}>
                        <span>Language</span>
                        <Chevron isOpen={openSections.language} />
                    </div>
                    {openSections.language && (
                        <div className="filter-content">
                            {languages.map(lang => (
                                <label key={lang} className="filter-label">
                                    <input 
                                        type="checkbox" 
                                        className="filter-checkbox"
                                        checked={selectedLanguages.has(lang)}
                                        onChange={() => handleCheckboxChange(setSelectedLanguages, selectedLanguages, lang)}
                                    />
                                    <span>{lang}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {others && others.length > 0 && (
                <div className="filter-section">
                    <div className={`filter-title ${!openSections.others ? 'collapsed' : ''}`} onClick={() => toggleSection('others')}>
                        <span>Other Filters</span>
                        <Chevron isOpen={openSections.others} />
                    </div>
                    {openSections.others && (
                        <div className="filter-content">
                            {others.map(other => (
                                <label key={other} className="filter-label">
                                    <input 
                                        type="checkbox" 
                                        className="filter-checkbox"
                                        checked={selectedOthers.has(other)}
                                        onChange={() => handleCheckboxChange(setSelectedOthers, selectedOthers, other)}
                                    />
                                    <span>{other}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="filter-section">
                <div className={`filter-title ${!openSections.movies ? 'collapsed' : ''}`} onClick={() => toggleSection('movies')}>
                    <span>Movies</span>
                    <Chevron isOpen={openSections.movies} />
                </div>
                {openSections.movies && (
                    <div className="filter-content">
                        {['New Movies', 'Coming Soon', 'International Films', 'Fan Faves & Classics', 'Events', 'Livestream Events'].map(cat => {
                            const moviesInCategory = groupedMovies[cat] || [];
                            const catMovies = availableMovies ? moviesInCategory.filter(m => availableMovies.has(m)) : moviesInCategory;
                            if (!catMovies || catMovies.length === 0) return null;
                            
                            return (
                                <div key={cat} style={{ marginBottom: '1.25rem' }}>
                                    <div 
                                        onClick={() => toggleSubGenre(cat)}
                                        style={{ 
                                            fontSize: '0.75rem', 
                                            textTransform: 'uppercase', 
                                            letterSpacing: '0.05em', 
                                            color: 'var(--text-secondary)', 
                                            opacity: 0.8, 
                                            fontWeight: 700, 
                                            marginBottom: '0.5rem',
                                            display: 'flex',
                                            justifyContent: 'flex-start',
                                            gap: '0.5rem',
                                            alignItems: 'center',
                                            cursor: 'pointer',
                                            userSelect: 'none'
                                        }}
                                    >
                                        <span>{cat}</span>
                                        <Chevron isOpen={openSubGenres[cat]} />
                                    </div>
                                    {openSubGenres[cat] && (() => {
                                        const label = movie => (movieDisplayTitles && movieDisplayTitles[movie]) || movie;
                                        const variantsOf = (movie) => {
                                            const allVariants = (movieVariants && movieVariants[movie]) || [];
                                            return availableVariantKeys
                                                ? allVariants.filter(({ variant }) => availableVariantKeys.has(`${movie}::${variant}`))
                                                : allVariants;
                                        };
                                        // Special screenings of the selected movies that can be picked on their own.
                                        const selectableVariants = catMovies
                                            .filter(movie => selectedMovies.has(movie))
                                            .map(movie => [movie, variantsOf(movie).filter(({ isInformational }) => !isInformational)])
                                            .filter(([, variants]) => variants.length > 0);
                                        return (
                                            <>
                                                <div className="poster-grid">
                                                    {catMovies.map(movie => (
                                                        <PosterTile
                                                            key={movie}
                                                            title={label(movie)}
                                                            poster={moviePosters?.[movie]}
                                                            note={variantsOf(movie).filter(({ isInformational }) => isInformational).map(({ variant }) => variant).join(', ')}
                                                            selected={selectedMovies.has(movie)}
                                                            onToggle={() => toggleMovie(movie)}
                                                        />
                                                    ))}
                                                </div>
                                                {selectableVariants.length > 0 && (
                                                    <div className="poster-variants">
                                                        {selectableVariants.map(([movie, variants]) => (
                                                            <div key={movie} className="poster-variants-movie">
                                                                <div className="poster-variants-title">{label(movie)}</div>
                                                                {variants.map(({ variant }) => (
                                                                    <label key={variant} className="filter-label">
                                                                        <input
                                                                            type="checkbox"
                                                                            className="filter-checkbox"
                                                                            checked={selectedVariants.has(`${movie}::${variant}`)}
                                                                            onChange={() => handleCheckboxChange(setSelectedVariants, selectedVariants, `${movie}::${variant}`)}
                                                                        />
                                                                        <span>{variant}</span>
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </aside>
    );
}
