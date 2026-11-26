
const crypto = require("crypto");
const { db } = require("./firebase");

const TIME_ZONE = "Africa/Addis_Ababa";
const MIN_SIMS = 55;
const MAX_SIMS = 75;
const ENTRY_FEE = 200;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const CHECK_INTERVAL = 30000;

let schedulerStarted = false;

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

function getTomorrowDate() {
  const [year, month, day] = getAddisDate()
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(year, month - 1, day + 1)
  ).toISOString().slice(0, 10);
}

function addisTimestamp(date, hour, minute) {
  const [year, month, day] = date.split("-").map(Number);

  return Date.UTC(
    year,
    month - 1,
    day,
    hour - 3,
    minute
  );
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

function createDailySchedule(registrationDate, tournamentDate, ids) {
  const dailyTotal =
    crypto.randomInt(
      MIN_SIMS,
      Math.min(MAX_SIMS, ids.length) + 1
    );

  const selected = shuffle(ids).slice(0, dailyTotal);
  const tasks = [];

  // Exactly 8 at 2:30 PM
  for (let i = 0; i < 8; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(registrationDate, 14, 30),
      status: "pending"
    });
  }

  // Exactly 13 at 4:25 PM
  for (let i = 8; i < 21; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(registrationDate, 16, 25),
      status: "pending"
    });
  }

  // Remaining simulators at random times
  for (let i = 21; i < dailyTotal; i++) {
    const randomMinute = crypto.randomInt(0, 1440);

    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(
        registrationDate,
        Math.floor(randomMinute / 60),
        randomMinute % 60
      ),
      status: "pending"
    });
  }

  tasks.sort((a, b) => a.runAt - b.runAt);

  return {
    registrationDate,
    tournamentDate,
    dailyTotal,
    createdAt: Date.now(),
    tasks
  };
}

// Create or retrieve the daily schedule
async function prepareDailySchedule() {
  const registrationDate = getAddisDate();
  const tournamentDate = getTomorrowDate();

  const scheduleRef = db.ref(
    `simulatorSchedules/${registrationDate}`
  );

  const existing = await scheduleRef.once("value");

  if (existing.exists()) {
    return existing.val();
  }

  // Check that tomorrow's tournament exists
  const tournamentSnapshot = await db
    .ref(`tournaments/${tournamentDate}`)
    .once("value");

  if (!tournamentSnapshot.exists()) {
    console.log("Tomorrow's tournament is not configured.");
    return null;
  }

  const tournament = tournamentSnapshot.val();

  if (
    tournament.id !== tournamentDate ||
    tournament.tournamentDate !== tournamentDate ||
    tournament.registrationOpen !== true
  ) {
    console.log("Tomorrow's tournament is not ready.");
    return null;
  }

  if (!ADMIN_ID) {
    console.error("ADMIN_ID is not configured; simulator registrations are paused.");
    return null;
  }

  const entryFee = Number(tournament.entryFee || ENTRY_FEE);
  if (!Number.isFinite(entryFee) || entryFee <= 0) {
    console.error("Tournament entry fee is invalid; simulator registrations are paused.");
    return null;
  }

  const adminSnapshot = await db.ref(`players/${ADMIN_ID}`).once("value");
  const adminBalance = Number(adminSnapshot.val()?.balance || 0);
  const affordableCount = Math.floor(adminBalance / entryFee);

  const simulatorSnapshot = await db
    .ref("simulators")
    .once("value");

  const simulators = simulatorSnapshot.val() || {};

  const eligibleIds = Object.entries(simulators)
    .filter(([id, account]) =>
      account &&
      account.isSimulator === true &&
      account.accountType === "simulator" &&
      !(
        account.simulatorRegistrations &&
        account.simulatorRegistrations[tournamentDate]
      )
    )
    .map(([id]) => id);

  const affordableIds = shuffle(eligibleIds).slice(
    0,
    Math.min(eligibleIds.length, affordableCount)
  );

  if (affordableIds.length < MIN_SIMS) {
    console.error(
      `Only ${eligibleIds.length} eligible simulators. At least ${MIN_SIMS} are required.`
    );
    return null;
  }

  const schedule = createDailySchedule(
    registrationDate,
    tournamentDate,
    affordableIds
  );

  const result = await scheduleRef.transaction((current) => {
    if (current) return current;
    return schedule;
  });

  console.log(
    `Prepared ${result.snapshot.val().dailyTotal} simulator registrations for ${tournamentDate}.`
  );

  return result.snapshot.val();
}

