import { preload } from 'react-dom';
import { SuiPoolLanding } from '../../components/SuiPoolLanding';

// Homepage is intentionally minimal: one focused page about the live
// SUI Mainnet Community Pool. Real numbers, fast path to deposit.
// Apple-themed (ios.* palette + Apple typography).
export default function HomePage() {
  // Preload the pool API — vault meter's LCP data lives here. React 19's
  // preload() emits <link rel="preload"> into <head> during the server
  // render, so the fetch starts during HTML parse instead of waiting
  // for JS to boot. On the cold-cache path this parallelises the
  // ~2-3s backend call with bundle download; on the warm path
  // (s-maxage=30 on the API route) it hits the CDN before hydration.
  // Match the exact URL the client fetch uses — a differing query
  // string bypasses the preload cache.
  preload('/api/sui/community-pool?network=mainnet', {
    as: 'fetch',
    crossOrigin: 'anonymous',
  });
  return <SuiPoolLanding />;
}
