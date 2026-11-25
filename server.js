
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { db } = require("./firebase");

const {
  ENTRY_FEE,
  TOTAL_GROUPS,
  PRIZE_SPLIT,
  createGroups,
  createGroupSchedule,
  createPairings,
  calculatePrizes
} = require("./tournament");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Server status
app.get("/", (req, res) => {
  res.send("Bingo Tournament Server is running!");
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    server: "Bingo Tournament"
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

app.listen(PORT, () => {
  console.log(`Bingo Tournament running on port ${PORT}`);
});
