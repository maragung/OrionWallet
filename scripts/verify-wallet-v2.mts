/**
 * Verify wallet import with CORRECT Octra derivation scheme.
 *
 * Key differences discovered from original C++ source:
 * 1. HD derivation (hd_version=2, index=0): HMAC-SHA512(key="Octra seed", data=master_seed)[0:32]
 * 2. Private key format: only first 32 bytes (seed), NOT full 64-byte secret key
 * 3. Mnemonic checksum: Octra validates it, but some mnemonics may have non-standard checksums
 */
import { mnemonicToSeed } from '../src/crypto/bip39';
import { keypairFromSeed } from '../src/crypto/ed25519';
import { deriveAddressFromPubkey } from '../src/crypto/address';
import { base64Encode } from '../src/crypto/base64';
import { deriveHdSeed } from '../src/crypto/hd';

async function main() {
  const mnemonic = 'predict anger trick phone coach near panda december endless ghost gloom scout';
  const expectedAddr = 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia';
  const expectedPrivKey = 'DgrXU6tcSZpiFDdduoQIjhCISWBlAqlxzLZP5Fh2tgM=';

  console.log('=== Octra Wallet Import Verification (Correct Scheme) ===\n');

  // Step 1: mnemonic → master seed (PBKDF2-HMAC-SHA512, 2048 iterations)
  const masterSeed = await mnemonicToSeed(mnemonic, '');
  console.log('Master seed (first 32 bytes):', base64Encode(masterSeed.subarray(0, 32)));

  // Step 2: HD derivation (hd_version=2, index=0) — HMAC-SHA512(key="Octra seed", data=master_seed)[0:32]
  const hdSeed = deriveHdSeed(masterSeed, 0, 2);
  console.log('HD seed (base64):', base64Encode(hdSeed));

  // Step 3: Generate Ed25519 keypair from HD seed
  const kp = keypairFromSeed(hdSeed);
  console.log('Public key (base64):', base64Encode(kp.publicKey));

  // Step 4: Derive address
  const addr = deriveAddressFromPubkey(kp.publicKey);
  console.log('Derived address:', addr);
  console.log('Expected address:', expectedAddr);
  console.log('Address match:', addr === expectedAddr ? '✓ YES' : '✗ NO');

  // Step 5: Check private key (32-byte HD seed)
  const privKey = base64Encode(hdSeed);
  console.log('');
  console.log('Private key (base64):', privKey);
  console.log('Expected privKey:    ', expectedPrivKey);
  console.log('PrivKey match:', privKey === expectedPrivKey ? '✓ YES' : '✗ NO');

  if (addr === expectedAddr && privKey === expectedPrivKey) {
    console.log('\n✅ ALL MATCH — correct Octra derivation scheme verified!');
  }
}

main().catch(console.error);
