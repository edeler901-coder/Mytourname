
const { db } = require("./firebase");
const bot = require("./bot");

const {
  DRAW_INTERVAL_MS,
  createMatch,
  openBoardSelection,
  startMatch,
  callNextNumber,
  getMatchState
} = require("./gameEngine");

const CHECK_INTERVAL_MS = 1000;

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

      try {
        const matchKey = `${tournamentDate}_${group.matchId}`;

        // Initialize match without overwriting existing data.
        if (!initializedMatches.has(matchKey)) {
          await createMatch(tournamentDate, group);
          initializedMatches.add(matchKey);

          console.log(
            `Group ${group.groupNumber}: match initialized.`
          );
        }

        const scheduledTime = new Date(
          group.scheduledAt
        ).getTime();

        if (!Number.isFinite(scheduledTime)) {
          console.error(
            `Group ${group.groupNumber}: invalid scheduled time.`
          );
          continue;
        }

        if (Date.now() < scheduledTime) {
          continue;
        }

        // Open the 100-second board selection window.
        await openBoardSelection(
          tournamentDate,
          group.matchId
        );

        let state = await getMatchState(
          tournamentDate,
          group.matchId
        );

        if (!state) continue;

        if (state.status === "board_selection") {
          const noticeRef = db.ref("tournaments/" + tournamentDate + "/matches/" + group.matchId + "/notificationFlags/selection");
          const notice = await noticeRef.transaction(current => current || Date.now());
          if (notice.committed) {
            for (const player of (state.players || [])) {
              if (player && player.telegramId) {
                await bot.notifyPlayer(player.telegramId, "🎮 Your Group " + group.groupNumber + " match is open. Choose your Bingo board now. You have 100 seconds.");
              }
            }
          }
        }

        // Start only after board selection has closed.
        if (state.status === "board_selection") {
          if (
            Date.now() >= Number(state.selectionEndsAt)
          ) {
            await startMatch(
              tournamentDate,
              group.matchId
            );

            state = await getMatchState(
              tournamentDate,
              group.matchId
            );
          }
        }

        if (state && state.status === "in_progress") {
          const noticeRef = db.ref("tournaments/" + tournamentDate + "/matches/" + group.matchId + "/notificationFlags/started");
          const notice = await noticeRef.transaction(current => current || Date.now());
          if (notice.committed) {
            for (const player of (state.players || [])) {
              if (player && player.telegramId) {
                await bot.notifyPlayer(player.telegramId, "🔔 Your Group " + group.groupNumber + " Bingo match has started. Good luck!");
              }
            }
          }
        }

        // Only draw numbers while the match is active.
        if (!state || state.status !== "in_progress") {
          continue;
        }

        // Respect the five-second interval between draws.
        const lastCalledAt = state.lastCalledNumber
          ? Number(state.lastCalledNumber.calledAt)
          : 0;

        if (
          lastCalledAt > 0 &&
          Date.now() - lastCalledAt < DRAW_INTERVAL_MS
        ) {
          continue;
        }

        const result = await callNextNumber(
          tournamentDate,
          group.matchId
        );

        if (result) {
          console.log(
            `Group ${group.groupNumber}: called ${result.letter}-${result.number}`
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
