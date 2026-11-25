// из N5: projects/05-podcast-clips-opus/apps/web/next.config.ts — + serverExternalPackages: bullmq читает
// свои Lua-скрипты с диска относительно своего пакета; в бандле Next эти пути теряются (pdf-source).
import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = { poweredByHeader: false, outputFileTracingRoot: path.resolve(__dirname, '../..'), experimental: { cpus: 2 },
  serverExternalPackages: ['bullmq'],
  async headers() {
    const privatePage = [
      { key: 'Cache-Control', value: 'no-store, max-age=0' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];
    return [
      ...['/verify-email', '/reset'].map(source => ({ source, headers: privatePage })),
      { source: '/support', headers: [...privatePage, {
        key: 'Content-Security-Policy',
        value: "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://support.clipmkr.ru wss://support.clipmkr.ru; frame-src 'self' https://support.clipmkr.ru; frame-ancestors 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://support.clipmkr.ru; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
      }] },
    ];
  } };
export default config;
