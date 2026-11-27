
const crypto = require("crypto");
const { db } = require("./firebase");

const GAME_SLOT_INTERVAL_MS = 10 * 60 * 1000;
const GAMES_PER_SLOT = 2;

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A one-player preliminary group is an automatic qualifier.
// Knockout-stage bye players are also carried forward without a match.
async function readCompletedWinners(tournamentDate, matchEntries, byePlayers = []) {
  const winners = [...(Array.isArray(byePlayers) ? byePlayers : [])];
  let latestCompletion = 0;

  for (const entry of matchEntries || []) {
    const participants = Array.isArray(entry.players) ? entry.players : [];
    if (participants.length === 0) continue;
    if (participants.length === 1) {
      winners.push(participants[0]);
      continue;
    }

    const snapshot = await db.ref(
      "tournaments/" + tournamentDate + "/matches/" + entry.matchId
    ).once("value");
    const match = snapshot.val();
    if (!match || match.status !== "completed" || !match.winner) return null;

    const winnerId = String(match.winner.telegramId);
    const player = participants.find(item =>
      String(item.telegramId) === winnerId
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

// Randomly pair players. If the count is not a power of two, randomly
// selected players receive byes so the remaining matches produce the
// next lower power-of-two bracket.
async function saveNextStage(
  tournamentDate, roundKey, roundLabel, players, firstGameAt
) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error("At least two players are required for " + roundLabel + ".");
  }

  const tournamentRef = db.ref("tournaments/" + tournamentDate);
  const stageRef = tournamentRef.child("bracket/rounds/" + roundKey);
  const shuffled = shuffle(players);
  const targetCount = Math.pow(2, Math.floor(Math.log2(shuffled.length - 1)));
  const byeCount = Math.max(0, (2 * targetCount) - shuffled.length);
  const byePlayers = shuffled.slice(0, byeCount);
  const pairedPlayers = shuffled.slice(byeCount);
  const matches = {};

  for (let i = 0; i < pairedPlayers.length; i += 2) {
    const matchId = crypto.randomUUID();
    const matchNumber = i / 2 + 1;
    const slotNumber = Math.floor((matchNumber - 1) / GAMES_PER_SLOT);
    const scheduledAt = firstGameAt + slotNumber * GAME_SLOT_INTERVAL_MS;

    matches[matchId] = {
      matchId,
      roundKey,
      roundLabel,
      matchNumber,
      slotNumber: slotNumber + 1,
      players: [pairedPlayers[i], pairedPlayers[i + 1]],
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
      scheduledAt: new Date(firstGameAt).toISOString(),
      byePlayers,
      matches
    };
  });

  const stage = result.snapshot.val();
  if (!stage || !stage.matches) {
    throw new Error("Unable to save " + roundLabel + ".");
  }

  const assignmentUpdates = {};
  for (const player of stage.byePlayers || []) {
    assignmentUpdates[
      "playerAssignments/" + String(player.telegramId)
    ] = {
      tournamentId: tournamentDate,
      roundKey,
      roundLabel,
      status: "bye_advanced",
      scheduledAt: stage.scheduledAt
    };
  }

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
    Object.keys(stage.matches).length + " matches, " +
    (stage.byePlayers || []).length + " random byes; " +
    GAMES_PER_SLOT + " games per 10-minute slot."
  );
  return stage;
}

async function stageIsComplete(tournamentDate, stage) {
  if (!stage || !stage.matches) return false;
  const entries = Object.values(stage.matches);
  if (!entries.length) return false;
  return Boolean(await readCompletedWinners(
    tournamentDate, entries, stage.byePlayers || []
  ));
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

  // Preliminary groups with one player qualify automatically. Groups with
  // two or more players must finish before their winner qualifies.
  if (!rounds.round32 && !rounds.playin) {
    const groups = Object.values(tournament.groups)
      .filter(group => group && Array.isArray(group.players) && group.players.length > 0);
    if (!groups.length) return;

    const groupResults = await readCompletedWinners(tournamentDate, groups);
    if (!groupResults || groupResults.winners.length < 20) return;

    const firstKnockoutAt = groupResults.latestCompletion > 0
      ? groupResults.latestCompletion + GAME_SLOT_INTERVAL_MS
      : Math.max(Date.now(), Number(tournament.startsAt) || Date.now());

    if (groupResults.winners.length === 32) {
      await saveNextStage(
        tournamentDate,
        "round32",
        "ROUND OF 32",
        groupResults.winners,
        firstKnockoutAt
      );
    } else {
      await saveNextStage(
        tournamentDate,
        "playin",
        "KNOCKOUT QUALIFIER",
        groupResults.winners,
        firstKnockoutAt
      );
    }
    return;
  }

  const progression = [
    { previous: "playin", next: "round16", label: "ROUND OF 16" },
    { previous: "round32", next: "round16", label: "ROUND OF 16" },
    { previous: "round16", next: "quarterfinals", label: "QUARTER-FINALS" },
    { previous: "quarterfinals", next: "semifinals", label: "SEMI-FINALS" }
  ];

  for (const step of progression) {
    bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
    rounds = bracket.rounds || {};
    if (rounds[step.next]) continue;

    const previousStage = rounds[step.previous];
    if (!previousStage) continue;

    const result = await readCompletedWinners(
      tournamentDate,
      Object.values(previousStage.matches || {}),
      previousStage.byePlayers || []
    );
    if (!result) return;

    await saveNextStage(
      tournamentDate,
      step.next,
      step.label,
      result.winners,
      result.latestCompletion + GAME_SLOT_INTERVAL_MS
    );
    return;
  }

  bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
  rounds = bracket.rounds || {};
  const semifinals = rounds.semifinals;

  if (semifinals && (!rounds.final || !Array.isArray(bracket.thirdPlacePlayers))) {
    const semiEntries = Object.values(semifinals.matches || {});
    const finalists = [];
    const jointThirdPlacePlayers = [];
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

      finalists.push(winner);
      jointThirdPlacePlayers.push(loser);
      latestCompletion = Math.max(
        latestCompletion,
        Number(match.completedAt || match.winner.claimedAt || 0)
      );
    }

    if (finalists.length !== 2 || jointThirdPlacePlayers.length !== 2) return;

    if (!rounds.final) {
      await saveNextStage(
        tournamentDate,
        "final",
        "GRAND FINAL",
        finalists,
        latestCompletion + GAME_SLOT_INTERVAL_MS
      );
    }

    const thirdPlaceUpdates = {};
    for (const player of jointThirdPlacePlayers) {
      thirdPlaceUpdates[
        "playerAssignments/" + String(player.telegramId)
      ] = {
        tournamentId: tournamentDate,
        roundKey: "thirdPlace",
        roundLabel: "JOINT 3RD PLACE",
        placement: 3,
        status: "completed",
        completedAt: latestCompletion
      };
    }

    await tournamentRef.update({
      "bracket/thirdPlacePlayers": jointThirdPlacePlayers,
      "bracket/thirdPlaceStatus": "shared",
      ...thirdPlaceUpdates
    });
    console.log("Third place shared by two semi-final losers for " + tournamentDate + ".");
    return;
  }

  bracket = (await tournamentRef.child("bracket").once("value")).val() || {};
  rounds = bracket.rounds || {};
  if (rounds.final && await stageIsComplete(tournamentDate, rounds.final)) {
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

module.exports = { processTournamentProgression };
