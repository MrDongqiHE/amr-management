import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],
server:{proxy:{'/api':{target:'https://zmpfjtnhldeckinukbcs.supabase.co',changeOrigin:true,rewrite:(path)=>path.replace(/^\/api\/?/,'/functions/v1/')}}}});