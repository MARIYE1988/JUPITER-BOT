# Jupiter Swap Bot

A Railway-ready Node.js bot for managing up to 10 independent Jupiter swap rules with a dashboard, transaction history, and per-rule start/stop controls.

## Features
- Up to 10 rules per wallet
- Per-rule start and stop buttons
- Swap amount range: $0.25 to $10.00, default $0.50
- Interval range: 1 to 59 minutes, default 3 minutes
- Uses Jupiter `/order` -> sign -> `/execute` flow
- Logs success, failure, fee estimates, and execution results

## Setup
1. Copy `.env.example` to `.env`.
2. Fill in your wallet address, base58 private key, RPC URL, and Jupiter API key.
3. Run `npm install`.
4. Run `npm start`.

## Railway
Railway will detect Node.js, install dependencies, and run `npm start`. The app listens on `process.env.PORT` and serves the dashboard from `public/`.