// Register one simulator using the administrator wallet.

async function registerSimulator(playerId, tournamentDate, entryFee = ENTRY_FEE) {
  const accountRef = db.ref(`simulators/${playerId}`);
  const registeredAt = Date.now();
  const fee = Number(entryFee);

  if (!ADMIN_ID) {
    throw new Error("ADMIN_ID is not configured; simulator entries cannot be funded.");
  }
  if (!Number.isFinite(fee) || fee <= 0) {
    throw new Error("Invalid simulator entry fee.");
  }

  const tournamentRegistrationRef = db.ref(
    `tournaments/${tournamentDate}/registrations/${playerId}`
  );

  const reservation = await tournamentRegistrationRef.transaction(existing => {
    if (existing) return existing;
    return {
      telegramId: String(playerId),
      playerId: String(playerId),
      tournamentId: tournamentDate,
      entryFee: fee,
      registeredAt,
      status: "processing",
      isSimulator: true
    };
  });

  const reserved = reservation.snapshot.val();
  if (!reserved || reserved.isSimulator !== true ||
      String(reserved.telegramId) !== String(playerId)) {
    throw new Error("A different registration already uses this player ID.");
  }
  if (reserved.status === "registered") return true;

  // Existing synthetic 10,000 Br balances are archived and made non-spendable.
  const prepared = await accountRef.transaction(account => {
    if (!account || account.isSimulator !== true) return;
    if (account.fundingVersion !== 1) {
      account.legacyVirtualBalance = Number(account.balance || 0);
      account.balance = 0;
      account.fundingVersion = 1;
    }
    account.simulatorRegistrations = account.simulatorRegistrations || {};
    return account;
  });

  let account = prepared.snapshot.val();
  if (!account || account.isSimulator !== true) {
    throw new Error("Simulator account not found or invalid.");
  }

  let registration = account.simulatorRegistrations?.[tournamentDate];
  const adminTransactionId = `sim_entry_${tournamentDate}_${playerId}`;

  // Debit the configured administrator wallet once per simulator per tournament.
  if (!registration) {
    const adminRef = db.ref(`players/${ADMIN_ID}`);
    const charge = await adminRef.transaction(admin => {
      if (!admin || !Number.isFinite(Number(admin.balance))) return;
      admin.transactions = admin.transactions || {};
      const prior = admin.transactions[adminTransactionId];
      if (prior) {
        if (prior.type === "simulator_entry_fee" &&
            Number(prior.amount) === fee &&
            prior.status === "completed") return admin;
        return;
      }
      if (Number(admin.balance) < fee) return;
      admin.balance = Number(admin.balance) - fee;
      admin.transactions[adminTransactionId] = {
        type: "simulator_entry_fee",
        amount: fee,
        playerId: String(playerId),
        tournamentDate,
        status: "completed",
        createdAt: Date.now()
      };
      return admin;
    });

    const admin = charge.snapshot.val();
    const debit = admin?.transactions?.[adminTransactionId];
    if (!debit || debit.type !== "simulator_entry_fee" ||
        Number(debit.amount) !== fee || debit.status !== "completed") {
      await tournamentRegistrationRef.transaction(current => {
        if (current && current.status === "processing" &&
            current.isSimulator === true &&
            String(current.telegramId) === String(playerId)) return null;
        return current;
      });
      throw new Error("Admin wallet has insufficient balance or the simulator entry debit failed.");
    }

    const saved = await accountRef.transaction(current => {
      if (!current || current.isSimulator !== true) return;
      current.simulatorRegistrations = current.simulatorRegistrations || {};
      if (current.simulatorRegistrations[tournamentDate]) return current;
      current.simulatorRegistrations[tournamentDate] = {
        tournamentDate,
        entryFee: fee,
        registeredAt,
        status: "registered",
        paymentSource: "admin_wallet",
        adminTransactionId
      };
      return current;
    });

    account = saved.snapshot.val();
    registration = account?.simulatorRegistrations?.[tournamentDate];

    if (!registration) {
      // Refund exactly once if the simulator registration could not be recorded.
      await adminRef.transaction(admin => {
        const tx = admin?.transactions?.[adminTransactionId];
        if (!admin || !tx || tx.status !== "completed") return admin;
        admin.balance = Number(admin.balance || 0) + fee;
        tx.status = "refunded";
        tx.refundedAt = Date.now();
        return admin;
      });
      await tournamentRegistrationRef.transaction(current => {
        if (current && current.status === "processing" &&
            current.isSimulator === true) return null;
        return current;
      });
      throw new Error("Simulator entry was refunded because its registration could not be saved.");
    }
  }

  const finalized = await tournamentRegistrationRef.transaction(current => {
    if (!current || current.isSimulator !== true ||
        String(current.telegramId) !== String(playerId)) return;
    current.status = "registered";
    current.entryFee = fee;
    current.registeredAt = registration.registeredAt || registeredAt;
    current.completedAt = Date.now();
    current.paymentSource = "admin_wallet";
    current.adminTransactionId = registration.adminTransactionId || adminTransactionId;
    return current;
  });

  const mainRegistration = finalized.snapshot.val();
  if (!mainRegistration || mainRegistration.status !== "registered") {
    throw new Error("Simulator entry was charged, but registration finalization needs recovery.");
  }

  const registrationRef = db.ref(
    `simulatorTournaments/${tournamentDate}/registrations/${playerId}`
  );
  await registrationRef.transaction(existing => existing || ({
    playerId,
    username: account.username || account.displayName || playerId,
    tournamentDate,
    entryFee: fee,
    registeredAt: registration.registeredAt || registeredAt,
    paymentSource: "admin_wallet",
    adminTransactionId: registration.adminTransactionId || adminTransactionId,
    status: "registered"
  }));

  return true;
}

