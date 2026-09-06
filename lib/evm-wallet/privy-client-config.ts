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
      // showWalletLoginFirst: true — MetaMask + injected wallets appear
      // in the FIRST screen of the Privy modal. Was false which hid them
      // behind an "advanced" tab that judges often missed, reading as
      // "not detected". Email input still visible below.
      showWalletLoginFirst: true,
      walletChainType: 'ethereum-only',
      logo: 'https://www.zkward.com/logo-official.svg',
      // Explicit wallet list. Excluding coinbase_wallet + base_account
      // sidesteps Privy's Coinbase Smart Wallet init blowing up on
      // Hedera/Cronos chains (throws "TypeError: e is not a function"
      // during initialize and cascades to hide MetaMask). `metamask` +
      // `detected_ethereum_wallets` covers MetaMask, Rabby, Trust,
      // Brave, and any EIP-6963 injector.
      walletList: [
        'detected_ethereum_wallets',
        'metamask',
        'wallet_connect',
        'phantom',
        'okx_wallet',
      ],
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
