import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: true,
    proxy: {
      '/isaac-s3': {
        target: 'https://omniverse-content-staging.s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/isaac-s3/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 800,
  },
  optimizeDeps: {
    include: ['three', 'physx-js-webidl'],
  },
});
