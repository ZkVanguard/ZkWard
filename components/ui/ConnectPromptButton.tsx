'use client';

/**
 * Empty-state Connect CTA — piggybacks the navbar's ConnectButton via a
 * data-attr click. Chosen over importing the full ConnectButton (547 LOC
 * of wallet SDK) into every empty state: keeps the wallet-modal state a
 * single source of truth and prevents drift between "the button in the
 * corner" and "the button in the card". If the navbar CTA isn't mounted
 * (e.g., user is already connected), we no-op silently.
 */

import { memo } from 'react';
import { Wallet } from 'lucide-react';

interface Props {
  label?: string;
  className?: string;
}

export const ConnectPromptButton = memo(function ConnectPromptButton({
  label = 'Connect Wallet',
  className = '',
}: Props) {
  const onClick = () => {
    const btn = document.querySelector<HTMLButtonElement>('[data-connect-cta="true"]');
    if (btn) {
      btn.click();
      btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-5 h-11 bg-ios-blue hover:bg-ios-blueHover active:scale-[0.98] text-white rounded-[12px] font-semibold text-[15px] transition-all shadow-ios-1 ${className}`}
    >
      <Wallet className="w-4 h-4" strokeWidth={2.5} />
      {label}
    </button>
  );
});
