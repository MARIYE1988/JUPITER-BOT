# Fee-control revision: simulation first

No Jupiter DCA is used. This service uses Jupiter Swap API V2 order/execute.

## Fee policy
- Dashboard percentage slider: 0–50%, default 50%. The original 50% protection cannot be disabled or raised.
- Optional stricter USD ceiling: off by default, editable default $0.05. When enabled, the smaller of percentage limit and USD ceiling wins.
- Settings apply to all rules. Unknown fee components or prices block execution.
- Estimated cost includes wallet-paid network fees/tips and estimated rent, plus the greater of platform-fee valuation and quoted input/output USD value loss. This is deliberately conservative and can reject a trade because of price impact. Pool fees are not individually reconciled.
- This is an estimate-based pre-signing gate, not a guarantee about final execution costs. History labels estimates. Actual total fee reconciliation and performance graphs remain follow-up work.

## Next step after commit
1. In Railway, deploy the main branch of MARIYE1988/JUPITER-BOT. Check npm test and npm run check in a Node 22+ environment before deployment; tests were supplied, not executed by the assistant.
2. Set API_AUTH_TOKEN to a long random secret, LIVE_TRADING=false, JUP_API_KEY, SOLANA_RPC_URL, and WALLET_PUBLIC_KEY. Never put signing secrets in GitHub or chat. Simulation does not require a private key.
3. Mount a persistent volume at /data and set BOT_STATE_PATH=/data/bot-state.json. To preserve existing bot-state.json, migrate it to that path before changing the setting. DATABASE_URL is not used by this revision.
4. Open the Railway HTTPS app URL. Enter API_AUTH_TOKEN in Dashboard access, connect, adjust fees, save limits, create a paused rule and start it in simulation. Simulation uses live quotes and wallet balances but does not sign or broadcast.
5. Verify permitted and rejected fee cases in history. All rules pause on every process startup. Up to 20 rules, $0.25–$10 per swap, and 1–1440 minute intervals are supported.
6. Before any live funds: audit the revised implementation and complete transaction-level validation/fee reconciliation. Only then configure a dedicated low-balance signer privately and deliberately set LIVE_TRADING=true. Do not use a primary holdings wallet.

## Compatibility and limitations
The old server, package file and dashboard are replaced. Existing rule IDs, settings and history are read from bot-state.json, but every rule is paused at startup; old rules retain fixed token-price-trigger behavior. New rules default to interval mode. Legacy attempt-window and balance-threshold options are not implemented in this revised worker. API_AUTH_TOKEN is now required for every control/read API except health. public/app.js and other older files remain in the repository but are no longer loaded by the dashboard. MetaMask connection, full historical charts, deposit-adjusted P&L, daily budgets, automatic reconciliation of uncertain transactions, independent security review and live integration tests are not completed by this revision.

An execution timeout or unconfirmed result pauses its rule with a pending signature. Do not clear pendingSignature or retry until the on-chain outcome is independently reconciled. Stop prevents new submissions but cannot cancel already submitted transactions. Use one Railway replica; the file store is not a distributed lock. Avoid redeploying while a transaction is pending.
