import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  ConnectHandler,
  type WalletHost,
  type ApprovalRequest,
} from '../../src/connect/rpc-handler';
import {
  ERROR_CODES,
  METHODS,
  PROTOCOL_VERSION,
  isEnvelope,
  makeRequest,
  type Envelope,
} from '../../src/sdk/protocol';
import { importWalletFromSeed } from '../../src/wallet/wallet';
import { activeNetworkInfo, networkInfoList } from '../../src/wallet/networks';
import { wipeEverything } from '../../src/wallet/storage';
import { canonicalJsonForTx, type TransactionFields } from '../../src/tx/canonical-json';
import { verifyTransaction } from '../../src/tx/builder';
import { base64Decode } from '../../src/crypto/base64';

/**
 * Coverage for the two methods a dApp leans on hardest and that had none:
 * `wallet_ping`, whose whole job is to answer questions the wallet is normally
 * too locked or too disconnected to answer, and `wallet_signTransfer`, which
 * exists so nobody has to disguise a transfer as a contract call.
 */

const wallet = importWalletFromSeed(new Uint8Array(32).fill(3));
const other = importWalletFromSeed(new Uint8Array(32).fill(9));
const ORIGIN = 'https://dapp.example';
const CHALLENGE = 'a'.repeat(64);

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
    getNetworkInfo: () => activeNetworkInfo('devnet', []),
    getNetworks: () => networkInfoList([]),
    getChainId: async () => 'octra:devnet',
    getBalance: async () => ({ balance: '1.5', balanceRaw: '1500000', nonce: 4 }),
    getNextNonce: async () => 5,
    requestApproval: async (req) => {
      approvals.push(req);
      return { approved: true };
    },
    requestUnlock: async () => true,
    requestUnlockAccount: async (addr) => (addr === wallet.addr ? wallet : null),
    setSessionAccount: () => undefined,
    getSessionAccount: () => wallet.addr,
    ...overrides,
  };
  return host;
}

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

  request(method: string, params: unknown): Promise<Envelope> {
    const env = makeRequest(method, params, this.nonce++);
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
  return { handler, driver: new Driver(channel.port2) };
}

async function connect(driver: Driver): Promise<Envelope> {
  driver.ack();
  return driver.request(METHODS.CONNECT, { origin: ORIGIN });
}

interface PingResult {
  pong: boolean;
  v: number;
  connected: boolean;
  locked: boolean;
  capabilities: string[];
  origin: string;
  ts: number;
}

beforeEach(async () => {
  await wipeEverything();
});

