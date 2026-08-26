import type { MetadataRoute } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

// Marketing routes only. Dashboard/simulator/api are per-user or dynamic
// and excluded from sitemap (robots also disallows). Each entry declares
// its language alternates so Google reads the 12 locales as siblings, not
// duplicate content.
const MARKETING_ROUTES = ['', '/agents', '/zk', '/rwa', '/whitepaper', '/privacy', '/terms'] as const;

// localePrefix: 'as-needed' — defaultLocale has no /en prefix, others do.
function urlFor(base: string, locale: string, route: string): string {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return `${base}${prefix}${route}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com').replace(/\/$/, '');
  const now = new Date();

  return MARKETING_ROUTES.map((route) => ({
    url: urlFor(base, defaultLocale, route),
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: route === '' ? 1 : 0.7,
    alternates: {
      languages: Object.fromEntries(
        locales.map((l) => [l, urlFor(base, l, route)]),
      ),
    },
  }));
}
