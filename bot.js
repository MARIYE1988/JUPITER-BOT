const axios = require('axios');
const { pool } = require('./db');
const { executeJupiterSwap } = require('./jupiter');

const timers = new Map();
let globalRunning = false;

// Concurrency queue controls
const MAX_CONCURRENT_TRADES = Number(process.env.MAX_CONCURRENT_TRADES || 3);
let activeTrades = 0;
const pendingQueue = []; // { connection, pairId }

async function getUsdPrice(priceId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(priceId)}&vs_currencies=usd`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const val = data?.[priceId]?.usd;
  if (!val) throw new Error(`Price unavailable for ${priceId}`);
  return Number(val);
}

async function runPair(connection, pairId) {
  const { rows } = await pool.query('SELECT * FROM pairs WHERE id = $1', [pairId]);
  const pair = rows[0];
  if (!pair || !pair.running || !pair.enabled) return;

  try {
    const currentPrice = await getUsdPrice(pair.input_price_id);

    if (!pair.entry_price) {
      await pool.query(
        'UPDATE pairs SET entry_price = $1, updated_at = NOW() WHERE id = $2',
        [currentPrice, pair.id]
      );
      return;
    }

    if (!(currentPrice >= Number(pair.min_price) && currentPrice > Number(pair.entry_price))) {
      return;
    }

    const tokenQty = Number(pair.usd_amount) / currentPrice;
    const amountAtomic = Math.floor(tokenQty * 1_000_000);

    const { signature, quote } = await executeJupiterSwap({
      connection,
      inputMint: pair.input_mint,
      outputMint: pair.output_mint,
      amountAtomic,
      slippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || 100)
    });

    const outputUsd = Number(quote?.outAmount || 0) * currentPrice / 1_000_000;
    const earned = outputUsd - Number(pair.usd_amount);

    await pool.query(
      `INSERT INTO trades
       (pair_id, status, tx_signature, input_amount_usd, output_amount_usd, realized_earned_usd, slippage_bps, quote_json)
       VALUES ($1, 'success', $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        pair.id,
        signature,
        pair.usd_amount,
        outputUsd,
        earned,
        Number(process.env.DEFAULT_SLIPPAGE_BPS || 100),
        JSON.stringify(quote)
      ]
    );
  } catch (e) {
    await pool.query(
      `INSERT INTO trades (pair_id, status, error_message) VALUES ($1, 'failed', $2)`,
      [pairId, e.message]
    );
  }
}

function enqueueTrade(connection, pairId) {
  pendingQueue.push({ connection, pairId });
  drainQueue();
}

function drainQueue() {
  while (activeTrades < MAX_CONCURRENT_TRADES && pendingQueue.length > 0) {
    const job = pendingQueue.shift();
    activeTrades += 1;

    runPair(job.connection, job.pairId)
      .catch(() => {})
      .finally(() => {
        activeTrades -= 1;
        drainQueue();
      });
  }
}

function startPairTimer(connection, pair) {
  stopPairTimer(pair.id);
  const intervalMs = Number(pair.interval_minutes) * 60 * 1000;
  const timer = setInterval(() => enqueueTrade(connection, pair.id), intervalMs);
  timers.set(pair.id, timer);
}

function stopPairTimer(pairId) {
  const t = timers.get(pairId);
  if (t) clearInterval(t);
  timers.delete(pairId);
}

async function recoverRunningPairs(connection) {
  const { rows } = await pool.query('SELECT * FROM pairs WHERE running = true AND enabled = true');
  rows.forEach((p) => startPairTimer(connection, p));
}

async function startGlobal(connection) {
  globalRunning = true;
  const { rows } = await pool.query('SELECT * FROM pairs WHERE enabled = true');

  for (const p of rows) {
    await pool.query('UPDATE pairs SET running = true, updated_at = NOW() WHERE id = $1', [p.id]);
    startPairTimer(connection, { ...p, running: true });
  }
}

async function stopGlobal() {
  globalRunning = false;
  const { rows } = await pool.query('SELECT id FROM pairs');

  for (const r of rows) {
    await pool.query('UPDATE pairs SET running = false, updated_at = NOW() WHERE id = $1', [r.id]);
    stopPairTimer(r.id);
  }
}

function getState() {
  return {
    globalRunning,
    activePairIds: [...timers.keys()],
    maxConcurrentTrades: MAX_CONCURRENT_TRADES,
    activeTrades,
    queuedTrades: pendingQueue.length
  };
}

module.exports = {
  runPair,
  enqueueTrade,
  startPairTimer,
  stopPairTimer,
  recoverRunningPairs,
  startGlobal,
  stopGlobal,
  getState
};
