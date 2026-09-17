// ═══════════════════════════════════════════════════════════
// ArenaX Server — v7.0 (Referral + Bonus + Auto-Deposit)
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
const AMRPAY_API_KEY = (process.env.AMRPAY_API_KEY || "").trim();
const AMRPAY_CREATE_URL = "https://amrpay.com/api/create-transaction.php";
const AMRPAY_STATUS_URL = "https://amrpay.com/api/status.php";

// Referral & Bonus Config
const REFERRAL_SIGNUP_BONUS = 5;
const REFERRAL_FIRST_DEPOSIT_BONUS = 20;
const REFERRER_BONUS = 5;
const MIN_DEPOSIT_FOR_BONUS = 100;

console.log(`💳 AMR Pay API Key: ${AMRPAY_API_KEY.substring(0, 20)}...`);

// ═══════════ Root & Health ═══════════
app.get("/", (req, res) => {
  res.json({ service: "ArenaX Server", status: "running", version: "7.0.0" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), service: "arenax", firebase: admin.apps.length > 0 ? "connected" : "disconnected" });
});

// ═══════════ Referral Code Generate ═══════════
function generateReferralCode(name) {
  const clean = (name || "PLAYER").toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 8) || "PLAYER";
  const num = Math.floor(100 + Math.random() * 900);
  return clean + num;
}

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

