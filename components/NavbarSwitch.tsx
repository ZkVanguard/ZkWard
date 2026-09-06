'use client';

// Root locale layout renders this instead of <Navbar />. On /dashboard,
// the Navbar mounts INSIDE WalletProviders (see dashboard/layout.tsx) so
// wagmi hooks in ConnectButton find their provider. Elsewhere this renders
// the marketing Navbar, whose ConnectButtonStub has no wagmi imports and
// keeps the marketing bundle small.

import { usePathname } from 'next/navigation';
import { Navbar } from './Navbar';

export function NavbarSwitch() {
  const pathname = usePathname() ?? '';
  if (pathname.includes('/dashboard')) return null;
  return <Navbar />;
}
