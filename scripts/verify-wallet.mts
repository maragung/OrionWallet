/**
 * Verify wallet import against known devnet test vector.
 * Mnemonic: predict anger trick phone coach near panda december endless ghost gloom scout
 * Expected address: octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia
 * Expected private key (base64): DgrXU6tcSZpiFDdduoQIjhCISWBlAqlxzLZP5Fh2tgM=
 */
import { importWalletFromMnemonic } from '../src/wallet/wallet';
import { isValidAddress } from '../src/crypto/address';
import { base64Encode } from '../src/crypto/base64';

async function main() {
  const mnemonic = 'predict anger trick phone coach near panda december endless ghost gloom scout';
  const expectedAddr = 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia';
  const expectedPrivKey = 'DgrXU6tcSZpiFDdduoQIjhCISWBlAqlxzLZP5Fh2tgM=';

  console.log('=== Wallet Import Verification ===\n');
  console.log('Mnemonic:', mnemonic);
  console.log('Expected address:', expectedAddr);
  console.log('Expected privKey:', expectedPrivKey);
  console.log('');

  try {
    const wallet = await importWalletFromMnemonic(mnemonic, 'Devnet Test', 0);
    console.log('Derived address:', wallet.addr);
    console.log('Derived privKey:', wallet.privB64);
    console.log('Derived pubKey:', wallet.pubB64);
    console.log('');

    const addrMatch = wallet.addr === expectedAddr;
    const privMatch = wallet.privB64 === expectedPrivKey;

    console.log('Address match:', addrMatch ? '✓ YES' : '✗ NO');
    console.log('PrivKey match:', privMatch ? '✓ YES' : '✗ NO');
    console.log('Address valid:', isValidAddress(wallet.addr) ? '✓ YES' : '✗ NO');

    if (!addrMatch) {
      console.log('\n⚠ Address mismatch! The HD derivation scheme may differ from Octra\'s.');
      console.log('Expected:', expectedAddr);
      console.log('Got:     ', wallet.addr);
    }
    if (!privMatch) {
      console.log('\n⚠ Private key mismatch! The HD derivation or key generation may differ.');
      console.log('Expected:', expectedPrivKey);
      console.log('Got:     ', wallet.privB64);
    }

    if (addrMatch && privMatch) {
      console.log('\n✅ ALL MATCH — wallet import is correct!');
    }
  } catch (e) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}

void base64Encode;
main();
