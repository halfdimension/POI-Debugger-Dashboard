import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VPD_');
  const backendUrl = env.VPD_BACKEND_URL || 'http://127.0.0.1:8010';

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      // This is an internal debugging tool and may be opened using either the
      // host machine's IP address or a company DNS name.
      allowedHosts: true,
      proxy: {
        '/api': backendUrl,
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      allowedHosts: true,
    },
  };
});
