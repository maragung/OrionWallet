import { describe, it, expect } from 'vitest';
import {
  noopProgress,
  shorten,
  b64Size,
  formatBytes,
  yieldToPaint,
  type ProgressReporter,
} from '../../src/utils/progress';
import { prepareStealthSend, STEALTH_PREPARE_STEPS } from '../../src/stealth';
import { ENCRYPT_STEPS, DECRYPT_STEPS } from '../../src/api/encrypt';
import { keypairFromSeed } from '../../src/crypto/ed25519';
import { randomBytes } from '../../src/crypto/random';

/** Records every reporter call so tests can assert on step order/status. */
function recordingReporter() {
  const calls: { id: string; status: 'active' | 'done' | 'error'; description?: string }[] = [];
  const reporter: ProgressReporter = {
    async begin(id, description) {
      calls.push({ id, status: 'active', description });
    },
    async done(id, description) {
      calls.push({ id, status: 'done', description });
    },
    fail(id, description) {
      calls.push({ id, status: 'error', description });
    },
  };
  return { calls, reporter };
}

describe('progress utilities', () => {
  it('noopProgress is safe to call and returns promises', async () => {
    await expect(noopProgress.begin('x')).resolves.toBeUndefined();
    await expect(noopProgress.done('x')).resolves.toBeUndefined();
    expect(() => noopProgress.fail('x')).not.toThrow();
  });

  it('yieldToPaint resolves even without requestAnimationFrame', async () => {
    const original = globalThis.requestAnimationFrame;
    // @ts-expect-error — deliberately removing the API to exercise the fallback
    delete globalThis.requestAnimationFrame;
    await expect(yieldToPaint()).resolves.toBeUndefined();
    globalThis.requestAnimationFrame = original;
  });

  it('shorten keeps short strings intact and elides long ones', () => {
    expect(shorten('abc')).toBe('abc');
    const long = 'a'.repeat(64);
    const short = shorten(long, 10, 6);
    expect(short).toContain('…');
    expect(short.length).toBeLessThan(long.length);
    expect(short.startsWith('a'.repeat(10))).toBe(true);
  });

  it('b64Size decodes byte length and ignores transport prefixes', () => {
    // 32 raw bytes → 44 base64 chars with one '=' pad
    const b64 = Buffer.from(randomBytes(32)).toString('base64');
    expect(b64Size(b64)).toBe('32 B');
    expect(b64Size(`hfhe_v1|${b64}`)).toBe('32 B');
  });

  it('formatBytes switches to KB above 1024', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('step descriptors', () => {
  it('encrypt and decrypt step ids are unique', () => {
    for (const steps of [ENCRYPT_STEPS, DECRYPT_STEPS]) {
      const ids = steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every step has a label and a description', () => {
    for (const steps of [ENCRYPT_STEPS, DECRYPT_STEPS, STEALTH_PREPARE_STEPS]) {
      for (const step of steps) {
        expect(step.label.length).toBeGreaterThan(0);
        expect(step.description?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('decrypt covers the extra proof steps encrypt does not need', () => {
    const decryptIds = DECRYPT_STEPS.map((s) => s.id);
    expect(decryptIds).toContain('range-proof');
    expect(decryptIds).toContain('ct-sub');
    expect(decryptIds).toContain('verify');
    expect(ENCRYPT_STEPS.map((s) => s.id)).not.toContain('range-proof');
  });
});

describe('prepareStealthSend progress reporting', () => {
  const recipient = keypairFromSeed(randomBytes(32));

  it('reports every declared step as active then done, in order', async () => {
    const { calls, reporter } = recordingReporter();
    await prepareStealthSend(
      { recipientEd25519Pubkey: recipient.publicKey, amountRaw: '1500000' },
      reporter,
    );

    // Each declared step should appear exactly once as active and once as done.
    for (const step of STEALTH_PREPARE_STEPS) {
      const forStep = calls.filter((c) => c.id === step.id);
      expect(forStep.map((c) => c.status)).toEqual(['active', 'done']);
    }

    // Completion order must match the declared order.
    const doneOrder = calls.filter((c) => c.status === 'done').map((c) => c.id);
    expect(doneOrder).toEqual(STEALTH_PREPARE_STEPS.map((s) => s.id));
  });

  it('attaches non-empty result details to completed steps', async () => {
    const { calls, reporter } = recordingReporter();
    await prepareStealthSend(
      { recipientEd25519Pubkey: recipient.publicKey, amountRaw: '1' },
      reporter,
    );
    for (const c of calls.filter((x) => x.status === 'done')) {
      expect(c.description, `step ${c.id} should report a detail`).toBeTruthy();
    }
  });

  it('never leaks the shared secret, claim secret or blinding into descriptions', async () => {
    const { calls, reporter } = recordingReporter();
    const prepared = await prepareStealthSend(
      { recipientEd25519Pubkey: recipient.publicKey, amountRaw: '2500000' },
      reporter,
    );

    const secrets = [
      Buffer.from(prepared.sharedSecret).toString('base64'),
      Buffer.from(prepared.claimSecret).toString('base64'),
      Buffer.from(prepared.blinding).toString('base64'),
    ];
    const text = calls.map((c) => c.description ?? '').join('\n');
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      // Also guard against a truncated prefix being exposed.
      expect(text).not.toContain(secret.slice(0, 10));
    }
  });

  it('still works when no reporter is supplied', async () => {
    const prepared = await prepareStealthSend({
      recipientEd25519Pubkey: recipient.publicKey,
      amountRaw: '1000',
    });
    expect(prepared.stealthTagHex).toHaveLength(64);
    expect(prepared.ephemeralPubkey).toHaveLength(32);
  });

  it('reports the same stealth tag it returns', async () => {
    const { calls, reporter } = recordingReporter();
    const prepared = await prepareStealthSend(
      { recipientEd25519Pubkey: recipient.publicKey, amountRaw: '77' },
      reporter,
    );
    const tagStep = calls.find((c) => c.id === 'stealth-tag' && c.status === 'done');
    expect(tagStep?.description).toContain(prepared.stealthTagHex.slice(0, 16));
  });
});
