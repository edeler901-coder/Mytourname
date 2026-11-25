
const crypto = require("crypto");
const { db } = require("./firebase");

const {
  createGroups,
  createGroupSchedule
} = require("./tournament");

const MIN_PLAYERS = 32;
const MAX_PLAYERS = 320;

// Assign players after registration closes
async function assignTournamentPlayers(tournamentDate) {
  const tournamentRef = db.ref(`tournaments/${tournamentDate}`);

  const result = await tournamentRef.transaction((current) => {
    if (!current) return;

    // Never assign the same tournament twice
    if (current.assignmentsCreatedAt) return current;

    if (current.registrationOpen !== true) return current;

    if (Date.now() < Number(current.registrationClosesAt)) {
      return current;
    }

    const registrations = current.registrations || {};

    const players = Object.entries(registrations)
      .filter(([id, registration]) =>
        registration &&
        registration.status === "registered" &&
        String(registration.telegramId || id) === String(id)
      )
      .map(([id, registration]) => ({
        telegramId: String(id),
        registeredAt: registration.registeredAt || null
      }));

    const updated = JSON.parse(JSON.stringify(current));

    updated.registrationOpen = false;
    updated.registrationClosedAt = Date.now();

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

    return updated;
  });

  const tournament = result.snapshot.val();

  if (tournament?.assignmentsCreatedAt) {
    console.log(
      `Assignments completed for ${tournamentDate}: ${tournament.totalPlayers} players.`
    );
  } else if (tournament?.status === "insufficient_players") {
    console.log(tournament.assignmentError);
  } else if (tournament?.status === "capacity_exceeded") {
    console.log(tournament.assignmentError);
  }

  return tournament;
}

// Find tournaments whose registration deadline has passed
async function closeExpiredTournaments() {
  const snapshot = await db.ref("tournaments").once("value");

  if (!snapshot.exists()) return;

  const tournaments = snapshot.val();
  const now = Date.now();

  for (const tournamentDate of Object.keys(tournaments)) {
    const tournament = tournaments[tournamentDate];

    if (
      tournament &&
      tournament.registrationOpen === true &&
      Number(tournament.registrationClosesAt) <= now
    ) {
      await assignTournamentPlayers(tournamentDate);
    }
  }
}

module.exports = {
  assignTournamentPlayers,
  closeExpiredTournaments
};
