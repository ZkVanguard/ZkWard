/**
 * WDK Wallet Context (Browser-Safe via ethers.js)
 *
 * Self-custodial wallet for Tether WDK USDT. Uses ethers.js
 * HDNodeWallet for BIP-39 mnemonic, key derivation, signing,
 * and on-chain transactions.
 *
 * Previously a 900+ line monolith — now delegates to:
 *   - storage.ts     (localStorage persistence)
 *   - zk-binding.ts  (passkey ↔ wallet cryptographic binding)
 *   - provider-cache.ts (shared RPC provider pool with TTL)
 *   - encryption.ts  (AES-GCM via Web Crypto)
 *   - passkey-service.ts (WebAuthn)
 *
 * @see https://docs.wdk.tether.io/
 */

'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { ethers } from 'ethers';
import { logger } from '@/lib/utils/logger';
import { WDK_CHAINS } from '@/lib/config/wdk';
import { PasskeyService } from './passkey-service';
import { generateKey, exportKey, importKey, encryptData, decryptData } from './encryption';
import { loadWallet, saveWallet, clearWallet, type StoredWallet } from './storage';
import { generateZKPasskeyBinding, verifyZKPasskeyBinding, sha256Hex } from './zk-binding';
import { getProviderAsync } from './provider-cache';

// Re-export storage type so existing importers keep working
export type { StoredWallet } from './storage';

// Dev-only logging — tree-shaken in production
const _wdkLog =
  process.env.NODE_ENV === 'development'
    ? (...args: unknown[]) => logger.debug(String(args[0] ?? ''), ...args.slice(1))
    : (..._args: unknown[]) => {};

// ============================================
// TYPES
// ============================================

export interface WdkAccount {
  address: string;
  chainKey: string;
  chainId: number;
}

export interface WdkWalletState {
  isConnected: boolean;
  isLoading: boolean;
  address: string | null;
  chainId: number | null;
  chainKey: string | null;
  accounts: WdkAccount[];
  error: string | null;
  isUnlocked: boolean;
  hasPasskey: boolean;
  hasWallet: boolean;
}

export interface WdkTransactionRequest {
  to: string;
  value?: bigint;
  data?: string;
}

export interface WdkContextValue {
  state: WdkWalletState;

  // Wallet management
  createWallet: () => Promise<string | null>;
  importWallet: (mnemonic: string) => Promise<boolean>;
  lockWallet: () => void;
  unlockWallet: (password: string) => Promise<boolean>;
  disconnect: () => void;
  registerPasskey: () => Promise<boolean>;
  loginWithPasskey: () => Promise<boolean>;
  resetWallet: () => void;

  // Chain operations
  switchChain: (chainKey: string) => Promise<boolean>;
  getBalance: (chainKey?: string) => Promise<string>;
  getUsdtBalance: (chainKey?: string) => Promise<string>;

  // Transactions
  sendTransaction: (tx: WdkTransactionRequest) => Promise<string | null>;
  sendUsdt: (to: string, amount: string) => Promise<string | null>;
  signMessage: (message: string | Uint8Array) => Promise<string | null>;
  signTypedData: (domain: any, types: any, value: any) => Promise<string | null>;

  // Utility
  getSupportedChains: () => string[];
  isChainSupported: (chainKey: string) => boolean;
}

const initialState: WdkWalletState = {
  isConnected: false,
  isLoading: true,
  address: null,
  chainId: null,
  chainKey: null,
  accounts: [],
  error: null,
  isUnlocked: false,
  hasPasskey: false,
  hasWallet: false,
};

const SUPPORTED_CHAINS = ['sepolia', 'cronos-mainnet', 'hedera-mainnet'];

// ============================================
// CONTEXT
// ============================================

const WdkContext = createContext<WdkContextValue | null>(null);

interface WdkProviderProps {
  children: ReactNode;
  defaultChain?: string;
}

