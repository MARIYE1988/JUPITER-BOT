import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables
const PORT = process.env.PORT || 3000;
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_COMMITMENT = process.env.SOLANA_COMMITMENT || 'confirmed';
const WALLET_PRIVATE_KEY_BASE58 = process.env.WALLET_PRIVATE_KEY_BASE58 || process.env.BS58_PRIVATE_KEY || '';
const JUPITER_QUOTE_URL = process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap';
const DEFAULT_SLIPPAGE_BPS = parseInt(process.env.DEFAULT_SLIPPAGE_BPS || '100', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);
const RETRY_BASE_MS = parseInt(process.env.RETRY_BASE_MS || '500', 10);
const MAX_CONCURRENT_TRADES = parseInt(process.env.MAX_CONCURRENT_TRADES || '3', 10);
const JUP_API_KEY = process.env.JUP_API_KEY || '';
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY || '';
const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

if (!JUP_API_KEY) console.warn('Missing JUP_API_KEY');
if (!WALLET_PUBLIC_KEY) console.warn('Missing WALLET_PUBLIC_KEY');
if (!WALLET_PRIVATE_KEY_BASE58) console.warn('Missing WALLET_PRIVATE_KEY_BASE58');

const connection = new Connection(SOLANA_RPC_URL, SOLANA_COMMITMENT);
const wallet = WALLET_PRIVATE_KEY_BASE58 ? Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY_BASE58)) : null;
const stateFile = path.join(process.cwd(), 'bot-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { rules: [], history: [], totals: { feesSpent: 0, success: 0, failure: 0 } };
  }
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function clamp(n, min, max, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : fallback;
}

function symbolForMint(mint) {
  const map = {
    'So11111111111111111111111111111111111111112': 'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    '27G9ch6tNiNvSZS8c12tVGmt3fwDMb1NA5aVZ6DM5579': 'JLP',
    'FeKc2btj2vZqLSTjHddxNn2RssdMjcLH8XxC6X7X5Nyb': 'jupUSD'
  };
  return map[mint] || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function normalizeRule(rule = {}) {
  const originalStartPrice = Number(rule.originalStartPrice ?? 0);
  const triggerOffset = Math.max(1, Math.min(20, parseInt(rule.triggerOffset ?? 1, 10) || 1));
  const maxAttemptsPerWindow = Number(rule.maxAttemptsPerWindow || 2);
  const windowMs = Number(rule.windowMs || 300000);

  return {
    id: rule.id || crypto.randomUUID(),
    name: rule.name || 'Rule',
    inputMint: rule.inputMint,
    outputMint: rule.outputMint,
    swapAmountUsd: clamp(rule.swapAmountUsd, 0.25, 10, 0.5),
    intervalMin: clamp(rule.intervalMin, 1, 59, 3),
    thresholdUsd: Math.max(0, Number(rule.thresholdUsd ?? 0)),
    enabled: Boolean(rule.enabled),
    lastRunAt: rule.lastRunAt || null,
    nextRunAt: rule.nextRunAt || null,
    busy: false,
    originalStartPrice,
    triggerOffset,
    triggerPrice: originalStartPrice > 0 ? originalStartPrice + triggerOffset : triggerOffset,
    maxAttemptsPerWindow,
    windowMs,
    attemptTimestamps: Array.isArray(rule.attemptTimestamps) ? rule.attemptTimestamps : [],
    lastEvaluationAt: rule.lastEvaluationAt || null,
    lastSwapAt: rule.lastSwapAt || null,
    lastError: rule.lastError || null
  };
}

let state = loadState();
state.rules = (state.rules || []).map(normalizeRule);
state.history = state.history || [];
state.totals = state.totals || { feesSpent: 0, success: 0, failure: 0 };

function pruneAttempts(rule, now = Date.now()) {
  const cutoff = now - Number(rule.windowMs || 300000);
  rule.attemptTimestamps = (rule.attemptTimestamps || []).filter(ts => Number(ts) >= cutoff);
  return rule.attemptTimestamps;
}

function getAttemptsInWindow(rule, now = Date.now()) {
  return pruneAttempts(rule, now).length;
}

async function getMintDecimals(mint) {
  const res = await connection.getParsedAccountInfo(new PublicKey(mint));
  const decimals = res?.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new Error('Unable to read mint decimals');
  return decimals;
}

async function getTokenBalanceUi(mint) {
  const ownerKey = WALLET_PUBLIC_KEY || wallet?.publicKey?.toBase58();
  if (!ownerKey) return 0;
  const res = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(ownerKey),
    { mint: new PublicKey(mint) }
  );
  let amount = 0;
  for (const a of res.value) {
    amount += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0);
  }
  return amount;
}

