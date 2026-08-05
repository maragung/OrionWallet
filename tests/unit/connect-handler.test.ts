import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConnectHandler,
  type WalletHost,
  type ApprovalRequest,
} from '../../src/connect/rpc-handler';
import {
  ERROR_CODES,
  METHODS,
  isEnvelope,
  makeRequest,
  type Envelope,
} from '../../src/sdk/protocol';
import { importWalletFromSeed } from '../../src/wallet/wallet';
import { wipeEverything } from '../../src/wallet/storage';

const wallet = importWalletFromSeed(new Uint8Array(32).fill(3));
const ORIGIN = 'https://dapp.example';
const CHALLENGE = 'a'.repeat(64);

/** Build a WalletHost with overridable approval behaviour. */
function makeHost(
  overrides: Partial<WalletHost> = {},
): WalletHost & { approvals: ApprovalRequest[] } {
  const approvals: ApprovalRequest[] = [];
  const host: WalletHost & { approvals: ApprovalRequest[] } = {
    approvals,
    getWallet: () => wallet,
    isUnlocked: () => true,
    getAddress: () => wallet.addr,
    getAccounts: () => [{ address: wallet.addr, publicKey: wallet.pubB64, name: 'A', index: 0 }],
    getNetwork: () => 'devnet',
    getChainId: async () => 'octra:devnet',
    getBalance: async () => ({ balance: '1.5', balanceRaw: '1500000', nonce: 4 }),
    getNextNonce: async () => 5,
    requestApproval: async (req) => {
      approvals.push(req);
      return true;
    },
    ...overrides,
  };
  return host;
}

/**
 * Test driver emulating the dApp side of the MessageChannel: sends the ack,
 * then correlates request/response envelopes.
 */
class Driver {
  private nonce = 1;
  private readonly pending = new Map<string, (env: Envelope) => void>();
  readonly events: Envelope[] = [];

  constructor(private readonly port: MessagePort) {
    port.onmessage = (e) => {
      const data = e.data;
      if (!isEnvelope(data)) return;
      const env = data as Envelope;
      if (env.kind === 'res') this.pending.get(env.id)?.(env);
      else if (env.kind === 'evt') this.events.push(env);
    };
    port.start?.();
  }

  ack(challenge = CHALLENGE, origin = ORIGIN): void {
    this.port.postMessage({ __ack: { challenge, dappNonce: 'x', v: 1, origin } });
  }

  request(method: string, params: unknown, nonceOverride?: number): Promise<Envelope> {
    const env = makeRequest(method, params, nonceOverride ?? this.nonce++);
    return this.send(env);
  }

  send(env: Envelope): Promise<Envelope> {
    return new Promise((resolve) => {
      this.pending.set(env.id, resolve);
      this.port.postMessage(env);
      setTimeout(
        () =>
          resolve({
            ...env,
            kind: 'res',
            error: { code: ERROR_CODES.TIMEOUT, message: 'test timeout' },
          } as Envelope),
        1000,
      );
    });
  }
}

function wire(host: WalletHost): { handler: ConnectHandler; driver: Driver } {
  const channel = new MessageChannel();
  const handler = new ConnectHandler({
    host,
    port: channel.port1,
    origin: ORIGIN,
    challenge: CHALLENGE,
    requestedCapabilities: undefined,
  });
  const driver = new Driver(channel.port2);
  return { handler, driver };
}

async function connect(driver: Driver): Promise<Envelope> {
  driver.ack();
  return driver.request(METHODS.CONNECT, { origin: ORIGIN });
}

beforeEach(async () => {
  await wipeEverything();
});

describe('ConnectHandler: prohibited methods', () => {
  it('rejects sendTransaction with METHOD_FORBIDDEN even after connect', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request('sendTransaction', { to: 'x', amount: '1' });
    expect(res.error?.code).toBe(ERROR_CODES.METHOD_FORBIDDEN);
  });

  it('rejects transfer/swap/bridge/broadcast', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    for (const m of ['transfer', 'swap', 'bridge', 'broadcastTransaction']) {
      const res = await driver.request(m, {});
      expect(res.error?.code, m).toBe(ERROR_CODES.METHOD_FORBIDDEN);
    }
  });
});

describe('ConnectHandler: challenge-response', () => {
  it('aborts when the ack challenge is wrong', async () => {
    const host = makeHost();
    const channel = new MessageChannel();
    new ConnectHandler({ host, port: channel.port1, origin: ORIGIN, challenge: CHALLENGE });
    const driver = new Driver(channel.port2);
    driver.ack('wrong-challenge');
    // After a bad ack the handler disposes; a subsequent request never resolves
    // with a real answer (driver times out).
    const res = await driver.request(METHODS.GET_ADDRESS, {});
    expect(res.error?.code).toBe(ERROR_CODES.TIMEOUT);
  });

  it('serves nothing before the ack', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    // No ack sent.
    const res = await driver.request(METHODS.GET_ADDRESS, {});
    expect(res.error?.code).toBe(ERROR_CODES.TIMEOUT);
  });
});

