# AMC Guide

**Live Site:** [https://LBDaniel.com/AMC-Guide](https://LBDaniel.com/AMC-Guide)

A personalized, automated web application designed to track, aggregate, and filter AMC theater showtimes at any AMC in the US. 

Built to solve the friction of navigating fragmented theater schedules, this project pulls showtimes from the official AMC Theatres API and serves them through a responsive React frontend to deliver a lightning-fast, faceted search experience.

## Features

- **Your Theaters, Anywhere:** Star the AMCs you go to; "Use my location" lists the nearest theaters first (without location access, theaters near your favorites come first). Favorites are kept on your device, and only their schedules are downloaded.
- **Automated Daily Updates:** Every morning at 4:00 AM EDT (and on every push), a single GitHub Actions workflow lists every open AMC theater and fetches its ticketable showtimes from the AMC Theatres API — one request per theater, paced at no more than two a second — then builds and deploys the site. Showtime data is generated at deploy time rather than committed to the repository.
- **Coming Soon Tracking:** Advance-ticket performances beyond the next two weeks are grouped separately in the Movies filter without breaking the unified, scrollable timeline.
- **True Faceted Search:** Dynamically filters theaters, formats (IMAX, 70mm, Dolby), and movies in real-time. Selecting mutually exclusive options intelligently hides conflicting tags to prevent empty calendar states.
- **Smart Categorization:** Automatically groups movies into custom subgenres (e.g., *New Movies*, *Fan Faves & Classics*, *Events*) based on metadata, title parsing, and format tags.
- **Visual Timeline:** Renders showtimes in an intuitive, horizontally-scrollable timeline clustered by time block, ensuring premium formats and overlapping schedules are easy to digest at a glance.

## Tech Stack

- **Frontend:** React, Vite, Vanilla CSS
- **Data Pipeline:** Node.js (no dependencies), AMC Theatres API
- **CI/CD & Automation:** GitHub Actions (Automated Cron Jobs)
- **Hosting:** Static deployment ready

## Running Locally

The data pipeline needs an AMC Theatres API vendor key. Put it in a `.env` file at the repository root (it is git-ignored):

```
AMC_VENDOR_KEY=your-key-here
```

Then:

```
npm test                     # pipeline and frontend data-processing tests
npm run fetch -- --dry-run   # fetch and validate without writing files
npm run fetch                # write frontend/public/data/ (used by `npm run dev` in frontend/)
```

A full run covers all ~520 theaters and takes about five minutes. It writes `data/theaters.json` (every theater, with its location and time zone) and one `data/theaters/{id}.json` per theater; the formats are described at the top of `fetch-showtimes.js`. In GitHub Actions, the key comes from the `AMC_VENDOR_KEY` repository secret. A theater the API fails to return keeps its previous showtimes, downloaded from the live site, and the run is only marked failed when more than 5% of theaters fail.

## iOS App

The iOS app wraps the same React frontend in a native shell with [Capacitor](https://capacitorjs.com), so filters, pins and the timeline behave exactly as on the website. On iPhone the filters open in a full-screen sheet, ticket links open in an in-app Safari view, and the last downloaded schedule is kept for offline use. The app fetches the showtimes published by the live site (set in `frontend/.env.ios`), so it stays current without an app update. "Use my location" asks for location permission the first time.

Requires Xcode and Node 20+:

```
cd frontend
npm run build:ios   # build the web app for iOS and copy it into ios/
npm run ios         # same, then open the project in Xcode to run on a simulator or device
```

Re-run `npm run build:ios` after any frontend change. To run on a physical iPhone, pick your team under *Signing & Capabilities* in Xcode.
