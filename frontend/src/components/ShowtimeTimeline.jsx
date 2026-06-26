import React from 'react';
import { Calendar, Pin } from 'lucide-react';

export default function ShowtimeTimeline({ showtimes, allDates, pinnedShowtimes = new Set(), onTogglePin }) {
    if (showtimes.length === 0 && (!allDates || allDates.length === 0)) {
        return (
            <div className="empty-state">
                <h3>Select a theater and movies</h3>
                <p>Use the filters on the left to select at least one theater. Then, select specific movies, or check the Premium Formats override to see what's playing.</p>
            </div>
        );
    }

    // Group by Date
    const groupedByDate = {};
    if (allDates) {
        allDates.forEach(d => groupedByDate[d] = []);
    }
    showtimes.forEach(showtime => {
        if (!groupedByDate[showtime.date]) groupedByDate[showtime.date] = [];
        groupedByDate[showtime.date].push(showtime);
    });

    const datesToRender = allDates ? allDates : Object.keys(groupedByDate).sort();

    const formatDate = (dateStr) => {
        const d = new Date(dateStr);
        const correctedDate = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
        return correctedDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'short', 
            day: 'numeric' 
        });
    };

    // Generate a unique HSL color based on the movie title with reduced opacity
    const getColorForMovie = (title) => {
        let hash = 0;
        for (let i = 0; i < title.length; i++) {
            hash = title.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash) % 360;
        // 45% lightness ensures white text remains readable, 0.85 opacity makes the block slightly transparent
        return `hsla(${hue}, 70%, 45%, 0.85)`;
    };

    // Calculate layout for overlapping events (VERTICAL TIMELINE)
    const calculateLayout = (events) => {
        // Shallow clone to prevent mutating the global data.showtimes objects
        const sorted = events.map(e => ({ ...e })).sort((a, b) => a.timeMinutes - b.timeMinutes);
        const positioned = [];
        
        // Pass 1: Indent Assignment
        sorted.forEach((event, idx) => {
            // Calculate indentIndex (lowest available indent lane among ALL overlapping events)
            const activeIndents = new Set();
            positioned.forEach(prev => {
                if (prev.timeMinutes + prev.runtimeMinutes > event.timeMinutes) {
                    activeIndents.add(prev.indentIndex);
                }
            });
            
            let indentIndex = 0;
            while (activeIndents.has(indentIndex)) {
                indentIndex++;
            }
            
            event.indentIndex = indentIndex;
            event.sortIndex = idx; // Track chronological order for zIndex
            positioned.push(event);
        });
        
        // Pass 2: Cluster grouping
        const clusters = [];
        positioned.forEach(event => {
            const overlappingClusters = clusters.filter(cluster => 
                cluster.some(prev => prev.timeMinutes + prev.runtimeMinutes > event.timeMinutes)
            );
            
            if (overlappingClusters.length > 0) {
                // Merge all overlapping clusters into the primary one
                const primaryCluster = overlappingClusters[0];
                primaryCluster.push(event);
                
                for (let i = 1; i < overlappingClusters.length; i++) {
                    primaryCluster.push(...overlappingClusters[i]);
                    overlappingClusters[i].length = 0; // Empty it out
                }
            } else {
                clusters.push([event]);
            }
        });
        
        const validClusters = clusters.filter(c => c.length > 0);
        
        // Pass 3: Apply Styles
        validClusters.forEach(cluster => {
            // The maximum indent lane in this continuous block of overlapping events
            const maxIndex = Math.max(...cluster.map(e => e.indentIndex));
            
            // We want the maximum indent to ALWAYS be 50%. 
            // We step evenly up to 50% based on how many overlaps there are.
            const stepPct = maxIndex > 0 ? 50 / maxIndex : 0;
            
            cluster.forEach(event => {
                let styleObj = {};
                
                // Y-axis mapping (9 AM = 540 mins, 4 AM next day = 1680 mins, total 1140 mins)
                const topPercent = ((event.timeMinutes - 540) / 1140) * 100;
                const heightPercent = (event.runtimeMinutes / 1140) * 100;
                
                styleObj.top = `${topPercent}%`;
                styleObj.height = `${heightPercent}%`;
                
                const indentPct = event.indentIndex * stepPct;
                
                if (indentPct > 0) {
                    styleObj.left = `${indentPct}%`;
                    styleObj.width = `${100 - indentPct}%`;
                } else {
                    styleObj.left = '0';
                    styleObj.width = '100%';
                }
                
                styleObj.backgroundColor = getColorForMovie(event.movieTitle);
                // Ensure later chronological movies always float to the top
                styleObj.zIndex = 10 + event.sortIndex;
                // If pinned, boost zIndex significantly
                if (pinnedShowtimes.has(event.id)) {
                    styleObj.zIndex += 1000;
                }
                event.styleObj = styleObj;
            });
        });
        
        return positioned;
    };

    // Generate 9 AM to 4 AM next day (19 hours total, inclusive ends = 20 markers)
    const hours = Array.from({length: 20}, (_, i) => i + 9);

    return (
        <div className="timeline-container vertical">
            {/* 19 Hour Ruler (Y-axis now) */}
            <div className="timeline-y-axis">
                <div className="timeline-corner"></div>
                {hours.map(hour => (
                    <div key={hour} className="timeline-hour-marker-y">
                        {hour === 12 ? '12 PM' : hour === 24 ? '12 AM' : hour > 24 ? `${hour-24} AM` : hour > 12 ? `${hour-12} PM` : `${hour} AM`}
                    </div>
                ))}
            </div>

            {/* Timeline Columns per Date (X-axis) */}
            <div className="timeline-x-axis">
                {datesToRender.map(date => {
                    const positionedEvents = calculateLayout(groupedByDate[date] || []);

                    return (
                        <div key={date} className="timeline-column">
                            <div className="timeline-col-label">
                                <Calendar size={16} />
                                <span>{formatDate(date)}</span>
                            </div>
                            <div className="timeline-day-col">
                                {/* Horizontal Grid lines for each hour */}
                                {hours.map(hour => (
                                    <div key={hour} className="timeline-grid-line-x"></div>
                                ))}
                                
                                {/* Event Blocks */}
                                {positionedEvents.map(event => {
                                    const isPinned = pinnedShowtimes.has(event.id);
                                    return (
                                        <div 
                                            key={event.id}
                                            className={`timeline-block ${isPinned ? 'pinned' : ''}`}
                                            style={event.styleObj}
                                            onClick={() => window.open(event.link, '_blank')}
                                            role="button"
                                            tabIndex={0}
                                            title={`${event.movieTitle} (${event.time} - ${event.runtime})`}
                                        >
                                            <button 
                                                className={`pin-btn ${isPinned ? 'active' : ''}`}
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    onTogglePin(event.id);
                                                }}
                                                title={isPinned ? "Unpin showtime" : "Pin showtime"}
                                            >
                                                <Pin size={12} fill={isPinned ? 'currentColor' : 'none'} />
                                            </button>
                                            <div className="timeline-block-content">
                                                <div className="timeline-block-time">
                                                    {event.time} <span style={{ opacity: 0.8, fontWeight: 500 }}>({event.runtime})</span>
                                                </div>
                                                <div className="timeline-block-title">{event.movieTitle}</div>
                                                <div className="timeline-block-meta">
                                                    {event.theaterName}
                                                    <span className="timeline-block-tags">
                                                        {' • '}{Array.isArray(event.format) ? event.format.filter(f => f !== 'Included in A-List').join(', ') : event.format}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
