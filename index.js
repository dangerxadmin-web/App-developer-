// ═══════════════════════════════════════════════════════════
// ArenaX PayU Server — v3.0
// PayU redirect-based (no webhook needed)
// ═══════════════════════════════════════════════════════════

const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

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

// ═══════════ Firebase Admin Init ═══════════
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8");
    serviceAccount = JSON.parse(decoded);
    console.log("✅ Firebase SA loaded from BASE64");
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase SA loaded from JSON env");
  } else if (process.env.NODE_ENV !== "production") {
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Firebase SA loaded from local file");
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

// ═══════════ PayU Config ═══════════
const PAYU_MERCHANT_KEY = process.env.PAYU_MERCHANT_KEY || "2Ax1YR";
const PAYU_MERCHANT_SALT = process.env.PAYU_MERCHANT_SALT || "Em2qKk3sOPK3rZk1vbedwq8tlkBjy0Aq";
const PAYU_ENVIRONMENT = process.env.PAYU_ENVIRONMENT || "test";

const PAYU_PAYMENT_URL = PAYU_ENVIRONMENT === "production"
  ? "https://secure.payu.in/_payment"
  : "https://test.payu.in/_payment";

console.log(`💳 PayU Env: ${PAYU_ENVIRONMENT}`);
console.log(`💳 PayU URL: ${PAYU_PAYMENT_URL}`);

// ═══════════ PayU Hash Generation ═══════════
function generatePaymentHash(params) {
  const hashString = [
    PAYU_MERCHANT_KEY,
    params.txnid || "",
    params.amount || "",
    params.productinfo || "",
    params.firstname || "",
    params.email || "",
    params.udf1 || "",
    params.udf2 || "",
    params.udf3 || "",
    params.udf4 || "",
    params.udf5 || "",
    "", "", "", "", "",
    PAYU_MERCHANT_SALT
  ].join("|");
  return crypto.createHash("sha512").update(hashString).digest("hex");
}

function verifyResponseHash(params) {
  const hashString = [
    PAYU_MERCHANT_SALT,
    params.status || "",
    "", "", "", "", "",
    params.udf5 || "",
    params.udf4 || "",
    params.udf3 || "",
    params.udf2 || "",
    params.udf1 || "",
    params.email || "",
    params.firstname || "",
    params.productinfo || "",
    params.amount || "",
    params.txnid || "",
    PAYU_MERCHANT_KEY
  ].join("|");
  return crypto.createHash("sha512").update(hashString).digest("hex");
}

// ═══════════ Root & Health ═══════════
app.get("/", (req, res) => {
  res.json({
    service: "ArenaX PayU Server",
    status: "running",
    version: "3.0.0",
    payuEnv: PAYU_ENVIRONMENT,
    endpoints: {
      health: "/health",
      createPayment: "/create-payment (POST)",
      paymentSuccess: "/payment-success (POST/GET)"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    service: "arenax-payu",
    firebase: admin.apps.length > 0 ? "connected" : "disconnected",
    payuEnv: PAYU_ENVIRONMENT
  });
});

// ═══════════ Create Payment ═══════════
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount, name, email, phone } = req.body;

    if (!uid || !amount || Number(amount) < 10) {
      return res.status(400).json({ ok: false, error: "Invalid uid or amount (min ₹10)" });
    }

    const txnid = "AX_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8).toUpperCase();

    await db.collection("pending_deposits").doc(txnid).set({
      uid: uid,
      txnid: txnid,
      amount: Number(amount),
      status: "PENDING",
      gateway: "payu",
      environment: PAYU_ENVIRONMENT,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const params = {
      key: PAYU_MERCHANT_KEY,
      txnid: txnid,
      amount: Number(amount).toFixed(2),
      productinfo: "ArenaX Wallet Topup",
      firstname: (name || "Player").substring(0, 60),
      email: email || "user@arenax.app",
      phone: phone || "9999999999",
      surl: "https://arenax-webhook.onrender.com/payment-success",
      furl: "https://arenax-webhook.onrender.com/payment-success",
      udf1: uid,
      udf2: "",
      udf3: "",
      udf4: "",
      udf5: ""
    };

    params.hash = generatePaymentHash(params);

    console.log(`📤 Payment created: ${txnid} for ₹${amount}`);

    res.json({
      ok: true,
      txnid: txnid,
      payuUrl: PAYU_PAYMENT_URL,
      params: params
    });
  } catch (err) {
    console.error("❌ Create payment error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Payment Success/Failure Handler ═══════════
app.all("/payment-success", async (req, res) => {
  const data = req.method === "POST" ? req.body : req.query;
  console.log("↩️ Payment redirect received");
  console.log("📦 Data:", JSON.stringify(data, null, 2));

  try {
    const status = String(data.status || "").toLowerCase();
    const txnid = data.txnid || "";

    // Verify hash (agar hash aaya hai)
    if (data.hash) {
      const calcHash = verifyResponseHash(data);
      if (calcHash !== data.hash) {
        console.warn("⚠️ Hash mismatch. Received:", data.hash, "Calc:", calcHash);
      } else {
        console.log("✅ Hash verified");
      }
    }

    if (["success", "captured", "auth"].includes(status) && txnid) {
      const pendingRef = db.collection("pending_deposits").doc(txnid);
      const pendingSnap = await pendingRef.get();

      if (pendingSnap.exists && pendingSnap.data().status !== "COMPLETED") {
        const uid = pendingSnap.data().uid;
        const amount = Number(pendingSnap.data().amount || data.amount || 0);
        const userRef = db.collection("users").doc(uid);

        await db.runTransaction(async (tx) => {
          const userSnap = await tx.get(userRef);
          if (!userSnap.exists) throw new Error("User not found");
          if (userSnap.data().banned === true) throw new Error("User banned");

          const currentBal = Number(userSnap.data().balance || 0);
          tx.update(userRef, { balance: currentBal + amount });

          tx.update(pendingRef, {
            status: "COMPLETED",
            mihpayid: data.mihpayid || "",
            source: "payu-redirect",
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          const txRef = db.collection("wallet_transactions").doc();
          tx.set(txRef, {
            uid: uid,
            amount: amount,
            type: "credit",
            description: `PayU Deposit — TXN ${txnid}`,
            txnid: txnid,
            mihpayid: data.mihpayid || "",
            source: "payu",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

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
      } else if (pendingSnap.exists) {
        console.log("✅ Already processed:", txnid);
      } else {
        console.warn("⚠️ No pending deposit for:", txnid);
      }
    } else {
      console.log("⏭️ Non-success or missing txnid:", status, txnid);
    }
  } catch (e) {
    console.error("❌ Credit error:", e);
  }

  // User ko wapas app pe bhejo
  res.redirect("https://tournament-b2771.web.app/?deposit=success");
});

// ═══════════ Start ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX PayU running on port ${PORT}`);
});    body.utr ||
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