describe('wallet_ping', () => {
  it('answers a locked wallet without raising an unlock prompt', async () => {
    const requestUnlock = vi.fn(async () => true);
    const host = makeHost({ isUnlocked: () => false, requestUnlock });
    const { driver } = wire(host);
    driver.ack();

    const res = await driver.request(METHODS.PING, {});
    const result = res.result as PingResult;

    expect(res.error).toBeUndefined();
    expect(result.pong).toBe(true);
    expect(result.locked).toBe(true);
    // The point of the exemption: a background liveness probe must never
    // interrupt the user with a PIN prompt for a question it never needed keys
    // to answer.
    expect(requestUnlock).not.toHaveBeenCalled();
  });

  it('reports connected:false before connect instead of failing UNAUTHORIZED', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    driver.ack();

    const res = await driver.request(METHODS.PING, {});
    const result = res.result as PingResult;

    // A probe has to be able to say "the port is alive but your session is
    // gone" — answering with an error would leave a caller unable to tell that
    // apart from a dead transport.
    expect(res.error).toBeUndefined();
    expect(result.connected).toBe(false);
    expect(result.v).toBe(PROTOCOL_VERSION);
    expect(result.origin).toBe(ORIGIN);
  });

  it('reports connected:true after connect, and echoes capabilities', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const result = (await driver.request(METHODS.PING, {})).result as PingResult;
    expect(result.connected).toBe(true);
    expect(result.locked).toBe(false);
    expect(Array.isArray(result.capabilities)).toBe(true);
    expect(result.capabilities.length).toBeGreaterThan(0);
  });

  it('never prompts for approval, however many times it is called', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);
    const approvalsAfterConnect = host.approvals.length;

    for (let i = 0; i < 3; i++) await driver.request(METHODS.PING, {});

    expect(host.approvals.length).toBe(approvalsAfterConnect);
  });

  it('does not refresh the session idle TTL', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    // A read touches the session; a ping must not. Compare the persisted idle
    // deadline across each, with the clock pushed forward in between so a
    // refresh would be visible. Only `Date.now` is mocked, not the timer queue:
    // faking timers here would stall the MessagePort round trip the driver
    // waits on.
    const { restoreSession } = await import('../../src/connect/session');
    const before = (await restoreSession(ORIGIN))!.idleExpiresAt;

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await driver.request(METHODS.PING, {});
      const afterPing = (await restoreSession(ORIGIN))!.idleExpiresAt;
      expect(afterPing).toBe(before);

      await driver.request(METHODS.GET_ADDRESS, {});
      const afterRead = (await restoreSession(ORIGIN))!.idleExpiresAt;
      expect(afterRead).toBeGreaterThan(before);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

interface TransferResult {
  signedTransaction: {
    from: string;
    to: string;
    amount: string;
    nonce: number;
    ou: string;
    timestamp: number;
    op_type: string;
    signature: string;
    public_key: string;
    message?: string;
    hash?: string;
  };
  to: string;
  amountRaw: string;
  ou: string;
  opType: string;
  nonce: number;
  hash?: string;
}

describe('wallet_signTransfer', () => {
  it('signs op_type "standard", and the signature verifies over the canonical bytes', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1500000',
    });
    const result = res.result as TransferResult;
    const tx = result.signedTransaction;

    expect(res.error).toBeUndefined();
    // The whole reason this method exists: `op_type` is inside the signed
    // digest, so a caller cannot sign a 'call' and rewrite it to 'standard'.
    expect(tx.op_type).toBe('standard');
    expect(result.opType).toBe('standard');
    expect(verifyTransaction(tx as never)).toBe(true);

    // Independent check with raw nacl over the exact bytes the node re-signs.
    const fields: TransactionFields = {
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      nonce: tx.nonce,
      ou: tx.ou,
      timestamp: tx.timestamp,
      op_type: tx.op_type,
    };
    const ok = nacl.sign.detached.verify(
      new Uint8Array(canonicalJsonForTx(fields)),
      new Uint8Array(base64Decode(tx.signature)),
      new Uint8Array(base64Decode(tx.public_key)),
    );
    expect(ok).toBe(true);
  });

  it('shows the user the exact numbers it then signs', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amount: '0.25',
    });
    const result = res.result as TransferResult;
    const tx = result.signedTransaction;

    const prompt = host.approvals.find((a) => a.kind === 'signTransfer');
    expect(prompt).toBeDefined();
    const detail = prompt!.detail as Record<string, unknown>;

    // Approving one fee and signing another is the failure this guards against:
    // every value the prompt rendered must be the value in the digest.
    expect(detail.to).toBe(tx.to);
    expect(detail.amountRaw).toBe(tx.amount);
    expect(detail.ou).toBe(tx.ou);
    expect(detail.nonce).toBe(tx.nonce);
    expect(detail.opType).toBe('standard');
    // …and the reply agrees with both.
    expect(result.to).toBe(tx.to);
    expect(result.amountRaw).toBe(tx.amount);
    expect(result.ou).toBe(tx.ou);
    expect(result.nonce).toBe(5); // host.getNextNonce()
  });

  it('resolves a decimal amount the same way the send form does', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const res = await driver.request(METHODS.SIGN_TRANSFER, { to: other.addr, amount: '0.25' });
    expect((res.result as TransferResult).amountRaw).toBe('250000');
  });

  it('fills in the recommended fee when ou is omitted, and honours one when given', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const auto = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
    });
    // recommendedOu('standard', <1e9) — see src/tx/builder.ts.
    expect((auto.result as TransferResult).ou).toBe('10000');

    const explicit = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
      ou: '12345',
    });
    expect((explicit.result as TransferResult).ou).toBe('12345');
    expect((explicit.result as TransferResult).signedTransaction.ou).toBe('12345');
  });

  it('carries an optional memo into the signed message field', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    await connect(driver);

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
      message: 'invoice 42',
    });
    const tx = (res.result as TransferResult).signedTransaction;
    expect(tx.message).toBe('invoice 42');
    expect(verifyTransaction(tx as never)).toBe(true);
  });

  it('rejects a bad request with INVALID_PARAMS and never opens a prompt', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing recipient', { amountRaw: '1000' }],
      ['invalid recipient', { to: 'not-an-address', amountRaw: '1000' }],
      ['self-send', { to: wallet.addr, amountRaw: '1000' }],
      ['zero amount', { to: other.addr, amountRaw: '0' }],
      ['non-integer amountRaw', { to: other.addr, amountRaw: '1.5' }],
      ['missing amount', { to: other.addr }],
      ['non-numeric fee', { to: other.addr, amountRaw: '1000', ou: 'free' }],
    ];

    for (const [label, params] of cases) {
      await wipeEverything();
      const host = makeHost();
      const { driver } = wire(host);
      await connect(driver);
      const approvalsAfterConnect = host.approvals.length;

      const res = await driver.request(METHODS.SIGN_TRANSFER, params);
      expect(res.error?.code, label).toBe(ERROR_CODES.INVALID_PARAMS);
      // Opening an approval for something that cannot be signed asks the user
      // to okay a transaction that will fail anyway.
      expect(host.approvals.length, label).toBe(approvalsAfterConnect);
    }
  });

  it('returns USER_REJECTED when the user declines, and signs nothing', async () => {
    const host = makeHost({
      requestApproval: async (req) => {
        (host.approvals as ApprovalRequest[]).push(req);
        return { approved: req.kind === 'connect' };
      },
    });
    const { driver } = wire(host);
    await connect(driver);

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
    });
    expect(res.error?.code).toBe(ERROR_CODES.USER_REJECTED);
    expect(res.result).toBeUndefined();
  });

  it('suspends behind the unlock prompt rather than failing outright', async () => {
    let unlocked = false;
    const requestUnlock = vi.fn(async () => {
      unlocked = true;
      return true;
    });
    const host = makeHost({ isUnlocked: () => unlocked, requestUnlock });
    const { driver } = wire(host);
    driver.ack();
    // connect() itself rides the same gate.
    await driver.request(METHODS.CONNECT, { origin: ORIGIN });

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
    });
    // One real request is enough to raise the prompt and then resolve — the
    // dApp does not have to re-handshake or ask twice.
    expect(requestUnlock).toHaveBeenCalled();
    expect(res.error).toBeUndefined();
    expect((res.result as TransferResult).signedTransaction.op_type).toBe('standard');
  });

  it('fails WALLET_LOCKED when the user never unlocks', async () => {
    const host = makeHost({ isUnlocked: () => false, requestUnlock: async () => false });
    const { driver } = wire(host);
    driver.ack();

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
    });
    expect(res.error?.code).toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('fails UNAUTHORIZED without a session', async () => {
    const host = makeHost();
    const { driver } = wire(host);
    driver.ack(); // no connect

    const res = await driver.request(METHODS.SIGN_TRANSFER, {
      to: other.addr,
      amountRaw: '1000',
    });
    expect(res.error?.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });
});
