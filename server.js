
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { db } = require("./firebase");

const registrationRouter = require("./registration");

const {
  ENTRY_FEE,
  TOTAL_GROUPS,
  PRIZE_SPLIT
} = require("./tournament");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Registration routes
app.use("/api/tournament", registrationRouter);

// Server status
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

// Tournament settings
app.get("/api/tournament/settings", (req, res) => {
  res.json({
    entryFee: ENTRY_FEE,
    totalGroups: TOTAL_GROUPS,
    prizeSplit: PRIZE_SPLIT
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
  console.log(
    `Bingo Tournament Server running on port ${PORT}`
  );
});
