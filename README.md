# SWAPBOT (Simple Production Starter)

A simpler live Jupiter trading bot for Solana mainnet with Postgres persistence and protected API controls.

## What this version includes

- ✅ Live Jupiter execution (quote + swap + sign + send + confirm)
- ✅ Wallet from base58 private key in `.env`
- ✅ Multi-pair configs with per-pair intervals/amounts
- ✅ Global + pair start/stop
- ✅ Postgres persistence (`pairs`, `trades`)
- ✅ Basic performance dashboard metrics
- ✅ Bearer token protection + rate limit
- ✅ Railway-ready (`PORT`, health endpoint `/`)

## What is intentionally simplified

- No circuit breaker yet
- No advanced token portfolio endpoint (tokens endpoint currently returns SOL balance)
- No complex service layering

---

## 1) Setup

```bash
cp .env.example .env
# edit .env
npm install
npm run migrate
npm start
```

---

## 2) Required env vars

- `PORT`
- `API_AUTH_TOKEN`
- `DATABASE_URL`
- `SOLANA_RPC_URL`
- `SOLANA_COMMITMENT`
- `WALLET_PRIVATE_KEY_BASE58`
- `JUPITER_QUOTE_URL`
- `JUPITER_SWAP_URL`
- `DEFAULT_SLIPPAGE_BPS`
- `MAX_RETRIES`
- `RETRY_BASE_MS`
- `MAX_CONCURRENT_TRADES`

---

## 3) Endpoints (all except `/` require Bearer token)

Header:
```http
Authorization: Bearer <API_AUTH_TOKEN>
```

### Health
```bash
curl http://localhost:3000/
```

### Create pair
```bash
curl -X POST http://localhost:3000/pairs \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "inputMint":"So11111111111111111111111111111111111111112",
    "outputMint":"Es9vMFrzaCERmJfrF4H2qxdjQbaVkj2rN6zGyFNR7fsR",
    "inputPriceId":"solana",
    "outputPriceId":"tether",
    "intervalMinutes":5,
    "usdAmount":0.25,
    "minPrice":1,
    "enabled":true,
    "running":false
  }'
```

### List pairs
```bash
curl http://localhost:3000/pairs -H "Authorization: Bearer $API_AUTH_TOKEN"
```

### Update pair
```bash
curl -X PATCH http://localhost:3000/pairs/<PAIR_ID> \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"intervalMinutes":10,"usdAmount":1}'
```

### Delete pair
```bash
curl -X DELETE http://localhost:3000/pairs/<PAIR_ID> \
  -H "Authorization: Bearer $API_AUTH_TOKEN"
```

### Start global
```bash
curl -X POST http://localhost:3000/start \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"global":true}'
```

### Start one pair
```bash
curl -X POST http://localhost:3000/start \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pairId":"<PAIR_ID>"}'
```

### Stop global
```bash
curl -X POST http://localhost:3000/stop \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"global":true}'
```

### Stop one pair
```bash
curl -X POST http://localhost:3000/stop \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pairId":"<PAIR_ID>"}'
```

### Status
```bash
curl http://localhost:3000/status -H "Authorization: Bearer $API_AUTH_TOKEN"
```

### Performance dashboard
Scales: `3m,5m,15m,30m,1h,4h,8h,12h,all`
```bash
curl "http://localhost:3000/dashboard/performance?scale=1h" \
  -H "Authorization: Bearer $API_AUTH_TOKEN"
```

### Tokens (simple)
```bash
curl http://localhost:3000/dashboard/tokens \
  -H "Authorization: Bearer $API_AUTH_TOKEN"
```

---

## 4) Trading condition logic

Trade only runs when:
1. current token A price >= `minPrice` (default 1)
2. current token A price > `entryPrice`

If `entryPrice` is empty, bot sets it from current price first.

---

## 5) Railway deploy

1. Push code to `MARIYE1988/JUPITER-BOT`
2. Create Railway project + Postgres
3. Set all env vars
4. Deploy
5. Run `npm run migrate`
6. Check `GET /`
7. Create pair and start small (`usdAmount=0.25`)