export function WdkProvider({
  children,
  defaultChain = process.env.NEXT_PUBLIC_DEFAULT_CHAIN || 'cronos-mainnet',
}: WdkProviderProps) {
  const [state, setState] = useState<WdkWalletState>({
    ...initialState,
    chainKey: defaultChain,
    chainId: WDK_CHAINS[defaultChain]?.chainId ?? null,
  });

  const walletRef = useRef<ethers.HDNodeWallet | null>(null);
  const mnemonicRef = useRef<string | null>(null);

  // ---- Boot: check for stored wallet ----
  useEffect(() => {
    const stored = loadWallet();
    if (stored) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        isConnected: false,
        isUnlocked: false,
        hasPasskey: !!stored.passkeyId,
        hasWallet: true,
        chainKey: stored.lastChain,
        chainId: WDK_CHAINS[stored.lastChain]?.chainId ?? null,
      }));
    } else {
      setState(prev => ({ ...prev, isLoading: false }));
    }
  }, []);

  // ---- Internal: derive accounts from mnemonic ----
  const initializeFromMnemonic = useCallback(
    async (mnemonic: string, chainKey: string = defaultChain): Promise<boolean> => {
      try {
        const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic);

        const accounts: WdkAccount[] = SUPPORTED_CHAINS.filter(c => WDK_CHAINS[c]).map(chain => ({
          address: hdNode.address,
          chainKey: chain,
          chainId: WDK_CHAINS[chain].chainId,
        }));

        walletRef.current = hdNode;
        mnemonicRef.current = mnemonic;

        const selected = accounts.find(a => a.chainKey === chainKey) ?? accounts[0];
        const stored = loadWallet();

        setState(prev => ({
          ...prev,
          isConnected: true,
          isUnlocked: true,
          hasPasskey: !!stored?.passkeyId,
          isLoading: false,
          address: selected?.address ?? null,
          chainId: WDK_CHAINS[chainKey]?.chainId ?? null,
          chainKey,
          accounts,
          error: null,
        }));
        return true;
      } catch (err: any) {
        logger.error('[WDK] Wallet init failed:', err);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: err?.message ?? 'Failed to initialize wallet',
        }));
        return false;
      }
    },
    [defaultChain],
  );

  // ---- Passkey registration ----
  const registerPasskey = useCallback(async (): Promise<boolean> => {
    if (!walletRef.current || !state.isUnlocked) {
      setState(prev => ({ ...prev, error: 'Wallet must be unlocked to add passkey' }));
      return false;
    }

    try {
      const username = walletRef.current.address.slice(0, 8);
      const credential = await PasskeyService.register(username);
      if (!credential) throw new Error('Passkey registration cancelled');

      const { proofHash: zkProofHash, bindingHash: zkBindingHash } =
        await generateZKPasskeyBinding(walletRef.current.address, credential.rawId);

      const stored = loadWallet();
      if (stored) {
        stored.passkeyId = credential.rawId;
        stored.zkProofHash = zkProofHash;
        stored.zkBindingHash = zkBindingHash;
        saveWallet(stored);
        setState(prev => ({ ...prev, hasPasskey: true }));

        // Fire-and-forget server-side ZK proof
        const walletAddr = walletRef.current!.address;
        fetch('/api/zk-proof/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenario: 'passkey_binding',
            statement: {
              claim: 'Passkey is cryptographically bound to wallet',
              wallet_hash: zkProofHash.slice(0, 32),
              binding_commitment: zkProofHash,
            },
            witness: {
              wallet_address: walletAddr.toLowerCase(),
              passkey_id_hash: await sha256Hex(credential.rawId),
              domain: window.location.hostname,
              registration_timestamp: Date.now(),
            },
          }),
        }).catch(() => {});

        return true;
      }
      return false;
    } catch (err: any) {
      logger.error('[WDK] registerPasskey error:', err);
      setState(prev => ({ ...prev, error: err.message || 'Failed to register passkey' }));
      return false;
    }
  }, [state.isUnlocked]);

  // ---- Passkey login ----
  const loginWithPasskey = useCallback(async (): Promise<boolean> => {
    const stored = loadWallet();
    if (!stored?.keyJwk) {
      setState(prev => ({ ...prev, error: 'No wallet found' }));
      return false;
    }

    try {
      // 1. WebAuthn biometric check
      if (stored.passkeyId) {
        const supported = await PasskeyService.isSupported();
        if (supported) {
          const verified = await PasskeyService.authenticate([stored.passkeyId]);
          if (!verified) throw new Error('Passkey verification failed. Please try again or re-register your passkey.');
        }

        // 2. ZK binding verification
        if (stored.zkBindingHash) {
          const zkValid = await verifyZKPasskeyBinding(
            stored.addresses?.[stored.lastChain] || '',
            stored.passkeyId,
            stored.zkBindingHash,
          );
          if (!zkValid) throw new Error('ZK wallet binding verification failed');
        }
      }

      // 3. Decrypt and initialize
      const key = await importKey(stored.keyJwk);
      const mnemonic = await decryptData(stored.encryptedData, stored.iv, key);
      if (!mnemonic) throw new Error('Failed to decrypt wallet');

      return await initializeFromMnemonic(mnemonic, stored.lastChain);
    } catch (err: any) {
      logger.error('[WDK] loginWithPasskey error:', err?.name, err?.message);
      setState(prev => ({ ...prev, error: err.message || 'Unlock failed' }));
      return false;
    }
  }, [initializeFromMnemonic]);

  // ---- Create wallet ----
  const createWallet = useCallback(async (): Promise<string | null> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      const wallet = ethers.HDNodeWallet.createRandom();
      const mnemonic = wallet.mnemonic?.phrase;
      if (!mnemonic) {
        setState(prev => ({ ...prev, isLoading: false, error: 'Mnemonic generation failed' }));
        return null;
      }

      const ok = await initializeFromMnemonic(mnemonic);
      if (!ok) return null;

      const key = await generateKey();
      const keyJwk = await exportKey(key);
      const { data: encryptedData, iv } = await encryptData(mnemonic, key);

      const stored: StoredWallet = {
        encryptedData,
        iv,
        keyJwk,
        addresses: {},
        lastChain: defaultChain,
      };
      SUPPORTED_CHAINS.forEach(chain => {
        stored.addresses[chain] = wallet.address;
      });
      saveWallet(stored);
      return mnemonic;
    } catch (err: any) {
      logger.error('[WDK] createWallet error:', err);
      setState(prev => ({ ...prev, isLoading: false, error: err?.message ?? 'Create wallet failed' }));
      return null;
    }
  }, [initializeFromMnemonic, defaultChain]);

  // ---- Import wallet ----
  const importWallet = useCallback(
    async (mnemonic: string): Promise<boolean> => {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      const words = mnemonic.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: 'Invalid seed phrase. Must be 12 or 24 words.',
        }));
        return false;
      }

      const ok = await initializeFromMnemonic(mnemonic.trim());
      if (!ok) return false;

      const address = walletRef.current?.address ?? '';
      const key = await generateKey();
      const keyJwk = await exportKey(key);
      const { data: encryptedData, iv } = await encryptData(mnemonic.trim(), key);

      const stored: StoredWallet = {
        encryptedData,
        iv,
        keyJwk,
        addresses: {},
        lastChain: defaultChain,
      };
      SUPPORTED_CHAINS.forEach(chain => {
        stored.addresses[chain] = address;
      });
      saveWallet(stored);
      return true;
    },
    [initializeFromMnemonic, defaultChain],
  );

  // ---- Lock wallet ----
  const lockWallet = useCallback(() => {
    walletRef.current = null;
    mnemonicRef.current = null;
    const stored = loadWallet();
    setState({
      ...initialState,
      isLoading: false,
      chainKey: stored?.lastChain ?? defaultChain,
      chainId: WDK_CHAINS[stored?.lastChain ?? defaultChain]?.chainId ?? null,
      hasPasskey: !!stored?.passkeyId,
      hasWallet: !!stored,
    });
  }, [defaultChain]);

  // ---- Unlock with password (fallback) ----
  const unlockWallet = useCallback(
    async (password: string): Promise<boolean> => {
      if (!password) {
        setState(prev => ({ ...prev, error: 'Password required' }));
        return false;
      }
      const stored = loadWallet();
      if (!stored?.keyJwk) {
        setState(prev => ({ ...prev, error: 'No wallet found' }));
        return false;
      }
      try {
        if (stored.passwordHash) {
          const inputHash = await sha256Hex(password);
          if (inputHash !== stored.passwordHash) {
            setState(prev => ({ ...prev, error: 'Incorrect password' }));
            return false;
          }
        }
        const key = await importKey(stored.keyJwk);
        const mnemonic = await decryptData(stored.encryptedData, stored.iv, key);
        if (!mnemonic) {
          setState(prev => ({ ...prev, error: 'Failed to decrypt wallet' }));
          return false;
        }
        return await initializeFromMnemonic(mnemonic, stored.lastChain);
      } catch (err: any) {
        logger.error('[WDK] unlockWallet error:', err);
        setState(prev => ({ ...prev, error: err?.message ?? 'Unlock failed' }));
        return false;
      }
    },
    [initializeFromMnemonic],
  );

  const disconnect = useCallback(() => lockWallet(), [lockWallet]);

  const resetWallet = useCallback(() => {
    walletRef.current = null;
    mnemonicRef.current = null;
    clearWallet();
    setState({
      ...initialState,
      isLoading: false,
      chainKey: defaultChain,
      chainId: WDK_CHAINS[defaultChain]?.chainId ?? null,
    });
  }, [defaultChain]);

  // ---- Verify action (biometric + ZK) ----
  const verifyAction = useCallback(async (): Promise<boolean> => {
    const stored = loadWallet();
    if (!stored?.passkeyId) return true;
    try {
      const verified = await PasskeyService.authenticate([stored.passkeyId]);
      if (!verified) throw new Error('Biometric verification denied');
      if (stored.zkBindingHash) {
        const walletAddr = stored.addresses?.[stored.lastChain] || state.address || '';
        const zkValid = await verifyZKPasskeyBinding(walletAddr, stored.passkeyId, stored.zkBindingHash);
        if (!zkValid) throw new Error('ZK binding verification failed — unauthorized');
      }
      return true;
    } catch (e: any) {
      logger.error('[WDK-ZK] Action verification failed:', e);
      setState(prev => ({ ...prev, error: e.message || 'Authorization failed' }));
      return false;
    }
  }, [state.address]);

  // ---- Chain switching ----
  const switchChain = useCallback(async (chainKey: string): Promise<boolean> => {
    if (!(chainKey in WDK_CHAINS)) return false;
    setState(prev => ({
      ...prev,
      chainKey,
      chainId: WDK_CHAINS[chainKey]?.chainId ?? null,
    }));
    const stored = loadWallet();
    if (stored) {
      stored.lastChain = chainKey;
      saveWallet(stored);
    }
    return true;
  }, []);

  // ---- Balance queries ----
  const getBalance = useCallback(
    async (chainKey?: string): Promise<string> => {
      const chain = chainKey ?? state.chainKey;
      if (!chain || !walletRef.current) return '0';
      try {
        const provider = await getProviderAsync(chain);
        if (!provider) return '0';
        const bal = await provider.getBalance(walletRef.current.address);
        return ethers.formatEther(bal);
      } catch {
        return '0';
      }
    },
    [state.chainKey],
  );

  const getUsdtBalance = useCallback(
    async (chainKey?: string): Promise<string> => {
      const chain = chainKey ?? state.chainKey;
      if (!chain || !walletRef.current) return '0';
      const config = WDK_CHAINS[chain];
      if (!config?.usdtAddress) return '0';
      try {
        const provider = await getProviderAsync(chain);
        if (!provider) return '0';
        const usdt = new ethers.Contract(
          config.usdtAddress,
          ['function balanceOf(address) view returns (uint256)'],
          provider,
        );
        const bal = await usdt.balanceOf(walletRef.current.address);
        return ethers.formatUnits(bal, 6);
      } catch {
        return '0';
      }
    },
    [state.chainKey],
  );

  // ---- Transactions ----
  const sendTransaction = useCallback(
    async (tx: WdkTransactionRequest): Promise<string | null> => {
      if (!walletRef.current || !state.chainKey) throw new Error('Wallet not connected');
      const allowed = await verifyAction();
      if (!allowed) throw new Error('Transaction cancelled by user');
      const provider = await getProviderAsync(state.chainKey);
      if (!provider) throw new Error(`No RPC provider for chain: ${state.chainKey}`);
      const signer = walletRef.current.connect(provider);
      const resp = await signer.sendTransaction({
        to: tx.to,
        value: tx.value ?? 0n,
        data: tx.data,
      });
      return resp.hash;
    },
    [state.chainKey, verifyAction],
  );

  const sendUsdt = useCallback(
    async (to: string, amount: string): Promise<string | null> => {
      if (!walletRef.current || !state.chainKey) return null;
      const allowed = await verifyAction();
      if (!allowed) return null;
      const config = WDK_CHAINS[state.chainKey];
      if (!config?.usdtAddress) return null;
      try {
        const provider = await getProviderAsync(state.chainKey);
        if (!provider) return null;
        const signer = walletRef.current.connect(provider);
        const usdt = new ethers.Contract(
          config.usdtAddress,
          ['function transfer(address,uint256) returns (bool)'],
          signer,
        );
        const tx = await usdt.transfer(to, ethers.parseUnits(amount, 6));
        return tx.hash;
      } catch (err: any) {
        logger.error('[WDK] sendUsdt failed:', err);
        setState(prev => ({ ...prev, error: err?.message ?? 'USDT transfer failed' }));
        return null;
      }
    },
    [state.chainKey, verifyAction],
  );

  const signMessage = useCallback(
    async (message: string | Uint8Array): Promise<string | null> => {
      if (!walletRef.current) return null;
      const allowed = await verifyAction();
      if (!allowed) return null;
      try {
        return await walletRef.current.signMessage(message);
      } catch (err: any) {
        logger.error('[WDK] signMessage failed:', err);
        return null;
      }
    },
    [verifyAction],
  );

  const signTypedData = useCallback(
    async (domain: any, types: any, value: any): Promise<string | null> => {
      if (!walletRef.current) throw new Error('Wallet not connected');
      const allowed = await verifyAction();
      if (!allowed) throw new Error('Signing cancelled by user');
      return await walletRef.current.signTypedData(domain, types, value);
    },
    [verifyAction],
  );

  // ---- Utility ----
  const getSupportedChains = useCallback(() => Object.keys(WDK_CHAINS), []);
  const isChainSupported = useCallback((chainKey: string) => chainKey in WDK_CHAINS, []);

  const value: WdkContextValue = {
    state,
    createWallet,
    importWallet,
    lockWallet,
    unlockWallet,
    disconnect,
    resetWallet,
    registerPasskey,
    loginWithPasskey,
    switchChain,
    getBalance,
    getUsdtBalance,
    sendTransaction,
    sendUsdt,
    signMessage,
    signTypedData,
    getSupportedChains,
    isChainSupported,
  };

  return <WdkContext.Provider value={value}>{children}</WdkContext.Provider>;
}

