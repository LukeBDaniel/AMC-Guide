const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const cheerio = require('cheerio');

// Add stealth plugin to bypass bot checks
chromium.use(stealth);

// Default theaters as requested by the user
const theaters = [
    { id: 'amc-empire-25', location: 'new-york' },
    { id: 'amc-lincoln-square-13', location: 'new-york' },
    { id: 'amc-34th-street-14', location: 'new-york' },
    { id: 'amc-kips-bay-15', location: 'new-york' },
    { id: 'amc-mountainside-10', location: 'new-jersey' },
    { id: 'amc-east-hanover-12', location: 'new-jersey' },
    { id: 'amc-aviation-12', location: 'new-jersey' },
    { id: 'amc-jersey-gardens-20', location: 'new-jersey' },
    { id: 'amc-clifton-commons-16', location: 'new-jersey' }
];

// Generate the next N days
function getDates(days = 4) {
    const dates = [];
    for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        // Format YYYY-MM-DD
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        dates.push(`${d.getFullYear()}-${month}-${day}`);
    }
    return dates;
}

async function scrapeAMC() {
    console.log('Starting AMC Scraper...');
    const browser = await chromium.launch({ headless: process.env.CI ? true : false });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });
    
    const page = await context.newPage();
    const dates = getDates(14); // Scrape the next 14 days
    console.log(`Calendar dates to scrape:`, dates);
    
    const fullSchedule = {
        scrapedAt: new Date().toISOString(),
        theaters: {}
    };

    for (const theater of theaters) {
        fullSchedule.theaters[theater.id] = {
            id: theater.id,
            location: theater.location,
            schedule: []
        };

        for (const date of dates) {
            const url = `https://www.amctheatres.com/movie-theatres/${theater.location}/${theater.id}/showtimes/all/${date}/${theater.id}/all`;
            console.log(`\nNavigating to ${theater.id} for date ${date}...`);
            
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // Wait to ensure dynamic Next.js content (React Server Components) has hydrated and rendered.
                await page.waitForTimeout(5000);

                // Extract HTML of the main content area
                const mainHtml = await page.evaluate(() => {
                    const main = document.querySelector('main');
                    return main ? main.innerHTML : document.body.innerHTML;
                });

                const $ = cheerio.load(mainHtml);
                const dailyData = {
                    date,
                    movies: []
                };

                // Parse the DOM using the structured sections
                $('section[id]').each((i, sectionEl) => {
                    const $section = $(sectionEl);
                    const titleNode = $section.find('h1 a');
                    if (titleNode.length === 0) return; // Skip if no title is found

                    const title = titleNode.text().trim();
                    const movieLink = titleNode.attr('href');
                    
                    const metadataList = $section.find('ul').first().find('li span.uppercase');
                    const runtime = metadataList.eq(0).text().trim() || null;
                    const ratingNode = $section.find('span[aria-label^="MPAA Rating"]');
                    const rating = ratingNode.length ? ratingNode.text().trim() : null;

                    const movieObj = {
                        title,
                        link: movieLink,
                        runtime,
                        rating,
                        formats: []
                    };

                    const formatListItems = $section.find('li[role="listitem"][aria-label$="Showtimes"]');
                    formatListItems.each((j, formatEl) => {
                        const $format = $(formatEl);
                        const formatTitleNode = $format.find('h3 span').first();
                        const formatName = formatTitleNode.text().trim() || $format.attr('aria-label').replace(' Showtimes', '');

                        const additionalTags = [];
                        $format.find('ul[id$="-attributes"] li').each((_, liEl) => {
                            const txt = $(liEl).text().trim();
                            if (txt) additionalTags.push(txt);
                        });

                        const allFormats = Array.from(new Set([formatName, ...additionalTags]));

                        const showtimes = [];
                        $format.find('ul[aria-label="Showtime Group Results"] a').each((k, timeEl) => {
                            const timeTextNode = $(timeEl).contents().filter(function() {
                                return this.nodeType === 3;
                            }).text().trim();
                            
                            const timeLink = $(timeEl).attr('href');
                            const performanceId = timeLink ? timeLink.split('/').pop() : null;
                            const alertNode = $(timeEl).find('span.sr-only');
                            const alertText = alertNode.length ? alertNode.text().trim() : null;

                            if (timeTextNode) {
                                showtimes.push({
                                    time: timeTextNode,
                                    performanceId,
                                    alert: alertText
                                });
                            }
                        });

                        if (showtimes.length > 0) {
                            movieObj.formats.push({ formats: allFormats, showtimes });
                        }
                    });

                    dailyData.movies.push(movieObj);
                });

                console.log(`Extracted ${dailyData.movies.length} movies for ${date}`);
                fullSchedule.theaters[theater.id].schedule.push(dailyData);

            } catch (err) {
                console.error(`Error scraping ${theater.id} on ${date}:`, err.message);
            }
        }
    }

    await browser.close();

    // Write the massive JSON data object to data.json
    fs.writeFileSync('data.json', JSON.stringify(fullSchedule, null, 2));
    fs.writeFileSync('frontend/public/data.json', JSON.stringify(fullSchedule, null, 2));
    console.log('\nSuccessfully saved schedule data to data.json and frontend/public/data.json!');
}

scrapeAMC().catch(console.error);
