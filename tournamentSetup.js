const { db } = require("./firebase");

const {
  closeExpiredTournaments
} = require("./assignment");

const TIME_ZONE = "Africa/Addis_Ababa";
const ENTRY_FEE = 200;
const CHECK_INTERVAL = 60000;

let setupStarted = false;
let checkRunning = false;

function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return `${values.year}-${values.month}-${values.day}`;
}

function addisTimestamp(date, hour, minute) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day, hour - 3, minute);
}

function getTomorrowDate() {
  const [year, month, day] = getAddisDate().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString().slice(0, 10);
}

async function ensureTomorrowTournament() {
  const tournamentDate = getTomorrowDate();
  const registrationDate = getAddisDate();
  const tournamentRef = db.ref(`tournaments/${tournamentDate}`);

  const newTournament = {
    id: tournamentDate,
    tournamentDate,
    entryFee: ENTRY_FEE,
    registrationOpen: true,
    registrationDate,
    registrationClosesAt: addisTimestamp(registrationDate, 24, 0),
    startsAt: addisTimestamp(tournamentDate, 16, 30),
    status: "scheduled",
    createdAt: Date.now()
  };

  let created = false;

  const result = await tournamentRef.transaction(current => {
    if (current) {
      // Never reopen a closed/assigned tournament or overwrite its registrations.
      created = false;
      return current;
    }

    created = true;
    return newTournament;
  });

  if (!result.committed) {
    throw new Error("Unable to create or confirm tomorrow's tournament.");
  }

  console.log(
    created
      ? `Tournament record created: ${tournamentDate}`
      : `Existing tournament preserved: ${tournamentDate}`
  );

  return result.snapshot.val();
}

async function runTournamentChecks() {
  if (checkRunning) return;
  checkRunning = true;

  try {
    // Creating tomorrow's registration must not block overdue assignments.
    try {
      await ensureTomorrowTournament();
    } catch (error) {
      console.error("Tomorrow tournament setup failed:", error);
    }

    // Always scan overdue tournament dates, even if tomorrow's setup failed.
    try {
      await closeExpiredTournaments();
    } catch (error) {
      console.error("Overdue tournament assignment scan failed:", error);
    }
  } finally {
    checkRunning = false;
  }
}

function startTournamentSetup() {
  if (setupStarted) return;

  setupStarted = true;
  console.log("Automatic daily tournament assignment started.");

  runTournamentChecks();
  setInterval(runTournamentChecks, CHECK_INTERVAL);
}

module.exports = {
  startTournamentSetup,
  ensureTomorrowTournament
};
