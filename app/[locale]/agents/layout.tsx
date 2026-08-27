import type { Metadata } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const path = '/agents';
  const canonical = locale === defaultLocale ? path : `/${locale}${path}`;
  return {
    title: 'AI agents',
    description: 'Seven specialised AI agents run the ZkWard vault: Lead, Risk, Hedging, Settlement, Reporting, PriceMonitor, SuiPool. 2-of-3 consensus on trades over $100k.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? path : `/${l}${path}`]),
      ),
    },
    // openGraph.images intentionally omitted — inherits the root-level
    // app/opengraph-image.tsx (1200x630 auto-generated brand card).
    openGraph: { title: 'AI agents · ZkWard', url: canonical, type: 'website' },
    twitter: { card: 'summary_large_image', title: 'AI agents · ZkWard' },
  };
}

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
