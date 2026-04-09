import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const JUP_BASE_URL = process.env.JUP_BASE_URL || 'https://api.jup.ag/swap/v2';
const JUP_API_KEY = process.env.JUP_API_KEY || '';
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY || '';
const BS58_PRIVATE_KEY = process.env.BS58_PRIVATE_KEY || '';
const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

if (!JUP_API_KEY) console.warn('Missing JUP_API_KEY');
if (!WALLET_PUBLIC_KEY) console.warn('Missing WALLET_PUBLIC_KEY');
if (!BS58_PRIVATE_KEY) console.warn('Missing BS58_PRIVATE_KEY');

const connection = new Connection(RPC_URL, 'confirmed');
const wallet = BS58_PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(BS58_PRIVATE_KEY)) : null;
const stateFile = path.join(process.cwd(), 'bot-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {
    return { rules: [], history: [], totals: { feesSpent: 0, success: 0, failure: 0 } };
  }
}
function saveState() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
function clamp(n, min, max, fallback) { const x = Number(n); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : fallback; }
function normalizeRule(rule) {
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
    busy: false
  };
}

let state = loadState();
state.rules = (state.rules || []).map(normalizeRule);
state.history = state.history || [];
state.totals = state.totals || { feesSpent: 0, success: 0, failure: 0 };

async function getMintDecimals(mint) {
  const res = await connection.getParsedAccountInfo(new PublicKey(mint));
  const decimals = res?.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new Error('Unable to read mint decimals');
  return decimals;
}

async function getTokenBalanceUi(mint) {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(WALLET_PUBLIC_KEY), { mint: new PublicKey(mint) });
  let amount = 0;
  for (const a of res.value) amount += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0);
  return amount;
}

async function quoteUsdValue(mint, uiAmount) {
  const decimals = await getMintDecimals(mint);
  const amount = Math.floor(uiAmount * 10 ** decimals);
  const url = new URL(`${JUP_BASE_URL}/order`);
  url.searchParams.set('inputMint', mint);
  url.searchParams.set('outputMint', USDC_MINT);
  url.searchParams.set('amount', String(amount));
  const res = await fetch(url, { headers: { 'x-api-key': JUP_API_KEY } });
  if (!res.ok) throw new Error(`Price order failed ${res.status}`);
  const order = await res.json();
  return { usd: Number(order.outAmount || 0) / 1e6, order };
}

async function executeRule(rule) {
  const balanceUi = await getTokenBalanceUi(rule.inputMint);
  const { usd: balanceUsd } = await quoteUsdValue(rule.inputMint, balanceUi);
  if (balanceUsd < rule.thresholdUsd + 1) return { skipped: true, reason: 'balance below threshold + 1', balanceUsd };

  const desiredUsd = Math.min(rule.swapAmountUsd, balanceUsd);
  const inputDecimals = await getMintDecimals(rule.inputMint);
  const amountIn = Math.floor((desiredUsd / balanceUsd) * balanceUi * 10 ** inputDecimals);

  const orderUrl = new URL(`${JUP_BASE_URL}/order`);
  orderUrl.searchParams.set('inputMint', rule.inputMint);
  orderUrl.searchParams.set('outputMint', rule.outputMint);
  orderUrl.searchParams.set('amount', String(amountIn));
  orderUrl.searchParams.set('taker', WALLET_PUBLIC_KEY);

  const orderRes = await fetch(orderUrl, { headers: { 'x-api-key': JUP_API_KEY } });
  if (!orderRes.ok) throw new Error(`Jupiter order failed ${orderRes.status}`);
  const order = await orderRes.json();
  if (!order.transaction || !order.requestId) throw new Error('Invalid order response from Jupiter');

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([wallet]);
  const signedTx = Buffer.from(tx.serialize()).toString('base64');

  const execRes = await fetch(`${JUP_BASE_URL}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': JUP_API_KEY },
    body: JSON.stringify({ signedTransaction: signedTx, requestId: order.requestId })
  });
  if (!execRes.ok) throw new Error(`Jupiter execute failed ${execRes.status}`);
  const result = await execRes.json();
  if (result.status !== 'Success' || result.code !== 0) throw new Error(result.error || `Execute failed code ${result.code}`);
  return { success: true, order, result, amountIn, balanceUsd, desiredUsd };
}

async function tick() {
  for (const rule of state.rules) {
    if (!rule.enabled || rule.busy) continue;
    if (rule.nextRunAt && Date.now() < new Date(rule.nextRunAt).getTime()) continue;
    rule.busy = true;
    try {
      const r = await executeRule(rule);
      rule.lastRunAt = new Date().toISOString();
      rule.nextRunAt = new Date(Date.now() + rule.intervalMin * 60 * 1000).toISOString();
      if (r.success) {
        state.totals.success += 1;
        state.history.unshift({
          ts: new Date().toISOString(), ruleId: rule.id, ruleName: rule.name, status: 'success',
          amountIn: r.amountIn, balanceUsd: r.balanceUsd, desiredUsd: r.desiredUsd,
          order: { requestId: r.order.requestId, outAmount: r.order.outAmount, router: r.order.router, mode: r.order.mode, feeBps: r.order.feeBps, feeMint: r.order.feeMint },
          execute: { status: r.result.status, signature: r.result.signature, code: r.result.code, inputAmountResult: r.result.inputAmountResult, outputAmountResult: r.result.outputAmountResult }
        });
      }
    } catch (e) {
      state.totals.failure += 1;
      state.history.unshift({ ts: new Date().toISOString(), ruleId: rule.id, ruleName: rule.name, status: 'failure', error: e.message });
    } finally {
      rule.busy = false;
      saveState();
    }
  }
}
setInterval(tick, 15_000);

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/state', (req, res) => res.json(state));
app.post('/api/rules', (req, res) => {
  if (state.rules.length >= 10) return res.status(400).json({ error: 'Maximum 10 rules' });
  const rule = normalizeRule(req.body || {});
  if (!rule.inputMint || !rule.outputMint) return res.status(400).json({ error: 'inputMint and outputMint required' });
  state.rules.push(rule); saveState(); res.json(rule);
});
app.put('/api/rules/:id', (req, res) => {
  const idx = state.rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  state.rules[idx] = normalizeRule({ ...state.rules[idx], ...req.body, id: state.rules[idx].id });
  saveState(); res.json(state.rules[idx]);
});
app.post('/api/rules/:id/start', (req, res) => {
  const rule = state.rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  rule.enabled = true; rule.nextRunAt = new Date().toISOString(); saveState(); res.json(rule);
});
app.post('/api/rules/:id/stop', (req, res) => {
  const rule = state.rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  rule.enabled = false; saveState(); res.json(rule);
});
app.delete('/api/rules/:id', (req, res) => {
  state.rules = state.rules.filter(r => r.id !== req.params.id); saveState(); res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
