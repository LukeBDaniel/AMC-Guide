import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The iOS app serves the build from the app bundle's root, not the GitHub Pages subpath.
  base: mode === 'ios' ? './' : '/AMC-Guide/',
}))
