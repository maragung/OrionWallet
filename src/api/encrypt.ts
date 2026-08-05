/**
 * Encrypted balance API layer — encrypt / decrypt operations.
 *
 * Faithful port of the reference webcli handlers (main.cpp):
 *   POST /api/encrypt  → op_type "encrypt"
 *   POST /api/decrypt  → op_type "decrypt"
 *
 * Both are SELF-transfers (to == from) carrying a PVAC-HFHE payload in
 * `encrypted_data`. The node validates the FHE ciphertext and the bound
 * zero-knowledge proof, so this cannot be faked with plain AES — it requires
 * the compiled PVAC WASM module.
 *
 * encrypt encrypted_data:
 *   { cipher, amount_commitment, zero_proof, blinding }
 * decrypt encrypted_data:
 *   { cipher, amount_commitment, zero_proof, blinding, range_proof_balance }
 */
import type { RpcClient, SubmitTxResult } from '../rpc/client';
import type { Wallet } from '../wallet/wallet';
import {
  signTransaction,
  buildTxJson,
  parseAmountRaw,
  formatAmount,
  recommendedOu,
  nowTs,
  signBalanceRequest,
  signRegisterRequest,
  type Transaction,
} from '../tx/builder';
import { base64Encode } from '../crypto/base64';
import { randomBytes } from '../crypto/random';
import { getPvacBridge, isPvacWasmAvailable } from '../pvac';
import type { WasmPvacBridge } from '../pvac/wasm-bridge';
import { putTxCache } from '../wallet/storage';
import {
  noopProgress,
  shorten,
  b64Size,
  formatBytes,
  type ProgressReporter,
  type StepDescriptor,
} from '../utils/progress';

/** Optional FHE layer-count detail; never fatal if the bridge cannot report it. */
function describeLayers(bridge: WasmPvacBridge, ct: number): string {
  try {
    const n = bridge.baseLayerCount(ct);
    return n > 0 ? `, ${n} FHE layer${n === 1 ? '' : 's'}` : '';
  } catch {
    return '';
  }
}

/**
 * Step list for the encrypt flow, in execution order. Exported so the UI can
 * render the full sequence up-front (pending) before work starts.
 */
export const ENCRYPT_STEPS: StepDescriptor[] = [
  {
    id: 'pvac-init',
    label: 'Initializing PVAC module',
    description: 'Deriving FHE keys from your wallet key',
  },
  {
    id: 'pvac-register',
    label: 'Verifying on-chain encryption key',
    description: 'Checking your registered PVAC public key',
  },
  {
    id: 'read-balance',
    label: 'Reading encrypted balance',
    description: 'Signed RPC request for your balance ciphertext',
  },
  {
    id: 'decrypt-balance',
    label: 'Decrypting current balance',
    description: 'Local FHE decryption of the ciphertext',
  },
  {
    id: 'nonce',
    label: 'Fetching nonce & public balance',
    description: 'Reading account state from the node',
  },
  {
    id: 'fhe-encrypt',
    label: 'FHE-encrypting the amount',
    description: 'Building a homomorphic ciphertext',
  },
  {
    id: 'commit',
    label: 'Creating Pedersen commitment',
    description: 'Binding the amount to a random blinding factor',
  },
  {
    id: 'zero-proof',
    label: 'Generating zero-knowledge proof',
    description: 'Proving ciphertext and commitment encode the same amount',
  },
  {
    id: 'payload',
    label: 'Assembling encrypted payload',
    description: 'Serializing cipher, commitment and proof',
  },
  {
    id: 'sign',
    label: 'Signing transaction',
    description: 'Ed25519 signature over the canonical transaction',
  },
  {
    id: 'submit',
    label: 'Broadcasting to network',
    description: 'Submitting the transaction to the Octra RPC',
  },
  {
    id: 'cache',
    label: 'Updating local cache',
    description: 'Recording the transaction for history',
  },
];

