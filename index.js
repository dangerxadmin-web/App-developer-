// ═══════════════════════════════════════════════════════════
// ArenaX Server — v9.1 (PayPal + Referral + Bonus + Auth Bridge)
// ═══════════════════════════════════════════════════════════

const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const crypto = require("crypto");   // 🆕 for one-time auth bridge tokens

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ═══════════ Firebase Init ═══════════
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8");
    serviceAccount = JSON.parse(decoded);
    console.log("✅ Firebase SA loaded from BASE64");
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

// ═══════════ Config ═══════════
const PAYPAL_CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || "").trim();
const PAYPAL_CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || "").trim();
const PAYPAL_WEBHOOK_ID = (process.env.PAYPAL_WEBHOOK_ID || "").trim();
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const PAYPAL_CURRENCY = "USD";

// Referral & Bonus Config
const REFERRAL_SIGNUP_BONUS = 5;
const REFERRAL_FIRST_DEPOSIT_BONUS = 20;
const REFERRER_BONUS = 5;
const MIN_DEPOSIT_FOR_BONUS = 100;

// 🆕 Auth Bridge Config
const AUTH_BRIDGE_TTL_MS = 5 * 60 * 1000;   // 5 minutes validity
const AUTH_BRIDGE_COLLECTION = "auth_bridge";

console.log(`💳 PayPal Mode: ${PAYPAL_API_BASE.includes("sandbox") ? "SANDBOX" : "LIVE"}`);

// ═══════════ PayPal Access Token ═══════════
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("PayPal access token failed: " + JSON.stringify(data));
  return data.access_token;
}

// ═══════════ Root & Health ═══════════
app.get("/", (req, res) => {
  res.json({ service: "ArenaX Server", status: "running", version: "9.1.0", gateway: "paypal", authBridge: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), service: "arenax", firebase: admin.apps.length > 0 ? "connected" : "disconnected" });
});

// ═══════════════════════════════════════════════════════════════════
// 🔗 AUTH BRIDGE — enables external-browser sign-in on the app
// Flow:
//  1) Web auth page (arenax-beige.vercel.app) signs the user into
//     Firebase (Google / Phone OTP), then calls /auth-bridge/create
//     with the Firebase ID token to receive a one-time bridge code.
//  2) The web page then redirects the browser to:
//        arenax://auth-success?token=<bridgeCode>&provider=...&status=success
//     which Android WebView hands back to the Hopweb app.
//  3) The app calls /auth-bridge/exchange with the one-time code,
//     receives a Firebase custom token, and calls signInWithCustomToken.
// ═══════════════════════════════════════════════════════════════════

// ─── Create one-time bridge code ───
app.post("/auth-bridge/create", async (req, res) => {
  try {
    const { idToken, uid, provider } = req.body || {};

    if (!idToken || !uid) {
      return res.status(400).json({ ok: false, error: "idToken and uid are required" });
    }

    // 1️⃣ Verify the Firebase ID token from the web auth page
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken, true /* checkRevoked */);
    } catch (verifyErr) {
      console.warn("⚠️ verifyIdToken failed:", verifyErr.message);
      return res.status(401).json({ ok: false, error: "Invalid or expired ID token" });
    }

    // 2️⃣ Sanity check — the token must belong to the claimed UID
    if (decoded.uid !== uid) {
      return res.status(400).json({ ok: false, error: "UID mismatch" });
    }

    // 3️⃣ Generate a cryptographically random, single-use code
    const code = crypto.randomBytes(32).toString("hex");

    // 4️⃣ Persist the bridge document with an explicit expiry timestamp
    await db.collection(AUTH_BRIDGE_COLLECTION).doc(code).set({
      uid,
      provider: provider || "google",
      email: decoded.email || "",
      phone: decoded.phone_number || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + AUTH_BRIDGE_TTL_MS,
      used: false
    });

    console.log(`🔗 Auth bridge created: uid=${uid} provider=${provider || "google"}`);

    return res.json({ ok: true, token: code, expiresIn: AUTH_BRIDGE_TTL_MS / 1000 });

  } catch (err) {
    console.error("❌ /auth-bridge/create error:", err);
    return res.status(500).json({ ok: false, error: err.message || "create failed" });
  }
});

