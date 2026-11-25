
const { db } = require("./firebase");
const {
  registerPlayerForTournament
} = require("./registration");

const TIME_ZONE = "Africa/Addis_Ababa";
const MIN_SIMS = 55;
const MAX_SIMS = 75;
const CHECK_INTERVAL = 30000;

let schedulerStarted = false;

// Get date in Addis Ababa
function getAddisDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// Get tomorrow's date
function getTomorrowDate() {
  const today = getAddisDate();
  const [year, month, day] = today.split("-").map(Number);

  const tomorrow = new Date(
    Date.UTC(year, month - 1, day + 1)
  );

  return tomorrow.toISOString().slice(0, 10);
}

// Convert Addis local time to timestamp
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

// Random shuffle
function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

// Create daily schedule
function createDailySchedule(date, tournamentDate, simulatorIds) {
  const dailyTotal =
    Math.floor(Math.random() * 21) + MIN_SIMS;

  const selected = shuffle(simulatorIds).slice(
    0,
    dailyTotal
  );

  const tasks = [];

  // First batch: 8 sims at 2:30 PM
  for (let i = 0; i < 8; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(date, 14, 30),
      batch: "first",
      status: "pending"
    });
  }

  // Second batch: 13 sims at 4:25 PM
  for (let i = 8; i < 21; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(date, 16, 25),
      batch: "second",
      status: "pending"
    });
  }

  // Remaining sims: random times throughout the day
  for (let i = 21; i < dailyTotal; i++) {
    const randomMinute = Math.floor(
      Math.random() * 1440
    );

    tasks.push({
      playerId: selected[i],
      runAt: addisTimestamp(
        date,
        Math.floor(randomMinute / 60),
        randomMinute % 60
      ),
      batch: "random",
      status: "pending"
    });
  }

  tasks.sort((a, b) => a.runAt - b.runAt);

  return {
    registrationDate: date,
    tournamentDate,
    tournamentId: tournamentDate,
    dailyTotal,
    createdAt: Date.now(),
    tasks
  };
}

// Prepare today's simulator schedule
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

  // Tomorrow's tournament must already exist.
  const tournamentRef = db.ref(
    `tournaments/${tournamentDate}`
  );

  const tournamentSnapshot = await tournamentRef.once("value");

  if (!tournamentSnapshot.exists()) {
    console.log(
      `Tomorrow's tournament ${tournamentDate} is not configured yet.`
    );
    return null;
  }

  const tournament = tournamentSnapshot.val();

  if (
    tournament.id !== tournamentDate ||
    tournament.registrationOpen !== true ||
    tournament.tournamentDate !== tournamentDate
  ) {
    console.log("Tomorrow's tournament is not ready.");
    return null;
  }

  const playersSnapshot = await db
    .ref("players")
    .once("value");

  const players = playersSnapshot.val() || {};

  const simulatorIds = Object.entries(players)
    .filter(([id, player]) =>
      player &&
      player.isSimulator === true &&
      Number.isFinite(player.balance) &&
      player.balance >= Number(tournament.entryFee || 200) &&
      !(
        player.tournamentRegistrations &&
        player.tournamentRegistrations[tournamentDate]
      )
    )
    .map(([id]) => id);

  if (simulatorIds.length < MAX_SIMS) {
    console.error(
      `Need at least ${MAX_SIMS} eligible sims. Found ${simulatorIds.length}.`
    );
    return null;
  }

  const schedule = createDailySchedule(
    registrationDate,
    tournamentDate,
    simulatorIds
  );

  // Save only once. Do not generate a new random schedule
  // if the server restarts.
  const result = await scheduleRef.transaction((current) => {
    if (current) return current;
    return schedule;
  });

  console.log(
    `Prepared ${result.snapshot.val().dailyTotal} simulator registrations for ${tournamentDate}.`
  );

  return result.snapshot.val();
}

// Process registrations that are due
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

    const tournamentRef = db.ref(
      `tournaments/${schedule.tournamentDate}`
    );

    const tournamentSnapshot = await tournamentRef.once("value");

    if (!tournamentSnapshot.exists()) return;

    const tournament = tournamentSnapshot.val();

    if (
      tournament.registrationOpen !== true ||
      tournament.id !== schedule.tournamentId
    ) {
      return;
    }

    const now = Date.now();
    const registrationClosesAt = addisTimestamp(
      schedule.registrationDate,
      24,
      0
    );

    if (now >= registrationClosesAt) return;

    for (let i = 0; i < schedule.tasks.length; i++) {
      const task = schedule.tasks[i];

      if (
        task.status !== "pending" ||
        task.runAt > now
      ) {
        continue;
      }

      const taskRef = scheduleRef.child(`tasks/${i}`);

      try {
        await registerPlayerForTournament(
          task.playerId,
          tournament
        );

        await taskRef.update({
          status: "completed",
          completedAt: Date.now()
        });

        console.log(
          `Simulator registered: ${task.playerId}`
        );

      } catch (error) {
        console.error(
          `Simulator registration failed: ${task.playerId}`,
          error.message
        );
      }
    }

  } catch (error) {
    console.error("Simulator scheduler error:", error);
  }
}

// Start scheduler
function startSimulatorScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;

  console.log("Bingo Champions simulator scheduler started.");

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
