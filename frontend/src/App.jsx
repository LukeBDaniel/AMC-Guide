import { useState, useEffect, useMemo } from 'react';
import Filters from './components/Filters';
import ShowtimeTimeline from './components/ShowtimeTimeline';
import { flattenScheduleData } from './utils/dataProcessor';
import { Ticket } from 'lucide-react';

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // Filter state
  const [selectedMovies, setSelectedMovies] = useState(new Set());
  const [selectedTheaters, setSelectedTheaters] = useState(new Set());
  const [selectedFormats, setSelectedFormats] = useState(new Set());
  const [selectedSeatings, setSelectedSeatings] = useState(new Set());
  const [selectedOthers, setSelectedOthers] = useState(new Set());
  const [selectedLanguages, setSelectedLanguages] = useState(new Set());
  const [pinnedShowtimes, setPinnedShowtimes] = useState(new Set());

  useEffect(() => {
    // Fetch data.json from public folder
    fetch('/data.json')
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

  // Apply filters. If pinned, always show.
  const filteredShowtimes = data ? data.showtimes.filter(showtime => {
    if (pinnedShowtimes.has(showtime.id)) return true;
    
    if (selectedTheaters.size === 0) return false;
    if (!selectedTheaters.has(showtime.theaterId)) return false;

    const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

    if (selectedMovies.size === 0 || !selectedMovies.has(showtime.movieTitle)) {
        return false;
    }

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
      if (!data) return { availableMovies: new Set(), availableTheaters: {}, availableFormats: [], availableSeatings: [], availableOthers: [], availableLanguages: [] };
      
      const isShowtimeValid = (showtime, ignoreCategory) => {
        if (selectedTheaters.size > 0 && ignoreCategory !== 'theaters' && !selectedTheaters.has(showtime.theaterId)) return false;

        const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

        if (selectedMovies.size > 0 && ignoreCategory !== 'movies' && !selectedMovies.has(showtime.movieTitle)) {
            return false;
        }

        if (selectedFormats.size > 0 && ignoreCategory !== 'formats') {
            const hasSelectedFormat = formatArray.some(f => selectedFormats.has(f));
            if (!hasSelectedFormat) return false;
        }

        if (selectedLanguages.size > 0 && ignoreCategory !== 'languages') {
            const hasSelectedLanguage = formatArray.some(f => selectedLanguages.has(f));
            if (!hasSelectedLanguage) return false;
        }

        if (selectedSeatings.size > 0 && ignoreCategory !== 'seatings') {
            const hasSelectedSeating = formatArray.some(f => selectedSeatings.has(f));
            if (!hasSelectedSeating) return false;
        }

        if (selectedOthers.size > 0 && ignoreCategory !== 'others') {
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

      data.showtimes.forEach(showtime => {
          const formatArray = Array.isArray(showtime.format) ? showtime.format : [showtime.format];

          if (isShowtimeValid(showtime, 'movies')) validMovies.add(showtime.movieTitle);
          if (isShowtimeValid(showtime, 'theaters')) validTheaterIds.add(showtime.theaterId);
          if (isShowtimeValid(showtime, 'formats')) formatArray.forEach(f => validFormatNames.add(f));
          if (isShowtimeValid(showtime, 'seatings')) formatArray.forEach(f => validSeatingNames.add(f));
          if (isShowtimeValid(showtime, 'others')) formatArray.forEach(f => validOtherNames.add(f));
          if (isShowtimeValid(showtime, 'languages')) formatArray.forEach(f => validLanguageNames.add(f));
      });

      // Always retain currently selected items in the available pool so they can be unchecked
      selectedMovies.forEach(m => validMovies.add(m));
      selectedFormats.forEach(f => validFormatNames.add(f));
      selectedSeatings.forEach(s => validSeatingNames.add(s));
      selectedOthers.forEach(o => validOtherNames.add(o));
      selectedLanguages.forEach(l => validLanguageNames.add(l));

      const availableTheaters = data.theaters;
      
      const availableFormats = data.formats.filter(f => validFormatNames.has(f));
      const availableSeatings = data.seatings.filter(s => validSeatingNames.has(s));
      const availableOthers = data.others.filter(o => validOtherNames.has(o));
      const availableLanguages = data.languages.filter(l => validLanguageNames.has(l));

      return { availableMovies: validMovies, availableTheaters, availableFormats, availableSeatings, availableOthers, availableLanguages };
  }, [data, selectedMovies, selectedTheaters, selectedFormats, selectedLanguages, selectedSeatings, selectedOthers]);

  const { availableMovies, availableTheaters, availableFormats, availableSeatings, availableOthers, availableLanguages } = dynamicFilters;

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
        availableMovies={availableMovies}
        theaters={availableTheaters}
        formats={availableFormats}
        languages={availableLanguages}
        selectedMovies={selectedMovies}
        setSelectedMovies={setSelectedMovies}
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
