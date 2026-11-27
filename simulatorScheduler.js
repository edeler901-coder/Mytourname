const crypto = require("crypto");
const { db } = require("./firebase");
const { registerPlayerForTournament } = require("./registration");
const { SIMULATORS } = require("./simulatorList");

const TIME_ZONE = "Africa/Addis_Ababa";
const ENTRY_FEE = 200;
const CHECK_INTERVAL = 60 * 1000;
const MIN_DAILY_SIMULATORS = 55;
const MAX_DAILY_SIMULATORS = 75;

let schedulerStarted = false;
let schedulerTimer = null;
let cycleRunning = false;

function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  return values.year + "-" + values.month + "-" + values.day;
}

function getTomorrowDate(dateString = getAddisDate()) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function getAddisDayEnd(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day + 1, -3, 0, 0, 0);
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function validSimulator(account) {
  return Boolean(account &&
    account.isSimulator === true &&
    account.accountType === "simulator");
}

async function getOpenTournament(tournamentDate) {
  const snapshot = await db.ref("tournaments/" + tournamentDate).once("value");
  const tournament = snapshot.val();
  if (!tournament ||
      tournament.tournamentDate !== tournamentDate ||
      tournament.registrationOpen !== true) return null;

  const entryFee = Number(tournament.entryFee || ENTRY_FEE);
  if (!Number.isFinite(entryFee) || entryFee <= 0) {
    throw new Error("Tournament entry fee is invalid.");
  }
  return { ...tournament, entryFee };
}

// One saved daily batch replaces the old per-task scheduler.
// Each simulator has only a due time and a final/retry state; there are no
// task claims, processing leases, or competing task-claim transactions.
async function prepareDailyBatch() {
  const registrationDate = getAddisDate();
  const tournamentDate = getTomorrowDate(registrationDate);
  const batchRef = db.ref("simulatorBatches/" + registrationDate);
  const existingBatchSnapshot = await batchRef.once("value");
  const existingBatch = existingBatchSnapshot.val();
  if (existingBatch && existingBatch.tournamentDate === tournamentDate &&
      existingBatch.version === 1) return existingBatch;

  const tournament = await getOpenTournament(tournamentDate);
  if (!tournament) return null;

  const [walletsSnapshot, registrationsSnapshot] = await Promise.all([
    db.ref("simulators").once("value"),
    db.ref("tournaments/" + tournamentDate + "/registrations").once("value")
  ]);

  const wallets = walletsSnapshot.val() || {};
  const registrations = registrationsSnapshot.val() || {};
  const eligibleIds = SIMULATORS
    .filter(item => validSimulator(wallets[item.id]))
    .map(item => item.id);

  if (eligibleIds.length < MIN_DAILY_SIMULATORS) {
    console.warn("Only " + eligibleIds.length +
      " valid simulator wallets are available; the batch will use all valid wallets.");
  }
  if (!eligibleIds.length) {
    console.error("No valid simulator wallets found. No wallet was changed.");
    return null;
  }

  const target = Math.min(
    eligibleIds.length,
    crypto.randomInt(
      Math.min(MIN_DAILY_SIMULATORS, eligibleIds.length),
      Math.min(MAX_DAILY_SIMULATORS, eligibleIds.length) + 1
    )
  );
  const selectedIds = shuffle(eligibleIds).slice(0, target);
  const now = Date.now();
  const closingAt = Math.min(
    getAddisDayEnd(registrationDate),
    Number(tournament.registrationClosesAt) || getAddisDayEnd(registrationDate)
  );
  const duration = Math.max(0, closingAt - now);
  const entries = {};

  for (const id of selectedIds) {
    const existing = registrations[id];
    const alreadyRegistered = Boolean(existing &&
      existing.status === "registered" &&
      existing.isSimulator === true);
    entries[id] = {
      playerId: id,
      runAt: alreadyRegistered ? now : now + crypto.randomInt(duration + 1),
      nextAttemptAt: now,
      status: alreadyRegistered ? "registered" : "pending",
      entryFee: tournament.entryFee,
      registeredAt: alreadyRegistered ? existing.registeredAt || now : null
    };
  }

  const transaction = await batchRef.transaction(current => {
    if (current && current.tournamentDate === tournamentDate &&
        current.version === 1) return current;
    return {
      version: 1,
      registrationDate,
      tournamentDate,
      dailyTarget: selectedIds.length,
      entryFee: tournament.entryFee,
      createdAt: now,
      updatedAt: now,
      entries
    };
  });

  const batch = transaction.snapshot.val();
  if (batch) {
    console.log("Daily simulator batch ready:", {
      tournamentDate,
      selected: batch.dailyTarget,
      alreadyRegistered: Object.values(batch.entries || {})
        .filter(item => item.status === "registered").length,
      registrationClosesAt: new Date(closingAt).toLocaleString("en-GB", {
        timeZone: TIME_ZONE
      })
    });
  }
  return batch;
}