// ─── Exchange one-time bridge code for a Firebase custom token ───
app.post("/auth-bridge/exchange", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token || typeof token !== "string" || token.length < 20) {
      return res.status(400).json({ ok: false, error: "token is required" });
    }

    const ref = db.collection(AUTH_BRIDGE_COLLECTION).doc(token);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Invalid or unknown token" });
    }

    const data = snap.data() || {};

    // Already burned — prevent replay
    if (data.used === true) {
      return res.status(400).json({ ok: false, error: "Token already used" });
    }

    // Expired
    if (typeof data.expiresAtMs === "number" && Date.now() > data.expiresAtMs) {
      // Best-effort cleanup; ignore errors
      ref.delete().catch(() => {});
      return res.status(400).json({ ok: false, error: "Token expired" });
    }

    if (!data.uid) {
      return res.status(400).json({ ok: false, error: "Bridge record missing uid" });
    }

    // 1️⃣ Burn the token immediately (atomic guard via transaction)
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) throw new Error("Token missing");
      const fd = fresh.data() || {};
      if (fd.used === true) throw new Error("Token already used");
      if (typeof fd.expiresAtMs === "number" && Date.now() > fd.expiresAtMs) {
        throw new Error("Token expired");
      }
      tx.update(ref, {
        used: true,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        usedAtMs: Date.now()
      });
    });

    // 2️⃣ Mint a Firebase custom token for that UID
    const customToken = await admin.auth().createCustomToken(data.uid);

    console.log(`✅ Auth bridge exchanged: uid=${data.uid} provider=${data.provider || "google"}`);

    return res.json({
      ok: true,
      customToken,
      uid: data.uid,
      provider: data.provider || "google"
    });

  } catch (err) {
    console.error("❌ /auth-bridge/exchange error:", err);
    const msg = /expired/i.test(err.message) ? "Token expired"
              : /used/i.test(err.message)    ? "Token already used"
              : "exchange failed";
    return res.status(400).json({ ok: false, error: msg });
  }
});

// ─── (Optional) Cleanup old auth_bridge docs — runs every 15 min ───
async function cleanupAuthBridgeDocs() {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000; // older than 30 min
    const old = await db.collection(AUTH_BRIDGE_COLLECTION)
      .where("expiresAtMs", "<", cutoff)
      .limit(200)
      .get();

    if (old.empty) return;

    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`🧹 Cleaned ${old.size} expired auth_bridge docs`);
  } catch (err) {
    console.warn("auth_bridge cleanup skipped:", err.message);
  }
}
setInterval(cleanupAuthBridgeDocs, 15 * 60 * 1000);

// ═══════════ Referral Code Generate ═══════════
function generateReferralCode(name) {
  const clean = (name || "PLAYER").toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 8) || "PLAYER";
  const num = Math.floor(100 + Math.random() * 900);
  return clean + num;
}

