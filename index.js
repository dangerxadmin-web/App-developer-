// ═══════════════════════════════════════════════════════════
// ArenaX Instamojo Server — v5.0
// Render deploy ready
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

// ═══════════ Config ═══════════
const INSTAMOJO_API_KEY = process.env.INSTAMOJO_API_KEY || "";
const INSTAMOJO_AUTH_TOKEN = process.env.INSTAMOJO_AUTH_TOKEN || "";
const INSTAMOJO_SALT = process.env.INSTAMOJO_SALT || "";
const INSTAMOJO_ENVIRONMENT = process.env.INSTAMOJO_ENVIRONMENT || "production";

const INSTAMOJO_BASE_URL = INSTAMOJO_ENVIRONMENT === "test"
  ? "https://test.instamojo.com/api/1.1"
  : "https://api.instamojo.com/api/1.1";

const SERVER_URL = process.env.SERVER_URL || "https://arenax-webhook.onrender.com";

console.log(`💳 Instamojo Env: ${INSTAMOJO_ENVIRONMENT}`);
console.log(`💳 Instamojo URL: ${INSTAMOJO_BASE_URL}`);
console.log(`🖥️ Server URL: ${SERVER_URL}`);

// ═══════════ Root & Health ═══════════
app.get("/", (req, res) => {
  res.json({
    service: "ArenaX Instamojo Server",
    status: "running",
    version: "5.0.0",
    env: INSTAMOJO_ENVIRONMENT,
    endpoints: {
      health: "/health",
      createPayment: "/create-payment (POST)",
      webhook: "/instamojo-webhook (POST)",
      success: "/payment-success"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    service: "arenax-instamojo",
    firebase: admin.apps.length > 0 ? "connected" : "disconnected",
    env: INSTAMOJO_ENVIRONMENT
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

    // Firestore me pending deposit save karo
    await db.collection("pending_deposits").doc(txnid).set({
      uid: uid,
      txnid: txnid,
      amount: Number(amount),
      status: "PENDING",
      gateway: "instamojo",
      environment: INSTAMOJO_ENVIRONMENT,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Instamojo API call
    const formData = new URLSearchParams();
    formData.append("purpose", "ArenaX Wallet Topup");
    formData.append("amount", String(amount));
    formData.append("buyer_name", name || "Player");
    formData.append("email", email || "user@arenax.app");
    formData.append("phone", phone || "9999999999");
    formData.append("redirect_url", SERVER_URL + "/payment-success");
    formData.append("webhook", SERVER_URL + "/instamojo-webhook");
    formData.append("send_email", "false");
    formData.append("send_sms", "false");
    formData.append("allow_repeated_payments", "false");

    console.log("📤 Instamojo API call for:", txnid, "amount:", amount);

    const instamojoResp = await fetch(INSTAMOJO_BASE_URL + "/payment_requests/", {
      method: "POST",
      headers: {
        "X-Api-Key": INSTAMOJO_API_KEY,
        "X-Auth-Token": INSTAMOJO_AUTH_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });

    const result = await instamojoResp.json();
    console.log("📥 Instamojo response:", JSON.stringify(result).substring(0, 300));

    if (!result.success) {
      return res.status(500).json({ ok: false, error: result.message || "Instamojo error" });
    }

    // Link txnid with payment request id
    await db.collection("pending_deposits").doc(txnid).update({
      paymentRequestId: result.payment_request.id
    });

    res.json({
      ok: true,
      txnid: txnid,
      paymentRequestId: result.payment_request.id,
      longurl: result.payment_request.longurl
    });

  } catch (err) {
    console.error("❌ Create payment error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Instamojo Webhook ═══════════
app.post("/instamojo-webhook", async (req, res) => {
  const data = req.body;
  console.log("🔔 Instamojo webhook received:", JSON.stringify(data, null, 2));

  try {
    // MAC verify karo
    const receivedMac = data.mac;
    if (!receivedMac) {
      console.warn("⚠️ No MAC in webhook");
      return res.status(400).send("No MAC");
    }

    // MAC data string banao (alphabetical order me)
    const macData = [
      data.payment_id,
      data.payment_request_id,
      data.status,
      data.amount,
      data.buyer_name,
      data.buyer_email,
      data.buyer_phone
    ].filter(Boolean).join("|");

    const hmac = crypto.createHmac("sha1", INSTAMOJO_SALT);
    hmac.update(macData);
    const calculatedMac = hmac.digest("hex");

    if (calculatedMac !== receivedMac) {
      console.warn("⚠️ MAC mismatch");
      console.warn("  Received:  ", receivedMac);
      console.warn("  Calculated:", calculatedMac);
      return res.status(400).send("Invalid MAC");
    }
    console.log("✅ MAC verified");

    // Only process Credit status
    if (data.status !== "Credit") {
      console.log("⏭️ Non-Credit status:", data.status);
      return res.status(200).send("Ignored");
    }

    // Find pending deposit by payment_request_id
    const pendingQ = await db.collection("pending_deposits")
      .where("paymentRequestId", "==", data.payment_request_id)
      .limit(1)
      .get();

    if (pendingQ.empty) {
      console.warn("⚠️ No pending deposit for:", data.payment_request_id);
      return res.status(200).send("Not found");
    }

    const pendingDoc = pendingQ.docs[0];
    const pendingData = pendingDoc.data();

    if (pendingData.status === "COMPLETED") {
      console.log("✅ Already processed:", data.payment_request_id);
      return res.status(200).send("Already processed");
    }

    const uid = pendingData.uid;
    const amount = Number(pendingData.amount);

    // Credit user atomically
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      if (userSnap.data().banned === true) throw new Error("User banned");

      const currentBal = Number(userSnap.data().balance || 0);
      tx.update(userRef, { balance: currentBal + amount });

      tx.update(pendingDoc.ref, {
        status: "COMPLETED",
        paymentId: data.payment_id || "",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection("wallet_transactions").doc();
      tx.set(txRef, {
        uid: uid,
        amount: amount,
        type: "credit",
        description: `Instamojo Deposit — ${data.payment_id}`,
        paymentId: data.payment_id || "",
        txnid: pendingData.txnid || "",
        source: "instamojo",
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
    res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ═══════════ Payment Success Redirect ═══════════
app.all("/payment-success", (req, res) => {
  const data = req.method === "POST" ? req.body : req.query;
  console.log("↩️ Payment redirect:", data);

  // Success screen dikhao
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Payment Successful — ArenaX</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{min-height:100vh;background:#05070d;color:#eef2ff;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;}
.card{max-width:400px;width:100%;background:linear-gradient(160deg,#10162a,#0a0e1a);border:1px solid #1f2a4a;border-radius:22px;padding:36px 24px;box-shadow:0 10px 40px rgba(0,0,0,.6);}
.icon{font-size:72px;margin-bottom:18px;}
.title{font-size:22px;font-weight:800;margin-bottom:12px;color:#00e676;}
.msg{font-size:15px;color:#8892b0;line-height:1.6;margin-bottom:24px;}
.hint{padding:14px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);border-radius:12px;font-size:13px;color:#00e5ff;line-height:1.5;}
.close-btn{display:block;width:100%;padding:14px;margin-top:20px;background:linear-gradient(135deg,#00e5ff,#7c4dff);color:#04121a;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:1px;}
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <div class="title">Payment Successful!</div>
  <div class="msg">Aapka payment ho gaya hai. Balance 5-10 second me add ho jayega.</div>
  <div class="hint">Aap is page ko band kar sakte ho. Wapas app kholke balance dekho.</div>
  <button class="close-btn" onclick="tryClose()">CLOSE PAGE</button>
</div>
<script>
function tryClose(){
  window.open('', '_self', '');
  window.close();
  setTimeout(() => { if (document.referrer) history.back(); }, 100);
}
setTimeout(() => { tryClose(); }, 5000);
</script>
</body>
</html>`);
});

// ═══════════ Start ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX Instamojo running on port ${PORT}`);
});