/** Step list for the decrypt flow, in execution order. */
export const DECRYPT_STEPS: StepDescriptor[] = [
  {
    id: 'pvac-init',
    label: 'Initializing PVAC module',
    description: 'Deriving FHE keys from your wallet key',
  },
  {
    id: 'pvac-register',
    label: 'Verifying on-chain encryption key',
    description: 'Checking your registered PVAC public key',
  },
  {
    id: 'read-balance',
    label: 'Reading encrypted balance',
    description: 'Signed RPC request for your balance ciphertext',
  },
  {
    id: 'decrypt-balance',
    label: 'Decrypting current balance',
    description: 'Local FHE decryption of the ciphertext',
  },
  {
    id: 'nonce',
    label: 'Fetching nonce & public balance',
    description: 'Reading account state from the node',
  },
  {
    id: 'fhe-encrypt',
    label: 'FHE-encrypting the amount',
    description: 'Building a homomorphic ciphertext',
  },
  {
    id: 'commit',
    label: 'Creating Pedersen commitment',
    description: 'Binding the amount to a random blinding factor',
  },
  {
    id: 'ct-sub',
    label: 'Computing new balance homomorphically',
    description: 'Subtracting the amount ciphertext on-chain style',
  },
  {
    id: 'commit-balance',
    label: 'Committing to the new balance',
    description: 'Pedersen commitment over the remaining balance',
  },
  {
    id: 'zero-proof',
    label: 'Generating zero-knowledge proof',
    description: 'Proving ciphertext and commitment encode the same amount',
  },
  {
    id: 'range-proof',
    label: 'Generating balance range proof',
    description: 'Proving the new balance stays non-negative',
  },
  {
    id: 'verify',
    label: 'Verifying proofs locally',
    description: 'Checking the range proof against the commitment',
  },
  {
    id: 'payload',
    label: 'Assembling encrypted payload',
    description: 'Serializing ciphers, commitments and proofs',
  },
  {
    id: 'sign',
    label: 'Signing transaction',
    description: 'Ed25519 signature over the canonical transaction',
  },
  {
    id: 'submit',
    label: 'Broadcasting to network',
    description: 'Submitting the transaction to the Octra RPC',
  },
  {
    id: 'cache',
    label: 'Updating local cache',
    description: 'Recording the transaction for history',
  },
];

/** Obtain the WASM-backed bridge, initialized for this wallet. */
async function requireBridge(
  wallet: Wallet,
  progress: ProgressReporter = noopProgress,
): Promise<WasmPvacBridge> {
  await progress.begin('pvac-init');
  if (!isPvacWasmAvailable()) {
    progress.fail('pvac-init', 'PVAC WASM module is not loaded');
    throw new Error(
      'PVAC module not loaded — encrypted balance operations require the PVAC WASM module',
    );
  }
  const bridge = getPvacBridge() as WasmPvacBridge;
  if (!bridge.isInitialized()) {
    const ok = await bridge.init(wallet.privB64);
    if (!ok) {
      progress.fail('pvac-init', 'PVAC key derivation failed');
      throw new Error('PVAC init failed');
    }
    await progress.done('pvac-init', 'FHE keypair derived from wallet key');
  } else {
    await progress.done('pvac-init', 'Reusing already-initialized FHE keypair');
  }
  return bridge;
}

/**
 * Ensure the wallet's PVAC pubkey is registered on-chain, mirroring the
 * encrypt handler's key check:
 *   - if the node already has a key, it must equal ours (or extend it)
 *   - otherwise register ours
 */
async function ensurePvacRegistered(
  wallet: Wallet,
  rpc: RpcClient,
  bridge: WasmPvacBridge,
  progress: ProgressReporter = noopProgress,
): Promise<void> {
  await progress.begin('pvac-register');
  const localPk = bridge.serializePubkeyB64();
  const remote = await rpc.getPvacPubkey(wallet.addr);
  const remotePk =
    remote.ok && remote.result && remote.result.pvac_pubkey ? remote.result.pvac_pubkey : null;

  if (remotePk) {
    if (remotePk !== localPk && !bridge.pubkeyExtendsLocal(remotePk)) {
      progress.fail('pvac-register', 'On-chain key does not match this wallet');
      throw new Error('key mismatch: use key switch to reset encryption key');
    }
    await progress.done(
      'pvac-register',
      remotePk === localPk
        ? `Key matches on-chain (${b64Size(localPk)})`
        : 'On-chain key is a valid extension of the local key',
    );
    return;
  }

  // Not registered yet — register the local key.
  await progress.begin('pvac-register', 'No key on chain yet — registering this wallet key');
  const pkBlob = bridge.serializePubkeyBytes();
  const regSig = signRegisterRequest(wallet.addr, pkBlob, wallet.sk);
  const rr = await rpc.registerPvacPubkey(wallet.addr, localPk, regSig, wallet.pubB64, '');
  if (!rr.ok && !(rr.error ?? '').includes('already registered')) {
    progress.fail('pvac-register', rr.error ?? 'registration rejected');
    throw new Error(`pvac pubkey register failed: ${rr.error ?? 'unknown'}`);
  }
  await progress.done('pvac-register', `Registered new PVAC public key (${b64Size(localPk)})`);
}

