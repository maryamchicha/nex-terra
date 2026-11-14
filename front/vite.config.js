import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/nex-terra/',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8000' } },
  build: { 
    outDir: 'dist',
    commonjsOptions: { transformMixedEsModules: true }
  }
})
