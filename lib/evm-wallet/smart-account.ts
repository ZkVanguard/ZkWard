/**
 * Smart-account hook — disconnected shim.
 * Real implementation lands with the universal EVM wallet connector.
 * ponytail: returns "not available" so the dashboard fee-abstraction
 * gate falls through to the standard EOA path.
 */

'use client';

export interface SmartAccountState {
  isAvailable: boolean;
  isDeployed: boolean;
  address: `0x${string}` | null;
  chainId: number | null;
}

export interface UseSmartAccountReturn {
  state: SmartAccountState;
  deploy: () => Promise<`0x${string}` | null>;
  sponsoredWrite: () => Promise<`0x${string}` | null>;
  // Loose signature — real impl (per-chain) may take (amount) or
  // (pool, usdt, amount). Consumers gate this behind isConnected, so at
  // runtime this shim's null return is unreachable while EVM is dark.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  depositWithGasless: (...args: any[]) => Promise<`0x${string}`>;
  isReady: boolean;
}

export function useSmartAccount(): UseSmartAccountReturn {
  return {
    state: { isAvailable: false, isDeployed: false, address: null, chainId: null },
    deploy: async () => null,
    sponsoredWrite: async () => null,
    depositWithGasless: async () => {
      throw new Error('EVM wallet not connected');
    },
    isReady: false,
  };
}