/** Read the raw encrypted-balance cipher string via the signed RPC call. */
async function readEncryptedCipher(
  wallet: Wallet,
  rpc: RpcClient,
  progress: ProgressReporter = noopProgress,
): Promise<string> {
  await progress.begin('read-balance');
  const sig = signBalanceRequest(wallet.addr, wallet.sk);
  const r = await rpc.getEncryptedBalance(wallet.addr, sig, wallet.pubB64);
  if (!r.ok || !r.result) {
    progress.fail('read-balance', r.error ?? 'node rejected the balance request');
    throw new Error(r.error ?? 'cannot read encrypted balance');
  }
  const cipher = r.result.cipher ?? '0';
  await progress.done(
    'read-balance',
    !cipher || cipher === '0'
      ? 'No encrypted balance stored yet'
      : `Ciphertext received (${b64Size(cipher)})`,
  );
  return cipher;
}

/**
 * Read and decrypt the wallet's current encrypted balance (raw integer string).
 * Returns "0" when there is no encrypted balance yet.
 */
export async function getEncryptedBalanceRaw(wallet: Wallet, rpc: RpcClient): Promise<string> {
  if (!isPvacWasmAvailable()) return '0';
  try {
    const bridge = await requireBridge(wallet);
    const cipher = await readEncryptedCipher(wallet, rpc);
    if (!cipher || cipher === '0') return '0';
    const v = bridge.tryGetBalance(cipher);
    if (v === null) {
      throw new Error('encrypted balance amount is outside the valid balance domain');
    }
    return v.toString();
  } catch {
    return '0';
  }
}

export interface EncryptResult {
  tx: Transaction;
  submitResult: SubmitTxResult;
  /** New encrypted balance (raw integer string) after the operation. */
  newEncryptedRaw: string;
  /** New public balance (raw integer string) after the operation. */
  newPublicRaw: string;
}

/** Fetch nonce + public balance, mirroring get_nonce_balance_for. */
async function nonceAndBalance(
  wallet: Wallet,
  rpc: RpcClient,
  progress: ProgressReporter = noopProgress,
): Promise<{ nonce: number; publicRaw: bigint }> {
  await progress.begin('nonce');
  const bi = await rpc.getBalance(wallet.addr);
  if (!bi.ok || !bi.result) {
    progress.fail('nonce', bi.error ?? 'balance request failed');
    throw new Error(`Failed to fetch balance: ${bi.error ?? 'unknown'}`);
  }
  const confirmed = bi.result.nonce ?? 0;
  const nonce = bi.result.pending_nonce ?? confirmed;
  const publicRaw = BigInt(bi.result.balance_raw ?? parseAmountRaw(bi.result.balance || '0'));
  await progress.done(
    'nonce',
    `Nonce ${nonce + 1} · public balance ${formatAmount(publicRaw.toString())} OCT`,
  );
  return { nonce, publicRaw };
}

/** Sign + submit + cache a built transaction. */
async function submitTx(
  wallet: Wallet,
  rpc: RpcClient,
  fields: Parameters<typeof signTransaction>[0]['fields'],
  progress: ProgressReporter = noopProgress,
): Promise<{ tx: Transaction; submitResult: SubmitTxResult }> {
  await progress.begin('sign');
  const tx = signTransaction({
    secretKey: wallet.sk,
    publicKeyB64: wallet.pubB64,
    fields,
  });
  await progress.done('sign', `Signed · hash ${shorten(tx.hash, 12, 8)}`);

  await progress.begin('submit');
  const submit = await rpc.submitTx(JSON.parse(buildTxJson(tx)));
  if (!submit.ok || !submit.result) {
    progress.fail('submit', submit.error ?? 'node rejected the transaction');
    throw new Error(`Submit failed: ${submit.error ?? 'unknown'}`);
  }
  await progress.done('submit', `Accepted by node at nonce ${submit.result.nonce}`);

  await progress.begin('cache');
  await putTxCache({
    key: `${wallet.addr}:${tx.hash}`,
    addr: wallet.addr,
    hash: tx.hash,
    tx,
    receivedAt: Date.now(),
  });
  await progress.done('cache', 'Transaction stored in local history');
  return { tx, submitResult: submit.result };
}

/**
 * Encrypt `amount` OCT: move it from the public balance into the encrypted balance.
 * Port of POST /api/encrypt.
 */
