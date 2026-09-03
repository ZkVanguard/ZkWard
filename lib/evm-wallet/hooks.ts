/**
 * EVM wallet hooks — disconnected shim.
 *
 * These stubs replace the previous WDK-backed wagmi-shaped hooks so the
 * dashboard EVM UI compiles and renders in a permanent "not connected"
 * state. When the universal EVM wallet (WalletConnect / Reown AppKit /
 * Privy / whatever we pick) is wired, swap this file for real wagmi
 * bindings — every consumer already uses this API shape.
 *
 * ponytail: intentional shim, upgrade path is a straight file swap.
 */

'use client';

import { useCallback, useState } from 'react';

// ============================================
// Account
// ============================================

export interface UseAccountReturn {
  address: `0x${string}` | undefined;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnected: boolean;
  chain?: { id: number; name: string };
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
}

export function useAccount(): UseAccountReturn {
  return {
    address: undefined,
    isConnected: false,
    isConnecting: false,
    isDisconnected: true,
    chain: undefined,
    status: 'disconnected',
  };
}

// ============================================
// Chain
// ============================================

export function useChainId(): number {
  return 11155111; // Sepolia — first EVM chain we'll wire
}

export interface UseSwitchChainReturn {
  switchChain: (args: { chainId: number }) => Promise<void>;
  switchChainAsync: (args: { chainId: number }) => Promise<boolean>;
  isPending: boolean;
  error: Error | null;
}

export function useSwitchChain(): UseSwitchChainReturn {
  const notReady = useCallback(async () => {
    throw new Error('EVM wallet not connected');
  }, []);
  return {
    switchChain: notReady,
    switchChainAsync: async () => false,
    isPending: false,
    error: null,
  };
}

// ============================================
// Signing
// ============================================

export interface UseSignMessageReturn {
  signMessage: (args: { message: string }) => void;
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>;
  data: `0x${string}` | undefined;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export function useSignMessage(): UseSignMessageReturn {
  return {
    signMessage: () => {
      throw new Error('EVM wallet not connected');
    },
    signMessageAsync: async () => {
      throw new Error('EVM wallet not connected');
    },
    data: undefined,
    isPending: false,
    error: null,
    reset: () => {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypedDataArgs = any;

export function useSignTypedData() {
  return {
    signTypedData: (_args?: TypedDataArgs) => {
      throw new Error('EVM wallet not connected');
    },
    signTypedDataAsync: async (_args?: TypedDataArgs): Promise<`0x${string}`> => {
      throw new Error('EVM wallet not connected');
    },
    data: undefined as `0x${string}` | undefined,
    isPending: false,
    error: null as Error | null,
    reset: () => {},
  };
}

// ============================================
// Contract writes
// ============================================

export interface WriteContractArgs {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chainId?: number;
}

export interface UseWriteContractReturn {
  writeContract: (args: WriteContractArgs) => void;
  writeContractAsync: (args: WriteContractArgs) => Promise<`0x${string}`>;
  data: `0x${string}` | undefined;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export function useWriteContract(): UseWriteContractReturn {
  return {
    writeContract: () => {
      throw new Error('EVM wallet not connected');
    },
    writeContractAsync: async () => {
      throw new Error('EVM wallet not connected');
    },
    data: undefined,
    isPending: false,
    error: null,
    reset: () => {},
  };
}

// ============================================
// Transaction receipt
// ============================================

export interface UseWaitForTransactionReceiptReturn {
  data: unknown;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
}

export function useWaitForTransactionReceipt(_args?: {
  hash?: `0x${string}` | undefined;
  chainId?: number;
}): UseWaitForTransactionReceiptReturn {
  return {
    data: undefined,
    isLoading: false,
    isSuccess: false,
    isError: false,
    error: null,
  };
}

// ============================================
// Contract reads
// ============================================

export interface ReadContractArgs {
  address?: `0x${string}`;
  abi?: readonly unknown[];
  functionName?: string;
  args?: readonly unknown[];
  chainId?: number;
  enabled?: boolean;
  query?: { enabled?: boolean; refetchInterval?: number };
}

export function useReadContract<T = unknown>(_args?: ReadContractArgs): {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: async () => {},
  };
}

// ============================================
// Clients
// ============================================
// Typed as `any` on purpose — real viem PublicClient / WalletClient will
// slot in when the universal EVM wallet lands. Consumers call methods
// like readContract / signTypedData / account / transport off these; the
// shim returns null at runtime so calls will throw if the code path is
// hit while EVM wallet is disconnected (which is the whole shim state).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function usePublicClient(): any {
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useWalletClient(): { data: any } {
  return { data: null };
}

// ============================================
// Balance
// ============================================

export function useBalance(_args?: { address?: `0x${string}`; chainId?: number }): {
  data: { value: bigint; decimals: number; symbol: string; formatted: string } | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<void>;
} {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: async () => {},
  };
}

// ============================================
// Disconnect
// ============================================

export function useDisconnect(): {
  disconnect: () => void;
  disconnectAsync: () => Promise<void>;
  isPending: boolean;
  error: Error | null;
} {
  const [error] = useState<Error | null>(null);
  return {
    disconnect: () => {},
    disconnectAsync: async () => {},
    isPending: false,
    error,
  };
}
