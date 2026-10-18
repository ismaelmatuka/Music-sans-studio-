

/**
 * Music Sans Studio — backend starter (Node.js 20+)
 *
 * This starter intentionally does NOT pretend payments or music generation are live.
 * Configure a payment provider and fal.ai adapter before production.
 */

import { promisify } from "node:util";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import pg from "pg";
const app = express();
const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);

app.set("trust proxy", 1);
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;

  const [salt, keyHex] = storedHash.split(":");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, salt, 64);

  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

function readSessionCookie(req) {
  const cookies = req.headers.cookie || "";
  const entry = cookies.split(";").map(v => v.trim())
    .find(v => v.startsWith("mss_session="));

  return entry ? entry.slice("mss_session=".length) : null;
}

function setSessionCookie(res, token) {
  res.cookie("mss_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

async function getAuthenticatedUser(req) {
  const token = readSessionCookie(req);
  if (!token || !pool) return null;

  const tokenHash = crypto.createHash("sha256")
    .update(token).digest("hex");

  const result = await pool.query(
    `SELECT u.id, u.email, u.credits, u.referral_code
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Adresse email invalide." });
    }

    if (password.length < 12 || password.length > 128) {
      return res.status(400).json({
        error: "Le mot de passe doit contenir entre 12 et 128 caractères."
      });
    }

    const id = crypto.randomUUID();
    const referralCode = crypto.randomUUID().slice(0, 8);
    const passwordHash = await hashPassword(password);

    await pool.query(
      `INSERT INTO users
       (id, email, password_hash, credits, referral_code)
       VALUES ($1, $2, $3, 0, $4)`,
      [id, email, passwordHash, referralCode]
    );

    return res.status(201).json({
      ok: true,
      message: "Compte créé. Tu peux maintenant te connecter."
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Cette adresse email est déjà utilisée."
      });
    }

    console.error("Registration failed:", error.message);
    return res.status(500).json({ error: "Impossible de créer le compte." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM users WHERE LOWER(email) = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({
        error: "Email ou mot de passe incorrect."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256")
      .update(token).digest("hex");

    await pool.query(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [tokenHash, user.id]
    );

    setSessionCookie(res, token);
    return res.json({ ok: true, message: "Connexion réussie." });
  } catch (error) {
    console.error("Login failed:", error.message);
    return res.status(500).json({ error: "Connexion impossible." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = readSessionCookie(req);

    if (token) {
      const tokenHash = crypto.createHash("sha256")
        .update(token).digest("hex");

      await pool.query(
        "DELETE FROM user_sessions WHERE token_hash = $1",
        [tokenHash]
      );
    }

    res.clearCookie("mss_session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/"
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Logout failed:", error.message);
    return res.status(500).json({ error: "Déconnexion impossible." });
  }
});

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

app.get("/api/me", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({ error: "Non connecté." });
    }

    return res.json({
      id: user.id,
      email: user.email,
      credits: Number(user.credits),
      referralCode: user.referral_code
    });
  } catch (error) {
    console.error("Session check failed:", error.message);
    return res.status(500).json({ error: "Erreur de session." });
  }
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
  let reservedUserId = null;

  try {
    const {
      lyrics,
      idea,
      mode,
      style,
      mood,
      voiceMode
    } = req.body || {};

    // 1. Vérifier la session réelle, pas un userId envoyé par le navigateur.
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Connecte-toi avant de générer une chanson."
      });
    }

    // 2. Vérifier les données reçues.
    if (!["lyrics", "idea"].includes(mode)) {
      return res.status(400).json({
        error: "Choisis les paroles ou une idée de chanson."
      });
    }

    if (
      mode === "lyrics" &&
      !String(lyrics || "").trim()
    ) {
      return res.status(400).json({
        error: "Écris les paroles de ta chanson."
      });
    }

    if (
      mode === "idea" &&
      !String(idea || "").trim()
    ) {
      return res.status(400).json({
        error: "Décris ton idée de chanson."
      });
    }

    if (
      mode === "lyrics" &&
      String(lyrics).length > 5000
    ) {
      return res.status(400).json({
        error: "Les paroles ne doivent pas dépasser 5000 caractères."
      });
    }

    if (
      mode === "idea" &&
      String(idea).length > 2000
    ) {
      return res.status(400).json({
        error: "L'idée ne doit pas dépasser 2000 caractères."
      });
    }

    if (voiceMode === "own") {
      return res.status(400).json({
        error: "La voix personnelle n'est pas encore prise en charge."
      });
    }

    if (!process.env.FAL_KEY) {
      return res.status(503).json({
        error: "La clé fal.ai n'est pas configurée sur le serveur."
      });
    }

    // 3. Réserver un crédit dans PostgreSQL.
    // L'opération atomique empêche deux requêtes simultanées
    // de dépenser le même crédit.
    const reservation = await pool.query(
      `UPDATE users
       SET credits = credits - 1
       WHERE id = $1 AND credits >= 1
       RETURNING credits`,
      [user.id]
    );

    if (reservation.rowCount === 0) {
      return res.status(402).json({
        error: "Tu n'as pas assez de crédits. Achète un pack pour continuer."
      });
    }

    reservedUserId = user.id;

    // 4. Préparer la demande de génération.
    const musicDetails = [
      style ? `Style musical : ${style}` : "",
      mood ? `Ambiance : ${mood}` : ""
    ].filter(Boolean).join(". ");

    const input = {
      enable_safety_checker: true
    };

    if (mode === "lyrics") {
      input.lyrics = String(lyrics).trim();
      input.prompt = musicDetails ||
        "Create a polished original song with suitable instrumentation and vocals.";
    } else {
      input.prompt = [
        String(idea).trim(),
        musicDetails,
        "Create a complete original song with vocals."
      ].filter(Boolean).join(". ");
    }

    // 5. Appeler fal.ai.
    const result = await fal.subscribe(
      "mureka/api/generate/song",
      { input }
    );

    const song = result?.data;
    const audioUrl = song?.audio?.url;

    if (!audioUrl) {
      throw new Error("Le fournisseur n'a renvoyé aucune URL audio.");
    }

    // Le crédit est maintenant consommé : ne pas le rembourser.
    reservedUserId = null;

    return res.json({
      ok: true,
      songId: song.song_id || result.requestId,
      audioUrl,
      duration: song.duration || null,
      creditsRemaining: Number(reservation.rows[0].credits),
      message: "Ta chanson a été générée."
    });

  } catch (error) {
    console.error("Music generation failed:", error.message);

    // 6. Rembourser le crédit réservé si la génération échoue.
    if (reservedUserId) {
      try {
        await pool.query(
          "UPDATE users SET credits = credits + 1 WHERE id = $1",
          [reservedUserId]
        );
      } catch (refundError) {
        console.error(
          "CRITICAL: credit refund failed:",
          refundError.message
        );
      }
    }

    return res.status(502).json({
      error: "La génération a échoué. Si le problème persiste, vérifie les logs Render."
    });
  }
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

await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT
`);

await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT
`);

await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (LOWER(email))
  WHERE email IS NOT NULL
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
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