// Process due simulator registrations
async function processDueRegistrations() {
  try {
    const registrationDate = getAddisDate();

    const scheduleRef = db.ref(
      `simulatorSchedules/${registrationDate}`
    );

    let snapshot = await scheduleRef.once("value");

    if (!snapshot.exists()) {
      const prepared = await prepareDailySchedule();
      if (!prepared) return;

      snapshot = await scheduleRef.once("value");
    }

    const schedule = snapshot.val();
    if (!schedule) return;

    const tournamentSnapshot = await db
      .ref(`tournaments/${schedule.tournamentDate}`)
      .once("value");

    if (!tournamentSnapshot.exists()) return;

    const tournament = tournamentSnapshot.val();

    if (tournament.registrationOpen !== true) return;

    const now = Date.now();

    const closingTime = addisTimestamp(
      registrationDate,
      24,
      0
    );

    if (now >= closingTime) return;

    for (let i = 0; i < schedule.tasks.length; i++) {
      const task = schedule.tasks[i];

      if (
        task.status !== "pending" ||
        task.runAt > now
      ) {
        continue;
      }

      const taskRef = scheduleRef.child(`tasks/${i}`);

      // Claim the task to avoid duplicate processing
      const claim = await taskRef.transaction((current) => {
        if (!current || current.status !== "pending") {
          return;
        }

        current.status = "processing";
        current.claimedAt = Date.now();

        return current;
      });

      if (!claim.committed) continue;

      try {
        await registerSimulator(
          task.playerId,
          schedule.tournamentDate,
          Number(tournament.entryFee || ENTRY_FEE)
        );

        await taskRef.update({
          status: "completed",
          completedAt: Date.now()
        });

        console.log(
          `Simulator registration completed: ${task.playerId}`
        );

      } catch (error) {
        console.error(
          `Registration failed for ${task.playerId}:`,
          error.message
        );

        await taskRef.update({
          status: "failed",
          error: error.message,
          failedAt: Date.now()
        });
      }
    }

  } catch (error) {
    console.error("Simulator scheduler error:", error);
  }
}

function startSimulatorScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;

  console.log("Simulator registration scheduler started.");

  processDueRegistrations();

  setInterval(
    processDueRegistrations,
    CHECK_INTERVAL
  );
}

module.exports = {
  startSimulatorScheduler,
  prepareDailySchedule,
  processDueRegistrations
};
