import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // En desarrollo local, Vercel CLI (`vercel dev`) sirve /api por su cuenta.
      // Si usas solo `vite dev`, apunta este proxy a tu instancia de `vercel dev`.
      '/api': 'http://localhost:3000',
    },
  },
});
