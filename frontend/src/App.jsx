import { useState, useEffect, useMemo, useCallback } from 'react';
import Filters from './components/Filters';
import ShowtimeTimeline from './components/ShowtimeTimeline';
import { flattenScheduleData } from './utils/dataProcessor';
import { Ticket } from 'lucide-react';

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [selectedMovies, setSelectedMovies] = useState(new Set());
  // Composite `${movieKey}::${variant}` keys — a movie's Fan Event/Anniversary/etc.
  // sub-checkboxes, scoped per movie so the same variant text on two different movies
  // (e.g. "Private Theatre Rental") doesn't cross-filter both of them.
  const [selectedVariants, setSelectedVariants] = useState(new Set());
  const [selectedTheaters, setSelectedTheaters] = useState(new Set());
  const [selectedFormats, setSelectedFormats] = useState(new Set());
  const [selectedSeatings, setSelectedSeatings] = useState(new Set());
  const [selectedOthers, setSelectedOthers] = useState(new Set());
  const [selectedLanguages, setSelectedLanguages] = useState(new Set());
  const [pinnedShowtimes, setPinnedShowtimes] = useState(new Set());

  useEffect(() => {
    // Fetch data.json using Vite's BASE_URL so it works on GitHub Pages subpaths
    fetch(`${import.meta.env.BASE_URL}data.json`)
      .then(res => res.json())
      .then(json => {
        const processed = flattenScheduleData(json);
        setData(processed);

        const allTheaterIds = Object.values(processed.theaters).flat().map(t => t.id);
        setSelectedTheaters(new Set(allTheaterIds));

        setLoading(false);
      })
      .catch(err => {
        console.error("Error loading data:", err);
        setLoading(false);
      });
  }, []);



  const togglePin = (showtimeId) => {
    setPinnedShowtimes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(showtimeId)) {
        newSet.delete(showtimeId);
      } else {
        newSet.add(showtimeId);
      }
      return newSet;
    });
  };

  // Movie keys that have at least one variant sub-checkbox checked, so a movie's showtimes
  // can be narrowed to just those specific showings (e.g. just the Fan Event screening)
  // instead of the whole movie. Unrelated movies with no checked variant are unaffected.
  const moviesWithVariantFilter = useMemo(() => {
    const set = new Set();
    selectedVariants.forEach(v => set.add(v.slice(0, v.indexOf('::'))));
    return set;
  }, [selectedVariants]);

  const passesVariantFilter = useCallback((showtime) => {
    if (!moviesWithVariantFilter.has(showtime.movieKey)) return true;
    return !!showtime.variant && selectedVariants.has(`${showtime.movieKey}::${showtime.variant}`);
  }, [moviesWithVariantFilter, selectedVariants]);

  // Apply filters. If pinned, always show.
  const filteredShowtimes = data ? data.showtimes.filter(showtime => {
    if (pinnedShowtimes.has(showtime.id)) return true;

    if (selectedTheaters.size === 0) return false;
    if (!selectedTheaters.has(showtime.theaterId)) return false;

    const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

    if (selectedMovies.size === 0 || !selectedMovies.has(showtime.movieKey)) {
        return false;
    }

    if (!passesVariantFilter(showtime)) return false;

    if (selectedFormats.size > 0) {
        const hasSelectedFormat = formatArray.some(f => selectedFormats.has(f));
        if (!hasSelectedFormat) return false;
    }

    if (selectedLanguages.size > 0) {
        const hasSelectedLanguage = formatArray.some(f => selectedLanguages.has(f));
        if (!hasSelectedLanguage) return false;
    }

    if (selectedSeatings.size > 0) {
        const hasSelectedSeating = formatArray.some(f => selectedSeatings.has(f));
        if (!hasSelectedSeating) return false;
    }

    if (selectedOthers.size > 0) {
        const hasAllSelectedOthers = [...selectedOthers].every(f => formatArray.includes(f));
        if (!hasAllSelectedOthers) return false;
    }

    return true;
  }) : [];

  const dynamicFilters = useMemo(() => {
      if (!data) return { availableMovies: new Set(), availableVariantKeys: new Set(), availableTheaters: {}, availableFormats: [], availableSeatings: [], availableOthers: [], availableLanguages: [] };

      // `ignoreCategory` may be a single category name or an array of them — e.g. computing
      // variant availability ignores both 'variants' (its own filter) and 'movies' (so
      // selecting one movie doesn't hide another movie's variant checkboxes).
      const isShowtimeValid = (showtime, ignoreCategory) => {
        const ignored = Array.isArray(ignoreCategory) ? ignoreCategory : [ignoreCategory];
        if (selectedTheaters.size > 0 && !ignored.includes('theaters') && !selectedTheaters.has(showtime.theaterId)) return false;

        const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

        if (selectedMovies.size > 0 && !ignored.includes('movies') && !selectedMovies.has(showtime.movieKey)) {
            return false;
        }

        if (!ignored.includes('variants') && !passesVariantFilter(showtime)) return false;

        if (selectedFormats.size > 0 && !ignored.includes('formats')) {
            const hasSelectedFormat = formatArray.some(f => selectedFormats.has(f));
            if (!hasSelectedFormat) return false;
        }

        if (selectedLanguages.size > 0 && !ignored.includes('languages')) {
            const hasSelectedLanguage = formatArray.some(f => selectedLanguages.has(f));
            if (!hasSelectedLanguage) return false;
        }

        if (selectedSeatings.size > 0 && !ignored.includes('seatings')) {
            const hasSelectedSeating = formatArray.some(f => selectedSeatings.has(f));
            if (!hasSelectedSeating) return false;
        }

        if (selectedOthers.size > 0 && !ignored.includes('others')) {
            const hasAllSelectedOthers = [...selectedOthers].every(f => formatArray.includes(f));
            if (!hasAllSelectedOthers) return false;
        }

        return true;
      };

      const validMovies = new Set();
      const validTheaterIds = new Set();
      const validFormatNames = new Set();
      const validSeatingNames = new Set();
      const validOtherNames = new Set();
      const validLanguageNames = new Set();
      // Composite `${movieKey}::${variant}` keys still reachable under the other active
      // filters — e.g. selecting "IMAX" should hide a "Sensory Friendly Screening"
      // sub-checkbox whose showtimes don't actually have an IMAX showing.
      const validVariantKeys = new Set();

      data.showtimes.forEach(showtime => {
          const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

          if (isShowtimeValid(showtime, 'movies')) validMovies.add(showtime.movieKey);
          if (isShowtimeValid(showtime, 'theaters')) validTheaterIds.add(showtime.theaterId);
          if (isShowtimeValid(showtime, 'formats')) formatArray.forEach(f => validFormatNames.add(f));
          if (isShowtimeValid(showtime, 'seatings')) formatArray.forEach(f => validSeatingNames.add(f));
          if (isShowtimeValid(showtime, 'others')) formatArray.forEach(f => validOtherNames.add(f));
          if (isShowtimeValid(showtime, 'languages')) formatArray.forEach(f => validLanguageNames.add(f));
          if (showtime.variant && isShowtimeValid(showtime, ['variants', 'movies'])) validVariantKeys.add(`${showtime.movieKey}::${showtime.variant}`);
      });

      // Always retain currently selected items in the available pool so they can be unchecked
      selectedMovies.forEach(m => validMovies.add(m));
      selectedFormats.forEach(f => validFormatNames.add(f));
      selectedSeatings.forEach(s => validSeatingNames.add(s));
      selectedOthers.forEach(o => validOtherNames.add(o));
      selectedLanguages.forEach(l => validLanguageNames.add(l));
      selectedVariants.forEach(v => validVariantKeys.add(v));

      const availableTheaters = data.theaters;

      const availableFormats = data.formats.filter(f => validFormatNames.has(f));
      const availableSeatings = data.seatings.filter(s => validSeatingNames.has(s));
      const availableOthers = data.others.filter(o => validOtherNames.has(o));
      const availableLanguages = data.languages.filter(l => validLanguageNames.has(l));

      return { availableMovies: validMovies, availableVariantKeys: validVariantKeys, availableTheaters, availableFormats, availableSeatings, availableOthers, availableLanguages };
  }, [data, selectedMovies, selectedVariants, passesVariantFilter, selectedTheaters, selectedFormats, selectedLanguages, selectedSeatings, selectedOthers]);

  const { availableMovies, availableVariantKeys, availableTheaters, availableFormats, availableSeatings, availableOthers, availableLanguages } = dynamicFilters;

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading showtimes...</div>;
  }

  if (!data) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Failed to load data.</div>;
  }

  return (
    <div className="app-container">
      {/* Left Sidebar Filters */}
      <Filters
        groupedMovies={data.groupedMovies}
        movieDisplayTitles={data.movieDisplayTitles}
        movieVariants={data.movieVariants}
        availableMovies={availableMovies}
        availableVariantKeys={availableVariantKeys}
        theaters={availableTheaters}
        formats={availableFormats}
        languages={availableLanguages}
        selectedMovies={selectedMovies}
        setSelectedMovies={setSelectedMovies}
        selectedVariants={selectedVariants}
        setSelectedVariants={setSelectedVariants}
        selectedTheaters={selectedTheaters}
        setSelectedTheaters={setSelectedTheaters}
        selectedFormats={selectedFormats}
        setSelectedFormats={setSelectedFormats}
        seatings={availableSeatings}
        selectedSeatings={selectedSeatings}
        setSelectedSeatings={setSelectedSeatings}
        others={availableOthers}
        selectedOthers={selectedOthers}
        setSelectedOthers={setSelectedOthers}
        selectedLanguages={selectedLanguages}
        setSelectedLanguages={setSelectedLanguages}
      />

      {/* Right Main Content */}
      <main style={{ flex: 1, minWidth: 0 }}>
        <header style={{ marginBottom: '2rem' }}>
          <h1 className="header-title" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Ticket className="text-accent-color" size={32} color="var(--accent-color)" />
            AMC Guide
          </h1>
          <p className="header-subtitle">
            Showing {filteredShowtimes.length} upcoming showtimes
          </p>
        </header>

        <ShowtimeTimeline
          showtimes={filteredShowtimes}
          allDates={data.dates}
          pinnedShowtimes={pinnedShowtimes}
          onTogglePin={togglePin}
        />
      </main>
    </div>
  );
}

export default App;
