
const { db } = require("./firebase");
const {
  registerPlayerForTournament
} = require("./registration");

const TIME_ZONE = "Africa/Addis_Ababa";
const MIN_DAILY_SIMS = 55;
const MAX_DAILY_SIMS = 75;
const CHECK_INTERVAL = 30 * 1000;

let schedulerStarted = false;

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

// Convert Addis Ababa local time to timestamp.
// Ethiopia uses UTC+3.
function addisTimeToTimestamp(date, hour, minute) {
  const [year, month, day] = date.split("-").map(Number);

  return Date.UTC(
    year,
    month - 1,
    day,
    hour - 3,
    minute
  );
}

// Randomly shuffle accounts
function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

// Generate random daily registration schedule
function createDailySchedule(date, simulatorIds) {
  const dailyTotal =
    Math.floor(
      Math.random() *
      (MAX_DAILY_SIMS - MIN_DAILY_SIMS + 1)
    ) + MIN_DAILY_SIMS;

  const selected = shuffle(simulatorIds).slice(
    0,
    dailyTotal
  );

  const tasks = [];

  // First batch: 8 sims at 2:30 PM
  for (let i = 0; i < 8; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimeToTimestamp(date, 14, 30),
      status: "pending"
    });
  }

  // Second batch: 13 sims at 4:25 PM
  for (let i = 8; i < 21; i++) {
    tasks.push({
      playerId: selected[i],
      runAt: addisTimeToTimestamp(date, 16, 25),
      status: "pending"
    });
  }

  // Remaining sims register at random times
  // throughout the day until midnight.
  for (let i = 21; i < dailyTotal; i++) {
    const randomMinute = Math.floor(
      Math.random() * (24 * 60)
    );

    const hour = Math.floor(randomMinute / 60);
    const minute = randomMinute % 60;

    tasks.push({
      playerId: selected[i],
      runAt: addisTimeToTimestamp(
        date,
        hour,
        minute
      ),
      status: "pending"
    });
  }

  tasks.sort((a, b) => a.runAt - b.runAt);

  return {
    date,
    dailyTotal,
    tournamentId: null,
    createdAt: Date.now(),
    tasks
  };
}

// Create or retrieve today's schedule
async function prepareDailySchedule() {
  const date = getAddisDate();

  const scheduleRef = db.ref(
    `simulatorSchedules/${date}`
  );

  const existing = await scheduleRef.once("value");

  if (existing.exists()) {
    return existing.val();
  }

  const tournamentSnapshot = await db
    .ref("tournaments/current")
    .once("value");

  if (!tournamentSnapshot.exists()) {
    console.log("No current tournament configured.");
    return null;
  }

  const tournament = tournamentSnapshot.val();

  if (tournament.registrationOpen !== true) {
    console.log("Tournament registration is closed.");
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
      player.balance >= Number(tournament.entryFee || 200)
    )
    .map(([id]) => id);

  if (simulatorIds.length < MAX_DAILY_SIMS) {
    console.error(
      `Need at least ${MAX_DAILY_SIMS} eligible simulator accounts. Found ${simulatorIds.length}.`
    );

    return null;
  }

  const schedule = createDailySchedule(
    date,
    simulatorIds
  );

  schedule.tournamentId = String(
    tournament.id || "current"
  );

  const result = await scheduleRef.transaction(
    (current) => {
      if (current) return current;
      return schedule;
    }
  );

  const savedSchedule = result.snapshot.val();

  console.log(
    `Simulator schedule ready: ${savedSchedule.dailyTotal} registrations for ${date}.`
  );

  return savedSchedule;
}

// Process registrations whose scheduled time has arrived
async function processDueRegistrations() {
  try {
    const date = getAddisDate();

    const scheduleRef = db.ref(
      `simulatorSchedules/${date}`
    );

    const snapshot = await scheduleRef.once("value");

    if (!snapshot.exists()) {
      await prepareDailySchedule();
      return;
    }

    const schedule = snapshot.val();

    const tournamentSnapshot = await db
      .ref("tournaments/current")
      .once("value");

    if (!tournamentSnapshot.exists()) return;

    const tournament = tournamentSnapshot.val();

    if (tournament.registrationOpen !== true) return;

    const currentTournamentId = String(
      tournament.id || "current"
    );

    if (currentTournamentId !== schedule.tournamentId) {
      console.error("Tournament ID does not match today's simulator schedule.");
      return;
    }

    const now = Date.now();

    for (let i = 0; i < schedule.tasks.length; i++) {
      const task = schedule.tasks[i];

      if (
        task.status !== "pending" ||
        task.runAt > now
      ) {
        continue;
      }

      const taskRef = scheduleRef
        .child(`tasks/${i}`);

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
          `Simulator registration failed for ${task.playerId}:`,
          error.message
        );
      }
    }

  } catch (error) {
    console.error(
      "Simulator scheduler error:",
      error
    );
  }
}

// Start scheduler
function startSimulatorScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;

  console.log("Simulator scheduler started.");

  // Check immediately
  processDueRegistrations();

  // Check every 30 seconds
  setInterval(
    processDueRegistrations,
    CHECK_INTERVAL
  );
}

module.exports = {
  startSimulatorScheduler
};
