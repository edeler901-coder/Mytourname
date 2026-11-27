
const crypto = require("crypto");
const { db } = require("./firebase");
const { createGroups, createGroupSchedule } = require("./tournament");

const MIN_PLAYERS = 20;
const MAX_PLAYERS = 320;

async function assignTournamentPlayers(tournamentDate) {
  const tournamentRef = db.ref("tournaments/" + tournamentDate);

  const result = await tournamentRef.transaction(current => {
    if (!current) return;
    if (current.assignmentsCreatedAt) return current;
    if (current.registrationOpen !== true) return current;
    if (Date.now() < Number(current.registrationClosesAt)) return current;

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
    updated.registrationClosedAt = Date.now();

    if (players.length < MIN_PLAYERS) {
      updated.status = "insufficient_players";
      updated.assignmentError =
        "Only " + players.length + " players registered. At least " +
        MIN_PLAYERS + " are required.";
      return updated;
    }

    if (players.length > MAX_PLAYERS) {
      updated.status = "capacity_exceeded";
      updated.assignmentError =
        "There are " + players.length + " registrations. Maximum capacity is " +
        MAX_PLAYERS + ".";
      return updated;
    }

    const groups = createGroups(players);
    const schedule = createGroupSchedule(new Date(Number(current.startsAt)));
    const savedGroups = {};
    const playerAssignments = {};
    const assignedAt = Date.now();

    groups.forEach(group => {
      const groupNumber = group.groupNumber;
      const scheduledAt = schedule[groupNumber - 1].startTime;
      const matchId = crypto.randomUUID();
      const playerCount = group.players.length;

      savedGroups[groupNumber] = {
        groupNumber,
        matchId,
        scheduledAt,
        status: playerCount === 0
          ? "empty"
          : playerCount === 1
            ? "auto_qualified"
            : "scheduled",
        autoQualifiedAt: playerCount === 1 ? assignedAt : null,
        players: group.players
      };

      group.players.forEach(player => {
        playerAssignments[player.telegramId] = {
          tournamentId: tournamentDate,
          groupNumber,
          matchId,
          scheduledAt,
          status: playerCount === 1 ? "auto_qualified" : "assigned"
        };
      });
    });

    updated.groups = savedGroups;
    updated.playerAssignments = playerAssignments;
    updated.totalPlayers = players.length;
    updated.totalGroups = groups.length;
    updated.autoQualifiedPlayers = groups
      .filter(group => group.players.length === 1).length;
    updated.preliminaryMatches = groups
      .filter(group => group.players.length > 1).length;
    updated.assignmentsCreatedAt = assignedAt;
    updated.status = "assigned";
    delete updated.assignmentError;
    return updated;
  });

  const tournament = result.snapshot.val();
  if (tournament && tournament.assignmentsCreatedAt) {
    console.log(
      "Assignments completed for " + tournamentDate + ": " +
      tournament.totalPlayers + " players; " +
      (tournament.preliminaryMatches || 0) + " preliminary matches; " +
      (tournament.autoQualifiedPlayers || 0) + " automatic qualifiers."
    );
  } else if (tournament && tournament.status === "insufficient_players") {
    console.log(tournament.assignmentError);
  } else if (tournament && tournament.status === "capacity_exceeded") {
    console.log(tournament.assignmentError);
  }
  return tournament;
}

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

module.exports = { assignTournamentPlayers, closeExpiredTournaments };