// ═══════════ Create User (Signup with Referral) ═══════════
app.post("/create-user", async (req, res) => {
  try {
    const { uid, name, email, phone, referralCode } = req.body;

    if (!uid || !name || !email) {
      return res.status(400).json({ ok: false, error: "uid, name, email required" });
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      return res.json({ ok: true, alreadyExists: true });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ═══ DUPLICATE EMAIL CHECK ═══
    const dupEmail = await db.collection("users")
      .where("email", "==", normalizedEmail)
      .limit(1)
      .get();

    if (!dupEmail.empty && dupEmail.docs[0].id !== uid) {
      return res.status(400).json({
        ok: false,
        error: "This email is already registered. Please login instead."
      });
    }

    // ═══ REFERRAL CODE VERIFY ═══
    let referrerUid = null;
    if (referralCode) {
      const refCode = String(referralCode).trim().toUpperCase();
      const q = await db.collection("users").where("referralCode", "==", refCode).limit(1).get();
      if (!q.empty) {
        referrerUid = q.docs[0].id;
        console.log(`🎁 Referral detected: ${refCode} → ${referrerUid}`);
      } else {
        console.log(`⚠️ Invalid referral code: ${refCode} (skipped)`);
      }
    }

    const myRefCode = generateReferralCode(name);
    const signupBonus = referrerUid ? REFERRAL_SIGNUP_BONUS : 0;

    await userRef.set({
      uid,
      name,
      email: normalizedEmail,
      phone: phone || "",
      photoURL: "",
      balance: 0,
      bonusBalance: signupBonus,
      gameUid: "",
      ign: "",
      matchesPlayed: 0,
      totalWon: 0,
      banned: false,
      referralCode: myRefCode,
      referredBy: referrerUid || "",
      referralRewarded: false,
      firstDepositRewarded: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ User created: ${uid} (refCode: ${myRefCode}, referredBy: ${referrerUid || "none"}, bonus: ₹${signupBonus})`);

    if (signupBonus > 0) {
      await db.collection("wallet_transactions").add({
        uid,
        amount: signupBonus,
        type: "credit",
        isBonus: true,
        description: "🎁 Sign-up Referral Bonus",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection("notifications").add({
        uid,
        title: "🎁 Welcome Bonus!",
        body: `₹${signupBonus} sign-up bonus mila! Tournament join karne me use kar sakte ho.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({
      ok: true,
      referralCode: myRefCode,
      signupBonus,
      referredBy: referrerUid || ""
    });

  } catch (err) {
    console.error("❌ Create user error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Verify Referral Code ═══════════
app.post("/verify-referral", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: "Code required" });
    const refCode = String(code).trim().toUpperCase();
    const q = await db.collection("users").where("referralCode", "==", refCode).limit(1).get();
    if (q.empty) return res.json({ ok: false, valid: false, error: "Invalid referral code" });
    const referrerDoc = q.docs[0];
    const referrerData = referrerDoc.data();
    res.json({
      ok: true,
      valid: true,
      referrerUid: referrerDoc.id,
      referrerName: referrerData.name || "Player"
    });
  } catch (err) {
    console.error("❌ Verify referral error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Create Payment (PayPal) ═══════════
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount, name, email, phone } = req.body;

    if (!uid || !amount || Number(amount) < 1) {
      return res.status(400).json({ ok: false, error: "Invalid uid or amount (min ₹1)" });
    }

    const orderId = "AX_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8).toUpperCase();
    const inrAmount = Number(amount);
    const usdAmount = (inrAmount / 83).toFixed(2);

    await db.collection("pending_deposits").doc(orderId).set({
      uid,
      orderId,
      amount: inrAmount,
      usdAmount: Number(usdAmount),
      status: "PENDING",
      gateway: "paypal",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const accessToken = await getPayPalAccessToken();

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: PAYPAL_CURRENCY,
          value: usdAmount
        },
        description: `ArenaX Wallet Topup — ₹${inrAmount}`,
        custom_id: orderId,
        invoice_id: orderId
      }],
      application_context: {
        brand_name: "ArenaX",
        landing_page: "BILLING",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        return_url: (process.env.RETURN_URL || "https://your-render-url.onrender.com") + "/payment-success",
        cancel_url: (process.env.RETURN_URL || "https://your-render-url.onrender.com") + "/payment-cancel"
      }
    };

    console.log("📤 PayPal create order:", JSON.stringify(orderPayload));

    const paypalResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderPayload)
    });

    const paypalResult = await paypalResp.json();

    if (!paypalResp.ok || !paypalResult.id) {
      return res.status(500).json({ ok: false, error: "PayPal order create failed: " + JSON.stringify(paypalResult) });
    }

    let paymentUrl = "";
    if (paypalResult.links && Array.isArray(paypalResult.links)) {
      const approveLink = paypalResult.links.find(l => l.rel === "approve" || l.rel === "payer-action");
      if (approveLink) paymentUrl = approveLink.href;
    }

    if (!paymentUrl) {
      return res.status(500).json({ ok: false, error: "PayPal approval URL not found" });
    }

    await db.collection("pending_deposits").doc(orderId).update({
      paypalOrderId: paypalResult.id,
      paymentUrl: paymentUrl
    });

    res.json({
      ok: true,
      orderId,
      paypalOrderId: paypalResult.id,
      paymentUrl: paymentUrl
    });

  } catch (err) {
    console.error("❌ Create payment error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Capture PayPal Order ═══════════
app.post("/capture-order", async (req, res) => {
  try {
    const { orderId, paypalOrderId } = req.body;
    if (!orderId || !paypalOrderId) {
      return res.status(400).json({ ok: false, error: "orderId and paypalOrderId required" });
    }

    const accessToken = await getPayPalAccessToken();
    const captureResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    const captureResult = await captureResp.json();

    if (!captureResp.ok) {
      return res.status(500).json({ ok: false, error: "PayPal capture failed: " + JSON.stringify(captureResult) });
    }

    const pendingSnap = await db.collection("pending_deposits").doc(orderId).get();
    if (!pendingSnap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const captureId = captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id || "";
    await creditUser(pendingSnap, Number(pendingSnap.data().amount) || 0, captureId, "capture");

    res.json({ ok: true, status: "COMPLETED", captureResult });
  } catch (err) {
    console.error("❌ Capture order error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Process Deposit Bonuses ═══════════
async function processDepositBonuses(uid, depositAmount) {
  try {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return;
    const userData = userSnap.data();

    console.log(`🎁 Processing bonuses for ${uid}, deposit: ₹${depositAmount}`);

    if (!userData.firstDepositRewarded && depositAmount >= MIN_DEPOSIT_FOR_BONUS) {
      await userRef.update({
        bonusBalance: admin.firestore.FieldValue.increment(REFERRAL_FIRST_DEPOSIT_BONUS),
        firstDepositRewarded: true
      });
      await db.collection("wallet_transactions").add({
        uid,
        amount: REFERRAL_FIRST_DEPOSIT_BONUS,
        type: "credit",
        isBonus: true,
        description: `🎁 First Deposit Bonus (₹${MIN_DEPOSIT_FOR_BONUS}+)`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection("notifications").add({
        uid,
        title: "🎁 First Deposit Bonus",
        body: `₹${REFERRAL_FIRST_DEPOSIT_BONUS} bonus mila! Tournament join karne me use kar sakte ho.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const referrerUid = userData.referredBy;
      if (referrerUid && !userData.referralRewarded) {
        const referrerRef = db.collection("users").doc(referrerUid);
        const referrerSnap = await referrerRef.get();
        if (referrerSnap.exists) {
          await referrerRef.update({
            bonusBalance: admin.firestore.FieldValue.increment(REFERRER_BONUS)
          });
          await db.collection("wallet_transactions").add({
            uid: referrerUid,
            amount: REFERRER_BONUS,
            type: "credit",
            isBonus: true,
            description: `🎁 Referral Bonus — ${userData.name || "Friend"}`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection("notifications").add({
            uid: referrerUid,
            title: "🎁 Referral Bonus",
            body: `${userData.name || "Aapke friend"} ne ₹${MIN_DEPOSIT_FOR_BONUS} deposit kiya! ₹${REFERRER_BONUS} bonus mila.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await userRef.update({ referralRewarded: true });
          console.log(`✅ Referrer bonus: ₹${REFERRER_BONUS} to ${referrerUid}`);
        }
      }
    }
  } catch (err) {
    console.error("❌ processDepositBonuses error:", err);
  }
}

// ═══════════ Credit User ═══════════
async function creditUser(pendingDoc, amount, utr, source = "webhook") {
  const pendingData = pendingDoc.data();
  const uid = pendingData.uid;
  if (!uid) throw new Error("No uid in pending deposit");

  if (pendingData.status === "COMPLETED") {
    console.log("✅ Already processed:", pendingData.orderId);
    return { credited: false, alreadyProcessed: true };
  }

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("User not found");
    if (userSnap.data().banned === true) throw new Error("User banned");

    const currentBal = Number(userSnap.data().balance || 0);
    tx.update(userRef, { balance: currentBal + amount });

    tx.update(pendingDoc.ref, {
      status: "COMPLETED",
      utr: utr || "",
      creditedAmount: amount,
      source,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const txRef = db.collection("wallet_transactions").doc();
    tx.set(txRef, {
      uid,
      amount,
      type: "credit",
      description: `Deposit — ${pendingData.orderId || ""}`,
      orderId: pendingData.orderId || "",
      utr: utr || "",
      source: "paypal",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notifRef = db.collection("notifications").doc();
    tx.set(notifRef, {
      uid,
      title: "✅ Deposit Credited",
      body: `₹${amount} added to your wallet!`,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  console.log(`✅ Credited ₹${amount} to ${uid} (via ${source})`);

  await processDepositBonuses(uid, amount);

  return { credited: true, amount, uid };
}

// ═══════════ Check Status ═══════════
app.get("/check-status/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const snap = await db.collection("pending_deposits").doc(orderId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const data = snap.data();
    if (data.status === "COMPLETED") {
      return res.json({ ok: true, status: "COMPLETED", credited: true });
    }

    const paypalOrderId = data.paypalOrderId;
    if (!paypalOrderId) {
      return res.json({ ok: true, status: data.status, note: "No PayPal order ID yet" });
    }

    const accessToken = await getPayPalAccessToken();
    const statusResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const statusResult = await statusResp.json();

    if (statusResult.status === "COMPLETED") {
      await creditUser(snap, Number(data.amount) || 0, "", "polling");
      return res.json({ ok: true, status: "COMPLETED", credited: true });
    }

    res.json({ ok: true, status: statusResult.status || data.status, credited: false });
  } catch (err) {
    console.error("❌ Status check error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ PayPal Webhook ═══════════
app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("🔔 PayPal webhook:", JSON.stringify(data).substring(0, 500));

  try {
    if (PAYPAL_WEBHOOK_ID) {
      const verifyPayload = {
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: PAYPAL_WEBHOOK_ID,
        webhook_event: data
      };
      const accessToken = await getPayPalAccessToken();
      const verifyResp = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(verifyPayload)
      });
      const verifyResult = await verifyResp.json();
      if (verifyResult.verification_status !== "SUCCESS") {
        console.warn("⚠️ Webhook verification failed");
        return res.status(200).send("Verification failed");
      }
    }

    const eventType = data.event_type;
    const resource = data.resource || {};

    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const orderId = resource.custom_id || resource.invoice_id || "";
      const captureId = resource.id || "";
      if (orderId) {
        const pendingSnap = await db.collection("pending_deposits").doc(orderId).get();
        if (pendingSnap.exists) {
          await creditUser(pendingSnap, Number(pendingSnap.data().amount) || 0, captureId, "webhook");
        }
      }
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ═══════════ Payment Success Page ═══════════
app.all("/payment-success", (req, res) => {
  const orderId = req.query.orderId || "";
  const paypalOrderId = req.query.token || "";
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Payment Successful</title><style>body{min-height:100vh;background:#05070d;color:#eef2ff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;margin:0}.card{max-width:400px;width:100%;background:linear-gradient(160deg,#10162a,#0a0e1a);border:1px solid #1f2a4a;border-radius:22px;padding:36px 24px}.icon{font-size:72px}.title{font-size:22px;font-weight:800;color:#00e676;margin:18px 0 12px}.msg{color:#8892b0;line-height:1.6}.hint{margin-top:20px;padding:14px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);border-radius:12px;font-size:13px;color:#00e5ff}.close-btn{width:100%;padding:14px;margin-top:20px;background:linear-gradient(135deg,#00e5ff,#7c4dff);color:#04121a;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer}</style></head><body><div class="card"><div class="icon">✅</div><div class="title">Payment Successful!</div><div class="msg">Aapka payment ho gaya hai. Balance 5-10 second me add ho jayega.</div><div class="hint">Wapas app kholke balance dekho.</div><button class="close-btn" onclick="tryClose()">CLOSE PAGE</button></div><script>
var orderId = "${orderId}";
var paypalOrderId = "${paypalOrderId}";
function tryClose(){window.open('','_self','');window.close();setTimeout(function(){if(document.referrer)history.back()},100);}
if (orderId && paypalOrderId) {
  fetch('/capture-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: orderId, paypalOrderId: paypalOrderId }) }).catch(function(e){ console.log('Capture error:', e); });
}
setTimeout(tryClose, 8000);
</script></body></html>`);
});

app.all("/payment-cancel", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Payment Cancelled</title><style>body{min-height:100vh;background:#05070d;color:#eef2ff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;margin:0}.card{max-width:400px;width:100%;background:linear-gradient(160deg,#10162a,#0a0e1a);border:1px solid #1f2a4a;border-radius:22px;padding:36px 24px}.icon{font-size:72px}.title{font-size:22px;font-weight:800;color:#ff5c73;margin:18px 0 12px}.msg{color:#8892b0;line-height:1.6}</style></head><body><div class="card"><div class="icon">❌</div><div class="title">Payment Cancelled</div><div class="msg">Aapne payment cancel kar diya. Koi paisa nahi kata.</div></div></body></html>`);
});

// ═══════════ Start ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX Server running on port ${PORT}`);
  console.log(`💳 PayPal Mode: ${PAYPAL_API_BASE.includes("sandbox") ? "SANDBOX" : "LIVE"}`);
  console.log(`🔗 Auth Bridge endpoints: /auth-bridge/create, /auth-bridge/exchange`);
});
