import type { MetadataRoute } from 'next';

// Next 13+ file-based convention. Emitted at /robots.txt at build time,
// picked up by Google/Bing/etc. Kept short — /api/ + /dashboard are
// per-user or non-indexable, so we disallow them to keep the crawl budget
// on the marketing surface.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com').replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard', '/simulator'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
