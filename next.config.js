const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin();

// --- Build-time env sanitization ---------------------------------------------
// Strip trailing CRLF, stray whitespace, and matched surrounding quotes from
// every env var. This protects build-time-inlined `NEXT_PUBLIC_*` constants
// from upstream upload corruption (e.g. PowerShell pipe CRLF). The
// `instrumentation.ts` hook handles runtime; this handles build.
{
  let sanitized = 0;
  for (const k of Object.keys(process.env)) {
    const raw = process.env[k];
    if (raw === undefined) continue;
    let v = raw.replace(/[\r\n\t\u00A0]+/g, '');
    if (v.length >= 2) {
      const f = v.charCodeAt(0);
      const l = v.charCodeAt(v.length - 1);
      if ((f === 34 || f === 39) && f === l) v = v.slice(1, -1);
    }
    v = v.replace(/^[\x20]+|[\x20]+$/g, '');
    if (v !== raw) {
      process.env[k] = v;
      sanitized++;
    }
  }
  if (sanitized > 0) {
    // eslint-disable-next-line no-console
    console.log(`[next.config] Sanitized ${sanitized} env var(s) at build start`);
  }
}
// -----------------------------------------------------------------------------

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Standalone output — smaller deployment, faster cold starts
  output: 'standalone',

  // Performance optimizations
  experimental: {
    optimizePackageImports: [
      'viem', 'lucide-react', '@heroicons/react', 'framer-motion',
      'chart.js', 'react-chartjs-2', '@mysten/dapp-kit', '@mysten/sui',
      'ethers', 'eventemitter3', 'uuid',
      '@tanstack/react-query', 'react-markdown', 'remark-gfm',
    ],
    // optimizeCss removed: it's webpack-only + requires the `critters`
    // dependency (not installed). Next 16 defaults to Turbopack for
    // `next build`, so the flag was a no-op. Turbopack uses lightningcss.
  },

  // Reduce serverless function size (moved from experimental in Next 15)
  outputFileTracingExcludes: {
    '*': [
      'node_modules/@swc/core-linux-x64-gnu',
      'node_modules/@swc/core-linux-x64-musl',
      'node_modules/@esbuild',
      'node_modules/sharp',
    ],
  },

  // Compiler optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  // Turbopack config (v16 default). Only silences Node-native modules that
  // sneak into client bundles via transitive web3 deps; refactor imports if
  // you can, this is a fallback per Next 16 upgrade guide.
  // ponytail: minimal turbopack config, add resolveAlias entries only when
  //   a runtime "Can't resolve X for browser" surfaces.
  turbopack: {},

  // env: {} block removed — all vars listed were NEXT_PUBLIC_*, which
  // Next.js auto-inlines at build time. The block was doubling that work.
  // API keys stay server-only via process.env on server routes; never
  // expose CRYPTOCOM_DEVELOPER_API_KEY or any secret to the browser.

  // Production optimizations
  compress: true,
  poweredByHeader: false,

  // Image optimization
  images: {
    // Next 16: images.domains deprecated in favor of remotePatterns
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 24h image caching
    deviceSizes: [640, 750, 828, 1080, 1200], // Fewer sizes = fewer variants to cache
  },
  
  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.cryptocom.com https://*.crypto.com https://api.coingecko.com https://hermes.pyth.network wss: https:",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
