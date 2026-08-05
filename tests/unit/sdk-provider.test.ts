import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WalletProvider } from '../../src/sdk/WalletProvider';
import {
  ERROR_CODES,
  EVENTS,
  METHODS,
  isEnvelope,
  makeEvent,
  makeResponse,
  makeError,
  type Envelope,
} from '../../src/sdk/protocol';
import type { Transport, ConnectContext, HandshakeResult } from '../../src/sdk/transport/types';

/**
 * In-memory transport that lets the test act as the wallet: it captures
 * outbound requests and can push responses/events back to the provider.
 */
class FakeTransport implements Transport {
  private handler: ((env: Envelope) => void) | null = null;
  private closer: ((r: string) => void) | null = null;
  connected = false;
  readonly sent: Envelope[] = [];
  /** Auto-answer map: method -> (env) => result | throw code. */
  auto: Record<string, (env: Envelope) => unknown> = {};

  async connect(_ctx: ConnectContext): Promise<HandshakeResult> {
    this.connected = true;
    return { version: 1, capabilities: ['signMessage', 'events'], walletOrigin: 'https://wallet' };
  }
  send(env: Envelope): void {
    if (!this.connected) throw new Error('not connected');
    this.sent.push(env);
    const fn = this.auto[env.method ?? ''];
    if (fn) {
      queueMicrotask(() => {
        try {
          this.reply(makeResponse(env.id, fn(env), 1));
        } catch (e) {
          this.reply(makeError(env.id, { code: ERROR_CODES.INTERNAL, message: String(e) }, 1));
        }
      });
    }
  }
  onMessage(h: (env: Envelope) => void): void {
    this.handler = h;
  }
  onClose(h: (r: string) => void): void {
    this.closer = h;
  }
  isConnected(): boolean {
    return this.connected;
  }
  close(reason = 'closed'): void {
    this.connected = false;
    this.closer?.(reason);
  }
  focus(): void {}

  // Test helpers
  reply(env: Envelope): void {
    if (isEnvelope(env)) this.handler?.(env);
  }
  pushEvent(env: Envelope): void {
    this.handler?.(env);
  }
  lastOf(method: string): Envelope | undefined {
    return [...this.sent].reverse().find((e) => e.method === method);
  }
}

function makeProvider(transport: FakeTransport) {
  transport.auto[METHODS.CONNECT] = () => ({
    address: 'octAddr',
    publicKey: 'pk',
    accounts: [{ address: 'octAddr', publicKey: 'pk' }],
    network: 'devnet',
    chainId: 'octra:devnet',
  });
  transport.auto[METHODS.DISCONNECT] = () => ({ ok: true });
  return new WalletProvider({ walletUrl: 'https://wallet/connect', transport });
}

beforeEach(() => {
  // jsdom in this runner may not wire a working localStorage; provide a shim so
  // the best-effort session-hint feature is exercised deterministically.
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
});

describe('WalletProvider: prohibited methods blocked locally', () => {
  it('rejects sendTransaction without touching the transport', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    const before = t.sent.length;
    await expect(p.request('sendTransaction', {})).rejects.toMatchObject({
      code: ERROR_CODES.METHOD_FORBIDDEN,
    });
    // Nothing new was sent over the wire.
    expect(t.sent.length).toBe(before);
  });

  it('blocks transfer/swap/bridge/broadcast locally', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    for (const m of ['transfer', 'swap', 'bridge', 'broadcastTransaction']) {
      await expect(p.request(m, {})).rejects.toMatchObject({
        code: ERROR_CODES.METHOD_FORBIDDEN,
      });
    }
  });
});

describe('WalletProvider: connect + reads', () => {
  it('connects and exposes account snapshot', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    const res = await p.connect();
    expect(res.address).toBe('octAddr');
    expect(p.isConnected()).toBe(true);
  });

  it('correlates responses to requests', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    t.auto[METHODS.GET_BALANCE] = () => ({ balance: '2', balanceRaw: '2000000', nonce: 1 });
    const bal = await p.getBalance();
    expect(bal.balance).toBe('2');
  });

  it('rejects a request when the wallet returns an error', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    t.auto[METHODS.SIGN_MESSAGE] = (env) => {
      throw `err-${env.id}`;
    };
    await expect(p.signMessage('x')).rejects.toBeTruthy();
  });
});

describe('WalletProvider: events', () => {
  it('emits connect and routes wallet events to listeners', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    const onConnect = vi.fn();
    const onAccount = vi.fn();
    p.on(EVENTS.CONNECT, onConnect);
    p.on(EVENTS.ACCOUNT_CHANGED, onAccount);

    await p.connect();
    expect(onConnect).toHaveBeenCalledTimes(1);

    t.pushEvent(makeEvent(EVENTS.ACCOUNT_CHANGED, { address: 'octNew' }, 2));
    expect(onAccount).toHaveBeenCalledWith({ address: 'octNew' });
  });

  it('off() removes a listener', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    const fn = vi.fn();
    p.on(EVENTS.NETWORK_CHANGED, fn);
    p.off(EVENTS.NETWORK_CHANGED, fn);
    await p.connect();
    t.pushEvent(makeEvent(EVENTS.NETWORK_CHANGED, { network: 'mainnet' }, 3));
    expect(fn).not.toHaveBeenCalled();
  });

  it('clears session on sessionExpired event', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    expect(p.isConnected()).toBe(true);
    t.pushEvent(makeEvent(EVENTS.SESSION_EXPIRED, {}, 4));
    expect(p.isConnected()).toBe(false);
  });
});

describe('WalletProvider: session hint', () => {
  it('persists a hint on connect and reports it', async () => {
    const t = new FakeTransport();
    const p = makeProvider(t);
    await p.connect();
    expect(p.hasSessionHint()).toBe(true);
    await p.disconnect();
    expect(p.hasSessionHint()).toBe(false);
  });
});
