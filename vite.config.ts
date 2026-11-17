import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/node_modules\/(prosemirror-|@tiptap\/pm)/.test(id)) return 'prosemirror';
          if (id.includes('/@tiptap/')) return 'tiptap';
          if (/node_modules\/(remark-|unified|micromark|mdast-|hast-|unist-|vfile)/.test(id)) return 'markdown';
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8088',
      '/embed-sandbox': 'http://127.0.0.1:8088',
      '/healthz': 'http://127.0.0.1:8088'
    }
  }
});