// ============================================
// HOOKS (kept here for public API stability)
// ============================================

export function useWdk(): WdkContextValue {
  const context = useContext(WdkContext);
  if (!context) throw new Error('useWdk must be used within a WdkProvider');
  return context;
}

export function useWdkSafe(): WdkContextValue | null {
  return useContext(WdkContext);
}

export function useWdkAccount() {
  const { state } = useWdk();
  return {
    address: state.address,
    isConnected: state.isConnected,
    chainId: state.chainId,
    chainKey: state.chainKey,
  };
}

/**
 * Provider-tolerant variant of useWdkAccount for components that render
 * both inside and outside WdkProvider. Marketing pages don't wrap in
 * WdkProvider (bundle-size optimization); only `/dashboard/**` does.
 * The <Navbar/> render tree crosses that boundary — same ConnectButton
 * on `/dashboard` and `/`. useWdk() throws when no provider; this
 * returns a disconnected default so ConnectButton renders as if no
 * wallet were connected instead of crashing the page.
 */
export function useWdkAccountSafe() {
  const context = useContext(WdkContext);
  if (!context) {
    return { address: null, isConnected: false, chainId: null, chainKey: null };
  }
  return {
    address: context.state.address,
    isConnected: context.state.isConnected,
    chainId: context.state.chainId,
    chainKey: context.state.chainKey,
  };
}

export function useWdkChain() {
  const { state, switchChain, getSupportedChains } = useWdk();
  return {
    chainId: state.chainId,
    chainKey: state.chainKey,
    switchChain,
    supportedChains: getSupportedChains(),
  };
}

export { WdkContext };
