
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const { db } = require("./firebase");
const { router: registrationRouter } = require("./registration");
const { requireTelegramAuth } = require("./telegramAuth");
const { startSimulatorScheduler } = require("./simulatorScheduler");

require("./bot");

const {
  ENTRY_FEE,
  TOTAL_GROUPS,
  PRIZE_SPLIT
} = require("./tournament");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Frontend
app.use(express.static(path.join(__dirname, "public")));

// Tournament registration
app.use("/api/tournament", registrationRouter);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    server: "Bingo Champions",
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

// Player wallet
app.get("/api/player/balance", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    const snapshot = await db
      .ref(`players/${telegramId}/balance`)
      .once("value");

    const balance = snapshot.val();

    res.json({
      success: true,
      balance: Number.isFinite(balance) ? balance : 0
    });

  } catch (error) {
    console.error("Wallet error:", error);

    res.status(500).json({
      error: "Unable to load wallet balance."
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Bingo Champions running on port ${PORT}`);

  // Start automatic simulator registration
  startSimulatorScheduler();
});
