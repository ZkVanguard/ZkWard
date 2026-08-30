'use client';

import React, { memo, useMemo } from 'react';
import { Wallet } from 'lucide-react';
import type { UserPosition, ChainKey } from './types';
import { formatUSD, formatPercent } from './utils';

interface UserPositionCardProps {
  userPosition: UserPosition;
  selectedChain: ChainKey;
  chainName: string;
}

export const UserPositionCard = memo(function UserPositionCard({
  userPosition,
  selectedChain,
  chainName,
}: UserPositionCardProps) {
  const isSui = selectedChain === 'sui';

  const valueDisplay = useMemo(() => {
    if (isSui) {
      // SUI USDC pool: valueUSD reflects current share price × shares (v0.2.0
      // external-NAV oracle). At inception share price is $1, so shares can
      // act as a sane fallback when valueUSD hasn't loaded yet — but past
      // inception this fallback under-reports the member's true entitlement.
      const usdcVal = Number(userPosition.valueUSD) || Number(userPosition.shares) || 0;
      return formatUSD(usdcVal);
    }
    return formatUSD(userPosition.valueUSD);
  }, [isSui, userPosition.valueUSD, userPosition.shares]);

  const valueSubtext = useMemo(() => {
    if (isSui) return 'Current Value (USDC)';
    return 'Current Value';
  }, [isSui]);

  const txCount = (userPosition.depositCount || 0) + (userPosition.withdrawalCount || 0);

  return (
    <div className="p-4 sm:p-5 border-b border-gray-100 dark:border-gray-700 bg-system-bg-secondary dark:bg-gray-800/50">
      <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-3 flex-wrap text-sm sm:text-base">
        <Wallet className="w-4 h-4 flex-shrink-0" />
        <span>Your Position</span>
        <span className="text-[11px] sm:text-xs font-normal text-gray-500 dark:text-gray-400 sm:ml-2">
          on {chainName}
        </span>
      </h3>

      {userPosition.isMember ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="min-w-0">
            <p className="text-base sm:text-lg md:text-xl font-bold text-indigo-600 dark:text-indigo-400 tabular-nums break-all">
              {(Number(userPosition.shares) || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </p>
            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">Your Shares</p>
          </div>
          <div className="min-w-0">
            <p className="text-base sm:text-lg md:text-xl font-bold text-green-600 dark:text-green-400 tabular-nums break-all">{valueDisplay}</p>
            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2 leading-tight">{valueSubtext}</p>
          </div>
          <div className="min-w-0">
            <p className="text-base sm:text-lg md:text-xl font-bold text-purple-600 dark:text-purple-400 tabular-nums">
              {formatPercent(userPosition.percentage)}
            </p>
            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">Pool Ownership</p>
          </div>
          <div className="min-w-0">
            <p className="text-base sm:text-lg md:text-xl font-bold text-gray-900 dark:text-white tabular-nums">{txCount}</p>
            <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">Transactions</p>
          </div>
        </div>
      ) : (
        <p className="text-gray-500 dark:text-gray-400 text-xs sm:text-sm">
          You haven&apos;t joined the {chainName} pool yet. Deposit to receive shares.
        </p>
      )}
    </div>
  );
});
