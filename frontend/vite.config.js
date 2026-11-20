import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The iOS app downloads showtimes from the website (VITE_DATA_BASE_URL in .env.ios), so the
// showtime files a local `npm run fetch` leaves in public/ are kept out of the app bundle.
function omitShowtimeData() {
  let outDir
  return {
    name: 'omit-showtime-data',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const name of ['data', 'data.json']) {
        fs.rmSync(path.join(outDir, name), { recursive: true, force: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), mode === 'ios' && omitShowtimeData()],
  // The iOS app serves the build from the app bundle's root, not the GitHub Pages subpath.
  base: mode === 'ios' ? './' : '/AMC-Guide/',
}))
