'use client';

import { memo } from 'react';
import { Link } from '../i18n/routing';
import { useTranslations } from 'next-intl';

const currentYear = new Date().getFullYear();

const LINK_CLASS = 'text-subheadline text-label-secondary hover:text-ios-blue transition-colors leading-relaxed';
const HEADING_CLASS = 'text-caption-1 font-semibold text-label-primary mb-4 uppercase tracking-wide';

export const Footer = memo(function Footer() {
  const t = useTranslations('footer');

  return (
    <footer className="bg-system-bg-secondary pb-safe border-t border-separator-opaque/30">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="pt-12 sm:pt-16 pb-8 sm:pb-10">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-8 sm:gap-10 lg:gap-16 min-w-0">
            <div>
              <h3 className={HEADING_CLASS}>{t('product')}</h3>
              <ul className="space-y-3">
                <li><Link href="/dashboard" className={LINK_CLASS}>{t('dashboard')}</Link></li>
                <li><Link href="/agents" className={LINK_CLASS}>{t('agents')}</Link></li>
                <li><Link href="/simulator" className={LINK_CLASS}>{t('simulator')}</Link></li>
                <li><Link href="/whitepaper" className={LINK_CLASS}>{t('documentation')}</Link></li>
              </ul>
            </div>

            <div>
              <h3 className={HEADING_CLASS}>{t('platform')}</h3>
              <ul className="space-y-3">
                <li><Link href="/zk" className={LINK_CLASS}>{t('zkVerification')}</Link></li>
                <li><Link href="/rwa" className={LINK_CLASS}>{t('authenticity')}</Link></li>
                <li><Link href="/whitepaper" className={LINK_CLASS}>{t('whitepaper')}</Link></li>
                <li><Link href="/docs" className={LINK_CLASS}>{t('api')}</Link></li>
              </ul>
            </div>

            <div>
              <h3 className={HEADING_CLASS}>{t('resources')}</h3>
              <ul className="space-y-3">
                <li><a href="https://calendly.com/ashishregmi2017/30min" target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{t('contact')}</a></li>
                <li><a href="https://t.me/+QoAodv90iWExZmVh" target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{t('community')}</a></li>
                <li><a href="https://github.com/ZkVanguard/ZkVanguard" target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{t('github')}</a></li>
                <li><a href="https://twitter.com" target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{t('twitter')}</a></li>
              </ul>
            </div>

            <div>
              <h3 className={HEADING_CLASS}>{t('legal')}</h3>
              <ul className="space-y-3">
                <li><Link href="/privacy" className={LINK_CLASS}>{t('privacy')}</Link></li>
                <li><Link href="/terms" className={LINK_CLASS}>{t('terms')}</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="border-t border-separator-opaque/40 py-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="text-caption-1 text-label-tertiary leading-relaxed">
              © {currentYear} ZkWard. {t('rights')}
              <span className="hidden md:inline ml-2">·</span>
              <span className="block md:inline md:ml-2 text-ios-blue">{t('testnet')}</span>
              <div className="mt-1 text-caption-2 text-label-tertiary">{t('migrationNotice')}</div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-caption-1">
              <span className="px-3 py-1.5 bg-ios-blue/10 text-ios-blue rounded-full font-medium">
                {t('stage')}
              </span>
              <span className="text-label-tertiary">{t('builtWith')}</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
});
