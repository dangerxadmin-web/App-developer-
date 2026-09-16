// ═══════════════════════════════════════════════════════════
// ArenaX PayU Server — v4.0 (No Redirect)
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
const PAYU_MERCHANT_KEY = process.env.PAYU_MERCHANT_KEY || "2Ax1YR";
const PAYU_MERCHANT_SALT = process.env.PAYU_MERCHANT_SALT || "Em2qKk3sOPK3rZk1vbedwq8tlkBjy0Aq";
const PAYU_ENVIRONMENT = process.env.PAYU_ENVIRONMENT || "test";

const PAYU_PAYMENT_URL = PAYU_ENVIRONMENT === "production"
  ? "https://secure.payu.in/_payment"
  : "https://test.payu.in/_payment";

const SERVER_URL = process.env.SERVER_URL || "https://arenax-webhook.onrender.com";

console.log(`💳 PayU Env: ${PAYU_ENVIRONMENT}`);
console.log(`💳 PayU URL: ${PAYU_PAYMENT_URL}`);
console.log(`🖥️ Server URL: ${SERVER_URL}`);

// ═══════════ PayU Hash ═══════════
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
    version: "4.0.0",
    payuEnv: PAYU_ENVIRONMENT,
    serverUrl: SERVER_URL
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
      surl: SERVER_URL + "/payment-success",
      furl: SERVER_URL + "/payment-success",
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

// ═══════════ Payment Success — NO REDIRECT ═══════════
app.all("/payment-success", async (req, res) => {
  const data = req.method === "POST" ? req.body : req.query;
  console.log("↩️ Payment redirect received");
  console.log("📦 Data:", JSON.stringify(data, null, 2));

  let credited = false;
  let creditAmount = 0;
  let creditError = "";

  try {
    const status = String(data.status || "").toLowerCase();
    const txnid = data.txnid || "";

    if (data.hash) {
      const calcHash = verifyResponseHash(data);
      if (calcHash !== data.hash) {
        console.warn("⚠️ Hash mismatch");
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
            source: "payu-direct",
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
        credited = true;
        creditAmount = amount;
        console.log(`✅ Credited ₹${amount} to ${uid}`);
      } else if (pendingSnap.exists) {
        credited = true;
        creditAmount = Number(pendingSnap.data().amount || 0);
        console.log("✅ Already processed:", txnid);
      } else {
        console.warn("⚠️ No pending deposit for:", txnid);
        creditError = "Pending deposit not found";
      }
    } else {
      console.log("⏭️ Non-success status:", status);
      creditError = "Payment status: " + status;
    }
  } catch (e) {
    console.error("❌ Credit error:", e);
    creditError = e.message;
  }

  // ✅ NO REDIRECT — ek clean success screen dikhao
  const statusIcon = credited ? "✅" : "⚠️";
  const statusColor = credited ? "#00e676" : "#ffb300";
  const statusTitle = credited ? "Payment Successful!" : "Payment Received";
  const statusMsg = credited
    ? `₹${creditAmount} aapke wallet me add ho gaya hai.`
    : "Payment aa gaya, verification 1-2 min me hoga.";
  const hint = "Aap is page ko band kar sakte ho. Wapas app kholke balance dekho.";

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
.title{font-size:22px;font-weight:800;margin-bottom:12px;color:${statusColor};}
.msg{font-size:15px;color:#8892b0;line-height:1.6;margin-bottom:24px;}
.amount{font-size:32px;font-weight:900;color:#ffb300;margin:18px 0;letter-spacing:1px;}
.hint{padding:14px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);border-radius:12px;font-size:13px;color:#00e5ff;line-height:1.5;}
.close-btn{display:block;width:100%;padding:14px;margin-top:20px;background:linear-gradient(135deg,#00e5ff,#7c4dff);color:#04121a;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:1px;}
.close-btn:active{transform:scale(.98);}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${statusIcon}</div>
  <div class="title">${statusTitle}</div>
  ${credited ? `<div class="amount">₹${creditAmount}</div>` : ""}
  <div class="msg">${statusMsg}</div>
  <div class="hint">${hint}</div>
  <button class="close-btn" onclick="tryClose()">CLOSE PAGE</button>
</div>
<script>
function tryClose(){
  // Try to close tab (may fail if not opened by script)
  window.open('', '_self', '');
  window.close();
  // Fallback — go back
  setTimeout(() => {
    if (document.referrer) history.back();
  }, 100);
}
// Auto attempt close after 3 sec
setTimeout(() => { tryClose(); }, 3000);
</script>
</body>
</html>`);
});

// ═══════════ Test ═══════════
app.post("/test-webhook", async (req, res) => {
  try {
    const txnid = req.body.txnid;
    if (!txnid) return res.status(400).json({ ok: false, error: "txnid required" });
    const pendingSnap = await db.collection("pending_deposits").doc(txnid).get();
    if (!pendingSnap.exists) return res.json({ ok: true, note: "Not found" });
    res.json({ ok: true, data: pendingSnap.data() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Start ═══════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ArenaX PayU running on port ${PORT}`);
});
