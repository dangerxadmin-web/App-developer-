// ═══════════════════════════════════════════════════════════
// ArenaX AMR Pay Server — v3.0 (Nested Response Fixed)
// ═══════════════════════════════════════════════════════════

const express = require("express");
const admin = require("firebase-admin");

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
    console.log("✅ Firebase SA loaded");
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

// ═══════════ AMR Pay Config ═══════════
const AMRPAY_API_KEY = (process.env.AMRPAY_API_KEY || "").trim();
const AMRPAY_CREATE_URL = "https://amrpay.com/api/create-transaction.php";

console.log(`💳 AMR Pay API Key: ${AMRPAY_API_KEY.substring(0, 20)}...`);

// ═══════════ Root & Health ═══════════
app.get("/", (req, res) => {
  res.json({ service: "ArenaX AMR Pay Server", status: "running", version: "3.0.0" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), service: "arenax-amrpay", firebase: admin.apps.length > 0 ? "connected" : "disconnected" });
});

// ═══════════ Create Payment ═══════════
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount, name, email, phone } = req.body;

    if (!uid || !amount || Number(amount) < 10) {
      return res.status(400).json({ ok: false, error: "Invalid uid or amount (min ₹10)" });
    }

    if (!AMRPAY_API_KEY) {
      console.error("❌ AMRPAY_API_KEY not set");
      return res.status(500).json({ ok: false, error: "AMR Pay API key missing on server" });
    }

    const orderId = "AX_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8).toUpperCase();

    await db.collection("pending_deposits").doc(orderId).set({
      uid: uid,
      orderId: orderId,
      amount: Number(amount),
      status: "PENDING",
      gateway: "amrpay",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const payload = {
      api_key: AMRPAY_API_KEY,
      order_id: orderId,
      amount: Number(amount),
      customer_name: (name || "Player").substring(0, 100),
      customer_email: (email || "user@arenax.app").trim().toLowerCase(),
      customer_mobile: String(phone || "9999999999").replace(/[^0-9]/g, "").slice(-10),
      remark: "ArenaX Wallet Topup"
    };

    console.log("📤 AMR Pay create request:", JSON.stringify(payload));

    const amrResp = await fetch(AMRPAY_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const rawText = await amrResp.text();
    console.log("📥 AMR Pay RAW response:", rawText.substring(0, 800));

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      console.error("❌ AMR Pay ne JSON nahi bheja");
      return res.status(500).json({ ok: false, error: "AMR Pay response invalid" });
    }

    // ✅ FIX: Nested data object se fields nikalo
    const d = result.data || result;

    const txnId = d.txn_id || d.txnId || d.transaction_id || d.id || "";
    const paymentUrl = d.payment_url || d.paymentUrl || d.url || "";
    const qrUrl = d.qr_url || d.qrUrl || "";
    const upiUrl = d.upi_url || d.upiUrl || d.upi_intent || "";

    if (!txnId && !paymentUrl) {
      console.error("❌ No txn_id or payment_url in response:", JSON.stringify(result));
      return res.status(500).json({ ok: false, error: "AMR Pay ne txn_id nahi bheja" });
    }

    // ✅ Payment URL fallback
    let finalPaymentUrl = paymentUrl;
    if (!finalPaymentUrl && txnId) {
      finalPaymentUrl = "https://amrpay.com/pay.php?txn_id=" + encodeURIComponent(txnId);
    }

    console.log(`✅ Payment URL: ${finalPaymentUrl}`);

    await db.collection("pending_deposits").doc(orderId).update({
      txnId: txnId,
      paymentUrl: finalPaymentUrl,
      qrUrl: qrUrl,
      upiUrl: upiUrl
    });

    res.json({
      ok: true,
      orderId: orderId,
      txnId: txnId,
      paymentUrl: finalPaymentUrl,
      qrUrl: qrUrl,
      upiUrl: upiUrl
    });

  } catch (err) {
    console.error("❌ Create payment error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ AMR Pay Webhook ═══════════
app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("🔔 AMR Pay webhook:", JSON.stringify(data, null, 2));

  try {
    const status = String(data.status || "").toLowerCase();
    const txnId = data.txn_id || data.txnId || "";
    const orderId = data.order_id || "";
    const amount = Number(data.amount || 0);
    const utr = data.utr || "";

    if (status !== "success") {
      console.log("⏭️ Non-success status:", status);
      return res.status(200).send("Ignored");
    }

    let pendingDoc = null;

    if (orderId) {
      const snap = await db.collection("pending_deposits").doc(orderId).get();
      if (snap.exists) pendingDoc = snap;
    }

    if (!pendingDoc && txnId) {
      const q = await db.collection("pending_deposits").where("txnId", "==", txnId).limit(1).get();
      if (!q.empty) pendingDoc = q.docs[0];
    }

    if (!pendingDoc) {
      console.warn("⚠️ No pending deposit for:", orderId, txnId);
      return res.status(200).send("Not found");
    }

    const pendingData = pendingDoc.data();
    if (pendingData.status === "COMPLETED") {
      console.log("✅ Already processed");
      return res.status(200).send("Already processed");
    }

    const uid = pendingData.uid;
    const creditAmount = Number(pendingData.amount) || amount;
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      if (userSnap.data().banned === true) throw new Error("User banned");

      const currentBal = Number(userSnap.data().balance || 0);
      tx.update(userRef, { balance: currentBal + creditAmount });

      tx.update(pendingDoc.ref, {
        status: "COMPLETED",
        txnId: txnId,
        utr: utr,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection("wallet_transactions").doc();
      tx.set(txRef, {
        uid: uid,
        amount: creditAmount,
        type: "credit",
        description: `AMR Pay Deposit — ${txnId || orderId}`,
        txnId: txnId,
        utr: utr,
        source: "amrpay",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const notifRef = db.collection("notifications").doc();
      tx.set(notifRef, {
        uid: uid,
        title: "✅ Deposit Credited",
        body: `₹${creditAmount} added to your wallet!`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`✅ Credited ₹${creditAmount} to ${uid}`);
    res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ═══════════ Payment Success Page ═══════════
app.all("/payment-success", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Payment Successful</title><style>body{min-height:100vh;background:#05070d;color:#eef2ff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;margin:0}.card{max-width:400px;width:100%;background:linear-gradient(160deg,#10162a,#0a0e1a);border:1px solid #1f2a4a;border-radius:22px;padding:36px 24px}.icon{font-size:72px}.title{font-size:22px;font-weight:800;color:#00e676;margin:18px 0 12px}.msg{color:#8892b0;line-height:1.6}.hint{margin-top:20px;padding:14px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);border-radius:12px;font-size:13px;color:#00e5ff}.close-btn{width:100%;padding:14px;margin-top:20px;background:linear-gradient(135deg,#00e5ff,#7c4dff);color:#04121a;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer}</style></head><body><div class="card"><div class="icon">✅</div><div class="title">Payment Successful!</div><div class="msg">Aapka payment ho gaya hai. Balance 5-10 second me add ho jayega.</div><div class="hint">Aap is page ko band kar sakte ho. Wapas app kholke balance dekho.</div><button class="close-btn" onclick="tryClose()">CLOSE PAGE</button></div><script>function tryClose(){window.open('','_self','');window.close();setTimeout(function(){if(document.referrer)history.back()},100)}setTimeout(tryClose,5000)</script></body></html>`);
});

// ═══════════ Start ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX AMR Pay Server running on port ${PORT}`);
});
