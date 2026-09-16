// server.js
const express = require("express");
const admin = require("firebase-admin");
const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json"))
});
const db = admin.firestore();

app.post("/webhook/ekqr", async (req, res) => {
  try {
    const body = req.body;
    console.log("🔔 Webhook received:", body);

    // 1. Verify API key
    if (body.key !== process.env.EKQR_API_KEY) {
      return res.status(401).json({ ok: false });
    }

    // 2. Only process successful payments
    if (body.status !== "success" && body.status !== "SUCCESS") {
      return res.json({ ok: true, ignored: true });
    }

    const clientTxnId = body.client_txn_id;
    const amount = Number(body.amount);
    const utr = body.utr || body.bank_txn_id || "";

    if (!clientTxnId || !amount) {
      return res.status(400).json({ ok: false, reason: "missing fields" });
    }

    // 3. Find pending deposit
    const pendingQ = await db.collection("pending_deposits")
      .where("clientTxnId", "==", clientTxnId)
      .where("status", "==", "PENDING")
      .limit(1)
      .get();

    if (pendingQ.empty) {
      console.log("⚠️ No pending deposit found for", clientTxnId);
      return res.json({ ok: true, alreadyProcessed: true });
    }

    const pendingDoc = pendingQ.docs[0];
    const pendingData = pendingDoc.data();
    const uid = pendingData.uid;

    // 4. Atomic transaction: credit balance + mark complete
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");

      const currentBal = Number(userSnap.data().balance || 0);
      tx.update(userRef, { balance: currentBal + amount });
      tx.update(pendingDoc.ref, {
        status: "COMPLETED",
        utr: utr,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 5. Wallet transaction log
      const txRef = db.collection("wallet_transactions").doc();
      tx.set(txRef, {
        uid: uid,
        amount: amount,
        type: "credit",
        description: `Deposit via UPI — UTR ${utr}`,
        utr: utr,
        clientTxnId: clientTxnId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 6. Notification
      const notifRef = db.collection("notifications").doc();
      tx.set(notifRef, {
        uid: uid,
        title: "✅ Deposit Credited",
        body: `₹${amount} added to your wallet!`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log("✅ Credited", amount, "to", uid);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ ok: false });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Webhook listening"));
