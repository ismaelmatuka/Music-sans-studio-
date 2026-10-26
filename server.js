

/**
 * Music Sans Studio — backend starter (Node.js 20+)
 *
 * This starter intentionally does NOT pretend payments or music generation are live.
 * Configure a payment provider and fal.ai adapter before production.
 */
import multer from "multer";
import { promisify } from "node:util";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import pg from "pg";
import { fal } from "@fal-ai/client";
const app = express();
const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);
if (process.env.FAL_KEY) {
  fal.config({
    credentials: process.env.FAL_KEY
  });
}
app.set("trust proxy", 1);
import path from "node:path";
import { fileURLToPath } from "node:url";
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/mp3"
    ];

    if (allowed.includes(file.mimetype)) {
      return callback(null, true);
    }

    return callback(
      new Error("Utilise un fichier audio MP3 ou M4A.")
    );
  }
});
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
    `SELECT u.id, u.email, u.credits, u.referral_code, u.vocal_id
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

app.post(
  "/api/voice/clone",
  voiceUpload.single("file"),
  async (req, res) => {
    try {
      const user = await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          error: "Connecte-toi avant d'enregistrer ta voix."
        });
      }

      if (!process.env.MUREKA_API_KEY) {
        return res.status(503).json({
          error: "La clé Mureka n'est pas configurée."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Choisis un fichier audio MP3 ou M4A."
        });
      }

      const form = new FormData();

      form.append(
        "file",
        new Blob([req.file.buffer], {
          type: req.file.mimetype
        }),
        req.file.originalname
      );

      const response = await fetch(
        "https://api.mureka.ai/v1/song/vocal-clone",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${process.env.MUREKA_API_KEY}`
          },
          body: form
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error("Mureka vocal clone error:", data);

        return res.status(502).json({
          error: "Mureka n'a pas pu enregistrer cette voix."
        });
      }

      const vocalId = data.vocal_id || data.id;

      if (!vocalId) {
        console.error("Mureka response missing vocal ID:", data);

        return res.status(502).json({
          error: "Mureka n'a pas renvoyé d'identifiant vocal."
        });
      }

      await pool.query(
        `UPDATE users
         SET vocal_id = $1
         WHERE id = $2`,
        [vocalId, user.id]
      );

      return res.json({
        ok: true,
        message: "Ta voix a été enregistrée.",
      });
    } catch (error) {
      console.error("Voice clone failed:", error.message);

      return res.status(500).json({
        error: "Impossible d'enregistrer ta voix pour le moment."
      });
    }
  }
);
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


app.post("/api/checkout", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ error: "Connecte-toi avant d'acheter." });
    }

    const { packId, provider } = req.body || {};

    if (provider !== "crypto") {
      return res.status(400).json({
        error: "Cette route accepte uniquement les paiements crypto NOWPayments."
      });
    }

    const pack = PACKS[packId];
    if (!pack) {
      return res.status(400).json({ error: "Pack invalide." });
    }

    if (process.env.PAYMENTS_ENABLED !== "true") {
      return res.status(503).json({
        error: "Les paiements restent désactivés pendant la configuration."
      });
    }

    if (
      !process.env.NOWPAYMENTS_API_KEY ||
      !process.env.NOWPAYMENTS_IPN_SECRET ||
      !APP_ORIGIN.startsWith("https://")
    ) {
      return res.status(503).json({
        error: "La configuration NOWPayments est incomplète."
      });
    }

    const orderId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO payments
       (id, user_id, pack_id, amount_cents, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [orderId, user.id, packId, pack.priceCents]
    );

    try {
      const response = await fetch("https://api.nowpayments.io/v1/invoice", {
        method: "POST",
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          price_amount: pack.priceCents / 100,
          price_currency: "usd",
          order_id: orderId,
          order_description: `Music Sans Studio - ${pack.songs} chansons`,
          ipn_callback_url: `${APP_ORIGIN}/api/webhooks/nowpayments`,
          success_url: `${APP_ORIGIN}/?payment=success`,
          cancel_url: `${APP_ORIGIN}/?payment=cancelled`
        })
      });

      const invoice = await response.json();

      if (!response.ok || !invoice.invoice_url || !invoice.id) {
        throw new Error("NOWPayments n'a pas créé la facture.");
      }

      await pool.query(
        `UPDATE payments
         SET provider_payment_id = $1, invoice_url = $2
         WHERE id = $3`,
        [String(invoice.id), invoice.invoice_url, orderId]
      );

      return res.json({
        ok: true,
        orderId,
        invoiceUrl: invoice.invoice_url,
        checkoutUrl: invoice.invoice_url
      });
    } catch (error) {
      await pool.query(
        `UPDATE payments SET status = 'creation_failed' WHERE id = $1`,
        [orderId]
      );
      throw error;
    }
  } catch (error) {
    console.error("NOWPayments checkout failed:", error.message);
    return res.status(502).json({
      error: "Impossible de créer la facture. Réessaie plus tard."
    });
  }
});


function sortIpnObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortIpnObject);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortIpnObject(value[key]);
        return sorted;
      }, {});
  }

  return value;
}

app.post("/api/webhooks/nowpayments", async (req, res) => {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  const receivedSignature = req.get("x-nowpayments-sig");

  if (!secret || !receivedSignature || !req.body) {
    return res.status(401).json({ error: "Notification non authentifiée." });
  }

  const canonicalBody = JSON.stringify(sortIpnObject(req.body));
  const expectedSignature = crypto
    .createHmac("sha512", secret)
    .update(canonicalBody)
    .digest("hex");

  const received = Buffer.from(receivedSignature.toLowerCase(), "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({ error: "Signature invalide." });
  }

  const { order_id, payment_status, price_amount, price_currency } = req.body;

  if (!order_id || !payment_status) {
    return res.status(400).json({ error: "Données de paiement incomplètes." });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, user_id, pack_id, amount_cents, status, credited_at
       FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [String(order_id)]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Commande inconnue." });
    }

    const payment = result.rows[0];

    // Déjà crédité : répondre OK sans ajouter de crédits une seconde fois.
    if (payment.credited_at) {
      await client.query("COMMIT");
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    // Ne créditer que les paiements réellement terminés.
    if (payment_status !== "finished") {
      await client.query(
        `UPDATE payments SET status = $1 WHERE id = $2`,
        [String(payment_status).slice(0, 50), payment.id]
      );
      await client.query("COMMIT");
      return res.status(200).json({ ok: true, status: payment_status });
    }

    const pack = PACKS[payment.pack_id];
    const paidCents = Math.round(Number(price_amount) * 100);

    if (
      !pack ||
      !Number.isFinite(paidCents) ||
      paidCents !== Number(payment.amount_cents) ||
      String(price_currency).toLowerCase() !== "usd"
    ) {
      await client.query("ROLLBACK");
      console.error("NOWPayments amount or currency mismatch:", order_id);
      return res.status(400).json({ error: "Montant ou devise incorrect." });
    }

    const creditResult = await client.query(
      `UPDATE users
       SET credits = credits + $1
       WHERE id = $2
       RETURNING credits`,
      [pack.songs, payment.user_id]
    );

    if (creditResult.rowCount !== 1) {
      throw new Error("Utilisateur du paiement introuvable.");
    }

    await client.query(
      `UPDATE payments
       SET status = 'finished', credited_at = NOW()
       WHERE id = $1`,
      [payment.id]
    );

    await client.query("COMMIT");

    console.log("NOWPayments credits added:", payment.id);

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error("NOWPayments webhook failed:", error.message);
    return res.status(500).json({ error: "Erreur de traitement du paiement." });
  } finally {
    client?.release();
  }
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

    if (voiceMode !== "ai" && voiceMode !== "own") {
  return res.status(400).json({
    error: "Choisis une voix IA ou ta voix personnelle."
  });
}

if (voiceMode === "own" && !user.vocal_id) {
  return res.status(400).json({
    error: "Enregistre d'abord ta voix avant de générer une chanson."
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
  model: "mureka-9",
  enable_safety_checker: true
};

if (voiceMode === "own") {
  input.vocal_id = user.vocal_id;
}

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
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vocal_id TEXT
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
await pool.query(`
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    pack_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_payment_id TEXT UNIQUE,
    invoice_url TEXT,
    credited_at TIMESTAMPTZ,
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

