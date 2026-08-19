/**
 * Public, tree-shakable entry point for the Octra Wallet SDK (dApp side).
 *
 * Example:
 *   import { injectWalletProvider } from '@octra/wallet-sdk';
 *   const wallet = injectWalletProvider({ walletUrl: 'https://wallet.app/connect' });
 *   const { address } = await wallet.connect();
 *   const { signature } = await wallet.signMessage('gm');
 *
 * No React, no wallet-core, no DOM-heavy imports are pulled in transitively,
 * so bundlers can drop everything a given dApp doesn't use.
 */
export { WalletProvider } from './WalletProvider';
export type {
  WalletProviderOptions,
  WalletAccount,
  NetworkInfo,
  ConnectResult,
  SignMessageResult,
  SignTypedDataResult,
  TypedData,
  ApproveContractParams,
  SignContractParams,
  SignTransferParams,
  SignTransferResult,
  PingResult,
  RequestOptions,
} from './WalletProvider';

export { injectWalletProvider } from './inject';
export type { InjectOptions } from './inject';

export { PopupTransport } from './transport/PopupTransport';
export type {
  Transport,
  ConnectContext,
  HandshakeResult,
  TransportMessageHandler,
  TransportCloseHandler,
} from './transport/types';

export { toNodeWireTx, buildNodeWireJson } from './wire-tx';
export type { SignedTxLike } from './wire-tx';

export { WalletError } from './errors';
export {
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  METHODS,
  ORION_METHODS,
  ORION_METHOD_PREFIX,
  SUPPORTED_METHODS,
  canonicalizeMethod,
  EVENTS,
  CAPABILITIES,
  WALLET_CAPABILITIES,
  ERROR_CODES,
  PROHIBITED_METHODS,
  isProhibitedMethod,
} from './protocol';
export type {
  Method,
  Capability,
  WalletEventName,
  ErrorCode,
  Envelope,
  WireError,
} from './protocol';
