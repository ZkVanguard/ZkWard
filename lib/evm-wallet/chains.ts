/**
 * EVM chain metadata for the multi-chain community pools.
 *
 * Data-only module — no wallet SDK bindings. Consumed by dashboard UI
 * for display (chain name, explorer URL, native currency, deposit-token
 * address). The universal EVM wallet connector (to be wired) will use
 * these chainIds and RPC URLs to attach viem clients.
 *
 * Kept intact from the previous WDK config so all downstream imports of
 * getChainConfig / getUSDTAddress / USDT_METADATA / EVM_CHAINS continue
 * to compile without dashboard rewrites.
 */

import { getRpcUrl } from '../rpc-urls';

// ============================================
// Deposit-token (USDT / USD₮0) addresses
// ============================================

export const USDT_ADDRESSES = {
  sepolia: {
    mainnet: null,
    testnet: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
  },
  cronos: {
    mainnet: '0x66e428c3f67a68878562e79A0234c1F83c208770',
    testnet: '0x28217DAddC55e3C4831b4A48A00Ce04880786967',
  },
  hedera: {
    mainnet: null,
    testnet: null,
  },
  ethereum: {
    mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    testnet: null,
  },
  plasma: {
    mainnet: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    testnet: null,
  },
  stable: {
    mainnet: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
    testnet: null,
  },
} as const;

export const USDT_METADATA = {
  name: 'Tether USD',
  symbol: 'USDT',
  decimals: 6,
  logo: 'https://cryptologos.cc/logos/tether-usdt-logo.svg',
} as const;

// ============================================
// Chain configs
// ============================================

export interface EvmChainConfig {
  chainId: number;
  name: string;
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  usdtAddress: string | null;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export const EVM_CHAINS: Record<string, EvmChainConfig> = {
  sepolia: {
    chainId: 11155111,
    name: 'Sepolia',
    network: 'testnet',
    rpcUrl: getRpcUrl('sepolia'),
    usdtAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  },
  'cronos-mainnet': {
    chainId: 25,
    name: 'Cronos',
    network: 'mainnet',
    rpcUrl: 'https://evm.cronos.org',
    usdtAddress: USDT_ADDRESSES.cronos.mainnet,
    explorerUrl: 'https://cronoscan.com',
    nativeCurrency: { name: 'Cronos', symbol: 'CRO', decimals: 18 },
  },
  'cronos-testnet': {
    chainId: 338,
    name: 'Cronos Testnet',
    network: 'testnet',
    rpcUrl: 'https://evm-t3.cronos.org',
    usdtAddress: USDT_ADDRESSES.cronos.testnet,
    explorerUrl: 'https://explorer.cronos.org/testnet',
    nativeCurrency: { name: 'Test Cronos', symbol: 'tCRO', decimals: 18 },
  },
  'hedera-mainnet': {
    chainId: 295,
    name: 'Hedera',
    network: 'mainnet',
    rpcUrl: 'https://mainnet.hashio.io/api',
    usdtAddress: USDT_ADDRESSES.hedera.mainnet,
    explorerUrl: 'https://hashscan.io/mainnet',
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  },
  'hedera-testnet': {
    chainId: 296,
    name: 'Hedera Testnet',
    network: 'testnet',
    rpcUrl: 'https://testnet.hashio.io/api',
    usdtAddress: USDT_ADDRESSES.hedera.testnet,
    explorerUrl: 'https://hashscan.io/testnet',
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  },
  plasma: {
    chainId: 9745,
    name: 'Plasma',
    network: 'mainnet',
    rpcUrl: 'https://rpc.plasma.to',
    usdtAddress: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    explorerUrl: 'https://plasmascan.to',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  },
  stable: {
    chainId: 988,
    name: 'Stable',
    network: 'mainnet',
    rpcUrl: 'https://rpc.stable.xyz',
    usdtAddress: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
    explorerUrl: 'https://stablescan.xyz',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  },
} as const;

// ============================================
// Back-compat aliases (old WDK names)
// ============================================
// Kept as re-exports so downstream call sites don't need renaming.
// Drop after universal EVM wallet lands and the shim is retired.
export const WDK_CHAINS = EVM_CHAINS;
export type WDKChainConfig = EvmChainConfig;

// ============================================
// Helpers
// ============================================

export function getUSDTAddress(chainId: number): string | null {
  const chain = Object.values(EVM_CHAINS).find((c) => c.chainId === chainId);
  return chain?.usdtAddress ?? null;
}

export function getChainConfig(chainId: number): EvmChainConfig | undefined {
  return Object.values(EVM_CHAINS).find((c) => c.chainId === chainId);
}

export function isMainnet(chainId: number): boolean {
  return getChainConfig(chainId)?.network === 'mainnet';
}

export function getDepositTokenAddress(
  chainId: number,
  testnetUsdtAddress?: string,
): string | null {
  const chain = getChainConfig(chainId);
  if (!chain) {
    throw new Error(`No deposit token configured for chain ${chainId}`);
  }
  return chain.usdtAddress ?? testnetUsdtAddress ?? null;
}

export const EVM_SUPPORTED_CHAINS = [25, 338, 295, 296] as const;
export const WDK_SUPPORTED_CHAINS = EVM_SUPPORTED_CHAINS;
export type EvmSupportedChainId = (typeof EVM_SUPPORTED_CHAINS)[number];
export type WDKSupportedChainId = EvmSupportedChainId;
