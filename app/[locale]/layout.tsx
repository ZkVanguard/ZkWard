import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata, Viewport } from 'next';
import { Space_Grotesk } from 'next/font/google';
import '../../styles/globals.css';
import { Providers } from '../providers';
import { Navbar } from '../../components/Navbar';
import { Footer } from '../../components/Footer';
import { CookieConsent } from '../../components/CookieConsent';
import { PwaProvider } from '../../components/PwaProvider';
import { LegacyDomainBanner } from '../../components/LegacyDomainBanner';
import { locales } from '../../i18n/request';
import { IntlProvider } from '../../components/IntlProvider';

// Display face — self-hosted (no <link> to fonts.googleapis.com), variable
// CSS var consumed by `font-display` utility in tailwind config. Applied to
// hero headlines only; body stays on SF for zero-cost native feel.
const displayFont = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// Mobile-first viewport: viewportFit 'cover' enables env(safe-area-inset-*)
// so we can pad around the iPhone home indicator and notch. themeColor
// matches the app background so the iOS status bar blends in.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export async function generateMetadata(
  props: {
    params: Promise<{ locale: string }>;
  }
): Promise<Metadata> {
  const params = await props.params;

  const {
    locale
  } = params;

  const t = await getTranslations({ locale, namespace: 'hero' });

  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com'),
    title: 'ZkWard - AI-Powered RWA Risk Management with Zero-Knowledge Proofs',
    description: t('subtitle'),
    keywords: ['RWA', 'DeFi', 'AI Agents', 'Risk Management', 'Cronos', 'zkEVM'],
    authors: [{ name: 'ZkWard Team' }],
    icons: {
      icon: '/logo-official.svg',
      shortcut: '/logo-official.svg',
      apple: '/logo-official.svg',
    },
    manifest: '/manifest.json',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: 'ZkWard',
    },
    openGraph: {
      title: 'ZkWard',
      description: 'AI-Powered RWA Risk Management Platform',
      type: 'website',
      images: ['/logo-official.svg'],
    },
  };
}

export default async function LocaleLayout(
  props: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
  }
) {
  const params = await props.params;

  const {
    locale
  } = params;

  const {
    children
  } = props;

  // Validate locale
  if (!locales.includes(locale as typeof locales[number])) {
    notFound();
  }

  return (
    <html lang={locale} className={displayFont.variable} suppressHydrationWarning>
      <head>
        {/* Resource hints for faster loading */}
        <link rel="preconnect" href="https://api.crypto.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://api.crypto.com" />
        <link rel="preconnect" href={process.env.NEXT_PUBLIC_CRONOS_RPC || 'https://evm.cronos.org'} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={process.env.NEXT_PUBLIC_CRONOS_RPC || 'https://evm.cronos.org'} />
        
        {/* Preload critical fonts (system fonts, no external fonts needed) */}
        <style dangerouslySetInnerHTML={{ __html: `
          /* Critical inline CSS for instant render */
          * { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          body { margin: 0; background: #fff; }
          @keyframes shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
        `}} />
        
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Critical theme initialization (no FOUC - Flash Of Unstyled Content)
              (function() {
                const theme = localStorage.getItem('theme') || 'light';
                if (theme === 'dark') {
                  document.documentElement.classList.add('dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body className="antialiased bg-system-bg-primary min-h-screen" suppressHydrationWarning>
        <IntlProvider locale={locale}>
          <Providers>
            <div className="flex flex-col min-h-screen">
              <LegacyDomainBanner />
              <Navbar />
              <main className="flex-1">
                {children}
              </main>
              <Footer />
              <CookieConsent />
              <PwaProvider />
            </div>
          </Providers>
        </IntlProvider>
      </body>
    </html>
  );
}