async function setEntryState(registrationDate, playerId, updates) {
  const entryRef = db.ref(
    "simulatorBatches/" + registrationDate + "/entries/" + playerId
  );
  await entryRef.transaction(current => {
    if (!current) return;
    if (current.status === "registered") return current;
    return { ...current, ...updates, updatedAt: Date.now() };
  });
}

async function registerSimulator(playerId, tournamentDate, entryFee) {
  const snapshot = await db.ref("tournaments/" + tournamentDate).once("value");
  const tournament = snapshot.val();
  if (!tournament || tournament.registrationOpen !== true) {
    return { status: "registration_closed" };
  }

  const result = await registerPlayerForTournament(
    playerId, tournament, { accountType: "simulator" }
  );

  return {
    status: result.status === "insufficient_funds"
      ? "insufficient_funds"
      : result.alreadyRegistered ? "already_registered" : "registered",
    balance: result.balance
  };
}

async function processDailyBatch() {
  if (cycleRunning) return;
  cycleRunning = true;

  try {
    const registrationDate = getAddisDate();
    const tournamentDate = getTomorrowDate(registrationDate);
    let batch = await prepareDailyBatch();
    if (!batch || batch.tournamentDate !== tournamentDate) return;

    const tournament = await getOpenTournament(tournamentDate);
    if (!tournament) return;

    const closingAt = Math.min(
      getAddisDayEnd(registrationDate),
      Number(tournament.registrationClosesAt) || getAddisDayEnd(registrationDate)
    );
    const now = Date.now();
    if (now >= closingAt) return;

    const entries = Object.values(batch.entries || {})
      .sort((a, b) => Number(a.runAt || 0) - Number(b.runAt || 0));

    let attempted = 0;
    for (const entry of entries) {
      if (!entry || entry.status === "registered" ||
          entry.status === "insufficient_funds") continue;
      if (Number(entry.runAt || 0) > now ||
          Number(entry.nextAttemptAt || 0) > now) continue;

      const playerId = String(entry.playerId);
      attempted++;
      try {
        console.log("Batch registering simulator:", playerId, tournamentDate);
        const result = await registerSimulator(
          playerId, tournamentDate, tournament.entryFee
        );

        if (result.status === "registered" ||
            result.status === "already_registered") {
          await setEntryState(registrationDate, playerId, {
            status: "registered",
            registeredAt: Date.now(),
            balanceAfterEntry: result.balance,
            lastError: null
          });
          console.log("Simulator registered:", playerId);
        } else if (result.status === "insufficient_funds") {
          await setEntryState(registrationDate, playerId, {
            status: "insufficient_funds",
            nextAttemptAt: closingAt,
            lastError: "Insufficient simulator wallet balance."
          });
          console.log("Simulator skipped for insufficient funds:", playerId);
        } else {
          await setEntryState(registrationDate, playerId, {
            status: "pending",
            nextAttemptAt: Date.now() + CHECK_INTERVAL,
            lastError: "Registration window is not open."
          });
        }
      } catch (error) {
        const message = String(error.message || error).slice(0, 500);
        await setEntryState(registrationDate, playerId, {
          status: "pending",
          nextAttemptAt: Date.now() + CHECK_INTERVAL,
          lastError: message
        });
        console.error("Simulator batch registration failed:", playerId, message);
      }
    }

    const latest = await db.ref(
      "simulatorBatches/" + registrationDate
    ).once("value");
    const latestBatch = latest.val() || batch;
    const values = Object.values(latestBatch.entries || {});
    const counts = {
      total: values.length,
      registered: values.filter(item => item.status === "registered").length,
      insufficientFunds: values.filter(item => item.status === "insufficient_funds").length,
      pending: values.filter(item => item.status === "pending").length
    };

    await db.ref("simulatorRegistrationReports/" + tournamentDate).update({
      registrationDate,
      tournamentDate,
      entryFee: tournament.entryFee,
      totalSimulators: counts.total,
      registered: counts.registered,
      skippedForInsufficientFunds: counts.insufficientFunds,
      pending: counts.pending,
      processing: 0,
      registrationOpen: true,
      updatedAt: Date.now(),
      system: "daily_batch_v1"
    });

    if (attempted) {
      console.log("Simulator batch cycle completed:", { ...counts, attempted });
    }
  } catch (error) {
    console.error("Simulator daily batch failed:", error);
  } finally {
    cycleRunning = false;
  }
}

function startSimulatorScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  console.log("Daily simulator batch processor started. Checks every 60 seconds.");
  processDailyBatch();
  schedulerTimer = setInterval(processDailyBatch, CHECK_INTERVAL);
  if (schedulerTimer && typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
}

module.exports = {
  startSimulatorScheduler,
  prepareDailyBatch,
  processDailyBatch,
  registerSimulator
};
