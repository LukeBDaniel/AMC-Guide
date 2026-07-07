import React, { useState } from 'react';

export default function Filters({
    groupedMovies,
    movieDisplayTitles,
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
    includeImax,
    setIncludeImax,
    include70mm,
    setInclude70mm
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
        'International Films': false,
        'Fan Faves & Classics': false,
        'Events': false,
        'Livestream Events': false,
        'Private Theatre Rentals': false
    });

    const toggleSection = (section) => {
        setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    const toggleSubGenre = (genre) => {
        setOpenSubGenres(prev => ({ ...prev, [genre]: !prev[genre] }));
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

    const handleCheckboxChange = (setFn, currentSelection, value) => {
        const newSelection = new Set(currentSelection);
        if (newSelection.has(value)) {
            newSelection.delete(value);
        } else {
            newSelection.add(value);
        }
        setFn(newSelection);
    };

    const clearFilters = () => {
        setSelectedMovies(new Set());
        setSelectedVariants(new Set());
        setSelectedTheaters(new Set());
        setSelectedFormats(new Set());
        setSelectedSeatings(new Set());
        setSelectedOthers(new Set());
        setSelectedLanguages(new Set());
        setIncludeImax(false);
        setInclude70mm(false);
    };

    const hasFilters = selectedMovies.size > 0 || selectedVariants.size > 0 || selectedTheaters.size > 0 || selectedFormats.size > 0 || selectedSeatings.size > 0 || selectedOthers.size > 0 || selectedLanguages.size > 0 || includeImax || include70mm;

    return (
        <aside className="filters-sidebar">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Filters</h2>
                {hasFilters && (
                    <button className="filter-clear-btn" onClick={clearFilters}>
                        Clear All
                    </button>
                )}
            </div>

            <div className="filter-section">
                <div className={`filter-title ${!openSections.theaters ? 'collapsed' : ''}`} onClick={() => toggleSection('theaters')}>
                    <span>Theaters</span>
                    <Chevron isOpen={openSections.theaters} />
                </div>
                {openSections.theaters && (
                    <div className="filter-content">
                        {(() => {
                            const allTheaterIds = theaters ? Object.values(theaters).flat().map(t => t.id) : [];
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
                                    {['New York', 'New Jersey'].map(state => {
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
                        {['New Movies', 'International Films', 'Fan Faves & Classics', 'Events', 'Livestream Events', 'Private Theatre Rentals'].map(cat => {
                            const catMovies = availableMovies ? groupedMovies[cat].filter(m => availableMovies.has(m)) : groupedMovies[cat];
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
                                    {openSubGenres[cat] && catMovies.map(movie => {
                                        const label = (movieDisplayTitles && movieDisplayTitles[movie]) || movie;
                                        const allVariants = (movieVariants && movieVariants[movie]) || [];
                                        const variants = availableVariantKeys
                                            ? allVariants.filter(({ variant }) => availableVariantKeys.has(`${movie}::${variant}`))
                                            : allVariants;
                                        return (
                                            <div key={movie} style={{ marginBottom: variants.length ? '0.5rem' : 0 }}>
                                                <label className="filter-label">
                                                    <input
                                                        type="checkbox"
                                                        className="filter-checkbox"
                                                        checked={selectedMovies.has(movie)}
                                                        onChange={() => handleCheckboxChange(setSelectedMovies, selectedMovies, movie)}
                                                    />
                                                    <span>{label}</span>
                                                </label>
                                                {variants.map(({ variant, isInformational }) => (
                                                    isInformational ? (
                                                        <div key={variant} style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: '1.5rem' }}>
                                                            {variant}
                                                        </div>
                                                    ) : (
                                                        <label key={variant} className="filter-label" style={{ marginLeft: '1.5rem', fontSize: '0.85rem', opacity: 0.85 }}>
                                                            <input
                                                                type="checkbox"
                                                                className="filter-checkbox"
                                                                checked={selectedVariants.has(`${movie}::${variant}`)}
                                                                onChange={() => handleCheckboxChange(setSelectedVariants, selectedVariants, `${movie}::${variant}`)}
                                                            />
                                                            <span>{variant}</span>
                                                        </label>
                                                    )
                                                ))}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </aside>
    );
}
