/**
 * Music Sans Studio — backend starter (Node.js 20+)
 *
 * This starter intentionally does NOT pretend payments or music generation are live.
 * Configure a payment provider and fal.ai adapter before production.
 */
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import pg from "pg";
const app = express();
const { Pool } = pg;
import { fal } from "@fal-ai/client";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;
const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:3000";

app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, limit: 90 }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PACKS = {
  "pack-2":  { songs: 2,  priceCents: 600 },
  "pack-4":  { songs: 4,  priceCents: 1000 },
  "pack-7":  { songs: 7,  priceCents: 1500 },
  "pack-14": { songs: 14, priceCents: 2500 },
};

// Demo in-memory store only. Replace with a transactional database before deployment.
const users = new Map();
const payments = new Map();
const generations = new Map();
const referrals = new Map();

function getUser(userId) {
  if (!userId) throw Object.assign(new Error("userId required"), { status: 400 });
  if (!users.has(userId)) users.set(userId, { id: userId, credits: 0, referralCode: crypto.randomUUID().slice(0, 8), referredBy: null });
  return users.get(userId);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

app.get("/api/health", async (_req, res) => {
try {
if (!pool) {
return res.status(503).json({
ok: false,
database: "DATABASE_URL missing"
});
}
await pool.query("SELECT NOW()");

res.json({
  ok: true,
  service: "music-sans-studio",
  database: "connected"
});
} catch (error) {
console.error("Database health check failed:", error.message);
res.status(503).json({
ok: false,
database: "disconnected"
});
}
});

// A signed-in user should be identified by a verified auth session, never by a client-supplied ID.
// This header is only a local-development placeholder; replace with verified Firebase/Supabase/Auth.js session.
app.get("/api/me", (req, res) => {
  const user = getUser(req.header("x-demo-user"));
  res.json({ id: user.id, credits: user.credits, referralCode: user.referralCode });
});

app.post("/api/referrals/attach", (req, res) => {
  const { userId, referralCode } = req.body || {};
  if (!userId || !referralCode) return res.status(400).json({ error: "userId and referralCode required" });
  const user = getUser(userId);
  if (user.referralCode === referralCode) return res.status(400).json({ error: "Self-referral is not allowed" });
  const referrer = [...users.values()].find(u => u.referralCode === referralCode);
  if (!referrer) return res.status(404).json({ error: "Referral code not found" });
  if (user.referredBy) return res.status(409).json({ error: "Referral already attached" });
  user.referredBy = referrer.id;
  res.json({ ok: true });
});

// Payment intent creation must be implemented with the selected payment provider.
// Never accept a client-side "payment successful" flag as proof of payment.
app.post("/api/checkout", (req, res) => {
  const { userId, packId, provider } = req.body || {};
  if (!PACKS[packId]) return res.status(400).json({ error: "Unknown pack" });
  if (!["stripe", "paypal", "crypto"].includes(provider)) return res.status(400).json({ error: "Unsupported provider" });
  if (!process.env.PAYMENTS_ENABLED || process.env.PAYMENTS_ENABLED !== "true") {
    return res.status(501).json({
      error: "Payments are not configured yet.",
      next: "Connect Stripe/PayPal/crypto provider and verify webhooks before enabling checkout.",
      pack: PACKS[packId]
    });
  }
  // TODO: Create provider checkout session on server and persist provider reference.
  res.status(501).json({ error: "Payment provider adapter must be implemented before enabling live payments." });
});

// Provider-specific webhook routes must verify each provider's signature using its official SDK.
// This generic route is deliberately disabled rather than insecurely minting credits.
app.post("/api/webhooks/:provider", (req, res) => {
  res.status(501).json({ error: "Webhook verification is not configured. No credits were added." });
});

// Each successful generation must atomically deduct exactly 1 credit before calling the model.
// Half credits are supported for affiliate rewards, but a generation requires >= 1 full credit.
app.post("/api/generations", async (req, res) => {
  const { userId, lyrics, idea, mode, style, mood, voiceMode } = req.body || {};
  if (!userId || !["lyrics", "idea"].includes(mode) || !["ai", "own"].includes(voiceMode)) {
    return res.status(400).json({ error: "Invalid generation request" });
  }
  if (mode === "lyrics" && !String(lyrics || "").trim()) return res.status(400).json({ error: "Lyrics required" });
  if (mode === "idea" && !String(idea || "").trim()) return res.status(400).json({ error: "Idea required" });

  const user = getUser(userId);
  if (user.credits < 1) return res.status(402).json({ error: "Not enough credits", credits: user.credits });
  if (!process.env.FAL_KEY) return res.status(503).json({ error: "Music model is not configured yet; no credit was consumed." });

  // TODO: Validate model-specific payload and consent for uploaded/voice-cloned audio.
  // TODO: Use a DB transaction/ledger to reserve 1 credit idempotently before calling fal.ai.
  // TODO: Call fal.ai from the server only. Never expose FAL_KEY to browser code.
  // TODO: On provider failure, refund the reserved credit; on success, store audio URL and provider job ID.
  res.status(501).json({ error: "fal.ai model adapter is not configured; no credit was consumed." });
});

app.get("/api/config", (_req, res) => {
  res.json({
    packs: Object.entries(PACKS).map(([id, p]) => ({ id, songs: p.songs, priceUSD: p.priceCents / 100 })),
    creditRule: "1 generated song = 1 credit",
    affiliateRewards: { "600": 0.5, "1000": 1, "1500": 2, "2500": 3 },
    generationCostTarget: 0.15,
    appOrigin: APP_ORIGIN,
    liveFeaturesEnabled: false
  });
});

async function initDb() {
if (!pool) {
throw new Error("DATABASE_URL is not configured");
}

await pool.query(`     CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      credits NUMERIC(10,2) NOT NULL DEFAULT 0,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

console.log("PostgreSQL users table is ready");
}

initDb()
.then(() => {
app.listen(PORT, () => {
console.log(`Music Sans Studio running on port ${PORT}`);
});
})
.catch((error) => {
console.error("Database initialization failed:", error.message);
process.exit(1);
});

