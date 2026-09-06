/**
 * Privy client config — browser-only surface with wagmi chain list.
 *
 * Split from privy-config.ts (server-safe) because this file imports
 * wagmi chains, which pulls in ESM that Node-based unit tests can't
 * parse without a transformer. Consumers under app/wallet-providers.tsx
 * import from here; server routes import from privy-config.ts only.
 */

import { hederaTestnet, hederaMainnet, sepolia, cronosMainnet } from './wagmi-config';

/**
 * Privy client config for the browser <PrivyProvider>.
 *
 * Shape mirrors PrivyClientConfig — kept as Record<string, unknown> so
 * we don't force downstream to depend on Privy's exported types.
 */
export function buildPrivyClientConfig(): Record<string, unknown> {
  return {
    appearance: {
      accentColor: '#00A79F',
      theme: 'light',
      // Email-first, no external wallets. Privy's core value here is the
      // self-custodial embedded wallet created behind the scenes — the
      // whole point is that judges never see MetaMask or a seed phrase.
      showWalletLoginFirst: false,
      walletChainType: 'ethereum-only',
      logo: 'https://www.zkward.com/logo-official.svg',
    },
    // Only email + Google. Deliberately no 'wallet' — the "hide onchain
    // complexity" prize criterion is undermined the moment we show a
    // wallet-connector picker. Users who want to bring an external
    // wallet can still use the SUI/Slush path in the same navbar.
    loginMethods: ['email', 'google'],
    embeddedWallets: {
      // 'all-users' guarantees every login gets an embedded wallet, even
      // if they somehow arrive with one from a prior session. Reads
      // cleaner on the prize demo — one login = one on-chain address.
      createOnLogin: 'all-users',
      requireUserPasswordOnCreate: false,
      // No prompt on every signature — cleaner UX for the financial-flow
      // demo where the whole point is one-click funding + one-click send.
      // If the B2B track judging cares about explicit approval, the quorum
      // layer in /api/admin/hedera-pool/quorum-action provides it.
      noPromptOnSignature: true,
    },
    supportedChains: [hederaTestnet, hederaMainnet, sepolia, cronosMainnet],
    defaultChain: hederaTestnet, // Hedera-primary pivot
    fundingMethodConfig: {
      moonpay: {
        useSandbox: process.env.HEDERA_NETWORK !== 'mainnet',
      },
    },
  };
}
