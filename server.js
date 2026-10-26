import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { normalizeFeePolicy, evaluateFees } from './fee-policy.js';
dotenv.config();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
const PORT = process.env.PORT || 3000;
const AUTH = process.env.API_AUTH_TOKEN || '';
const LIVE = process.env.LIVE_TRADING === 'true';
const SOL = 'So11111111111111111111111111111111111111112';
const RPC = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const API_KEY = process.env.JUP_API_KEY || '';
const secret = process.env.WALLET_PRIVATE_KEY_BASE58 || process.env.BS58_PRIVATE_KEY;
const wallet = LIVE && secret ? Keypair.fromSecretKey(bs58.decode(secret)) : null;
const owner = process.env.WALLET_PUBLIC_KEY || wallet?.publicKey.toBase58() || '';
if (LIVE && (!wallet || !AUTH || !API_KEY)) throw new Error('Live mode requires signer, API_AUTH_TOKEN and JUP_API_KEY');
if (wallet && owner !== wallet.publicKey.toBase58()) throw new Error('Signer/public key mismatch');
const stateFile = path.resolve(process.env.BOT_STATE_PATH || 'bot-state.json');
const iso = () => new Date().toISOString();
const bounded = (v, lo, hi, d) => { const n = Number(v ?? d); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Value must be ${lo}–${hi}`); return n; };
function normalizeRule(r = {}) {
  return { ...r, id: r.id || crypto.randomUUID(), name: String(r.name || 'Rule').slice(0, 100), inputMint: new PublicKey(r.inputMint).toBase58(), outputMint: new PublicKey(r.outputMint).toBase58(), swapAmountUsd: bounded(r.swapAmountUsd, 0.25, 10, 0.5), intervalMin: bounded(r.intervalMin, 1, 1440, 3), mode: r.mode === 'interval' ? 'interval' : 'price', originalStartPrice: bounded(r.originalStartPrice, 0, 1e15, 0), triggerOffset: bounded(r.triggerOffset, 0, 1e15, 1), enabled: r.enabled === true, feePolicy: normalizeFeePolicy(r.feePolicy), busy: false };
}
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { rules: [], history: [], totals: { success: 0, failure: 0, feesSpent: 0 } }; }
state.rules = (state.rules || []).map(r => normalizeRule({ ...r, enabled: false }));
state.history ||= [];
state.totals ||= { success: 0, failure: 0, feesSpent: 0 };
state.feePolicy = normalizeFeePolicy(state.feePolicy);
function save() { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); }
function record(rule, status, extra = {}) { const item = { ts: iso(), ruleId: rule.id, ruleName: rule.name, inputMint: rule.inputMint, outputMint: rule.outputMint, status, ...extra }; state.history.unshift(item); state.history = state.history.slice(0, 10000); save(); return item; }
app.get('/api/health', (_req, res) => res.json({ ok: true, live: LIVE }));
app.use('/api', (req, res, next) => {
  if (!AUTH) return res.status(503).json({ error: 'Set API_AUTH_TOKEN in Railway variables first' });
  const incoming = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(AUTH);
  if (incoming.length !== expected.length || !crypto.timingSafeEqual(incoming, expected)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
app.use(express.static('public'));
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000), headers: { 'x-api-key': API_KEY, ...options.headers } });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.json();
}
async function price(mint) { const data = await json(`https://api.jup.ag/price/v3?ids=${mint}`); const p = Number(data[mint]?.usdPrice); if (!Number.isFinite(p) || p <= 0) throw new Error('Unknown USD price'); return p; }
async function decimals(mint) { if (mint === SOL) return 9; const data = await RPC.getParsedAccountInfo(new PublicKey(mint)); const d = data.value?.data?.parsed?.info?.decimals; if (!Number.isInteger(d)) throw new Error('Unknown mint decimals'); return d; }
async function balance(mint) {
  if (!owner) throw new Error('Set WALLET_PUBLIC_KEY');
  if (mint === SOL) return (await RPC.getBalance(new PublicKey(owner))) / 1e9;
  const data = await RPC.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  return data.value.reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.uiAmountString || 0), 0);
}
async function estimate(order) {
  const nonnegative = (v, label) => { if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) throw new Error(`Unknown ${label}; swap blocked`); return Number(v); };
  const inputUsd = nonnegative(order.inUsdValue, 'input value');
  const outputUsd = nonnegative(order.outUsdValue, 'output value');
  if (!inputUsd) throw new Error('Zero quote input value');
  let gasLamports = 0;
  let rentLamports = 0;
  for (const [amount, payer] of [['signatureFeeLamports', 'signatureFeePayer'], ['prioritizationFeeLamports', 'prioritizationFeePayer'], ['rentFeeLamports', 'rentFeePayer']]) {
    const n = nonnegative(order[amount], amount);
    if (n && typeof order[payer] !== 'string') throw new Error('Unknown fee payer; swap blocked');
    if (order[payer] === owner) { if (amount === 'rentFeeLamports') rentLamports += n; else gasLamports += n; }
  }
  const bps = nonnegative(order.feeBps, 'platform fee rate');
  let platformUsd = inputUsd * bps / 10000;
  if (order.platformFee?.amount !== undefined) {
    const raw = nonnegative(order.platformFee.amount, 'platform fee amount');
    if (raw) { const mint = order.platformFee.feeMint || order.feeMint; if (!mint) throw new Error('Unknown fee token'); platformUsd = Math.max(platformUsd, raw / 10 ** await decimals(mint) * await price(mint)); }
  }
  const solUsd = await price(SOL);
  const networkUsd = gasLamports / 1e9 * solUsd;
  const rentUsd = rentLamports / 1e9 * solUsd;
  const quoteLossUsd = Math.max(0, inputUsd - outputUsd);
  const tradingCostUsd = Math.max(platformUsd, quoteLossUsd);
  return { inputUsd, outputUsd, platformUsd, networkUsd, rentUsd, quoteLossUsd, estimatedCostUsd: tradingCostUsd + networkUsd + rentUsd, note: 'Conservative estimate includes account rent and quoted value loss/price impact. Not an exact itemization of every pool fee.' };
}
async function run(rule) {
  let detail = {};
  try {
    if (!API_KEY) throw new Error('Set JUP_API_KEY');
    const p = await price(rule.inputMint);
    if (rule.mode === 'price' && p < rule.originalStartPrice + rule.triggerOffset) return record(rule, 'skipped', { skipReason: 'Below fixed token-price trigger' });
    if (await balance(rule.inputMint) * p < rule.swapAmountUsd) return record(rule, 'skipped', { skipReason: 'Insufficient input balance' });
    const raw = Math.floor(rule.swapAmountUsd / p * 10 ** await decimals(rule.inputMint));
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error('Unsafe or zero token amount');
    const url = new URL('https://api.jup.ag/swap/v2/order');
    for (const [k, v] of Object.entries({ inputMint: rule.inputMint, outputMint: rule.outputMint, amount: String(raw), taker: owner, slippageBps: 100, maxSupportedTransactionVersion: '0' })) url.searchParams.set(k, v);
    const receivedAt = Date.now();
    const order = await json(url);
    if (!order.transaction || !order.requestId || order.errorCode || order.taker !== owner || order.inputMint !== rule.inputMint || order.outputMint !== rule.outputMint || order.inAmount !== String(raw)) throw new Error(order.errorMessage || 'Invalid swap order');
    const fees = await estimate(order);
    const feeCheck = evaluateFees(Math.min(rule.swapAmountUsd, fees.inputUsd), fees.estimatedCostUsd, rule.feePolicy);
    detail = { desiredUsd: rule.swapAmountUsd, amountIn: String(raw), fees, feeCheck };
    if (!feeCheck.allowed) return record(rule, 'skipped', { ...detail, skipReason: feeCheck.reason });
    if (Date.now() - receivedAt > 15000) return record(rule, 'skipped', { ...detail, skipReason: 'Quote stale; wait for next interval' });
    if (!LIVE) return record(rule, 'simulation', { ...detail, skipReason: 'Simulation only: not signed or broadcast' });
    if (!rule.enabled) return record(rule, 'skipped', { ...detail, skipReason: 'Stopped before signing' });
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (!required.some(k => k.toBase58() === owner)) throw new Error('Signer not required by transaction');
    tx.sign([wallet]);
    const signature = bs58.encode(tx.signatures[required.findIndex(k => k.toBase58() === owner)]);
    rule.pendingSignature = signature;
    record(rule, 'pending', { ...detail, signature, requestId: order.requestId });
    let result;
    try { result = await json('https://api.jup.ag/swap/v2/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: order.requestId, lastValidBlockHeight: order.lastValidBlockHeight }) }); }
    catch (error) { rule.enabled = false; return record(rule, 'unknown', { ...detail, signature, error: error.message, skipReason: 'Execution outcome uncertain. Rule paused; reconcile signature before restarting.' }); }
    if (result.status !== 'Success' || result.code !== 0) { rule.enabled = false; return record(rule, 'unknown', { ...detail, signature, execute: result, skipReason: 'Execution not confirmed successful; reconcile before restart' }); }
    delete rule.pendingSignature;
    state.totals.success += 1;
    return record(rule, 'success', { ...detail, execute: result, signature: result.signature || signature, actualFeesUsd: null, note: 'Estimated costs only; actual total fees have not been reconciled.' });
  } catch (error) { state.totals.failure += 1; rule.lastError = error.message; return record(rule, 'failure', { ...detail, error: error.message }); }
}
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try { for (const rule of state.rules) {
    if (!rule.enabled || rule.busy || rule.pendingSignature || Date.now() < Date.parse(rule.nextRunAt || '1970-01-01')) continue;
    rule.busy = true; rule.lastEvaluationAt = iso();
    try { await run(rule); } finally { rule.busy = false; rule.lastRunAt = iso(); rule.nextRunAt = new Date(Date.now() + rule.intervalMin * 60000).toISOString(); save(); }
  } } catch (e) { console.error('Worker error:', e.message); } finally { ticking = false; }
}
setInterval(tick, 15000);
app.get('/api/state', (_req, res) => res.json({ ...state, live: LIVE, walletPublicKey: owner }));
app.put('/api/fees', (req, res, next) => { try { const policy = normalizeFeePolicy(req.body); state.feePolicy = policy; for (const r of state.rules) r.feePolicy = { ...policy }; save(); res.json(policy); } catch (e) { next(e); } });
app.get('/api/wallet/tokens', async (_req, res, next) => { try {
  if (!owner) return res.json({ walletPublicKey: null, tokens: [] });
  const tokens = [];
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const data = await RPC.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(programId) });
    for (const a of data.value) { const info = a.account.data.parsed.info; const n = Number(info.tokenAmount.uiAmountString); if (n > 0) tokens.push({ mint: info.mint, balanceUi: n }); }
  }
  const native = await balance(SOL); if (native > 0) tokens.unshift({ mint: SOL, balanceUi: native });
  res.json({ walletPublicKey: owner, tokens });
} catch (e) { next(e); } });
app.post('/api/rules', (req, res, next) => { try { if (state.rules.length >= 20) throw new Error('Maximum 20 rules'); const r = normalizeRule({ ...req.body, id: crypto.randomUUID(), feePolicy: state.feePolicy, enabled: false, pendingSignature: null, mode: req.body.mode || 'interval' }); if (r.inputMint === r.outputMint) throw new Error('Choose different tokens'); state.rules.push(r); save(); res.json(r); } catch (e) { next(e); } });
app.put('/api/rules/:id', (req, res, next) => { try { const i = state.rules.findIndex(r => r.id === req.params.id); if (i < 0) return res.sendStatus(404); if (state.rules[i].busy || state.rules[i].pendingSignature) throw new Error('Rule busy or awaiting reconciliation'); const old = state.rules[i]; state.rules[i] = normalizeRule({ ...old, ...req.body, id: old.id, pendingSignature: old.pendingSignature, enabled: old.enabled, feePolicy: state.feePolicy }); save(); res.json(state.rules[i]); } catch (e) { next(e); } });
for (const action of ['start', 'stop']) app.post(`/api/rules/:id/${action}`, (req, res, next) => { try { const r = state.rules.find(v => v.id === req.params.id); if (!r) return res.sendStatus(404); if (action === 'start' && r.pendingSignature) throw new Error('Pending transaction must be reconciled before restarting'); r.enabled = action === 'start'; if (r.enabled) r.nextRunAt = iso(); save(); res.json(r); } catch (e) { next(e); } });
app.post('/api/stop', (_req, res) => { for (const r of state.rules) r.enabled = false; save(); res.json({ ok: true }); });
app.delete('/api/rules/:id', (req, res, next) => { try { const r = state.rules.find(v => v.id === req.params.id); if (!r) return res.sendStatus(404); if (r.busy || r.pendingSignature) throw new Error('Cannot delete busy or pending rule'); state.rules = state.rules.filter(v => v.id !== r.id); save(); res.json({ ok: true }); } catch (e) { next(e); } });
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));
app.listen(PORT, () => console.log(`Swap bot listening on ${PORT}; ${LIVE ? 'LIVE' : 'SIMULATION'}; all rules paused at startup`));
