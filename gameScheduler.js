
const { db } = require("./firebase");

const {
  DRAW_INTERVAL_MS,
  createMatch,
  startMatch,
  callNextNumber,
  getMatchState
} = require("./gameEngine");

const CHECK_INTERVAL_MS = 5000;

let schedulerStarted = false;
let schedulerRunning = false;

const initializedMatches = new Set();

function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Addis_Ababa",
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

async function processScheduledMatches() {
  if (schedulerRunning) return;

  schedulerRunning = true;

  try {
    const tournamentDate = getAddisDate();

    const tournamentSnapshot = await db
      .ref(`tournaments/${tournamentDate}`)
      .once("value");

    if (!tournamentSnapshot.exists()) return;

    const tournament = tournamentSnapshot.val();

    if (
      tournament.status !== "assigned" ||
      !tournament.groups ||
      !tournament.assignmentsCreatedAt
    ) {
      return;
    }

    const groups = Object.values(tournament.groups);

    for (const group of groups) {
      if (
        !group ||
        !group.matchId ||
        !Array.isArray(group.players) ||
        group.players.length === 0
      ) {
        continue;
      }

      const matchKey = `${tournamentDate}_${group.matchId}`;

      try {
        // Create the match once. Existing matches are preserved.
        if (!initializedMatches.has(matchKey)) {
          await createMatch(tournamentDate, group);
          initializedMatches.add(matchKey);

          console.log(
            `Match ${group.groupNumber} initialized.`
          );
        }

        const scheduledTime = new Date(
          group.scheduledAt
        ).getTime();

        if (!Number.isFinite(scheduledTime)) {
          console.error(
            `Invalid schedule for group ${group.groupNumber}.`
          );
          continue;
        }

        if (Date.now() < scheduledTime) {
          continue;
        }

        // Start the match when its scheduled time arrives.
        await startMatch(
          tournamentDate,
          group.matchId
        );

        const state = await getMatchState(
          tournamentDate,
          group.matchId
        );

        if (!state || state.status !== "in_progress") {
          continue;
        }

        // Draw the next number.
        const result = await callNextNumber(
          tournamentDate,
          group.matchId
        );

        if (result && result.calledNumber) {
          console.log(
            `Group ${group.groupNumber}: called ${result.calledNumber}`
          );
        }

      } catch (error) {
        console.error(
          `Group ${group.groupNumber} scheduler error:`,
          error.message
        );
      }
    }

  } catch (error) {
    console.error("Game scheduler error:", error);
  } finally {
    schedulerRunning = false;
  }
}

function startGameScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;

  console.log("Automatic game scheduler started.");

  processScheduledMatches();

  setInterval(
    processScheduledMatches,
    CHECK_INTERVAL_MS
  );
}

module.exports = {
  startGameScheduler,
  processScheduledMatches
};
