'use client';

// Shared landing/marketing primitives — used by SuiPoolLanding + /agents /zk
// /rwa /whitepaper. Keep this file thin: layout primitives only, no product
// logic. Add a component here when the same pattern appears in ≥2 pages.

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// ─── PageShell ──────────────────────────────────────────────────────────
// Top-level wrapper for a marketing page. Standardises canvas color + text
// color so pages don't drift. Do NOT put max-width here — use <Section>.
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      {children}
    </div>
  );
}

// ─── Section ────────────────────────────────────────────────────────────
// Vertical rhythm + horizontal padding + max-width in one component.
// `tone` alternates the background between plain and tinted panel to give
// scroll rhythm without manual bg swaps.
export function Section({
  children,
  tone = 'primary',
  size = 'md',
  id,
  className = '',
}: {
  children: ReactNode;
  tone?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  id?: string;
  className?: string;
}) {
  const bg = tone === 'secondary' ? 'bg-system-bg-secondary' : 'bg-system-bg-primary';
  const py =
    size === 'sm' ? 'py-10 sm:py-14 md:py-16' :
    size === 'lg' ? 'py-16 sm:py-24 md:py-32' :
    'py-12 sm:py-20 md:py-24';
  return (
    <section id={id} className={`${bg} ${py} px-4 sm:px-5 lg:px-8 min-w-0 ${className}`}>
      <div className="max-w-[1100px] mx-auto">{children}</div>
    </section>
  );
}

// ─── Reveal ─────────────────────────────────────────────────────────────
// Subtle scroll-triggered fade+rise. Respects prefers-reduced-motion.
// Dial MOTION=4: fluid CSS, no scroll-hijack, no marquees.
export function Reveal({
  children, className, delay = 0,
}: {
  children: ReactNode; className?: string; delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ─── LiveIndicator ──────────────────────────────────────────────────────
// The pulsing green dot used in nav status pills, hero pills, and card
// headers. Wraps the ping-animation pattern once so it can't drift.
export function LiveIndicator({ label = 'Live', dot = 'green' }: { label?: string; dot?: 'green' | 'blue' | 'orange' }) {
  const color =
    dot === 'blue' ? 'bg-ios-blue' :
    dot === 'orange' ? 'bg-ios-orange' :
    'bg-ios-green';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative flex h-2 w-2">
        <span className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-75 animate-ping`} />
        <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
      </span>
      <span className="text-footnote font-medium text-label-secondary">{label}</span>
    </span>
  );
}

// ─── StatusPill ─────────────────────────────────────────────────────────
// The "Live on X · N members" pill used above hero headlines. Two-slot
// content (live indicator + right slot for a metric or divider).
export function StatusPill({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-system-bg-grouped border border-separator-opaque/40">
      {left}
      {right && (
        <>
          <span className="w-px h-3 bg-separator-opaque/40" />
          {right}
        </>
      )}
    </div>
  );
}

// ─── SectionHeader ──────────────────────────────────────────────────────
// Eyebrow + headline + optional lede. Enforces the eyebrow cap by making
// eyebrow optional and requiring caller to omit past cap. Uses font-display
// for the h2 (Phase 4 typography).
export function SectionHeader({
  eyebrow,
  title,
  lede,
  align = 'left',
}: {
  eyebrow?: string;
  title: string;
  lede?: string;
  align?: 'left' | 'center';
}) {
  const alignClass = align === 'center' ? 'text-center' : 'text-left';
  const ledeMax = align === 'center' ? 'max-w-[560px] mx-auto' : 'max-w-[600px]';
  return (
    <div className={`${alignClass} mb-10 sm:mb-14`}>
      {eyebrow && (
        <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
          {eyebrow}
        </p>
      )}
      <h2 className="font-display font-semibold text-[26px] sm:text-[34px] md:text-[42px] lg:text-[50px] tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
        {title}
      </h2>
      {lede && (
        <p className={`text-sm sm:text-callout md:text-[18px] text-label-secondary ${ledeMax} leading-relaxed sm:leading-[1.5] px-1`}>
          {lede}
        </p>
      )}
    </div>
  );
}

// ─── StatTile ───────────────────────────────────────────────────────────
// Small labeled number tile. Replaces the ad-hoc StatCard patterns each
// page was reinventing.
export function StatTile({
  label, value, hint, loading = false,
}: {
  label: string; value: string; hint?: string; loading?: boolean;
}) {
  return (
    <div className="bg-system-bg-primary rounded-ios-xl p-3 sm:p-5 md:p-6 shadow-ios-1 border border-separator-opaque/30 min-w-0">
      <div className="text-[10px] sm:text-caption-1 font-medium uppercase tracking-wide text-label-tertiary mb-1.5 sm:mb-2 truncate">
        {label}
      </div>
      <div className={`text-lg sm:text-title-2 md:text-title-1 font-semibold tabular-nums break-all text-label-primary ${loading ? 'animate-pulse' : ''}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] sm:text-caption-1 text-label-tertiary mt-1 sm:mt-1.5 tabular-nums truncate">{hint}</div>
      )}
    </div>
  );
}

// ─── TrustBadge ─────────────────────────────────────────────────────────
// Icon + title + value + hint. Used for "safety guards" or "capabilities"
// grids across landing pages.
export function TrustBadge({
  icon, title, value, hint,
}: {
  icon: ReactNode; title: string; value: string; hint: string;
}) {
  return (
    <div className="bg-system-bg-primary rounded-ios-xl p-3 sm:p-5 md:p-6 border border-separator-opaque/30 shadow-ios-1 min-w-0">
      <div className="flex items-center gap-1.5 sm:gap-2 mb-2 sm:mb-3 min-w-0">
        <div className="text-ios-blue flex-shrink-0">{icon}</div>
        <div className="text-[10px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary truncate">
          {title}
        </div>
      </div>
      <div className="text-base sm:text-title-3 md:text-title-2 font-semibold text-label-primary mb-1 break-words tabular-nums">{value}</div>
      <div className="text-[10px] sm:text-caption-1 text-label-tertiary leading-[1.4] break-words">{hint}</div>
    </div>
  );
}
