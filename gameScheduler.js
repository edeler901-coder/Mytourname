
const { db } = require("./firebase");
const bot = require("./bot");

const {
  DRAW_INTERVAL_MS,
  createMatch,
  openBoardSelection,
  startMatch,
  callNextNumber,
  getMatchState,
  getBoardSelectionState,
  selectBoard,
  verifyBingo,
  claimWinner
} = require("./gameEngine");

const { processTournamentProgression } = require("./tournamentProgression");

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

    const preliminaryMatches = Object.values(tournament.groups);
    const knockoutMatches = Object.values(tournament.bracket?.rounds || {})
      .flatMap(stage => Object.values(stage.matches || {}));
    const allMatches = [...preliminaryMatches, ...knockoutMatches];

    for (const group of allMatches) {
      if (
        !group ||
        !group.matchId ||
        !Array.isArray(group.players) ||
        group.players.length === 0
      ) {
        continue;
      }

      const matchLabel = group.roundLabel || ("Group " + group.groupNumber);

      try {
        const matchKey = `${tournamentDate}_${group.matchId}`;

        // Initialize match without overwriting existing data.
        if (!initializedMatches.has(matchKey)) {
          await createMatch(tournamentDate, group);
          initializedMatches.add(matchKey);

          console.log(
            `${matchLabel}: match initialized.`
          );
        }

        const scheduledTime = new Date(
          group.scheduledAt
        ).getTime();

        if (!Number.isFinite(scheduledTime)) {
          console.error(
            `${matchLabel}: invalid scheduled time.`
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
          // Simulator opponents choose a free permanent board during the same 100-second window.
          for (const player of (state.players || []).filter(item => item && item.isSimulator === true)) {
            try {
              const selection = await getBoardSelectionState(
                tournamentDate,
                group.matchId,
                player.telegramId
              );
              if (!selection.selectedBoardNumber) {
                const available = selection.availableBoards.filter(board => board.available);
                if (available.length) {
                  const board = available[require("crypto").randomInt(available.length)];
                  await selectBoard(tournamentDate, group.matchId, player.telegramId, board.boardNumber);
                }
              }
            } catch (error) {
              console.error("Simulator board selection failed:", player.telegramId, error.message);
            }
          }

          const noticeRef = db.ref("tournaments/" + tournamentDate + "/matches/" + group.matchId + "/notificationFlags/selection");
          const notificationTime = Date.now();
          const notice = await noticeRef.transaction(current => current || notificationTime);
          if (notice.committed && notice.snapshot.val() === notificationTime) {
            for (const player of (state.players || [])) {
              if (player && player.telegramId && player.isSimulator !== true) {
                await bot.notifyPlayer(player.telegramId, "🎮 Your " + matchLabel + " match is open. Choose your Bingo board now. You have 100 seconds.");
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
          const notificationTime = Date.now();
          const notice = await noticeRef.transaction(current => current || notificationTime);
          if (notice.committed && notice.snapshot.val() === notificationTime) {
            for (const player of (state.players || [])) {
              if (player && player.telegramId && player.isSimulator !== true) {
                await bot.notifyPlayer(player.telegramId, "🔔 Your " + matchLabel + " Bingo match has started. Good luck!");
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
            `${matchLabel}: called ${result.letter}-${result.number}`
          );

          // Simulator opponents use the same server-side winning-pattern verification as humans.
          for (const player of (state.players || []).filter(item => item && item.isSimulator === true)) {
            try {
              const verification = await verifyBingo(
                tournamentDate,
                group.matchId,
                player.telegramId
              );
              if (verification.valid) {
                const winner = await claimWinner(
                  tournamentDate,
                  group.matchId,
                  player.telegramId
                );
                console.log(
                  `Simulator ${player.telegramId} claimed Bingo in ${matchLabel}.`
                );
                if (winner) break;
              }
            } catch (error) {
              if (!String(error.message || "").includes("already has a winner")) {
                console.error("Simulator Bingo check failed:", player.telegramId, error.message);
              }
            }
          }
        }

      } catch (error) {
        console.error(
          `${matchLabel} scheduler error:`,
          error.message
        );
      }
    }

    // Create the next knockout stage only after every match in the
    // current stage has a confirmed winner.
    await processTournamentProgression(tournamentDate);

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
