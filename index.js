/* ═══════════════════════════════════════════════════════════
   ArenaX Payment Gateway Server — v12.0
   Custom UPI Payment Gateway (ZapUPI-style, own gateway)
   ═══════════════════════════════════════════════════════════ */

const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ═══════════ Firebase Init ═══════════ */
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8");
    serviceAccount = JSON.parse(decoded);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.NODE_ENV !== "production") {
    serviceAccount = require("./serviceAccountKey.json");
  } else {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT_BASE64 not set");
    process.exit(1);
  }
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase Admin initialized");
} catch (err) {
  console.error("❌ Firebase init failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

/* ═══════════ Config ═══════════ */
const PORT = process.env.PORT || 3000;
const MERCHANT_UPI = process.env.MERCHANT_UPI || "yourupi@ybl";
const MERCHANT_NAME = process.env.MERCHANT_NAME || "ArenaX Esports";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "change-this-secret-key";
const MIN_DEPOSIT = 10;
const MIN_WITHDRAW = 50;
const SIGNUP_BONUS = 5;
const REFERRER_BONUS = 5;
const FIRST_DEPOSIT_BONUS = 20;
const MIN_DEPOSIT_FOR_BONUS = 100;

/* ═══════════ Health & Root ═══════════ */
app.get("/", (req, res) => {
  res.json({
    service: "ArenaX Payment Gateway",
    status: "running",
    version: "12.0.0",
    gateway: "custom-upi"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    service: "arenax-payment",
    firebase: admin.apps.length > 0 ? "connected" : "disconnected"
  });
});

/* ═══════════════════════════════════════════════════════════
   AUTH — Register User (signup bonus + referral)
═══════════════════════════════════════════════════════════ */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { uid, name, email, referralCode } = req.body;
    if (!uid || !name || !email) {
      return res.status(400).json({ ok: false, error: "uid, name, email required" });
    }

    const userRef = db.collection("users").doc(uid);
    const existing = await userRef.get();
    if (existing.exists) {
      return res.json({ ok: true, alreadyExists: true });
    }

    // Referral validation
    let referrerUid = null;
    if (referralCode) {
      const q = await db.collection("users").where("referralCode", "==", String(referralCode).toUpperCase()).limit(1).get();
      if (!q.empty) referrerUid = q.docs[0].id;
    }

    const myRefCode = (String(name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PLAYER") +
      Math.floor(100 + Math.random() * 900);

    const bonus = referrerUid ? SIGNUP_BONUS : 0;

    await userRef.set({
      uid, name, email, phone: "",
      balance: 0,
      bonusBalance: bonus,
      referralCode: myRefCode,
      referredBy: referrerUid || "",
      referralRewarded: false,
      firstDepositRewarded: false,
      matchesPlayed: 0,
      totalWon: 0,
      banned: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (bonus > 0) {
      await db.collection("wallet_transactions").add({
        uid, amount: bonus, type: "credit", isBonus: true,
        description: "🎁 Sign-up Bonus",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ ok: true, referralCode: myRefCode, signupBonus: bonus, referredBy: referrerUid || "" });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   AUTH — Login (verifies Firebase token)
═══════════════════════════════════════════════════════════ */
app.post("/api/auth/login", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ ok: false, error: "idToken required" });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    res.json({
      ok: true,
      uid: decoded.uid,
      email: decoded.email,
      profile: userDoc.exists ? userDoc.data() : null
    });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   PROFILE — Update
═══════════════════════════════════════════════════════════ */
app.post("/api/user/update-profile", async (req, res) => {
  try {
    const { uid, name, gameUid, ign } = req.body;
    if (!uid) return res.status(400).json({ ok: false, error: "uid required" });

    const update = {};
    if (name) update.name = String(name).trim().slice(0, 24);
    if (gameUid !== undefined) {
      if (gameUid && !/^[0-9]{6,15}$/.test(gameUid)) {
        return res.status(400).json({ ok: false, error: "Invalid game UID" });
      }
      update.gameUid = gameUid || "";
    }
    if (ign !== undefined) update.ign = String(ign || "").trim().slice(0, 24);
    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("users").doc(uid).set(update, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   MATCHES — List
═══════════════════════════════════════════════════════════ */
app.get("/api/matches", async (req, res) => {
  try {
    const { game, mode, team } = req.query;
    let q = db.collection("tournaments");
    if (game) q = q.where("game", "==", game);
    const snap = await q.get();
    let items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    if (mode) items = items.filter(t => String(t.mode || t.category || "").toLowerCase() === mode.toLowerCase());
    if (team) items = items.filter(t => String(t.teamSize || t.team || "").toLowerCase() === team.toLowerCase());
    items = items.filter(t => t.status !== "CANCELLED");
    items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    res.json({ ok: true, matches: items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   MATCHES — Join
═══════════════════════════════════════════════════════════ */
app.post("/api/matches/join", async (req, res) => {
  try {
    const { uid, matchId, gameUID, ign } = req.body;
    if (!uid || !matchId || !gameUID || !ign) {
      return res.status(400).json({ ok: false, error: "uid, matchId, gameUID, ign required" });
    }

    const userRef = db.collection("users").doc(uid);
    const matchRef = db.collection("tournaments").doc(matchId);

    let result = null;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const matchSnap = await tx.get(matchRef);

      if (!userSnap.exists) throw new Error("User not found");
      if (!matchSnap.exists) throw new Error("Match not found");

      const u = userSnap.data();
      const m = matchSnap.data();

      if (u.banned === true) throw new Error("Account banned");
      if (m.status === "CANCELLED") throw new Error("Match cancelled");
      if (m.status === "COMPLETED" || m.completed === true) throw new Error("Match completed");
      if (m.status === "STARTED" || m.started === true) throw new Error("Match started");

      const balance = Number(u.balance || u.realBalance || u.mainBalance || 0);
      const bonus = Number(u.bonusBalance || u.bonus || 0);
      const total = balance + bonus;
      const fee = Number(m.entryFee || 0);
      const joined = Number(m.joinedCount || 0);
      const max = Number(m.maxSlots || 100);
      const joinedUsers = Array.isArray(m.joinedUsers) ? m.joinedUsers : [];

      if (joinedUsers.includes(uid)) throw new Error("Already joined");
      if (joined >= max) throw new Error("Match is full");
      if (total < fee) throw new Error("Insufficient balance");

      let newBonus = bonus, newBalance = balance;
      if (bonus >= fee) newBonus = bonus - fee;
      else { newBonus = 0; newBalance = balance - (fee - bonus); }

      tx.update(userRef, {
        balance: newBalance,
        bonusBalance: newBonus,
        ign, gameUid: gameUID,
        matchesPlayed: admin.firestore.FieldValue.increment(1)
      });
      tx.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(1),
        joinedUsers: [...joinedUsers, uid]
      });
      tx.set(matchRef.collection("participants").doc(uid), {
        uid, ign, gameUid: gameUID, entryFeePaid: fee,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        name: u.name || "Player"
      });

      result = { fee, newBalance, newBonus };
    });

    if (result.fee > 0) {
      await db.collection("wallet_transactions").add({
        uid, amount: -result.fee, type: "debit",
        description: `Entry Fee — Match ${matchId}`,
        matchId, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ ok: true, message: "Joined successfully", ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   WALLET — Create Order (Custom UPI Gateway)
═══════════════════════════════════════════════════════════ */
app.post("/api/wallet/createOrder", async (req, res) => {
  try {
    const { userId, amount, gateway } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    const amt = Number(amount);
    if (!amt || amt < MIN_DEPOSIT) {
      return res.status(400).json({ ok: false, error: `Minimum deposit ₹${MIN_DEPOSIT}` });
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: "User not found" });
    if (userDoc.data().banned === true) return res.status(403).json({ ok: false, error: "Account banned" });

    // Generate unique order ID
    const orderId = "AX_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex").toUpperCase();

    // Build UPI deep-link URI
    const payeeName = encodeURIComponent(MERCHANT_NAME);
    const txnNote = encodeURIComponent("ArenaX Topup " + orderId);
    const upiUri = `upi://pay?pa=${MERCHANT_UPI}&pn=${payeeName}&am=${amt}&cu=INR&tn=${txnNote}&tr=${orderId}`;

    // Store pending order
    await db.collection("pending_deposits").doc(orderId).set({
      uid: userId,
      orderId,
      amount: amt,
      currency: "INR",
      gateway: gateway || "UPI",
      merchant_upi: MERCHANT_UPI,
      payee_name: MERCHANT_NAME,
      upi_uri: upiUri,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      ok: true,
      orderId,
      amount: amt,
      currency: "INR",
      gateway: gateway || "UPI",
      merchant_upi: MERCHANT_UPI,
      payee_name: MERCHANT_NAME,
      upi_uri: upiUri,
      status: "PENDING",
      payment_page: `${process.env.PUBLIC_BASE_URL || "https://arenax-webhook.onrender.com"}/pay/${orderId}`
    });
  } catch (err) {
    console.error("createOrder error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   WALLET — Submit UTR / Verify Payment
═══════════════════════════════════════════════════════════ */
app.post("/api/wallet/submit-utr", async (req, res) => {
  try {
    const { orderId, utr } = req.body;
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });
    if (!utr || !/^\d{12}$/.test(String(utr))) {
      return res.status(400).json({ ok: false, error: "UTR must be 12 digits" });
    }

    const pendingRef = db.collection("pending_deposits").doc(orderId);
    const snap = await pendingRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const data = snap.data();
    if (data.status === "COMPLETED") {
      return res.json({ ok: true, status: "COMPLETED", message: "Already verified" });
    }

    await pendingRef.update({
      utr: String(utr),
      status: "PENDING",
      utrSubmittedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      ok: true,
      status: "PENDING",
      message: "UTR submitted. Awaiting verification.",
      orderId, utr
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   WALLET — Status Check
═══════════════════════════════════════════════════════════ */
app.get("/api/wallet/status/:orderId", async (req, res) => {
  try {
    const snap = await db.collection("pending_deposits").doc(req.params.orderId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });
    const d = snap.data();
    res.json({
      ok: true,
      orderId: d.orderId,
      amount: d.amount,
      status: d.status,
      utr: d.utr || "",
      upi_uri: d.upi_uri,
      merchant_upi: d.merchant_upi,
      payee_name: d.payee_name
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   WALLET — Withdraw
═══════════════════════════════════════════════════════════ */
app.post("/api/wallet/withdraw", async (req, res) => {
  try {
    const { userId, amount, upi } = req.body;
    if (!userId || !amount || !upi) {
      return res.status(400).json({ ok: false, error: "userId, amount, upi required" });
    }
    const amt = Number(amount);
    if (amt < MIN_WITHDRAW) return res.status(400).json({ ok: false, error: `Min ₹${MIN_WITHDRAW}` });
    if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi)) {
      return res.status(400).json({ ok: false, error: "Invalid UPI ID" });
    }

    const userRef = db.collection("users").doc(userId);
    let result = null;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      const u = userSnap.data();
      if (u.banned === true) throw new Error("Account banned");
      if (Number(u.matchesPlayed || 0) < 3) throw new Error("Play at least 3 matches first");
      const bal = Number(u.balance || u.realBalance || u.mainBalance || 0);
      if (bal < amt) throw new Error("Insufficient balance");
      tx.update(userRef, { balance: bal - amt });
      result = { newBalance: bal - amt };
    });

    await db.collection("withdrawals").add({
      uid: userId, amount: amt, upi,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection("wallet_transactions").add({
      uid: userId, amount: -amt, type: "debit",
      description: `Withdrawal → ${upi}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true, message: "Withdrawal requested", ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — Verify Deposit (UTR match)
═══════════════════════════════════════════════════════════ */
app.post("/api/admin/verify-deposit", async (req, res) => {
  try {
    const { adminKey, orderId } = req.body;
    if (adminKey !== ADMIN_API_KEY) return res.status(403).json({ ok: false, error: "Invalid admin key" });
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

    const result = await creditUser(orderId, "admin");
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   INTERNAL — Credit user wallet
═══════════════════════════════════════════════════════════ */
async function creditUser(orderId, source) {
  const pendingRef = db.collection("pending_deposits").doc(orderId);
  const snap = await pendingRef.get();
  if (!snap.exists) throw new Error("Order not found");

  const data = snap.data();
  if (data.status === "COMPLETED") return { credited: false, alreadyDone: true };

  const userRef = db.collection("users").doc(data.uid);
  let result = null;

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("User not found");
    const u = userSnap.data();

    const newBalance = Number(u.balance || u.realBalance || u.mainBalance || 0) + Number(data.amount);
    tx.update(userRef, { balance: newBalance });
    tx.update(pendingRef, {
      status: "COMPLETED",
      creditedAt: admin.firestore.FieldValue.serverTimestamp(),
      source
    });

    const txRef = db.collection("wallet_transactions").doc();
    tx.set(txRef, {
      uid: data.uid,
      amount: Number(data.amount),
      type: "credit",
      description: `Deposit — ${orderId}`,
      orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notifRef = db.collection("notifications").doc();
    tx.set(notifRef, {
      uid: data.uid,
      title: "✅ Deposit Credited",
      body: `₹${data.amount} added to your wallet!`,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    result = { credited: true, amount: data.amount, uid: data.uid };
  });

  // First deposit bonus
  try {
    await processDepositBonuses(data.uid, Number(data.amount));
  } catch (e) { console.warn("Bonus processing failed:", e.message); }

  return result;
}

async function processDepositBonuses(uid, amount) {
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) return;
  const u = snap.data();

  if (!u.firstDepositRewarded && amount >= MIN_DEPOSIT_FOR_BONUS) {
    await userRef.update({
      bonusBalance: admin.firestore.FieldValue.increment(FIRST_DEPOSIT_BONUS),
      firstDepositRewarded: true
    });
    await db.collection("wallet_transactions").add({
      uid, amount: FIRST_DEPOSIT_BONUS, type: "credit", isBonus: true,
      description: "🎁 First Deposit Bonus",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Referrer bonus
    const referrerUid = u.referredBy;
    if (referrerUid && !u.referralRewarded) {
      await db.collection("users").doc(referrerUid).update({
        bonusBalance: admin.firestore.FieldValue.increment(REFERRER_BONUS)
      });
      await db.collection("wallet_transactions").add({
        uid: referrerUid, amount: REFERRER_BONUS, type: "credit", isBonus: true,
        description: `🎁 Referral Bonus — ${u.name || "Friend"}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await userRef.update({ referralRewarded: true });
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   PAYMENT PAGE (simple UPI page with QR)
═══════════════════════════════════════════════════════════ */
app.get("/pay/:orderId", async (req, res) => {
  const orderId = req.params.orderId;
  const snap = await db.collection("pending_deposits").doc(orderId).get();
  if (!snap.exists) return res.status(404).send("Order not found");

  const o = snap.data();
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Pay ₹${o.amount} — ArenaX</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
body{margin:0;background:#0f172a;color:#f1f5f9;font-family:sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:20px;padding:24px;max-width:400px;width:100%;text-align:center}
h1{margin:0 0 8px;font-size:20px;color:#22c55e}
.amt{font-size:40px;font-weight:900;color:#22c55e;margin:12px 0}
#qrcode{background:#fff;padding:16px;border-radius:12px;display:inline-block;margin:16px 0}
.upi{background:#0f172a;padding:12px;border-radius:10px;font-family:monospace;font-size:13px;color:#06b6d4;word-break:break-all;margin:12px 0}
.btn{display:block;width:100%;padding:14px;background:linear-gradient(135deg,#06b6d4,#7c4dff);border:none;color:#fff;font-weight:800;border-radius:12px;margin-top:10px;cursor:pointer;font-size:15px;text-decoration:none;text-align:center;box-sizing:border-box}
input{width:100%;padding:14px;border-radius:10px;background:#0f172a;border:1px solid #334155;color:#f1f5f9;font-size:15px;margin-top:12px;box-sizing:border-box;outline:none}
.status{padding:12px;border-radius:10px;margin-top:12px;font-size:13px}
.status.ok{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.4)}
.status.wait{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.4)}
.status.err{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.4)}
</style></head>
<body>
<div class="card">
  <h1>🏆 ArenaX Topup</h1>
  <div class="amt">₹${o.amount}</div>
  <p style="color:#94a3b8;font-size:13px;margin:0">Order: ${o.orderId}</p>
  <div id="qrcode"></div>
  <div class="upi">${o.merchant_upi}</div>
  <a class="btn" href="${o.upi_uri}">📱 Open UPI App</a>
  <input type="text" id="utr" placeholder="Enter 12-digit UTR" maxlength="12" inputmode="numeric">
  <button class="btn" onclick="verify()">✅ Verify Payment</button>
  <div id="status"></div>
</div>
<script>
new QRCode(document.getElementById("qrcode"), { text: "${o.upi_uri}", width: 200, height: 200 });
async function verify() {
  const utr = document.getElementById("utr").value.trim();
  const s = document.getElementById("status");
  if (!/^\\d{12}$/.test(utr)) { s.className = "status err"; s.textContent = "❌ UTR must be 12 digits"; return; }
  s.className = "status wait"; s.textContent = "⏳ Verifying...";
  try {
    const r = await fetch("/api/wallet/submit-utr", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "${o.orderId}", utr })
    });
    const d = await r.json();
    if (d.status === "PENDING") { s.className = "status wait"; s.textContent = "⏳ UTR submitted. Awaiting verification."; }
    else if (d.status === "COMPLETED") { s.className = "status ok"; s.textContent = "✅ Verified!"; }
    else { s.className = "status err"; s.textContent = "❌ " + (d.error || "Failed"); }
  } catch(e) { s.className = "status err"; s.textContent = "❌ Network error"; }
}
</script>
</body></html>`);
});

/* ═══════════ Start ═══════════ */
app.listen(PORT, () => {
  console.log(`🚀 ArenaX Payment Gateway running on port ${PORT}`);
  console.log(`💳 Merchant UPI: ${MERCHANT_UPI}`);
});