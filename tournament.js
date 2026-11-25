
const crypto = require("crypto");

// Tournament settings
const ENTRY_FEE = 200;
const TOTAL_GROUPS = 32;
const GROUP_INTERVAL_MINUTES = 10;

const PRIZE_SPLIT = {
  first: 50,
  second: 30,
  third: 10,
  house: 10
};

// Randomly shuffle players
function shufflePlayers(players) {
  const shuffled = [...players];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);

    [shuffled[i], shuffled[j]] = [
      shuffled[j],
      shuffled[i]
    ];
  }

  return shuffled;
}

// Divide players into 32 balanced groups
function createGroups(players) {
  if (!Array.isArray(players) || players.length < TOTAL_GROUPS) {
    throw new Error("At least 32 players are required.");
  }

  const shuffled = shufflePlayers(players);

  const groups = Array.from(
    { length: TOTAL_GROUPS },
    (_, index) => ({
      groupNumber: index + 1,
      players: []
    })
  );

  shuffled.forEach((player, index) => {
    groups[index % TOTAL_GROUPS].players.push(player);
  });

  return groups;
}

// Create preliminary round schedule
function createGroupSchedule(startTime) {
  const schedule = [];

  for (let i = 0; i < TOTAL_GROUPS; i++) {
    const gameTime = new Date(
      startTime.getTime() +
      i * GROUP_INTERVAL_MINUTES * 60 * 1000
    );

    schedule.push({
      groupNumber: i + 1,
      startTime: gameTime.toISOString(),
      status: "scheduled"
    });
  }

  return schedule;
}

// Random knockout pairings
function createPairings(qualifiers) {
  if (!Array.isArray(qualifiers) || qualifiers.length < 2) {
    throw new Error("At least two qualifiers are required.");
  }

  const shuffled = shufflePlayers(qualifiers);
  const matches = [];

  for (let i = 0; i < shuffled.length; i += 2) {
    matches.push({
      matchId: crypto.randomUUID(),
      player1: shuffled[i],
      player2: shuffled[i + 1] || null,
      winner: null,
      status: "scheduled"
    });
  }

  return matches;
}

// Calculate tournament prizes
function calculatePrizes(totalPot) {
  return {
    first: totalPot * PRIZE_SPLIT.first / 100,
    second: totalPot * PRIZE_SPLIT.second / 100,
    third: totalPot * PRIZE_SPLIT.third / 100,
    house: totalPot * PRIZE_SPLIT.house / 100
  };
}

module.exports = {
  ENTRY_FEE,
  TOTAL_GROUPS,
  PRIZE_SPLIT,
  createGroups,
  createGroupSchedule,
  createPairings,
  calculatePrizes
};
