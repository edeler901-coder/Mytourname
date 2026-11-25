
const express = require("express");
const { db } = require("./firebase");
const { requireTelegramAuth } = require("./telegramAuth");

const router = express.Router();

const ENTRY_FEE = 200;

// Register a player
router.post("/register", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    // Check current tournament
    const tournamentRef = db.ref("tournaments/current");
    const tournamentSnapshot = await tournamentRef.once("value");

    if (!tournamentSnapshot.exists()) {
      return res.status(503).json({
        error: "Tournament is not configured yet."
      });
    }

    const tournament = tournamentSnapshot.val();

    if (tournament.registrationOpen !== true) {
      return res.status(403).json({
        error: "Tournament registration is closed."
      });
    }

    const tournamentId = tournament.id || "current";

    // Player account
    const playerRef = db.ref(`players/${telegramId}`);
    const registeredAt = Date.now();

    // Deduct fee and register in one transaction
    const result = await playerRef.transaction((player) => {
      if (!player) return;

      if (!Number.isFinite(player.balance)) return;

      if (player.balance < ENTRY_FEE) return;

      if (
        player.tournamentRegistrations &&
        player.tournamentRegistrations[tournamentId]
      ) {
        return;
      }

      player.balance -= ENTRY_FEE;

      if (!player.tournamentRegistrations) {
        player.tournamentRegistrations = {};
      }

      player.tournamentRegistrations[tournamentId] = {
        tournamentId,
        entryFee: ENTRY_FEE,
        registeredAt,
        status: "registered"
      };

      return player;
    });

    if (!result.committed) {
      return res.status(400).json({
        error: "Registration failed. Check your balance or registration status."
      });
    }

    res.json({
      success: true,
      message: "Tournament registration successful!",
      entryFee: ENTRY_FEE,
      balance: result.snapshot.val().balance
    });

  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      error: "Registration failed. Please try again."
    });
  }
});

module.exports = router;
