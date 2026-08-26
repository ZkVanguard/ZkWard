import type { Metadata } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const path = '/rwa';
  const canonical = locale === defaultLocale ? path : `/${locale}${path}`;
  return {
    title: 'Real-world assets',
    description: 'Custodian-signed attestations bind pool holdings to off-chain assets. Private list, provable backing. For issuers, custodians, and institutions.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? path : `/${l}${path}`]),
      ),
    },
    openGraph: {
      title: 'Real-world assets · ZkWard',
      url: canonical,
      type: 'website',
      images: ['/logo-official.svg'],
    },
    twitter: { card: 'summary_large_image', title: 'Real-world assets · ZkWard' },
  };
}

export default function RwaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
