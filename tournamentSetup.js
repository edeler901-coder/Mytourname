
const { db } = require("./firebase");

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

  const result = await tournamentRef.transaction((current) => {
    if (current) return current;
    return tournament;
  });

  if (result.committed) {
    console.log(
      `Tournament record created: ${tournamentDate}`
    );
  } else {
    console.log(
      `Tournament record already exists: ${tournamentDate}`
    );
  }

  return result.snapshot.val();
}

function startTournamentSetup() {
  if (setupStarted) return;

  setupStarted = true;

  console.log("Daily tournament setup started.");

  ensureTomorrowTournament().catch((error) => {
    console.error("Tournament setup error:", error);
  });

  setInterval(() => {
    ensureTomorrowTournament().catch((error) => {
      console.error("Tournament setup error:", error);
    });
  }, CHECK_INTERVAL);
}

module.exports = {
  startTournamentSetup,
  ensureTomorrowTournament
};
