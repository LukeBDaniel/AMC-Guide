# AMC Guide

A personalized, automated web application designed to track, aggregate, and filter AMC theater showtimes across the New York and New Jersey areas. 

Built to solve the friction of navigating fragmented theater schedules, this project uses a custom web scraper and a responsive React frontend to deliver a lightning-fast, faceted search experience.

## Features

- **Automated Daily Scraping:** Powered by GitHub Actions, a headless Playwright scraper runs every morning at 4:00 AM EDT to fetch a rolling 14-day window of showtimes.
- **True Faceted Search:** Dynamically filters theaters, formats (IMAX, 70mm, Dolby), and movies in real-time. Selecting mutually exclusive options intelligently hides conflicting tags to prevent empty calendar states.
- **Smart Categorization:** Automatically groups movies into custom subgenres (e.g., *New Movies*, *Fan Faves & Classics*, *Events*) based on metadata, title parsing, and format tags.
- **Visual Timeline:** Renders showtimes in an intuitive, horizontally-scrollable timeline clustered by time block, ensuring premium formats and overlapping schedules are easy to digest at a glance.

## Tech Stack

- **Frontend:** React, Vite, Vanilla CSS
- **Data Pipeline:** Node.js, Playwright (Headless Web Scraping)
- **CI/CD & Automation:** GitHub Actions (Automated Cron Jobs)
- **Hosting:** Static deployment ready

## Running Locally

### 1. Scrape the Data
To manually fetch the latest showtimes and generate the `data.json` file:
```bash
npm install
npx playwright install chromium
node scraper.js
```

### 2. Run the Frontend
To boot up the React application:
```bash
cd frontend
npm install
npm run dev
```
