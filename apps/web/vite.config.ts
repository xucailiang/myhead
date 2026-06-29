import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import process from 'node:process'

const daemonTarget = process.env.MYHEAD_DAEMON_URL ?? 'http://127.0.0.1:17573'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: daemonTarget,
        changeOrigin: true,
      },
    },
  },
})
