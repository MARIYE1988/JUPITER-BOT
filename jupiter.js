const axios = require('axios');
const { VersionedTransaction } = require('@solana/web3.js');
const { getKeypairFromEnv } = require('./wallet');

const QUOTE_URL = process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote';
const SWAP_URL = process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap';

async function executeJupiterSwap({
  connection,
  inputMint,
  outputMint,
  amountAtomic,
  slippageBps
}) {
  const wallet = getKeypairFromEnv();

  const quoteResp = await axios.get(QUOTE_URL, {
    params: {
      inputMint,
      outputMint,
      amount: amountAtomic,
      slippageBps
    },
    timeout: 15000
  });

  const route = quoteResp.data;
  if (!route) throw new Error('No quote returned from Jupiter');

  const swapResp = await axios.post(
    SWAP_URL,
    {
      quoteResponse: route,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true
    },
    { timeout: 20000 }
  );

  const swapTxBase64 = swapResp.data?.swapTransaction;
  if (!swapTxBase64) throw new Error('No swapTransaction returned');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
  tx.sign([wallet]);

  const sig = await connection.sendTransaction(tx, {
    maxRetries: Number(process.env.MAX_RETRIES || 2),
    preflightCommitment: process.env.SOLANA_COMMITMENT || 'confirmed'
  });

  const latest = await connection.getLatestBlockhash(process.env.SOLANA_COMMITMENT || 'confirmed');
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight
    },
    process.env.SOLANA_COMMITMENT || 'confirmed'
  );

  return { signature: sig, quote: route };
}

module.exports = { executeJupiterSwap };
