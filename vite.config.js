import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: true,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 800,
  },
  optimizeDeps: {
    include: ['three'],
  },
});
