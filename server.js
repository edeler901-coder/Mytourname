require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const { db } = require("./firebase");
const { router: registrationRouter } = require("./registration");
const { requireTelegramAuth } = require("./telegramAuth");

const { createSimulators } = require("./createSimulators");

const {
  startSimulatorScheduler
} = require("./simulatorScheduler");

const {
  startGameScheduler
} = require("./gameScheduler");

const {
  getMatchState,
  getBoardSelectionState,
  selectBoard,
  getPlayerCard,
  claimWinner
} = require("./gameEngine");

const {
  startTournamentSetup,
  ensureTomorrowTournament
} = require("./tournamentSetup");

require("./bot");
require("./adminBot");

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

// Tournament settings and live registration statistics
app.get("/api/tournament/settings", async (req, res) => {
  try {
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

    const today = `${date.year}-${date.month}-${date.day}`;
    const [year, month, day] = today.split("-").map(Number);
    const tournamentDate = new Date(
      Date.UTC(year, month - 1, day + 1)
    ).toISOString().slice(0, 10);

    const registrationsSnapshot = await db
      .ref(`tournaments/${tournamentDate}/registrations`)
      .once("value");

    const registrations = registrationsSnapshot.val() || {};
    const confirmedRegistrations = Object.values(registrations).filter(
      registration => registration && registration.status === "registered"
    );
    const registeredPlayers = confirmedRegistrations.length;
    const entryFee = Number(
      (await db.ref(`tournaments/${tournamentDate}/entryFee`).once("value")).val() || ENTRY_FEE
    );
    const grossContributions = confirmedRegistrations.reduce(
      (total, registration) => total + Number(registration.entryFee || entryFee),
      0
    );
    const simulatorPlayers = confirmedRegistrations.filter(
      registration => registration.isSimulator === true
    ).length;
    const prizePercentage =
      Number(PRIZE_SPLIT.first || 0) +
      Number(PRIZE_SPLIT.second || 0) +
      Number(PRIZE_SPLIT.third || 0);
    const prizePool = grossContributions * prizePercentage / 100;

    return res.json({
      entryFee,
      totalGroups: TOTAL_GROUPS,
      prizeSplit: PRIZE_SPLIT,
      tournamentDate,
      registeredPlayers,
      simulatorPlayers,
      humanPlayers: registeredPlayers - simulatorPlayers,
      grossContributions,
      prizePool
    });
  } catch (error) {
    console.error("Tournament stats error:", error);
    return res.status(500).json({
      error: "Unable to load tournament statistics."
    });
  }
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


/* =====================================
   BINGO GAME ROOM API
===================================== */

function getCurrentTournamentDate() {
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

  return `${date.year}-${date.month}-${date.day}`;
}

async function getPlayerMatch(telegramId) {
  const tournamentDate = getCurrentTournamentDate();

  const snapshot = await db
    .ref(`tournaments/${tournamentDate}`)
    .once("value");

  const tournament = snapshot.val() || {};
  const preliminaryMatches = Object.values(tournament.groups || {});
  const knockoutMatches = Object.values(tournament.bracket?.rounds || {})
    .flatMap(stage => Object.values(stage.matches || {}));

  const group = [...preliminaryMatches, ...knockoutMatches].find(item =>
    item &&
    item.matchId &&
    Array.isArray(item.players) &&
    item.players.some(
      player => String(player.telegramId) === String(telegramId)
    )
  );

  if (!group) {
    throw new Error("Your match assignment was not found.");
  }

  return { tournamentDate, group };
}

// Load player's game room
app.get("/api/player/match", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    const { tournamentDate, group } =
      await getPlayerMatch(telegramId);

    const state = await getMatchState(
      tournamentDate,
      group.matchId
    );

    if (!state) {
      return res.json({
        success: true,
        ready: false,
        message: "Your match is being prepared."
      });
    }

    const selection = await getBoardSelectionState(
      tournamentDate,
      group.matchId,
      telegramId
    );

    let card = null;

    if (selection.selectedBoardNumber) {
      card = await getPlayerCard(
        tournamentDate,
        group.matchId,
        telegramId
      );
    }

    return res.json({
      success: true,
      ready: true,
      match: {
        matchId: state.matchId,
        groupNumber: state.groupNumber,
        roundKey: state.roundKey,
        roundLabel: state.roundLabel,
        matchNumber: state.matchNumber,
        scheduledAt: state.scheduledAt,
        status: state.status,
        selectionStartedAt: state.selectionStartedAt,
        selectionEndsAt: state.selectionEndsAt,
        playerCount: Array.isArray(state.players)
          ? state.players.length
          : 0,
        selectedBoardCount: state.selectedBoardCount,
        drawnNumbers: state.drawnNumbers,
        lastCalledNumber: state.lastCalledNumber,
        remainingNumbers: state.remainingNumbers,
        winner: state.winner
      },
      selection,
      card
    });

  } catch (error) {
    console.error("Game room error:", error);

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Select or change player's board
app.post("/api/player/select-board", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);
    const boardNumber = Number(req.body.boardNumber);

    const { tournamentDate, group } =
      await getPlayerMatch(telegramId);

    await selectBoard(
      tournamentDate,
      group.matchId,
      telegramId,
      boardNumber
    );

    const selection = await getBoardSelectionState(
      tournamentDate,
      group.matchId,
      telegramId
    );

    return res.json({
      success: true,
      selection
    });

  } catch (error) {
    console.error("Board selection error:", error);

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Claim Bingo
app.post("/api/player/claim-bingo", requireTelegramAuth, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    const { tournamentDate, group } =
      await getPlayerMatch(telegramId);

    const winner = await claimWinner(
      tournamentDate,
      group.matchId,
      telegramId
    );

    return res.json({
      success: true,
      winner
    });

  } catch (error) {
    console.error("Bingo claim error:", error);

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});


// Secure SMS forwarder endpoint. The phone app must send JSON with { "message": "full SMS text" }
// and the header x-forwarder-secret matching SMS_FORWARDER_SECRET in Render.
function parseIncomingPaymentSms(message) {
  const text = String(message || "").trim();
  if (!text || text.length > 5000) return null;

  const idMatches = [...text.matchAll(/\b(?:[A-Z0-9]{8,24})\b/gi)].filter(match => {
    const token = match[0];
    return /[A-Z]/i.test(token) && /\d/.test(token) || /^\d{10,24}$/.test(token);
  });
  if (!idMatches.length) return null;
  const transactionId = idMatches[idMatches.length - 1][0].toUpperCase();

  // Prefer the final monetary-looking number before the transaction date.
  // This avoids interpreting the later account-balance figure as the payment amount.
  const dateMatch = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const beforeDate = dateMatch ? text.slice(0, dateMatch.index) : text;
  const numberMatches = [...beforeDate.matchAll(/(?:^|[^\d*])([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)(?![\d*])/g)];
  if (!numberMatches.length) return null;
  const amount = Number(numberMatches[numberMatches.length - 1][1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;

  let transactionTime = null;
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const year = Number(dateMatch[3]);
    const hour = Number(dateMatch[4]);
    const minute = Number(dateMatch[5]);
    const second = Number(dateMatch[6] || 0);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 &&
        hour <= 23 && minute <= 59 && second <= 59) {
      // SMS timestamps are local Ethiopia time (UTC+3).
      transactionTime = Date.UTC(year, month - 1, day, hour - 3, minute, second);
    }
  }
  return { transactionId, amount, transactionTime };
}

app.post(["/api/sms/incoming", "/api/sms/incoming/:secret"], async (req, res) => {
  try {
    const expectedSecret = process.env.SMS_FORWARDER_SECRET;
    const suppliedSecret = req.params.secret || req.get("x-forwarder-secret");
    if (!expectedSecret || !suppliedSecret || suppliedSecret !== expectedSecret) {
      return res.status(401).json({ success: false, error: "Unauthorized forwarder." });
    }

    const message = req.body && (req.body.message || req.body.text || req.body.sms);
    const now = Date.now();

    // Some forwarder apps send a connection test without an SMS body.
    if (typeof message !== "string" || !message.trim()) {
      return res.json({ success: true, received: false, ping: true, message: "Webhook connection successful." });
    }

    // Save the original SMS first so a parser mismatch never loses the message.
    const rawRef = db.ref("incomingPaymentSmsRaw").push();
    await rawRef.set({
      message: message.trim(),
      receivedAt: now,
      status: "received"
    });

    const parsed = parseIncomingPaymentSms(message);
    if (!parsed) {
      await rawRef.update({ status: "pending_parse" });
      return res.status(202).json({ success: true, received: true, parsed: false, message: "SMS received and saved for parsing." });
    }

    const transactionTime = parsed.transactionTime || now;
    if (transactionTime > now + 5 * 60 * 1000) {
      await rawRef.update({ status: "invalid_future_date", transactionId: parsed.transactionId });
      return res.status(202).json({ success: true, received: true, parsed: false, message: "SMS saved; date needs review." });
    }
    if (now - transactionTime > 72 * 60 * 60 * 1000) {
      await rawRef.update({ status: "expired", transactionId: parsed.transactionId });
      return res.status(202).json({ success: true, received: true, parsed: false, message: "SMS saved but payment is older than 72 hours." });
    }

    const safeId = parsed.transactionId.replace(/[^A-Z0-9_-]/g, "");
    const paymentRef = db.ref("incomingPaymentSms/" + safeId);
    const saved = await paymentRef.transaction(current => {
      if (current) return;
      return {
        transactionId: parsed.transactionId,
        amount: parsed.amount,
        transactionTime,
        receivedAt: now,
        status: "available"
      };
    });

    if (!saved.committed) {
      const existing = saved.snapshot.val() || {};
      await rawRef.update({ status: "duplicate", transactionId: parsed.transactionId });
      if (existing.transactionId === parsed.transactionId &&
          Number(existing.amount) === parsed.amount &&
          existing.status !== "available") {
        return res.status(200).json({ success: true, received: true, duplicate: true, message: "SMS received; transaction was already claimed." });
      }
      return res.status(200).json({ success: true, received: true, duplicate: true, message: "SMS received; transaction ID already exists." });
    }

    await rawRef.update({ status: "parsed", transactionId: parsed.transactionId });
    return res.json({ success: true, received: true, parsed: true, transactionId: parsed.transactionId });
  } catch (error) {
    console.error("Incoming SMS processing failed:", error.message);
    return res.status(500).json({ success: false, error: "Unable to receive incoming SMS." });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Bingo Champions running on port ${PORT}`);

  try {
    // Create and safely fund simulator accounts before registration scheduling begins.
    // The funding-version guard prevents repeat credits on normal server restarts.
    const simulatorSetup = await createSimulators();
    console.log("Simulator account setup result:", simulatorSetup);

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
