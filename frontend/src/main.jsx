import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { isNative } from './utils/platform'
import { StatusBar, Style } from '@capacitor/status-bar'

if (isNative) {
  // Scopes the iOS layout in index.css to the app, leaving the website untouched.
  document.documentElement.classList.add('native-app')
  // Dark status bar text to match the light theme, even when the phone is in dark mode.
  StatusBar.setStyle({ style: Style.Light })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
