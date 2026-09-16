// ═══════════════════════════════════════════════════════════
// ArenaX EkQR Webhook Server — v2.0
// Render deploy ready (index.js)
// ═══════════════════════════════════════════════════════════

const express = require("express");
const admin = require("firebase-admin");

const app = express();

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS (browser se test karne ke liye)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ═══════════ Firebase Admin Init ═══════════
let serviceAccount;

try {
  // Priority 1: Base64 encoded (Render ke liye best)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8");
    serviceAccount = JSON.parse(decoded);
    console.log("✅ Firebase Service Account loaded from BASE64");
  }
  // Priority 2: Plain JSON string
  else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase Service Account loaded from JSON env");
  }
  // Priority 3: Local file (development only)
  else {
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Firebase Service Account loaded from local file");
  }

  // Fix escaped newlines in private_key (agar JSON string se aaya hai)
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin initialized");
} catch (err) {
  console.error("❌ Firebase init failed:", err.message);
  console.error("💡 Make sure FIREBASE_SERVICE_ACCOUNT_BASE64 env var is set on Render");
  process.exit(1);
}

const db = admin.firestore();

const EKQR_API_KEY = process.env.EKQR_API_KEY || "4bff2fad-0f58-4553-aa1c-528809144e95";

// ═══════════ Root & Health Check ═══════════
app.get("/", (req, res) => {
  res.json({
    service: "ArenaX Webhook",
    status: "running",
    version: "2.0.0",
    ts: new Date().toISOString(),
    endpoints: {
      health: "/health",
      webhook: "/ekqr-webhook (POST)",
      test: "/test-webhook (POST)"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    service: "arenax-webhook",
    firebase: admin.apps.length > 0 ? "connected" : "disconnected"
  });
});

// ═══════════ Webhook Handler (shared logic) ═══════════
async function handleEkqrWebhook(body) {
  console.log("🔔 Webhook payload:", JSON.stringify(body, null, 2));

  // 1. Verify API key
  if (body.key && EKQR_API_KEY && body.key !== EKQR_API_KEY) {
    console.warn("⚠️ Invalid key received");
    return { ok: false, status: 401, reason: "invalid key" };
  }

  // 2. Extract fields (EkQR multiple formats)
  const clientTxnId =
    body.client_txn_id ||
    body.clientTxnId ||
    body.order_id ||
    body.udf1 ||
    "";

  const status = String(body.status || body.payment_status || "").toLowerCase();
  const amount = Number(body.amount || body.payable_amount || 0);
  const utr =
    body.utr ||
    body.bank_txn_id ||
    body.transaction_id ||
    body.upi_txn_id ||
    body.rrn ||
    body.ref_no ||
    body.txn_id ||
    "";

  console.log("📋 Parsed:", { clientTxnId, status, amount, utr });

  // 3. Only process successful payments
  if (!["success", "completed", "paid", "successful"].includes(status)) {
    console.log("⏭️ Non-success status, ignoring:", status);
    return { ok: true, status: 200, ignored: true, actualStatus: status };
  }

  if (!clientTxnId) {
    return { ok: false, status: 400, reason: "missing client_txn_id" };
  }
  if (amount <= 0) {
    return { ok: false, status: 400, reason: "invalid amount" };
  }

  // 4. Find pending deposit by clientTxnId
  const pendingQ = await db
    .collection("pending_deposits")
    .where("clientTxnId", "==", clientTxnId)
    .limit(1)
    .get();

  if (pendingQ.empty) {
    console.warn("⚠️ No pending deposit for:", clientTxnId);

    // Try by orderId as backup
    if (body.order_id) {
      const altQ = await db
        .collection("pending_deposits")
        .where("orderId", "==", body.order_id)
        .limit(1)
        .get();
      if (!altQ.empty) {
        return await creditUser(altQ.docs[0], amount, utr, clientTxnId);
      }
    }
    return { ok: true, status: 200, notFound: true };
  }

  return await creditUser(pendingQ.docs[0], amount, utr, clientTxnId);
}

// ═══════════ Credit Function ═══════════
async function creditUser(pendingDoc, amount, utr, clientTxnId) {
  const pendingData = pendingDoc.data();
  const uid = pendingData.uid;

  if (!uid) {
    return { ok: false, status: 400, reason: "no uid in pending deposit" };
  }

  // Idempotency check
  if (pendingData.status === "COMPLETED") {
    console.log("✅ Already processed:", clientTxnId);
    return { ok: true, status: 200, alreadyProcessed: true };
  }

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error("User not found: " + uid);

    const userData = userSnap.data();
    if (userData.banned === true) throw new Error("User is banned");

    const currentBal = Number(userData.balance || 0);

    // Credit balance
    tx.update(userRef, { balance: currentBal + amount });

    // Mark pending complete
    tx.update(pendingDoc.ref, {
      status: "COMPLETED",
      utr: utr || "",
      creditedAmount: amount,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Wallet transaction log
    const txRef = db.collection("wallet_transactions").doc();
    tx.set(txRef, {
      uid: uid,
      amount: amount,
      type: "credit",
      description: `Deposit via UPI — UTR ${utr || "auto"}`,
      utr: utr || "",
      clientTxnId: clientTxnId,
      source: "webhook",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Notification
    const notifRef = db.collection("notifications").doc();
    tx.set(notifRef, {
      uid: uid,
      title: "✅ Deposit Credited",
      body: `₹${amount} added to your wallet!`,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  console.log(`✅ Credited ₹${amount} to ${uid}`);
  return { ok: true, status: 200, credited: amount, uid };
}

// ═══════════ Main Webhook Endpoint ═══════════
app.post("/ekqr-webhook", async (req, res) => {
  const startTime = Date.now();
  try {
    const result = await handleEkqrWebhook(req.body);
    const elapsed = Date.now() - startTime;
    console.log(`⏱️ Processed in ${elapsed}ms`);
    res.status(result.status || 200).json(result);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Test Endpoint ═══════════
app.post("/test-webhook", async (req, res) => {
  console.log("🧪 Test webhook called");
  try {
    const fakeBody = {
      key: EKQR_API_KEY,
      client_txn_id: req.body.client_txn_id || "TEST_" + Date.now(),
      amount: req.body.amount || 10,
      status: "success",
      utr: "TESTUTR" + Date.now(),
      ...req.body
    };
    const result = await handleEkqrWebhook(fakeBody);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Start Server ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX Webhook running on port ${PORT}`);
  console.log(`📍 Health:    /health`);
  console.log(`📍 Webhook:   /ekqr-webhook (POST)`);
  console.log(`📍 Test:      /test-webhook (POST)`);
});
