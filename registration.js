
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

// Shared registration function for human and simulator players.
async function registerPlayerForTournament(playerId, tournament, options = {}) {
  const id = String(playerId || "");
  const simulator = options.accountType === "simulator";
  const tournamentId = String(tournament.id || tournament.tournamentDate || "");
  const fee = Number(tournament.entryFee || ENTRY_FEE);

  if (!id || /[.#$\[\]\/]/.test(id) || !tournamentId ||
      /[.#$\[\]\/]/.test(tournamentId) || !Number.isFinite(fee) || fee <= 0) {
    throw new Error("Invalid registration information.");
  }
  if (tournament.registrationOpen !== true ||
      tournament.tournamentDate !== tournamentId) {
    throw new Error("Tournament registration is closed.");
  }
  const today = getAddisDate();
  if (tournamentId !== getTomorrowDate()) throw new Error("This is not the next tournament.");
  if (Date.now() >= getRegistrationDeadline(today)) throw new Error("Registration deadline has passed.");

  const accountRef = db.ref((simulator ? "simulators/" : "players/") + id);
  const listRef = db.ref("tournaments/" + tournamentId + "/registrations/" + id);
  const now = Date.now();

  if (simulator) {
    const txId = "sim_entry_" + tournamentId + "_" + id;
    let transactionAbortReason = null;
    const charge = await accountRef.transaction(account => {
      transactionAbortReason = null;
      // Firebase may first invoke an Admin SDK transaction with a null
      // local value even when the wallet exists remotely. Returning null
      // asks RTDB to retry with the server value; undefined aborts immediately.
      if (!account) {
        transactionAbortReason = "wallet_missing_in_transaction";
        return null;
      }
      if (account.isSimulator !== true || account.accountType !== "simulator") {
        transactionAbortReason = "invalid_simulator_flags_in_transaction";
        return;
      }
      account.simulatorTransactions = account.simulatorTransactions || {};
      account.simulatorRegistrations = account.simulatorRegistrations || {};
      const prior = account.simulatorTransactions[txId];
      if (prior) {
        if (prior.type === "simulator_entry_fee" &&
            Number(prior.amount) === fee && prior.status === "completed") return account;
        transactionAbortReason = "existing_transaction_conflict";
        return;
      }
      const old = account.simulatorRegistrations[tournamentId];
      if (old && old.status === "registered" &&
          old.paymentSource === "simulator_wallet" && Number(old.entryFee) === fee) {
        account.simulatorTransactions[txId] = {
          type:"simulator_entry_fee", amount:fee, tournamentDate:tournamentId,
          status:"completed", recoveredFromExistingRegistration:true,
          createdAt:old.registeredAt || now
        };
        return account;
      }
      const balance = Number(account.balance);
      if (!Number.isFinite(balance) || balance < fee) {
        transactionAbortReason = "insufficient_or_invalid_balance";
        return;
      }
      account.balance = balance - fee;
      account.simulatorTransactions[txId] = {
        type:"simulator_entry_fee", amount:fee, tournamentDate:tournamentId,
        status:"completed", createdAt:now
      };
      account.simulatorRegistrations[tournamentId] = {
        tournamentDate:tournamentId, entryFee:fee, registeredAt:now,
        status:"registered", paymentSource:"simulator_wallet",
        simulatorTransactionId:txId
      };
      return account;
    });

    // Read the account directly after the transaction. An aborted Firebase
    // transaction can return an empty transaction snapshot even when the
    // simulator record still exists in the database.
    const accountSnapshot = await accountRef.get();
    const account = accountSnapshot.val();
    if (!account || account.isSimulator !== true || account.accountType !== "simulator") {
      throw new Error("Simulator account is missing or has invalid account flags.");
    }
    const payment = account.simulatorTransactions && account.simulatorTransactions[txId];
    if (!payment) {
      const balance = Number(account.balance);
      if (!Number.isFinite(balance) || balance < fee) {
        return { success:false, status:"insufficient_funds", balance:account.balance };
      }
      console.error("Simulator wallet transaction aborted:", {
        playerId: id,
        tournamentDate: tournamentId,
        committed: charge.committed,
        abortReason: transactionAbortReason || "unknown_transaction_abort",
        balance,
        isSimulator: account.isSimulator,
        accountType: account.accountType,
        transactionIdExists: Boolean(account.simulatorTransactions && account.simulatorTransactions[txId]),
        registrationExists: Boolean(account.simulatorRegistrations && account.simulatorRegistrations[tournamentId])
      });
      throw new Error("Simulator wallet transaction aborted: " +
        (transactionAbortReason || "unknown_transaction_abort") +
        "; balance was not deducted.");
    }
    if (payment.type !== "simulator_entry_fee" || Number(payment.amount) !== fee ||
        payment.status !== "completed") throw new Error("Simulator payment could not be verified.");

    const entry = account.simulatorRegistrations && account.simulatorRegistrations[tournamentId];
    if (!entry || entry.status !== "registered" || Number(entry.entryFee) !== fee ||
        entry.paymentSource !== "simulator_wallet") {
      throw new Error("Simulator payment is saved; registration recovery is required.");
    }
    const listed = await listRef.transaction(existing => {
      if (existing) {
        if (existing.status === "registered" && existing.isSimulator === true &&
            String(existing.playerId || existing.telegramId) === id) return existing;
        return;
      }
      return {
        telegramId:id, playerId:id, tournamentId, tournamentDate:tournamentId,
        entryFee:fee, registeredAt:entry.registeredAt || now, status:"registered",
        isSimulator:true, paymentSource:"simulator_wallet", simulatorTransactionId:txId,
        displayName:account.displayName || account.username || id,
        username:account.username || account.displayName || id
      };
    });
    const finalEntry = listed.snapshot.val();
    if (!finalEntry || finalEntry.status !== "registered" || finalEntry.isSimulator !== true ||
        String(finalEntry.playerId || finalEntry.telegramId) !== id) {
      throw new Error("Simulator payment is saved; tournament registration recovery is required.");
    }
    await db.ref("simulatorTournaments/" + tournamentId + "/registrations/" + id)
      .transaction(existing => existing && existing.status === "registered" ? existing : ({
        playerId:id, username:account.username || account.displayName || id,
        displayName:account.displayName || account.username || id,
        tournamentDate:tournamentId, entryFee:fee,
        registeredAt:finalEntry.registeredAt, paymentSource:"simulator_wallet",
        simulatorTransactionId:txId, status:"registered"
      }));
    return { success:true, status:"registered", balance:account.balance };
  }

  const token = crypto.randomUUID();
  const result = await accountRef.transaction(player => {
    // RTDB may initially supply null when the existing player value is not cached.
    // Returning null allows the transaction to retry against the server value;
    // returning undefined would abort the registration immediately.
    if (!player) return null;
    const balance = Number(player.balance);
    if (!Number.isFinite(balance)) return;
    player.tournamentRegistrations = player.tournamentRegistrations || {};
    if (player.tournamentRegistrations[tournamentId]) return player;
    if (balance < fee) return;
    player.balance = balance - fee;
    player.tournamentRegistrations[tournamentId] = {
      tournamentId, entryFee:fee, registeredAt:now,
      registrationToken:token, status:"registered"
    };
    return player;
  });
  const player = result.snapshot.val();
  const registration = player && player.tournamentRegistrations &&
    player.tournamentRegistrations[tournamentId];
  if (!player) throw new Error("Player account was not found. No entry fee was charged.");
  if (!registration) {
    const balance = Number(player.balance);
    if (!Number.isFinite(balance)) throw new Error("Your wallet balance is invalid. No entry fee was charged.");
    if (balance < fee) throw new Error("Insufficient balance. Entry fee: " + fee +
      " Br; available balance: " + balance + " Br. No entry fee was charged.");
    throw new Error("Registration transaction did not complete. No entry fee was charged.");
  }
  const alreadyRegistered = registration.registrationToken !== token;
  const listed = await listRef.transaction(existing => existing || ({
    telegramId:id, tournamentId, entryFee:registration.entryFee,
    registeredAt:registration.registeredAt, status:"registered"
  }));
  if (!listed.snapshot.val() || listed.snapshot.val().status !== "registered") {
    throw new Error("Player payment is saved; tournament registration recovery is required.");
  }
  const referrerId = String(player.referredBy || "");
  if (referrerId && referrerId !== id) {
    await db.ref("players/" + referrerId).transaction(referrer => {
      if (!referrer) return;
      referrer.referralRewards = referrer.referralRewards || {};
      if (referrer.referralRewards[id]) return referrer;
      referrer.balance = Number(referrer.balance || 0) + 10;
      referrer.referralRewards[id] = {
        referredPlayerId:id, amount:10, status:"paid", paidAt:Date.now(), tournamentId
      };
      referrer.transactions = referrer.transactions || {};
      referrer.transactions["referral_" + id] = {
        type:"referral_reward", amount:10, status:"paid",
        referredPlayerId:id, createdAt:Date.now()
      };
      return referrer;
    });
  }
  return { success:true, balance:player.balance, alreadyRegistered };
}

// Check whether the authenticated player is already registered for tomorrow.
router.get("/status", requireTelegramAuth, async (req, res) => {
  try {
    const tournamentDate = getTomorrowDate();
    const playerSnapshot = await db
      .ref("players/" + String(req.telegramUser.id) + "/tournamentRegistrations/" + tournamentDate)
      .once("value");

    const registration = playerSnapshot.val();

    return res.json({
      registered: Boolean(registration && registration.status === "registered"),
      tournamentDate
    });
  } catch (error) {
    console.error("Registration status error:", error);
    return res.status(500).json({ error: "Could not check registration status." });
  }
});

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
