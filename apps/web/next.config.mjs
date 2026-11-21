import { readFileSync } from 'node:fs';

/** L'interface appelle l'API via /api/* (même origine : cookies de session httpOnly, pas de CORS). */
const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

/** Version de l'application (package.json), seul champ transmis au navigateur. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dossier de construction modifiable : permet un « next build » sans perturber un « next dev » en cours.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: version },
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
    ] }];
  },
};
export default nextConfig;
