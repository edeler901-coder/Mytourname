
const crypto = require("crypto");
const { db } = require("./firebase");

const TIME_ZONE = "Africa/Addis_Ababa";
const MIN_SIMS = 55;
const MAX_SIMS = 75;
const ENTRY_FEE = 200;
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

  const simulatorSnapshot = await db
    .ref("simulators")
    .once("value");

  const simulators = simulatorSnapshot.val() || {};

  const eligibleIds = Object.entries(simulators)
    .filter(([id, account]) =>
      account &&
      account.isSimulator === true &&
      account.accountType === "simulator" &&
      Number.isFinite(account.balance) &&
      account.balance >= ENTRY_FEE &&
      !(
        account.simulatorRegistrations &&
        account.simulatorRegistrations[tournamentDate]
      )
    )
    .map(([id]) => id);

  if (eligibleIds.length < MIN_SIMS) {
    console.error(
      `Only ${eligibleIds.length} eligible simulators. At least ${MIN_SIMS} are required.`
    );
    return null;
  }

  const schedule = createDailySchedule(
    registrationDate,
    tournamentDate,
    eligibleIds
  );

  const result = await scheduleRef.transaction((current) => {
    if (current) return current;
    return schedule;
  });

  console.log(
    `Prepared ${result.snapshot.val().dailyTotal} simulator test registrations for ${tournamentDate}.`
  );

  return result.snapshot.val();
}

// Register one simulator using virtual balance only

async function registerSimulator(playerId, tournamentDate) {
  const accountRef = db.ref(`simulators/${playerId}`);
  const registeredAt = Date.now();

  // Deduct the entry fee from the simulator's virtual balance.
  const result = await accountRef.transaction((account) => {
    if (!account || account.isSimulator !== true) return;

    if (!Number.isFinite(account.balance)) return;

    if (!account.simulatorRegistrations) {
      account.simulatorRegistrations = {};
    }

    if (account.simulatorRegistrations[tournamentDate]) {
      return account;
    }

    if (account.balance < ENTRY_FEE) return;

    account.balance -= ENTRY_FEE;

    account.simulatorRegistrations[tournamentDate] = {
      tournamentDate,
      entryFee: ENTRY_FEE,
      registeredAt,
      status: "registered"
    };

    return account;
  });

  const account = result.snapshot.val();
  const registration =
    account?.simulatorRegistrations?.[tournamentDate];

  if (!registration) {
    throw new Error("Simulator registration failed.");
  }

  // Add simulator to the MAIN tournament registration list.
  const tournamentRegistrationRef = db.ref(
    `tournaments/${tournamentDate}/registrations/${playerId}`
  );

  const tournamentRegistration = await tournamentRegistrationRef.transaction(
    (existing) => {
      if (existing) {
        if (
          existing.isSimulator === true &&
          String(existing.telegramId) === String(playerId)
        ) {
          return existing;
        }

        return;
      }

      return {
        telegramId: String(playerId),
        playerId: String(playerId),
        username: account.username || account.displayName || String(playerId),
        tournamentId: tournamentDate,
        entryFee: ENTRY_FEE,
        registeredAt: registration.registeredAt,
        status: "registered",
        isSimulator: true
      };
    }
  );

  const mainRegistration = tournamentRegistration.snapshot.val();

  if (
    !mainRegistration ||
    mainRegistration.isSimulator !== true ||
    String(mainRegistration.telegramId) !== String(playerId)
  ) {
    throw new Error("Could not add simulator to the main tournament list.");
  }

  // Keep the separate simulator tournament history.
  const registrationRef = db.ref(
    `simulatorTournaments/${tournamentDate}/registrations/${playerId}`
  );

  await registrationRef.transaction((existing) => {
    if (existing) return existing;

    return {
      playerId,
      username: account.username || account.displayName || playerId,
      tournamentDate,
      entryFee: ENTRY_FEE,
      registeredAt: registration.registeredAt,
      status: "registered"
    };
  });

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
          schedule.tournamentDate
        );

        await taskRef.update({
          status: "completed",
          completedAt: Date.now()
        });

        console.log(
          `Simulator test registration completed: ${task.playerId}`
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

  console.log("Simulator test scheduler started.");

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