export async function encryptBalance(
  wallet: Wallet,
  rpc: RpcClient,
  amount: string,
  progress: ProgressReporter = noopProgress,
): Promise<EncryptResult> {
  const amountRaw = BigInt(parseAmountRaw(amount));
  if (amountRaw <= 0n) throw new Error('Amount must be positive');

  const bridge = await requireBridge(wallet, progress);
  await ensurePvacRegistered(wallet, rpc, bridge, progress);

  // Current encrypted balance (must be readable before spending).
  const currentCipher = await readEncryptedCipher(wallet, rpc, progress);
  await progress.begin('decrypt-balance');
  const currentEnc =
    !currentCipher || currentCipher === '0' ? 0n : bridge.tryGetBalance(currentCipher);
  if (currentEnc === null) {
    progress.fail('decrypt-balance', 'Ciphertext is outside the valid balance domain');
    throw new Error('encrypted balance upgrade required before encrypt');
  }
  await progress.done(
    'decrypt-balance',
    `Current encrypted balance: ${formatAmount(currentEnc.toString())} OCT`,
  );

  const { nonce, publicRaw } = await nonceAndBalance(wallet, rpc, progress);
  const ou = recommendedOu('encrypt', amountRaw);
  if (publicRaw < amountRaw + BigInt(ou)) {
    progress.fail(
      'nonce',
      `Need ${formatAmount((amountRaw + BigInt(ou)).toString())} OCT, have ${formatAmount(publicRaw.toString())} OCT`,
    );
    throw new Error('Insufficient public balance to cover amount + fee');
  }

  // ── build the PVAC payload (mirrors main.cpp encrypt handler) ──
  let ct = 0;
  let zkp = 0;
  try {
    await progress.begin('fhe-encrypt');
    ct = bridge.encryptHandle(amountRaw, randomBytes(32));
    const cipherStr = bridge.encodeBoundCipherHandle(ct);
    await progress.done(
      'fhe-encrypt',
      `Ciphertext built (${b64Size(cipherStr)}${describeLayers(bridge, ct)})`,
    );

    await progress.begin('commit');
    const blinding = randomBytes(32);
    const amtCommit = bridge.pedersenCommitBytes(amountRaw, blinding);
    const amtCommitB64 = base64Encode(amtCommit);
    await progress.done('commit', `Commitment ${shorten(amtCommitB64)} · 32-byte blinding factor`);

    await progress.begin('zero-proof');
    zkp = bridge.makeZeroProofBoundHandle(ct, amountRaw, blinding);
    const zpStr = bridge.encodeZeroProofHandle(zkp);
    await progress.done('zero-proof', `Zero proof generated (${b64Size(zpStr)})`);

    await progress.begin('payload');
    const encData = JSON.stringify({
      cipher: cipherStr,
      amount_commitment: amtCommitB64,
      zero_proof: zpStr,
      blinding: base64Encode(blinding),
    });
    await progress.done('payload', `encrypted_data payload: ${formatBytes(encData.length)}`);

    const { tx, submitResult } = await submitTx(
      wallet,
      rpc,
      {
        from: wallet.addr,
        to: wallet.addr,
        amount: amountRaw.toString(),
        nonce: nonce + 1,
        ou,
        timestamp: nowTs(),
        op_type: 'encrypt',
        encrypted_data: encData,
      },
      progress,
    );

    return {
      tx,
      submitResult,
      newEncryptedRaw: (currentEnc + amountRaw).toString(),
      newPublicRaw: (publicRaw - amountRaw - BigInt(ou)).toString(),
    };
  } finally {
    bridge.freeZeroProofHandle(zkp);
    bridge.freeCipherHandle(ct);
  }
}

/**
 * Decrypt `amount` OCT: move it from the encrypted balance back to the public balance.
 * Port of POST /api/decrypt.
 */
