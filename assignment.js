const crypto = require("crypto");
const { db } = require("./firebase");

const {
  createGroups,
  createGroupSchedule
} = require("./tournament");

const MIN_PLAYERS = 32;
const MAX_PLAYERS = 320;
const TIME_ZONE_OFFSET_HOURS = 3;

// Registration closes at 12:00 AM Addis Ababa time on the tournament date.
// Calculate it from the date itself instead of trusting a possibly missing
// or malformed Firebase registrationClosesAt field.
function getRegistrationDeadline(tournamentDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tournamentDate || ""))) {
    return null;
  }

  const [year, month, day] = tournamentDate.split("-").map(Number);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));

  if (
    dateCheck.getUTCFullYear() !== year ||
    dateCheck.getUTCMonth() !== month - 1 ||
    dateCheck.getUTCDate() !== day
  ) {
    return null;
  }

  return Date.UTC(year, month - 1, day, -TIME_ZONE_OFFSET_HOURS, 0, 0);
}

// The preliminary matches start at 4:30 PM Addis Ababa time.
function getDefaultTournamentStart(tournamentDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tournamentDate || ""))) {
    return null;
  }

  const [year, month, day] = tournamentDate.split("-").map(Number);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));

  if (
    dateCheck.getUTCFullYear() !== year ||
    dateCheck.getUTCMonth() !== month - 1 ||
    dateCheck.getUTCDate() !== day
  ) {
    return null;
  }

  return Date.UTC(year, month - 1, day, 16 - TIME_ZONE_OFFSET_HOURS, 30, 0);
}

function hasValidTimestamp(value) {
  const timestamp = Number(value);
  return value !== null && value !== undefined && value !== "" &&
    Number.isFinite(timestamp) && timestamp > 0;
}

// Assign a tournament once its Addis Ababa registration deadline has passed.
// The deadline is derived from the tournament date, so missing or stale
// registrationClosesAt data cannot silently prevent the assignment scan.
async function assignTournamentPlayers(tournamentDate) {
  const tournamentRef = db.ref(`tournaments/${tournamentDate}`);
  const deadline = getRegistrationDeadline(tournamentDate);

  if (deadline === null) {
    throw new Error(`Invalid tournament date: ${tournamentDate}`);
  }

  const result = await tournamentRef.transaction((current) => {
    if (!current) return;

    // A completed or already-attempted tournament must never be assigned twice.
    if (current.assignmentsCreatedAt || current.assignmentAttemptedAt) {
      return current;
    }

    // Always use the canonical midnight Addis Ababa deadline.
    if (Date.now() < deadline) {
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
    updated.registrationClosesAt = deadline;
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

    const startsAt = hasValidTimestamp(current.startsAt)
      ? Number(current.startsAt)
      : getDefaultTournamentStart(tournamentDate);

    if (!startsAt || !Number.isFinite(startsAt)) {
      updated.assignmentError =
        `Cannot create group schedule: invalid tournament start time for ${tournamentDate}.`;
      updated.status = "assignment_failed";
      return updated;
    }

    updated.startsAt = startsAt;

    const groups = createGroups(players);
    const schedule = createGroupSchedule(new Date(startsAt));

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
    console.error(`Assignment issue for ${tournamentDate}: ${tournament.assignmentError}`);
  } else if (tournament && Date.now() < deadline) {
    console.log(
      `Assignment for ${tournamentDate} is waiting until the midnight Addis Ababa registration deadline.`
    );
  }

  return tournament;
}

// Check every tournament record, not only records whose registrationOpen
// flag is true. Overdue assignments remain recoverable after restarts.
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

    const deadline = getRegistrationDeadline(tournamentDate);
    if (deadline === null) {
      console.error(`Skipping tournament with invalid date key: ${tournamentDate}`);
      continue;
    }

    if (deadline <= now) {
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
