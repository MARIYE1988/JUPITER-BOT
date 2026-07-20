const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

function getKeypairFromEnv() {
  const secret = process.env.WALLET_PRIVATE_KEY_BASE58;
  if (!secret) throw new Error('WALLET_PRIVATE_KEY_BASE58 missing');

  const bytes = bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}

module.exports = { getKeypairFromEnv };
