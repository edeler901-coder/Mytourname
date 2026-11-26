
const express = require("express");
const crypto = require("crypto");
const { db } = require("./firebase");
const { requireTelegramAuth } = require("./telegramAuth");
const { ENTRY_FEE } = require("./tournament");

const router = express.Router();

const TIME_ZONE = "Africa/Addis_Ababa";

// Get today's date in Addis Ababa
function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// Get tomorrow's date
function getTomorrowDate() {
  const [year, month, day] = getAddisDate()
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(year, month - 1, day + 1)
  ).toISOString().slice(0, 10);
}

// Registration closes at midnight Addis Ababa time
function getRegistrationDeadline(date) {
  const [year, month, day] = date.split("-").map(Number);

  return Date.UTC(year, month - 1, day + 1, -3, 0, 0);
}

// Shared registration function
async function registerPlayerForTournament(telegramId, tournament) {
  telegramId = String(telegramId);

  const tournamentId = String(tournament.id || "");
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

  if (
    tournament.registrationOpen !== true ||
    tournament.tournamentDate !== tournamentId
  ) {
    throw new Error("Tournament registration is closed.");
  }

  const registrationDate = getAddisDate();

  if (tournamentId !== getTomorrowDate()) {
    throw new Error("This is not the next tournament.");
  }

  if (Date.now() >= getRegistrationDeadline(registrationDate)) {
    throw new Error("Registration deadline has passed.");
  }

  const playerRef = db.ref(`players/${telegramId}`);
  const registrationToken = crypto.randomUUID();
  const registeredAt = Date.now();

  // Deduct the entry fee and record registration atomically
  const result = await playerRef.transaction((player) => {
    if (!player) return;

    if (!Number.isFinite(player.balance)) return;

    if (!player.tournamentRegistrations) {
      player.tournamentRegistrations = {};
    }

    if (player.tournamentRegistrations[tournamentId]) {
      return player;
    }

    if (player.balance < entryFee) return;

    player.balance -= entryFee;

    player.tournamentRegistrations[tournamentId] = {
      tournamentId,
      entryFee,
      registeredAt,
      registrationToken,
      status: "registered"
    };

    return player;
  });

  const player = result.snapshot.val();

  const registration =
    player?.tournamentRegistrations?.[tournamentId];

  if (!registration) {
    throw new Error("Insufficient balance or registration failed.");
  }

  const alreadyRegistered =
    registration.registrationToken !== registrationToken;

  // Repair or create the tournament registration list
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

  // Award the referral bonus only after the player's registration exists.
  // The referrer's transaction records each referred player once, preventing duplicate rewards.
  const referrerId = String(player.referredBy || "");
  if (referrerId && referrerId !== telegramId) {
    const referrerRef = db.ref(`players/${referrerId}`);
    await referrerRef.transaction((referrer) => {
      if (!referrer) return;
      referrer.referralRewards = referrer.referralRewards || {};
      if (referrer.referralRewards[telegramId]) return referrer;
      referrer.balance = Number(referrer.balance || 0) + 10;
      referrer.referralRewards[telegramId] = {
        referredPlayerId: telegramId,
        amount: 10,
        status: "paid",
        paidAt: Date.now(),
        tournamentId
      };
      referrer.transactions = referrer.transactions || {};
      referrer.transactions["referral_" + telegramId] = {
        type: "referral_reward",
        amount: 10,
        status: "paid",
        referredPlayerId: telegramId,
        createdAt: Date.now()
      };
      return referrer;
    });
  }

  return {
    success: true,
    balance: player.balance,
    alreadyRegistered
  };
}

// Human registration endpoint
router.post("/register", requireTelegramAuth, async (req, res) => {
  try {
    const tournamentDate = getTomorrowDate();

    const tournamentSnapshot = await db
      .ref(`tournaments/${tournamentDate}`)
      .once("value");

    if (!tournamentSnapshot.exists()) {
      return res.status(503).json({
        error: "The next tournament is not ready yet."
      });
    }

    const tournament = tournamentSnapshot.val();

    const result = await registerPlayerForTournament(
      req.telegramUser.id,
      tournament
    );

    return res.json({
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

    const message = error.message || "Registration failed.";

    const status =
      message.includes("closed") ||
      message.includes("deadline") ||
      message.includes("next tournament")
        ? 403
        : message.includes("Insufficient balance")
          ? 400
          : 500;

    return res.status(status).json({
      error: message
    });
  }
});

module.exports = {
  router,
  registerPlayerForTournament
};
