# Music Sans Studio — prototype + backend starter

## Included
- `public/index.html`: French responsive interface, song composer mockup, price packs, login mockup and affiliate rewards.
- `server.js`: Node.js API skeleton with credit rules and disabled-by-default payment/generation endpoints.
- `package.json`: backend dependencies.

## Business rules encoded
- 2 songs: $6
- 4 songs: $10
- 7 songs: $15
- 14 songs: $25
- 1 generated song consumes 1 credit.
- Affiliate reward after a confirmed referred purchase: $6 pack = 0.5 credit; $10 = 1 credit; $15 = 2 credits; $25 = 3 credits.
- fal.ai generation spend target: 15% of generation cost budget. This is an internal budget target, not a fee charged by fal.ai.
- Half-credit balances are supported; generation requires at least 1 full credit.

## Run locally
1. Install Node.js 20 or later.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and keep real secrets private.
4. Run `npm run dev`.
5. Open `http://localhost:3000`.

## Important production work remaining
This is a starter, not a production-ready paid service. Do not accept real payments or launch publicly until these are implemented:
1. Authentication with verified server sessions (email/password, Google, Apple), password reset, account deletion and abuse controls.
2. Persistent database (e.g. PostgreSQL) and a transactional, append-only credit ledger. The in-memory store resets on restart and is only a demo.
3. Official payment-provider adapters for card wallets, PayPal and crypto; webhook signature verification; idempotency; refunds, disputes and payment reconciliation. Credits must be added only from verified server-side provider events.
4. fal.ai model adapter using a currently available model's documented input/output schema, job polling/webhooks, audio storage and cleanup. Keep the API key on the server.
5. Voice upload security, explicit consent and rights checks for voice cloning, file size/type limits and deletion controls.
6. Affiliate fraud prevention, self-referral prevention, attribution windows, reversals after refunds/chargebacks, and terms describing the rewards.
7. Legal pages, privacy policy, terms, copyright policy, moderation, taxes, pricing/currency disclosure, monitoring, backups and deployment HTTPS.

## API endpoints currently available
- `GET /api/health`
- `GET /api/config`
- `GET /api/me` (demo header only; not real authentication)
- `POST /api/referrals/attach` (demo in-memory store)
- `POST /api/checkout` (returns 501 until payment provider is implemented)
- `POST /api/webhooks/:provider` (disabled until signature verification is implemented)
- `POST /api/generations` (disabled until fal.ai adapter is implemented)

Never treat a browser redirect or a client-submitted success flag as payment proof. Provider webhooks must be verified server-side.
