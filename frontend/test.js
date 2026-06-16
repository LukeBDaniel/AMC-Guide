import puppeteer from 'puppeteer';
import { spawn } from 'child_process';

const server = spawn('npm', ['run', 'preview', '--', '--port', '4173']);

setTimeout(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
        
        await page.goto('http://localhost:4173');
        await new Promise(r => setTimeout(r, 2000));
        await browser.close();
    } catch (e) {
        console.error(e);
    } finally {
        server.kill();
        process.exit(0);
    }
}, 2000);