describe('ConnectHandler: replay protection', () => {
  it('rejects a reused/rewound nonce', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    await driver.request(METHODS.GET_ADDRESS, {}, 50);
    const res = await driver.request(METHODS.GET_ADDRESS, {}, 50); // same nonce again
    expect(res.error?.code).toBe(ERROR_CODES.REPLAY_DETECTED);
  });

  it('rejects a stale timestamp', async () => {
    const host = makeHost();
    const { driver, handler } = wire(host);
    void handler;
    await connect(driver);
    const env = makeRequest(METHODS.GET_ADDRESS, {}, 999);
    env.ts = Date.now() - 60_000; // outside freshness window
    const res = await driver.send(env);
    expect(res.error?.code).toBe(ERROR_CODES.REPLAY_DETECTED);
  });
});

describe('ConnectHandler: reads require a session', () => {
  it('rejects reads before connect with UNAUTHORIZED', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    driver.ack();
    const res = await driver.request(METHODS.GET_BALANCE, {});
    expect(res.error?.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('serves balance/accounts/network after connect', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const bal = await driver.request(METHODS.GET_BALANCE, {});
    expect(bal.result).toMatchObject({ balance: '1.5', balanceRaw: '1500000' });
    const accts = await driver.request(METHODS.GET_ACCOUNTS, {});
    expect(Array.isArray(accts.result)).toBe(true);
    const net = await driver.request(METHODS.GET_NETWORK, {});
    expect(net.result).toBe('devnet');
  });
});

describe('ConnectHandler: signing requires approval every time', () => {
  it('signs a message after the user approves (scope granted on first approval)', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request(METHODS.SIGN_MESSAGE, { message: 'gm' });
    expect(res.result).toBeDefined();
    expect((res.result as { signature?: string }).signature).toBeTruthy();
    expect((res.result as { scheme?: string }).scheme).toBe('octra-ed25519-sha256/v1');
  });

  it('signs a raw message when scheme is "raw"', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request(METHODS.SIGN_MESSAGE, { message: 'gm', scheme: 'raw' });
    expect(res.result).toBeDefined();
    expect((res.result as { signature?: string }).signature).toBeTruthy();
    expect((res.result as { scheme?: string }).scheme).toBe('octra-ed25519-sha256-raw/v1');
  });

  it('returns USER_REJECTED when the user declines connect', async () => {
    const host = makeHost({ requestApproval: vi.fn(async () => false) });
    const { driver } = wire(host);
    driver.ack();
    const res = await driver.request(METHODS.CONNECT, { origin: ORIGIN });
    expect(res.error?.code).toBe(ERROR_CODES.USER_REJECTED);
  });

  it('signContract succeeds after approval (scope granted on first approval)', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request(METHODS.SIGN_CONTRACT, {
      program: 'octProg',
      method: 'stake',
      args: [1],
    });
    expect(res.result).toBeDefined();
    expect((res.result as { signedTransaction?: unknown }).signedTransaction).toBeDefined();
  });

  it('signContract honours opType "call" and reports it back', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request(METHODS.SIGN_CONTRACT, {
      program: 'octProg',
      method: 'buy',
      args: ['1', '1000'],
      opType: 'call',
    });
    const result = res.result as {
      signedTransaction: { op_type: string; encrypted_data: string; message: string };
      opType: string;
      nonce: number;
    };
    expect(result.opType).toBe('call');
    expect(result.signedTransaction.op_type).toBe('call');
    // Bare method + JSON args, the encoding the VM expects for `call`.
    expect(result.signedTransaction.encrypted_data).toBe('buy');
    expect(result.signedTransaction.message).toBe('["1","1000"]');
    // The nonce used is echoed so a dApp can retry on a nonce race.
    expect(result.nonce).toBe(5);
  });

  // An unrecognised opType must not be coerced to a default: it selects the
  // payload encoding, so guessing wrong yields a tx the chain rejects.
  it('signContract rejects an unsupported opType instead of defaulting', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const res = await driver.request(METHODS.SIGN_CONTRACT, {
      program: 'octProg',
      method: 'buy',
      opType: 'transfer',
    });
    expect(res.error?.code).toBe(ERROR_CODES.INVALID_PARAMS);
    // Refused before any approval prompt is shown.
    expect(host.approvals.some((a) => a.kind === 'signContract')).toBe(false);
  });

  it('signContract surfaces the resolved opType to the approval prompt', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    await driver.request(METHODS.SIGN_CONTRACT, { program: 'octProg', method: 'stake' });
    const prompt = host.approvals.find((a) => a.kind === 'signContract');
    expect(prompt?.detail.opType).toBe('program_call');
  });
});

describe('ConnectHandler: locked wallet', () => {
  it('refuses connect when locked', async () => {
    const host = makeHost({ isUnlocked: () => false });
    const { driver } = wire(host);
    driver.ack();
    const res = await driver.request(METHODS.CONNECT, { origin: ORIGIN });
    expect(res.error?.code).toBe(ERROR_CODES.WALLET_LOCKED);
  });
});
