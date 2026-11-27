const crypto = require("crypto");
const { db } = require("./firebase");

const ROUND_DEFINITIONS = [
  { key: "round32", label: "ROUND OF 32", expectedPlayers: 32 },
  { key: "round16", label: "ROUND OF 16", expectedPlayers: 16 },
  { key: "quarterfinals", label: "QUARTER-FINALS", expectedPlayers: 8 },
  { key: "semifinals", label: "SEMI-FINALS", expectedPlayers: 4 }
];

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function readCompletedWinners(tournamentDate, matchEntries) {
  const winners = [];
  let latestCompletion = 0;

  for (const entry of matchEntries) {
    const snapshot = await db.ref(
      "tournaments/" + tournamentDate + "/matches/" + entry.matchId
    ).once("value");
    const match = snapshot.val();

    if (!match || match.status !== "completed" || !match.winner) {
      return null;
    }

    const winnerId = String(match.winner.telegramId);
    const player = (entry.players || []).find(
      item => String(item.telegramId) === winnerId
    );

    if (!player) {
      throw new Error("Winner is not a participant in match " + entry.matchId);
    }

    winners.push(player);
    latestCompletion = Math.max(
      latestCompletion,
      Number(match.completedAt || match.winner.claimedAt || 0)
    );
  }

  return { winners, latestCompletion };
}

async function saveNextStage(tournamentDate, roundKey, roundLabel, players, scheduledAt) {
  if (!Array.isArray(players) || players.length < 2 || players.length % 2 !== 0) {
    throw new Error("Invalid qualifier count for " + roundLabel + ".");
  }

  const tournamentRef = db.ref("tournaments/" + tournamentDate);
  const stageRef = tournamentRef.child("bracket/rounds/" + roundKey);
  const shuffled = shuffle(players);
  const matches = {};

  for (let i = 0; i < shuffled.length; i += 2) {
    const matchId = crypto.randomUUID();
    const matchNumber = i / 2 + 1;
    matches[matchId] = {
      matchId,
      roundKey,
      roundLabel,
      matchNumber,
      players: [shuffled[i], shuffled[i + 1]],
      scheduledAt: new Date(scheduledAt).toISOString(),
      status: "scheduled"
    };
  }

  const result = await stageRef.transaction(current => {
    if (current) return current;
    return {
      key: roundKey,
      label: roundLabel,
      status: "scheduled",
      createdAt: Date.now(),
      scheduledAt,
      matches
    };
  });

  const stage = result.snapshot.val();
  if (!stage || !stage.matches) {
    throw new Error("Unable to save " + roundLabel + ".");
  }

  // Keep the player's current assignment pointed at their next match.
  const assignmentUpdates = {};
  for (const match of Object.values(stage.matches)) {
    for (const player of match.players || []) {
      assignmentUpdates[
        "playerAssignments/" + String(player.telegramId)
      ] = {
        tournamentId: tournamentDate,
        matchId: match.matchId,
        roundKey,
        roundLabel,
        matchNumber: match.matchNumber,
        scheduledAt: match.scheduledAt,
        status: "assigned"
      };
    }
  }

  if (Object.keys(assignmentUpdates).length) {
    await tournamentRef.update(assignmentUpdates);
  }

  console.log(
    roundLabel + " created for " + tournamentDate + ": " +
    Object.keys(stage.matches).length + " matches."
  );

  return stage;
}

async function stageIsComplete(tournamentDate, stage) {
  if (!stage || !stage.matches) return false;
  const entries = Object.values(stage.matches);
  if (!entries.length) return false;

  const result = await readCompletedWinners(tournamentDate, entries);
  return Boolean(result);
}

async function processTournamentProgression(tournamentDate) {
  const tournamentRef = db.ref("tournaments/" + tournamentDate);
  const tournamentSnapshot = await tournamentRef.once("value");
  const tournament = tournamentSnapshot.val();

  if (!tournament || tournament.status !== "assigned" ||
      !tournament.assignmentsCreatedAt || !tournament.groups) {
    return;
  }

  let bracket = tournament.bracket || {};
  let rounds = bracket.rounds || {};

  // The 32 preliminary group winners create the Round of 32.
  if (!rounds.round32) {
    const groups = Object.values(tournament.groups);
    if (groups.length !== 32) return;

    const groupResults = await readCompletedWinners(
      tournamentDate,
      groups
    );
    if (!groupResults || groupResults.winners.length !== 32) return;

    await saveNextStage(
      tournamentDate,
      "round32",
      "ROUND OF 32",
      groupResults.winners,
      groupResults.latestCompletion + 60000
    );

    return;
  }

  const progression = [
    { previous: "round32", next: "round16", label: "ROUND OF 16" },
    { previous: "round16", next: "quarterfinals", label: "QUARTER-FINALS" },
    { previous: "quarterfinals", next: "semifinals", label: "SEMI-FINALS" }
  ];

  for (const step of progression) {
    bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
    rounds = bracket.rounds || {};

    if (rounds[step.next]) continue;
    const previousStage = rounds[step.previous];
    if (!previousStage) return;

    const result = await readCompletedWinners(
      tournamentDate,
      Object.values(previousStage.matches || {})
    );
    if (!result) return;

    await saveNextStage(
      tournamentDate,
      step.next,
      step.label,
      result.winners,
      result.latestCompletion + 60000
    );
    return;
  }

  // After both semi-finals, create the final and third-place match.
  bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
  rounds = bracket.rounds || {};
  const semifinals = rounds.semifinals;

  if (semifinals && (!rounds.final || !rounds.thirdPlace)) {
    const semiEntries = Object.values(semifinals.matches || {});
    const winners = [];
    const losers = [];
    let latestCompletion = 0;

    for (const entry of semiEntries) {
      const snapshot = await db.ref(
        "tournaments/" + tournamentDate + "/matches/" + entry.matchId
      ).once("value");
      const match = snapshot.val();

      if (!match || match.status !== "completed" || !match.winner) return;

      const winnerId = String(match.winner.telegramId);
      const winner = (entry.players || []).find(
        player => String(player.telegramId) === winnerId
      );
      const loser = (entry.players || []).find(
        player => String(player.telegramId) !== winnerId
      );

      if (!winner || !loser) {
        throw new Error("Semi-final result has invalid participants.");
      }

      winners.push(winner);
      losers.push(loser);
      latestCompletion = Math.max(
        latestCompletion,
        Number(match.completedAt || match.winner.claimedAt || 0)
      );
    }

    if (winners.length !== 2 || losers.length !== 2) return;

    if (!rounds.final) {
      await saveNextStage(
        tournamentDate, "final", "GRAND FINAL", winners,
        latestCompletion + 60000
      );
    }
    if (!rounds.thirdPlace) {
      await saveNextStage(
        tournamentDate, "thirdPlace", "THIRD-PLACE MATCH", losers,
        latestCompletion + 60000
      );
    }
    return;
  }

  // Finish the tournament only after the final and third-place match end.
  bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
  rounds = bracket.rounds || {};
  if (rounds.final && rounds.thirdPlace) {
    const finalComplete = await stageIsComplete(tournamentDate, rounds.final);
    const thirdComplete = await stageIsComplete(tournamentDate, rounds.thirdPlace);

    if (finalComplete && thirdComplete) {
      await tournamentRef.transaction(current => {
        if (!current || current.status === "completed") return current;
        current.status = "completed";
        current.completedAt = Date.now();
        current.bracket = current.bracket || {};
        current.bracket.status = "completed";
        return current;
      });
      console.log("Tournament progression completed:", tournamentDate);
    }
  }
}

module.exports = { processTournamentProgression };
