
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const { db } = require("./firebase");
const registrationRouter = require("./registration");

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

// Serve frontend files
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

// Start backend
app.listen(PORT, () => {
  console.log(`Bingo Champions running on port ${PORT}`);
});
