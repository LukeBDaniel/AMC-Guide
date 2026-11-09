# AMC Guide

**Live Site:** [https://LBDaniel.com/AMC-Guide](https://LBDaniel.com/AMC-Guide)

A personalized, automated web application designed to track, aggregate, and filter AMC theater showtimes across the New York and New Jersey areas. 

Built to solve the friction of navigating fragmented theater schedules, this project pulls showtimes from the official AMC Theatres API and serves them through a responsive React frontend to deliver a lightning-fast, faceted search experience.

## Features

- **Automated Daily Updates:** Every morning at 4:00 AM EDT (and on every push), a single GitHub Actions workflow fetches every ticketable showtime from the AMC Theatres API — one request per tracked theater — then builds and deploys the site. Showtime data is generated at deploy time rather than committed to the repository.
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
npm run fetch                # write frontend/public/data.json (used by `npm run dev` in frontend/)
```

Tracked theaters (API ID, name and state) are configured in `fetch-showtimes.js`. In GitHub Actions, the key comes from the `AMC_VENDOR_KEY` repository secret, and the currently deployed `data.json` is downloaded first so that any theater the API fails to return keeps its previous showtimes.

## iOS App

The iOS app wraps the same React frontend in a native shell with [Capacitor](https://capacitorjs.com), so filters, pins and the timeline behave exactly as on the website. On iPhone the filters open in a full-screen sheet, ticket links open in an in-app Safari view, and the last downloaded schedule is kept for offline use. The app fetches the showtimes published by the live site (set in `frontend/.env.ios`), so it stays current without an app update.

Requires Xcode and Node 20+:

```
cd frontend
npm run build:ios   # build the web app for iOS and copy it into ios/
npm run ios         # same, then open the project in Xcode to run on a simulator or device
```

Re-run `npm run build:ios` after any frontend change. To run on a physical iPhone, pick your team under *Signing & Capabilities* in Xcode.
