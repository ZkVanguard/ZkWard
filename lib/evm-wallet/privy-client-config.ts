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
      showWalletLoginFirst: false, // email/social first, wallet as advanced
      walletChainType: 'ethereum-only',
      logo: 'https://www.zkward.com/icon.png',
    },
    loginMethods: ['email', 'google', 'wallet'],
    embeddedWallets: {
      createOnLogin: 'users-without-wallets',
      requireUserPasswordOnCreate: false,
      // Prompt for signature confirmation on every tx — matches the
      // B2B track's "explicit user approval" narrative.
      noPromptOnSignature: false,
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
