import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev: forward API calls to the Express backend on :3000 so the
    // frontend can use same-origin relative "/api" paths (matches production).
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
})
