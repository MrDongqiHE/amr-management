import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Client-side public values (safe to expose: publishable key, designed for browser use)
const SUPABASE_URL = 'https://zmpfjtnhldeckinukbcs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_e6g34tcqkfQkjZhEUtd1kg_CC4sJhMq';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(SUPABASE_URL),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(SUPABASE_PUBLISHABLE_KEY),
  },
  server: { proxy: { '/api': { target: SUPABASE_URL, changeOrigin: true, rewrite: (path) => path.replace(/^\/api\/?/, '/functions/v1/') } } },
});