async function getCurrentTokenUsdPrice(mint) {
  const url = new URL('https://api.jup.ag/price/v3');
  url.searchParams.set('ids', mint);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Price lookup failed ${res.status}`);
  const data = await res.json();
  const usdPrice = Number(data?.[mint]?.usdPrice || 0);
  if (!usdPrice || !Number.isFinite(usdPrice)) {
    throw new Error(`No valid USD price for mint ${mint}`);
  }
  return usdPrice;
}

async function quoteUsdValue(mint, uiAmount) {
  const decimals = await getMintDecimals(mint);
  const amount = Math.floor(uiAmount * 10 ** decimals);
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set('inputMint', mint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', String(amount));
  const res = await fetch(url, { headers: { 'x-api-key': JUP_API_KEY } });
  if (!res.ok) throw new Error(`Price quote failed ${res.status}`);
  const order = await res.json();
  return { usd: Number(order.outAmount || 0) / 1e6, order };
}

async function hasSufficientInputBalance(inputMint, swapAmountUsd) {
  const balanceUi = await getTokenBalanceUi(inputMint);
  if (balanceUi <= 0) return false;
  const currentPrice = await getCurrentTokenUsdPrice(inputMint);
  const balanceUsd = balanceUi * currentPrice;
  return balanceUsd >= Number(swapAmountUsd || 0);
}

async function executeJupiterSwapForRule(rule) {
  const balanceUi = await getTokenBalanceUi(rule.inputMint);
  if (balanceUi <= 0) throw new Error('No input token balance');
  
  const balanceUsd = balanceUi * await getCurrentTokenUsdPrice(rule.inputMint);
  const desiredUsd = Math.min(rule.swapAmountUsd, balanceUsd);
  if (desiredUsd <= 0) throw new Error('Desired USD amount is zero');

  const inputDecimals = await getMintDecimals(rule.inputMint);
  const amountIn = Math.floor((desiredUsd / balanceUsd) * balanceUi * 10 ** inputDecimals);
  if (amountIn <= 0) throw new Error('Calculated amountIn is zero');

  const orderUrl = new URL(JUPITER_QUOTE_URL);
  orderUrl.searchParams.set('inputMint', rule.inputMint);
  orderUrl.searchParams.set('outputMint', rule.outputMint);
  orderUrl.searchParams.set('amount', String(amountIn));
  orderUrl.searchParams.set('taker', WALLET_PUBLIC_KEY || wallet?.publicKey?.toBase58() || '');
  orderUrl.searchParams.set('slippageBps', String(DEFAULT_SLIPPAGE_BPS));

  const orderRes = await fetch(orderUrl, { headers: { 'x-api-key': JUP_API_KEY } });
  if (!orderRes.ok) throw new Error(`Jupiter quote failed ${orderRes.status}`);
  const order = await orderRes.json();
  if (!order.transaction || !order.requestId) throw new Error('Invalid order response from Jupiter');

  if (!wallet) throw new Error('Wallet signer unavailable');
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([wallet]);
  const signedTx = Buffer.from(tx.serialize()).toString('base64');

  const execUrl = new URL(JUPITER_SWAP_URL);
  const execRes = await fetch(execUrl.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': JUP_API_KEY },
    body: JSON.stringify({ signedTransaction: signedTx, requestId: order.requestId })
  });

  if (!execRes.ok) throw new Error(`Jupiter execute failed ${execRes.status}`);
  const result = await execRes.json();
  if (result.status !== 'Success' || result.code !== 0) {
    throw new Error(result.error || `Execute failed code ${result.code}`);
  }

  return { order, result, amountIn, balanceUsd, desiredUsd };
}

async function executeRule(rule) {
  const now = Date.now();
  rule.lastEvaluationAt = new Date(now).toISOString();
  rule.lastError = null;
  rule.triggerPrice = Number(rule.originalStartPrice || 0) + Number(rule.triggerOffset || 1);

  if (!rule.enabled) {
    return { skipped: true, skipReason: 'Rule disabled' };
  }

  if (!wallet || !(WALLET_PUBLIC_KEY || wallet?.publicKey?.toBase58())) {
    rule.lastError = 'Wallet unavailable';
    return { skipped: true, skipReason: 'Wallet unavailable' };
  }

  const currentPrice = await getCurrentTokenUsdPrice(rule.inputMint);
  if (!(currentPrice >= rule.triggerPrice)) {
    return {
      skipped: true,
      skipReason: 'Below trigger price',
      currentPriceAtEvaluation: currentPrice,
      triggerPrice: rule.triggerPrice,
      attemptsInWindow: getAttemptsInWindow(rule, now)
    };
  }

  const attemptsInWindow = getAttemptsInWindow(rule, now);
  if (attemptsInWindow >= Number(rule.maxAttemptsPerWindow || 2)) {
    rule.lastError = 'Attempt window limit reached';
    return {
      skipped: true,
      skipReason: 'Attempt window limit reached',
      currentPriceAtEvaluation: currentPrice,
      triggerPrice: rule.triggerPrice,
      attemptsInWindow
    };
  }

  const enoughBalance = await hasSufficientInputBalance(rule.inputMint, rule.swapAmountUsd);
  if (!enoughBalance) {
    rule.lastError = 'Insufficient token balance';
    return {
      skipped: true,
      skipReason: 'Insufficient token balance',
      currentPriceAtEvaluation: currentPrice,
      triggerPrice: rule.triggerPrice,
      attemptsInWindow
    };
  }

  rule.attemptTimestamps.push(now);

  try {
    const swap = await executeJupiterSwapForRule(rule);
    rule.lastSwapAt = new Date().toISOString();
    rule.lastRunAt = new Date().toISOString();
    rule.nextRunAt = new Date(Date.now() + rule.intervalMin * 60 * 1000).toISOString();
    return {
      success: true,
      ...swap,
      currentPriceAtEvaluation: currentPrice,
      triggerPrice: rule.triggerPrice,
      attemptsInWindow: getAttemptsInWindow(rule, now)
    };
  } catch (e) {
    rule.lastError = e.message || 'Swap execution failed';
    rule.lastRunAt = new Date().toISOString();
    rule.nextRunAt = new Date(Date.now() + rule.intervalMin * 60 * 1000).toISOString();
    return {
      success: false,
      error: rule.lastError,
      currentPriceAtEvaluation: currentPrice,
      triggerPrice: rule.triggerPrice,
      attemptsInWindow: getAttemptsInWindow(rule, now)
    };
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const rule of state.rules) {
      if (!rule.enabled || rule.busy) continue;
      if (rule.nextRunAt && Date.now() < new Date(rule.nextRunAt).getTime()) continue;
      rule.busy = true;
      try {
        const outcome = await executeRule(rule);
        if (outcome.success) {
          state.totals.success += 1;
          state.history.unshift({
            ts: new Date().toISOString(),
            ruleId: rule.id,
            ruleName: rule.name,
            status: 'success',
            amountIn: outcome.amountIn,
            balanceUsd: outcome.balanceUsd,
            desiredUsd: outcome.desiredUsd,
            baseline: rule.originalStartPrice,
            triggerOffset: rule.triggerOffset,
            triggerPrice: outcome.triggerPrice,
            currentPriceAtEvaluation: outcome.currentPriceAtEvaluation,
            attemptsInWindow: outcome.attemptsInWindow,
            order: {
              requestId: outcome.order.requestId,
              outAmount: outcome.order.outAmount,
              router: outcome.order.router,
              mode: outcome.order.mode,
              feeBps: outcome.order.feeBps,
              feeMint: outcome.order.feeMint
            },
            execute: {
              status: outcome.result.status,
              signature: outcome.result.signature,
              code: outcome.result.code,
              inputAmountResult: outcome.result.inputAmountResult,
              outputAmountResult: outcome.result.outputAmountResult
            }
          });
        } else {
          state.totals.failure += outcome.error ? 1 : 0;
          state.history.unshift({
            ts: new Date().toISOString(),
            ruleId: rule.id,
            ruleName: rule.name,
            status: 'failure',
            baseline: rule.originalStartPrice,
            triggerOffset: rule.triggerOffset,
            triggerPrice: outcome.triggerPrice ?? rule.triggerPrice,
            currentPriceAtEvaluation: outcome.currentPriceAtEvaluation ?? null,
            attemptsInWindow: outcome.attemptsInWindow ?? getAttemptsInWindow(rule),
            skipReason: outcome.skipReason || null,
            error: outcome.error || null
          });
        }
        state.history = state.history.slice(0, 200);
      } finally {
        rule.busy = false;
        saveState();
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 15_000);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/wallet/tokens', async (req, res) => {
  try {
    const walletPublicKey = WALLET_PUBLIC_KEY || wallet?.publicKey?.toBase58?.() || null;
    if (!walletPublicKey) {
      return res.json({ walletPublicKey: null, tokens: [] });
    }
    const owner = new PublicKey(walletPublicKey);
    const response = await connection.getParsedTokenAccountsByOwner(
      owner,
      { programId: TOKEN_PROGRAM_ID },
      'confirmed'
    );

    const rawTokens = response.value
      .map(({ account }) => {
        const info = account?.data?.parsed?.info;
        const amt = info?.tokenAmount;
        const balanceUi = Number(amt?.uiAmount || 0);
        return { mint: info?.mint, balanceUi };
      })
      .filter(t => t.mint && t.balanceUi > 0);

    if (rawTokens.length === 0) {
      return res.json({ walletPublicKey, tokens: [] });
    }

    const ids = rawTokens.map(t => t.mint).join(',');
    const url = new URL('https://api.jup.ag/price/v3');
    url.searchParams.set('ids', ids);
    const priceRes = await fetch(url);
    const priceJson = await priceRes.json();

    const tokens = rawTokens.map(t => {
      const usdPrice = Number(priceJson?.[t.mint]?.usdPrice || 0);
      return {
        mint: t.mint,
        symbol: symbolForMint(t.mint),
        balanceUi: t.balanceUi,
        usdValue: Number((t.balanceUi * usdPrice).toFixed(2))
      };
    });

    return res.json({ walletPublicKey, tokens });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to load wallet tokens' });
  }
});

app.get('/api/state', (req, res) => {
  const rules = state.rules.map(rule => {
    const normalized = normalizeRule(rule);
    return {
      ...normalized,
      attemptsInWindow: getAttemptsInWindow(normalized),
      triggerPrice: Number(normalized.originalStartPrice || 0) + Number(normalized.triggerOffset || 1)
    };
  });
  res.json({ ...state, rules });
});

app.post('/api/rules', (req, res) => {
  if (state.rules.length >= 10) return res.status(400).json({ error: 'Maximum 10 rules' });
  const rule = normalizeRule(req.body || {});
  if (!rule.inputMint || !rule.outputMint) {
    return res.status(400).json({ error: 'inputMint and outputMint required' });
  }
  if (!(Number(rule.originalStartPrice) > 0)) {
    return res.status(400).json({ error: 'originalStartPrice must be greater than 0' });
  }
  state.rules.push(rule);
  saveState();
  res.json(rule);
});

app.put('/api/rules/:id', (req, res) => {
  const idx = state.rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  state.rules[idx] = normalizeRule({ ...state.rules[idx], ...req.body, id: state.rules[idx].id });
  saveState();
  res.json(state.rules[idx]);
});

app.post('/api/rules/:id/start', (req, res) => {
  const rule = state.rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  rule.enabled = true;
  rule.nextRunAt = new Date().toISOString();
  saveState();
  res.json(rule);
});

app.post('/api/rules/:id/stop', (req, res) => {
  const rule = state.rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  rule.enabled = false;
  saveState();
  res.json(rule);
});

app.delete('/api/rules/:id', (req, res) => {
  state.rules = state.rules.filter(r => r.id !== req.params.id);
  saveState();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
