
const express = require("express");
const { db } = require("./firebase");
const { requireTelegramAuth } = require("./telegramAuth");
const { ENTRY_FEE } = require("./tournament");

const router = express.Router();

// Shared registration function.
// Human and simulator accounts can use the same function.
async function registerPlayerForTournament(telegramId, tournament) {
  telegramId = String(telegramId);

  const tournamentId = String(tournament.id || "current");
  const entryFee = Number(tournament.entryFee || ENTRY_FEE);

  if (
    !telegramId ||
    /[.#$\[\]\/]/.test(telegramId) ||
    !tournamentId ||
    /[.#$\[\]\/]/.test(tournamentId) ||
    !Number.isFinite(entryFee) ||
    entryFee <= 0
  ) {
    throw new Error("Invalid registration information.");
  }

  const playerRef = db.ref(`players/${telegramId}`);

  const registeredAt = Date.now();

  // Deduct balance and record registration together
  // inside one player transaction.
  const result = await playerRef.transaction((player) => {
    if (!player) return;

    if (!Number.isFinite(player.balance)) return;

    if (!player.tournamentRegistrations) {
      player.tournamentRegistrations = {};
    }

    // Prevent duplicate registration and duplicate payment.
    if (player.tournamentRegistrations[tournamentId]) {
      return player;
    }

    if (player.balance < entryFee) return;

    player.balance -= entryFee;

    player.tournamentRegistrations[tournamentId] = {
      tournamentId,
      entryFee,
      registeredAt,
      status: "registered"
    };

    return player;
  });

  const player = result.snapshot.val();

  const registration =
    player?.tournamentRegistrations?.[tournamentId];

  if (!registration) {
    throw new Error(
      "Registration failed. Check your balance."
    );
  }

  // Maintain a separate tournament registration list.
  // If a previous request failed here, a retry repairs it
  // without deducting the entry fee again.
  const registrationRef = db.ref(
    `tournaments/${tournamentId}/registrations/${telegramId}`
  );

  await registrationRef.transaction((existing) => {
    if (existing) return existing;

    return {
      telegramId,
      tournamentId,
      entryFee: registration.entryFee,
      registeredAt: registration.registeredAt,
      status: "registered"
    };
  });

  return {
    success: true,
    balance: player.balance,
    alreadyRegistered:
      registration.registeredAt !== registeredAt
  };
}

// Human player registration endpoint
router.post("/register", requireTelegramAuth, async (req, res) => {
  try {
    const tournamentSnapshot = await db
      .ref("tournaments/current")
      .once("value");

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

    const result = await registerPlayerForTournament(
      req.telegramUser.id,
      tournament
    );

    res.json({
      success: true,
      message: result.alreadyRegistered
        ? "You are already registered."
        : "Tournament registration successful!",
      entryFee: Number(tournament.entryFee || ENTRY_FEE),
      balance: result.balance,
      alreadyRegistered: result.alreadyRegistered
    });

  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      error: "Registration failed. Please try again."
    });
  }
});

module.exports = {
  router,
  registerPlayerForTournament
};