export async function decryptBalance(
  wallet: Wallet,
  rpc: RpcClient,
  amount: string,
  progress: ProgressReporter = noopProgress,
): Promise<EncryptResult> {
  const amountRaw = BigInt(parseAmountRaw(amount));
  if (amountRaw <= 0n) throw new Error('Amount must be positive');

  const bridge = await requireBridge(wallet, progress);
  await ensurePvacRegistered(wallet, rpc, bridge, progress);

  const currentCipher = await readEncryptedCipher(wallet, rpc, progress);
  if (!currentCipher || currentCipher === '0') {
    progress.fail('decrypt-balance', 'No encrypted balance to draw from');
    throw new Error('Insufficient encrypted balance');
  }
  await progress.begin('decrypt-balance');
  const currentEnc = bridge.tryGetBalance(currentCipher);
  if (currentEnc === null) {
    progress.fail('decrypt-balance', 'Ciphertext is outside the valid balance domain');
    throw new Error('encrypted balance upgrade required before decrypt');
  }
  if (currentEnc < amountRaw) {
    progress.fail(
      'decrypt-balance',
      `Have ${formatAmount(currentEnc.toString())} OCT, need ${formatAmount(amountRaw.toString())} OCT`,
    );
    throw new Error(
      `insufficient encrypted balance: have ${currentEnc.toString()}, need ${amountRaw.toString()}`,
    );
  }
  await progress.done(
    'decrypt-balance',
    `Current encrypted balance: ${formatAmount(currentEnc.toString())} OCT`,
  );

  const { nonce, publicRaw } = await nonceAndBalance(wallet, rpc, progress);
  const ou = recommendedOu('decrypt', amountRaw);
  if (publicRaw < BigInt(ou)) {
    progress.fail(
      'nonce',
      `Fee is ${formatAmount(ou)} OCT, public balance is ${formatAmount(publicRaw.toString())} OCT`,
    );
    throw new Error('Insufficient public balance to cover the fee');
  }

  // ── build the PVAC payload (mirrors main.cpp decrypt handler) ──
  let ct = 0;
  let currentCt = 0;
  let newBalCt = 0;
  let zkp = 0;
  let rpBal = 0;
  try {
    await progress.begin('fhe-encrypt');
    ct = bridge.encryptHandle(amountRaw, randomBytes(32));
    const cipherStr = bridge.encodeBoundCipherHandle(ct);
    await progress.done(
      'fhe-encrypt',
      `Ciphertext built (${b64Size(cipherStr)}${describeLayers(bridge, ct)})`,
    );

    await progress.begin('commit');
    const blinding = randomBytes(32);
    const amtCommit = bridge.pedersenCommitBytes(amountRaw, blinding);
    const amtCommitB64 = base64Encode(amtCommit);
    await progress.done('commit', `Commitment ${shorten(amtCommitB64)} · 32-byte blinding factor`);

    await progress.begin('ct-sub');
    currentCt = bridge.decodeCipherHandle(currentCipher);
    if (!currentCt) {
      progress.fail('ct-sub', 'Stored balance ciphertext could not be decoded');
      throw new Error('cannot decode encrypted balance');
    }
    newBalCt = bridge.ctSubHandle(currentCt, ct);
    const newBalValue = currentEnc - amountRaw;
    await progress.done(
      'ct-sub',
      `New encrypted balance: ${formatAmount(newBalValue.toString())} OCT (computed on ciphertexts)`,
    );

    await progress.begin('commit-balance');
    const balanceBlinding = randomBytes(32);
    const balanceCommit = bridge.pedersenCommitBytes(newBalValue, balanceBlinding);
    await progress.done(
      'commit-balance',
      `Balance commitment ${shorten(base64Encode(balanceCommit))}`,
    );

    await progress.begin('zero-proof');
    zkp = bridge.makeZeroProofBoundHandle(ct, amountRaw, blinding);
    const zpStr = bridge.encodeZeroProofHandle(zkp);
    await progress.done('zero-proof', `Zero proof generated (${b64Size(zpStr)})`);

    await progress.begin('range-proof');
    rpBal = bridge.makeBoundRangeProofHandle(newBalCt, newBalValue, balanceBlinding);
    const rpStr = bridge.encodeBoundRangeProofHandle(rpBal);
    await progress.done('range-proof', `Range proof generated (${b64Size(rpStr)})`);

    await progress.begin('verify');
    if (!bridge.verifyBoundRangeCommitment(newBalCt, rpBal, balanceCommit)) {
      progress.fail('verify', 'Range proof did not verify against the commitment');
      throw new Error('encrypted balance repair required before decrypt');
    }
    await progress.done('verify', 'Range proof verifies against the balance commitment');

    await progress.begin('payload');
    const encData = JSON.stringify({
      cipher: cipherStr,
      amount_commitment: amtCommitB64,
      zero_proof: zpStr,
      blinding: base64Encode(blinding),
      range_proof_balance: rpStr,
    });
    await progress.done('payload', `encrypted_data payload: ${formatBytes(encData.length)}`);

    const { tx, submitResult } = await submitTx(
      wallet,
      rpc,
      {
        from: wallet.addr,
        to: wallet.addr,
        amount: amountRaw.toString(),
        nonce: nonce + 1,
        ou,
        timestamp: nowTs(),
        op_type: 'decrypt',
        encrypted_data: encData,
      },
      progress,
    );

    return {
      tx,
      submitResult,
      newEncryptedRaw: newBalValue.toString(),
      newPublicRaw: (publicRaw + amountRaw - BigInt(ou)).toString(),
    };
  } finally {
    bridge.freeZeroProofHandle(rpBal);
    bridge.freeZeroProofHandle(zkp);
    bridge.freeCipherHandle(newBalCt);
    bridge.freeCipherHandle(currentCt);
    bridge.freeCipherHandle(ct);
  }
}
