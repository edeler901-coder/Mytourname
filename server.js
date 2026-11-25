
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Firebase connection
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// Home route
app.get("/", (req, res) => {
  res.send("Bingo Tournament Server is running!");
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    server: "Bingo Tournament",
    time: new Date().toISOString()
  });
});

// Firebase connection check
app.get("/api/firebase", async (req, res) => {
  try {
    await db.ref(".info/connected").once("value");

    res.json({
      status: "connected",
      database: "Firebase Realtime Database"
    });
  } catch (error) {
    console.error("Firebase error:", error);

    res.status(500).json({
      status: "error",
      message: "Firebase connection failed"
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Bingo Tournament Server running on port ${PORT}`);
});
