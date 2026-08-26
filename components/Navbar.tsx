'use client';

import { memo, useState, useEffect } from 'react';
import { Link } from '../i18n/routing';
import { ConnectButton } from './ConnectButton';
import { LanguageSelector } from './LanguageSelector';
import { Menu, X } from 'lucide-react';
import Logo from './Logo';
import { useTranslations } from 'next-intl';

export const Navbar = memo(function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const t = useTranslations('nav');

  // Detect scroll past 20px via IntersectionObserver on an injected sentinel.
  // Replaces window.addEventListener('scroll') which fired every frame.
  // Sentinel is absolute-positioned at y=20px in the document; when it exits
  // the viewport, we've crossed the threshold. O(1) per scroll direction.
  useEffect(() => {
    const sentinel = document.createElement('div');
    sentinel.style.cssText =
      'position:absolute;top:20px;left:0;width:1px;height:1px;pointer-events:none;';
    document.body.insertBefore(sentinel, document.body.firstChild);
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => {
      io.disconnect();
      sentinel.remove();
    };
  }, []);

  // Focused nav — one product (SUI vault), one narrative (agents + ZK + RWA), one document (whitepaper).
  // Pricing/Developers/Simulator/Docs are still reachable by direct URL but not linked from the top nav.
  const navLinks = [
    { href: '/', label: t('home') },
    { href: '/dashboard', label: t('vault') },
    { href: '/agents', label: t('agents') },
    { href: '/zk', label: t('zk') },
    { href: '/rwa', label: t('rwa') },
    { href: '/whitepaper', label: t('whitepaper') },
  ];

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 pt-safe pl-safe pr-safe transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
        scrolled
          ? 'bg-system-bg-primary/85 backdrop-blur-xl shadow-ios-1 border-b border-separator-opaque/40'
          : 'bg-system-bg-primary/90 backdrop-blur-lg'
      }`}
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-[52px] min-w-0">
          {/* Logo - Always visible */}
          <Link href="/" className="flex items-center gap-2 -ml-2">
            <Logo />
            <span className="lg:hidden text-[17px] font-semibold text-[#1d1d1f] tracking-tight">ZkWard</span>
          </Link>

          {/* Desktop Navigation - Centered with proper spacing */}
          <div className="hidden lg:flex items-center justify-center flex-1 gap-1 mx-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-3 h-11 flex items-center text-[16px] font-normal text-label-secondary hover:text-ios-blue active:scale-[0.98] transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)] whitespace-nowrap"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Desktop - Language Selector + Connect Button (Right side) */}
          <div className="hidden lg:flex items-center gap-3">
            <LanguageSelector />
            <ConnectButton />
          </div>

          {/* Mobile Menu Button - Proper 44pt touch target */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="lg:hidden w-11 h-11 flex items-center justify-center -mr-2 text-label-primary hover:text-ios-blue active:scale-[0.96] transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
            aria-label="Toggle menu"
          >
            {isOpen ? (
              <X className="w-6 h-6" strokeWidth={2} />
            ) : (
              <Menu className="w-6 h-6" strokeWidth={2} />
            )}
          </button>
        </div>

        {/* Mobile Navigation - Clean iOS-style list */}
        {isOpen && (
          <div className="lg:hidden pb-safe-4 border-t border-black/10 animate-fade-in max-h-[calc(100vh-52px-env(safe-area-inset-top))] overflow-y-auto">
            <div className="py-2 space-y-0.5">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="block px-3 h-11 flex items-center text-[17px] text-label-primary hover:bg-system-bg-grouped active:scale-[0.98] active:bg-black/[0.04] rounded-ios transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)] truncate"
                  onClick={() => setIsOpen(false)}
                >
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="mt-3 pt-3 px-3 border-t border-black/10 space-y-3">
              <LanguageSelector />
              <ConnectButton />
            </div>
          </div>
        )}
      </div>
    </nav>
  );
});
