const crypto = require("crypto");
const { db } = require("./firebase");

const {
  createGroups,
  createGroupSchedule
} = require("./tournament");

const MIN_PLAYERS = 32;
const MAX_PLAYERS = 320;

// Assign a tournament once its registration deadline has passed.
// This also recovers tournaments missed by an earlier scheduler run.
async function assignTournamentPlayers(tournamentDate) {
  const tournamentRef = db.ref(`tournaments/${tournamentDate}`);

  const result = await tournamentRef.transaction((current) => {
    if (!current) return;

    // A completed or already-attempted tournament must never be assigned twice.
    if (current.assignmentsCreatedAt || current.assignmentAttemptedAt) {
      return current;
    }

    const closesAt = Number(current.registrationClosesAt);
    if (!Number.isFinite(closesAt) || Date.now() < closesAt) {
      return current;
    }

    if (current.status === "cancelled") return current;

    const registrations = current.registrations || {};
    const players = Object.entries(registrations)
      .filter(([id, registration]) =>
        registration &&
        registration.status === "registered" &&
        String(registration.telegramId || id) === String(id)
      )
      .map(([id, registration]) => ({
        telegramId: String(id),
        registeredAt: registration.registeredAt || null,
        isSimulator: registration.isSimulator === true,
        displayName: registration.displayName || registration.username || null
      }));

    const updated = JSON.parse(JSON.stringify(current));
    updated.registrationOpen = false;
    updated.registrationClosedAt = updated.registrationClosedAt || Date.now();
    updated.assignmentAttemptedAt = Date.now();
    updated.assignmentPlayerCount = players.length;

    if (players.length < MIN_PLAYERS) {
      updated.status = "insufficient_players";
      updated.assignmentError =
        `Only ${players.length} players registered. At least ${MIN_PLAYERS} are required.`;
      return updated;
    }

    if (players.length > MAX_PLAYERS) {
      updated.status = "capacity_exceeded";
      updated.assignmentError =
        `There are ${players.length} registrations. Maximum capacity is ${MAX_PLAYERS}.`;
      return updated;
    }

    const groups = createGroups(players);
    const schedule = createGroupSchedule(
      new Date(Number(current.startsAt))
    );

    const savedGroups = {};
    const playerAssignments = {};

    groups.forEach((group, index) => {
      const groupNumber = group.groupNumber;
      const scheduledAt = schedule[index].startTime;
      const matchId = crypto.randomUUID();

      savedGroups[groupNumber] = {
        groupNumber,
        matchId,
        scheduledAt,
        status: "scheduled",
        players: group.players
      };

      group.players.forEach((player) => {
        playerAssignments[player.telegramId] = {
          tournamentId: tournamentDate,
          groupNumber,
          matchId,
          scheduledAt,
          status: "assigned"
        };
      });
    });

    updated.groups = savedGroups;
    updated.playerAssignments = playerAssignments;
    updated.totalPlayers = players.length;
    updated.totalGroups = groups.length;
    updated.assignmentsCreatedAt = Date.now();
    updated.status = "assigned";
    delete updated.assignmentError;

    return updated;
  });

  const tournament = result.snapshot.val();

  if (tournament?.assignmentsCreatedAt) {
    console.log(
      `Assignments completed for ${tournamentDate}: ${tournament.totalPlayers} players in ${tournament.totalGroups} groups.`
    );
  } else if (tournament?.assignmentError) {
    console.log(tournament.assignmentError);
  }

  return tournament;
}

// Check every tournament record, not only records whose registrationOpen
// flag is true. This makes overdue assignments recoverable after restarts
// or a missed/incorrect registration flag.
async function closeExpiredTournaments() {
  const snapshot = await db.ref("tournaments").once("value");
  if (!snapshot.exists()) return;

  const tournaments = snapshot.val() || {};
  const now = Date.now();

  for (const [tournamentDate, tournament] of Object.entries(tournaments)) {
    if (!tournament ||
        tournament.assignmentsCreatedAt ||
        tournament.assignmentAttemptedAt ||
        tournament.status === "cancelled") {
      continue;
    }

    const closesAt = Number(tournament.registrationClosesAt);
    if (Number.isFinite(closesAt) && closesAt <= now) {
      try {
        await assignTournamentPlayers(tournamentDate);
      } catch (error) {
        console.error(
          `Assignment failed for ${tournamentDate}:`,
          error
        );
      }
    }
  }
}

module.exports = {
  assignTournamentPlayers,
  closeExpiredTournaments
};
