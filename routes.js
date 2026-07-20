const express = require('express');
const { z } = require('zod');
const { pool } = require('./db');
const { startPairTimer, stopPairTimer, startGlobal, stopGlobal, getState } = require('./bot');

function createRouter(connection) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const version = await connection.getVersion();
      res.json({ status: 'ok', db: 'ok', solana: 'ok', solanaVersion: version['solana-core'] });
    } catch (e) {
      res.status(500).json({ status: 'error', error: e.message });
    }
  });

  const pairSchema = z.object({
    inputMint: z.string().min(32),
    outputMint: z.string().min(32),
    inputPriceId: z.string().min(1),
    outputPriceId: z.string().min(1),
    intervalMinutes: z.number().int().positive(),
    usdAmount: z.number().positive(),
    minPrice: z.number().positive().default(1),
    enabled: z.boolean().default(true),
    running: z.boolean().default(false)
  });

  router.post('/pairs', async (req, res) => {
    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const p = parsed.data;
    const q = `
      INSERT INTO pairs
      (input_mint, output_mint, input_price_id, output_price_id, interval_minutes, usd_amount, min_price, enabled, running)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`;
    const vals = [
      p.inputMint, p.outputMint, p.inputPriceId, p.outputPriceId,
      p.intervalMinutes, p.usdAmount, p.minPrice, p.enabled, p.running
    ];
    const { rows } = await pool.query(q, vals);
    res.json(rows[0]);
  });

  router.get('/pairs', async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM pairs ORDER BY created_at DESC');
    res.json(rows);
  });

  router.patch('/pairs/:id', async (req, res) => {
    const id = req.params.id;
    const allowed = [
      'interval_minutes','usd_amount','min_price',
      'enabled','running','input_price_id','output_price_id',
      'input_mint','output_mint','entry_price'
    ];

    const updates = [];
    const values = [];
    let i = 1;

    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.includes(k)) continue;
      updates.push(`${k} = $${i++}`);
      values.push(v);
    }

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(id);
    const sql = `UPDATE pairs SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`;
    const { rows } = await pool.query(sql, values);

    if (!rows[0]) return res.status(404).json({ error: 'Pair not found' });

    if (rows[0].running && rows[0].enabled) startPairTimer(connection, rows[0]);
    else stopPairTimer(rows[0].id);

    res.json(rows[0]);
  });

  router.delete('/pairs/:id', async (req, res) => {
    const id = req.params.id;
    stopPairTimer(id);
    const { rowCount } = await pool.query('DELETE FROM pairs WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Pair not found' });
    res.json({ ok: true });
  });

  router.post('/start', async (req, res) => {
    const { pairId, global } = req.body || {};

    if (global) {
      await startGlobal(connection);
      return res.json({ ok: true, mode: 'global' });
    }

    if (!pairId) return res.status(400).json({ error: 'pairId required (or global=true)' });

    const { rows } = await pool.query('SELECT * FROM pairs WHERE id = $1', [pairId]);
    const pair = rows[0];
    if (!pair) return res.status(404).json({ error: 'Pair not found' });

    await pool.query('UPDATE pairs SET running = true, updated_at = NOW() WHERE id = $1', [pairId]);
    startPairTimer(connection, { ...pair, running: true });
    res.json({ ok: true, pairId });
  });

  router.post('/stop', async (req, res) => {
    const { pairId, global } = req.body || {};

    if (global) {
      await stopGlobal();
      return res.json({ ok: true, mode: 'global' });
    }

    if (!pairId) return res.status(400).json({ error: 'pairId required (or global=true)' });

    await pool.query('UPDATE pairs SET running = false, updated_at = NOW() WHERE id = $1', [pairId]);
    stopPairTimer(pairId);
    res.json({ ok: true, pairId });
  });

  router.get('/status', (_req, res) => {
    res.json(getState());
  });

  router.get('/dashboard/performance', async (req, res) => {
    const scale = String(req.query.scale || '1h');

    const map = {
      '3m': `NOW() - INTERVAL '3 minutes'`,
      '5m': `NOW() - INTERVAL '5 minutes'`,
      '15m': `NOW() - INTERVAL '15 minutes'`,
      '30m': `NOW() - INTERVAL '30 minutes'`,
      '1h': `NOW() - INTERVAL '1 hour'`,
      '4h': `NOW() - INTERVAL '4 hours'`,
      '8h': `NOW() - INTERVAL '8 hours'`,
      '12h': `NOW() - INTERVAL '12 hours'`,
      'all': null
    };

    if (!(scale in map)) return res.status(400).json({ error: 'Invalid scale' });

    const where = map[scale] ? `WHERE created_at >= ${map[scale]}` : '';

    const statsSql = `
      SELECT
        COUNT(*)::int AS total_trades,
        COUNT(*) FILTER (WHERE status='success')::int AS successful_trades,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed_trades,
        COALESCE(SUM(realized_earned_usd),0)::float AS total_earned_usd
      FROM trades
      ${where}
    `;

    const recentSql = `
      SELECT id, pair_id, status, tx_signature, input_amount_usd, output_amount_usd, realized_earned_usd, error_message, created_at
      FROM trades
      ${where}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const [{ rows: statsRows }, { rows: recentRows }] = await Promise.all([
      pool.query(statsSql),
      pool.query(recentSql)
    ]);

    const s = statsRows[0];
    const successRate = s.total_trades > 0
      ? (s.successful_trades / s.total_trades) * 100
      : 0;

    res.json({
      scale,
      totalTrades: s.total_trades,
      successfulTrades: s.successful_trades,
      failedTrades: s.failed_trades,
      successRate: Number(successRate.toFixed(2)),
      totalEarnedUsd: Number(s.total_earned_usd.toFixed(8)),
      recentTrades: recentRows
    });
  });

  router.get('/dashboard/tokens', async (_req, res) => {
    try {
      const lamports = await connection.getBalance(connection.rpcEndpoint ? undefined : undefined);
      res.json({
        note: 'Starter endpoint. Replace with SPL token account aggregation.',
        solEstimated: lamports / 1e9
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createRouter };
