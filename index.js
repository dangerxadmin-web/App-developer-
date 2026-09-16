const express = require("express");
const admin = require("firebase-admin");

// Render ke Environment Variable se Firebase Key read karega
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/ekqr-webhook", async (req, res) => {
  try {
    const { status, amount, customer_mobile } = req.body;

    if (status === "COMPLETED" || status === "SUCCESS") {
      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("phone", "==", customer_mobile).get();

      if (!snapshot.empty) {
        snapshot.forEach(async (doc) => {
          await doc.ref.update({
            wallet: admin.firestore.FieldValue.increment(Number(amount))
          });
        });
      }
      return res.status(200).send("SUCCESS");
    }

    res.status(400).send("Transaction not completed");
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
