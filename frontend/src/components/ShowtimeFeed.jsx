import React from 'react';
import { Calendar, Clock, MapPin, Film } from 'lucide-react';

export default function ShowtimeFeed({ showtimes }) {
    if (showtimes.length === 0) {
        return (
            <div className="empty-state">
                <Film className="empty-state-icon" size={48} />
                <h3>No showtimes found</h3>
                <p>Try adjusting your filters to see more results.</p>
            </div>
        );
    }

    // Group showtimes by date
    const groupedByDate = showtimes.reduce((acc, showtime) => {
        if (!acc[showtime.date]) {
            acc[showtime.date] = [];
        }
        acc[showtime.date].push(showtime);
        return acc;
    }, {});

    // Helper to format date nicely (e.g. "Monday, Jun 15")
    const formatDate = (dateStr) => {
        const d = new Date(dateStr);
        // Correct for timezone offset to prevent off-by-one errors from YYYY-MM-DD
        const correctedDate = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
        return correctedDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'short', 
            day: 'numeric' 
        });
    };

    return (
        <div className="feed-container">
            {Object.keys(groupedByDate).sort().map(date => (
                <div key={date} className="date-group">
                    <h2 className="date-header">
                        <Calendar size={20} className="text-accent-color" />
                        {formatDate(date)}
                    </h2>
                    
                    {groupedByDate[date].map(showtime => (
                        <a 
                            key={showtime.id} 
                            href={showtime.link} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="showtime-card"
                        >
                            <div className="showtime-time-block">
                                <Clock size={18} color="var(--text-tertiary)" />
                                <span className="showtime-time">{showtime.time}</span>
                            </div>

                            <div className="showtime-details">
                                <div className="showtime-movie-title">{showtime.movieTitle}</div>
                                
                                <div className="showtime-meta">
                                    <span className="meta-item">
                                        <MapPin size={14} />
                                        {showtime.theaterName}
                                    </span>
                                    {showtime.rating && (
                                        <>
                                            <span className="meta-divider">•</span>
                                            <span className="meta-item">{showtime.rating}</span>
                                        </>
                                    )}
                                    {showtime.runtime && (
                                        <>
                                            <span className="meta-divider">•</span>
                                            <span className="meta-item">{showtime.runtime}</span>
                                        </>
                                    )}
                                </div>

                                <div className="showtime-badges">
                                    <span className="badge">{showtime.format}</span>
                                    {showtime.alert && (
                                        <span className="badge badge-alert">{showtime.alert}</span>
                                    )}
                                </div>
                            </div>
                        </a>
                    ))}
                </div>
            ))}
        </div>
    );
}
