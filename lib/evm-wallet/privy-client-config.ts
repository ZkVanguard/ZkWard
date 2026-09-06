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
      // ios-blueHover — matches site primary CTA (Deposit USDC, Sign in
      // buttons). Was Hedera teal which read as a chain-specific feature
      // rather than the app's native sign-in.
      accentColor: '#0069D9',
      theme: 'light',
      // Email primary; wallet-connect list appears in the same modal as
      // a secondary section. Gives judges the "hide onchain complexity"
      // story AND lets power users on Hedera Testnet bring MetaMask.
      showWalletLoginFirst: false,
      walletChainType: 'ethereum-only',
      logo: 'https://www.zkward.com/logo-official.svg',
      // Exclude coinbase_wallet + base_account — their smart-wallet init
      // throws on Hedera/Cronos chain IDs. detected_ethereum_wallets uses
      // EIP-6963 so any injected wallet (MetaMask, Rabby, Trust, Brave)
      // appears with its own icon and name.
      walletList: [
        'detected_ethereum_wallets',
        'metamask',
        'wallet_connect',
        'phantom',
        'okx_wallet',
      ],
    },
    // email + wallet only in the built-in modal. Google is driven through
    // Custom OAuth (see PrivyConnectSection.tsx → useLoginWithOAuth with
    // provider 'custom:google') so we use OUR OWN Google Cloud OAuth
    // client — Privy's built-in Google shares a client that fails on
    // custom domains with 'redirect_uri_mismatch'.
    loginMethods: ['email', 'wallet'],
    embeddedWallets: {
      // 'users-without-wallets' — if the user signs in with MetaMask,
      // don't force an extra embedded wallet on them. Email/social users
      // still get one automatically.
      createOnLogin: 'users-without-wallets',
      requireUserPasswordOnCreate: false,
      // No prompt on every signature for embedded wallets — cleaner UX
      // for the financial-flow demo (one-click fund + one-click send).
      // External wallets (MetaMask) always show their own confirmation
      // popup regardless of this flag. Quorum-gated admin actions have
      // their own explicit-approval story in the quorum route.
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
