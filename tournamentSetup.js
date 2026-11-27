const { db } = require("./firebase");

const {
  closeExpiredTournaments
} = require("./assignment");

const TIME_ZONE = "Africa/Addis_Ababa";
const ENTRY_FEE = 200;
const CHECK_INTERVAL = 60000;

let setupStarted = false;

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

function getTomorrowDate() {
  const [year, month, day] = getAddisDate()
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(year, month - 1, day + 1)
  ).toISOString().slice(0, 10);
}

async function ensureTomorrowTournament() {
  const tournamentDate = getTomorrowDate();
  const registrationDate = getAddisDate();

  const tournamentRef = db.ref(
    `tournaments/${tournamentDate}`
  );

  const tournament = {
    id: tournamentDate,
    tournamentDate,
    entryFee: ENTRY_FEE,
    registrationOpen: true,
    registrationDate,
    registrationClosesAt: addisTimestamp(
      registrationDate,
      24,
      0
    ),
    startsAt: addisTimestamp(
      tournamentDate,
      16,
      30
    ),
    status: "scheduled",
    createdAt: Date.now()
  };

  let created = false;

  const result = await tournamentRef.transaction(current => {
    if (!current) {
      created = true;
      return tournament;
    }

    created = false;

    // Reopen registration on the existing record without replacing
    // its registrations, payments, tournament settings, or other data.
    return {
      ...current,
      // Keep the existing tournament's entry fee aligned with the
      // configured fee used by human and simulator registration.
      entryFee: ENTRY_FEE,
      registrationOpen: true,
      registrationDate,
      registrationClosesAt: tournament.registrationClosesAt
    };
  });

  if (!result.committed) {
    throw new Error("Unable to create or update the tournament record.");
  }

  console.log(
    created
      ? `Tournament record created: ${tournamentDate}`
      : `Tournament registration confirmed open: ${tournamentDate}`
  );

  return result.snapshot.val();
}

async function runTournamentChecks() {
  try {
    await ensureTomorrowTournament();
    await closeExpiredTournaments();
  } catch (error) {
    console.error("Tournament check error:", error);
  }
}

function startTournamentSetup() {
  if (setupStarted) return;

  setupStarted = true;

  console.log("Daily tournament setup started.");

  runTournamentChecks();

  setInterval(() => {
    runTournamentChecks();
  }, CHECK_INTERVAL);
}

module.exports = {
  startTournamentSetup,
  ensureTomorrowTournament
};