// ═══════════ Create User (Signup with Referral) ═══════════
app.post("/create-user", async (req, res) => {
  try {
    const { uid, name, email, phone, referralCode } = req.body;

    if (!uid || !name || !email) {
      return res.status(400).json({ ok: false, error: "uid, name, email required" });
    }

    // Referrer dhundo (agar code diya hai)
    let referrerUid = null;
    if (referralCode) {
      const refCode = String(referralCode).trim().toUpperCase();
      const q = await db.collection("users").where("referralCode", "==", refCode).limit(1).get();
      if (!q.empty) {
        referrerUid = q.docs[0].id;
        console.log(`🎁 Referral detected: ${refCode} → ${referrerUid}`);
      }
    }

    const myRefCode = generateReferralCode(name);
    const signupBonus = referrerUid ? REFERRAL_SIGNUP_BONUS : 0;

    // User doc check karo — agar already exists toh skip
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      return res.json({ ok: true, alreadyExists: true });
    }

    // User banao
    await userRef.set({
      uid,
      name,
      email,
      phone: phone || "",
      photoURL: "",
      balance: 0,
      bonusBalance: signupBonus,
      gameUid: "",
      ign: "",
      matchesPlayed: 0,
      banned: false,
      referralCode: myRefCode,
      referredBy: referrerUid || "",
      referralRewarded: false,
      firstDepositRewarded: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Signup bonus log
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

    console.log(`✅ User created: ${uid} (refCode: ${myRefCode}, referredBy: ${referrerUid || "none"})`);

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

// ═══════════ Create Payment (AMR Pay) ═══════════
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount, name, email, phone } = req.body;

    if (!uid || !amount || Number(amount) < 10) {
      return res.status(400).json({ ok: false, error: "Invalid uid or amount (min ₹10)" });
    }
    if (!AMRPAY_API_KEY) {
      return res.status(500).json({ ok: false, error: "AMR Pay API key missing on server" });
    }

    const orderId = "AX_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8).toUpperCase();

    await db.collection("pending_deposits").doc(orderId).set({
      uid,
      orderId,
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

    console.log("📤 AMR Pay create:", JSON.stringify(payload));

    const amrResp = await fetch(AMRPAY_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const rawText = await amrResp.text();
    console.log("📥 AMR Pay RAW:", rawText.substring(0, 500));

    let result;
    try { result = JSON.parse(rawText); }
    catch (e) { return res.status(500).json({ ok: false, error: "AMR Pay response invalid" }); }

    const d = result.data || result;
    const txnId = d.txn_id || d.txnId || d.transaction_id || d.id || "";
    const paymentUrl = d.payment_url || d.paymentUrl || d.url || "";

    if (!txnId && !paymentUrl) {
      return res.status(500).json({ ok: false, error: "AMR Pay ne txn_id nahi bheja" });
    }

    let finalPaymentUrl = paymentUrl;
    if (!finalPaymentUrl && txnId) {
      finalPaymentUrl = "https://amrpay.com/pay.php?txn_id=" + encodeURIComponent(txnId);
    }

    await db.collection("pending_deposits").doc(orderId).update({
      txnId,
      paymentUrl: finalPaymentUrl
    });

    console.log(`✅ Payment URL: ${finalPaymentUrl}`);

    res.json({
      ok: true,
      orderId,
      txnId,
      paymentUrl: finalPaymentUrl
    });

  } catch (err) {
    console.error("❌ Create payment error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Process Deposit Bonuses (Referral + First Deposit) ═══════════
async function processDepositBonuses(uid, depositAmount) {
  try {
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return;
    const userData = userSnap.data();

    console.log(`🎁 Processing bonuses for ${uid}, deposit: ₹${depositAmount}`);

    // First deposit bonus (agar pehli baar ₹100+ deposit)
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
      console.log(`✅ First deposit bonus: ₹${REFERRAL_FIRST_DEPOSIT_BONUS} to ${uid}`);

      // Referrer ko bonus do
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

// ═══════════ Credit User (Helper) ═══════════
async function creditUser(pendingDoc, amount, utr, source = "polling") {
  const pendingData = pendingDoc.data();
  const uid = pendingData.uid;
  if (!uid) throw new Error("No uid in pending deposit");

  if (pendingData.status === "COMPLETED") {
    console.log("✅ Already processed:", pendingData.txnId);
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
      description: `Deposit — ${pendingData.txnId || ""}`,
      txnId: pendingData.txnId || "",
      utr: utr || "",
      source: "amrpay",
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

  // Bonuses process karo (first deposit + referral)
  await processDepositBonuses(uid, amount);

  return { credited: true, amount, uid };
}

// ═══════════ Check Status (Polling Endpoint) ═══════════
app.get("/check-status/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const snap = await db.collection("pending_deposits").doc(orderId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const data = snap.data();

    if (data.status === "COMPLETED") {
      return res.json({ ok: true, status: "COMPLETED", credited: true });
    }

    const txnId = data.txnId;
    if (!txnId) {
      return res.json({ ok: true, status: data.status, note: "No txn_id yet" });
    }

    const statusUrl = `${AMRPAY_STATUS_URL}?api_key=${encodeURIComponent(AMRPAY_API_KEY)}&txn_id=${encodeURIComponent(txnId)}`;
    const statusResp = await fetch(statusUrl);
    const statusText = await statusResp.text();
    console.log("📥 Status response:", statusText.substring(0, 300));

    let statusResult;
    try { statusResult = JSON.parse(statusText); }
    catch (e) { return res.json({ ok: false, error: "Status API response invalid" }); }

    const sd = statusResult.data || statusResult;
    const amrStatus = String(sd.status || statusResult.status || "").toLowerCase();

    if (amrStatus === "success" || amrStatus === "completed" || amrStatus === "paid") {
      const utr = sd.utr || sd.utr_number || "";
      const creditResult = await creditUser(snap, Number(data.amount) || 0, utr, "polling");
      return res.json({ ok: true, status: "COMPLETED", credited: creditResult.credited });
    }

    res.json({ ok: true, status: amrStatus || data.status, credited: false });

  } catch (err) {
    console.error("❌ Status check error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════ Webhook (AMR Pay) ═══════════
app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("🔔 AMR Pay webhook:", JSON.stringify(data, null, 2));

  try {
    const status = String(data.status || "").toLowerCase();
    const txnId = data.txn_id || data.txnId || "";
    const orderId = data.order_id || "";
    const amount = Number(data.amount || 0);
    const utr = data.utr || "";

    if (status !== "success") return res.status(200).send("Ignored");

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

    await creditUser(pendingDoc, amount || Number(pendingDoc.data().amount) || 0, utr, "webhook");
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
  console.log(`🚀 ArenaX Server running on port ${PORT}`);
});
