'use client';

import React, { memo } from 'react';
import { motion } from 'framer-motion';

/**
 * Skeleton components for Community Pool
 * Used during lazy loading and data fetching states
 */

interface SkeletonProps {
  className?: string;
}

// Base shimmer animation
const shimmer = {
  animate: {
    backgroundPosition: ['200% 0', '-200% 0'],
  },
  transition: {
    duration: 1.5,
    repeat: Infinity,
    ease: 'linear',
  },
};

export const SkeletonBox = memo(function SkeletonBox({ className = '' }: SkeletonProps) {
  return (
    <motion.div
      className={`bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 rounded-lg ${className}`}
      style={{ backgroundSize: '200% 100%' }}
      animate={shimmer.animate}
      transition={shimmer.transition}
    />
  );
});

export const SkeletonText = memo(function SkeletonText({ className = 'h-4 w-24' }: SkeletonProps) {
  return <SkeletonBox className={className} />;
});

export const SkeletonStatCard = memo(function SkeletonStatCard() {
  return (
    <div className="text-center p-3 sm:p-4">
      <SkeletonBox className="h-6 sm:h-8 w-16 sm:w-20 mx-auto mb-1.5 sm:mb-2" />
      <SkeletonBox className="h-3 w-12 sm:w-16 mx-auto" />
    </div>
  );
});

export const PoolStatsSkeleton = memo(function PoolStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4 p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <SkeletonStatCard />
      <SkeletonStatCard />
      <SkeletonStatCard />
      <SkeletonStatCard />
    </div>
  );
});

export const UserPositionSkeleton = memo(function UserPositionSkeleton() {
  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="bg-system-bg-secondary dark:bg-gray-800/50 rounded-2xl sm:rounded-xl p-3 sm:p-4">
        <div className="flex items-center gap-2 mb-2 sm:mb-3">
          <SkeletonBox className="w-5 h-5 rounded-full" />
          <SkeletonBox className="h-4 sm:h-5 w-20 sm:w-24" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div>
            <SkeletonBox className="h-3 w-12 mb-1" />
            <SkeletonBox className="h-5 sm:h-6 w-16 sm:w-20" />
          </div>
          <div>
            <SkeletonBox className="h-3 w-12 mb-1" />
            <SkeletonBox className="h-5 sm:h-6 w-14 sm:w-16" />
          </div>
          <div>
            <SkeletonBox className="h-3 w-12 mb-1" />
            <SkeletonBox className="h-5 sm:h-6 w-12 sm:w-14" />
          </div>
          <div>
            <SkeletonBox className="h-3 w-14 sm:w-16 mb-1" />
            <SkeletonBox className="h-5 sm:h-6 w-10 sm:w-12" />
          </div>
        </div>
      </div>
    </div>
  );
});

export const AllocationChartSkeleton = memo(function AllocationChartSkeleton() {
  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2 mb-3">
        <SkeletonBox className="w-4 h-4 rounded" />
        <SkeletonBox className="h-4 sm:h-5 w-24 sm:w-32" />
      </div>
      <div className="flex justify-center mb-4">
        <SkeletonBox className="w-40 h-40 sm:w-48 sm:h-48 rounded-full" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="text-center">
            <SkeletonBox className="w-3 h-3 mx-auto mb-1 rounded-full" />
            <SkeletonBox className="h-3 w-8 mx-auto" />
          </div>
        ))}
      </div>
    </div>
  );
});

export const LeaderboardSkeleton = memo(function LeaderboardSkeleton() {
  return (
    <div className="p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <SkeletonBox className="w-4 h-4" />
        <SkeletonBox className="h-4 sm:h-5 w-24 sm:w-28" />
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between p-2 sm:p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50">
            <div className="flex items-center gap-2 sm:gap-3">
              <SkeletonBox className="w-6 h-6 rounded-full" />
              <SkeletonBox className="h-4 w-20 sm:w-24" />
            </div>
            <div className="text-right">
              <SkeletonBox className="h-4 w-14 sm:w-16 mb-1" />
              <SkeletonBox className="h-3 w-8 sm:w-10" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export const ActionButtonsSkeleton = memo(function ActionButtonsSkeleton() {
  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
        <SkeletonBox className="flex-1 h-11 sm:h-12 rounded-xl sm:rounded-lg" />
        <SkeletonBox className="flex-1 h-11 sm:h-12 rounded-xl sm:rounded-lg" />
      </div>
    </div>
  );
});

export const CommunityPoolSkeleton = memo(function CommunityPoolSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg overflow-hidden">
      {/* Header skeleton */}
      <div className="bg-ios-blue p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <SkeletonBox className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg !bg-white/20 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <SkeletonBox className="h-5 sm:h-6 w-28 sm:w-36 mb-1 !bg-white/20" />
              <SkeletonBox className="h-3 sm:h-4 w-36 sm:w-48 !bg-white/20" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SkeletonBox className="w-full sm:w-32 h-8 rounded-lg !bg-white/20" />
          </div>
        </div>
      </div>

      <PoolStatsSkeleton />
      <AllocationChartSkeleton />
      <UserPositionSkeleton />
      <ActionButtonsSkeleton />
      <LeaderboardSkeleton />
    </div>
  );
});
