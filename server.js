
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const { db } = require("./firebase");
const { router: registrationRouter } = require("./registration");
const { requireTelegramAuth } = require("./telegramAuth");

const {
  startSimulatorScheduler
} = require("./simulatorScheduler");

const {
  startGameScheduler
} = require("./gameScheduler");

const {
  startTournamentSetup,
  ensureTomorrowTournament
} = require("./tournamentSetup");

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

// Get the authenticated player's tournament assignment
app.get("/api/player/assignment", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Addis_Ababa",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const date = {};
    parts.forEach(part => {
      date[part.type] = part.value;
    });

    const tournamentDate =
      `${date.year}-${date.month}-${date.day}`;

    const snapshot = await db
      .ref(`tournaments/${tournamentDate}/playerAssignments/${telegramId}`)
      .once("value");

    if (!snapshot.exists()) {
      return res.json({
        success: true,
        assigned: false,
        message: "No group assignment found yet."
      });
    }

    return res.json({
      success: true,
      assigned: true,
      assignment: snapshot.val()
    });

  } catch (error) {
    console.error("Assignment lookup error:", error);

    return res.status(500).json({
      error: "Unable to load tournament assignment."
    });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Bingo Champions running on port ${PORT}`);

  try {
    // Create tomorrow's tournament first
    await ensureTomorrowTournament();

    // Start automatic daily tournament setup
    startTournamentSetup();

    // Start simulator registration scheduler
startSimulatorScheduler();

// Start automatic Bingo game scheduler
startGameScheduler();

console.log("Tournament systems initialized.");

  } catch (error) {
    console.error(
      "Tournament initialization failed:",
      error
    );
  }
});
