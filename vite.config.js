import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/papertok/',
  plugins: [react()],
  server: {
    proxy: {
      '/api/arxiv': {
        target: 'http://export.arxiv.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/arxiv/, '/api/query'),
      },
    },
  },
})
