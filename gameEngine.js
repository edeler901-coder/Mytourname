
const crypto = require("crypto");
const { db } = require("./firebase");

// =====================================
// BINGO CHAMPIONS - GAME ENGINE
// =====================================

const TOTAL_NUMBERS = 75;
const DRAW_INTERVAL_MS = 5000;

const COLUMNS = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75]
};

// Shuffle an array securely
function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

// Generate one unique 5x5 Bingo card
function generateCard() {
  const card = {};

  for (const [letter, range] of Object.entries(COLUMNS)) {
    const numbers = [];

    for (let i = range[0]; i <= range[1]; i++) {
      numbers.push(i);
    }

    card[letter] = shuffle(numbers).slice(0, 5);
  }

  // Centre space is FREE
  card.N[2] = 0;

  return card;
}

// Generate all 75 numbers
function generateNumberPool() {
  const numbers = [];

  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    numbers.push(i);
  }

  return shuffle(numbers);
}

// Get the letter for a called number
function getLetter(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

// =====================================
// CREATE MATCH
// =====================================

async function createMatch(tournamentDate, group) {
  if (
    !tournamentDate ||
    !group ||
    !group.matchId ||
    !Array.isArray(group.players)
  ) {
    throw new Error("Invalid match information.");
  }

  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${group.matchId}`
  );

  const existing = await matchRef.once("value");

  if (existing.exists()) {
    return existing.val();
  }

  const cards = {};

  group.players.forEach((player) => {
    const telegramId = String(player.telegramId);

    cards[telegramId] = generateCard();
  });

  const match = {
    matchId: group.matchId,
    tournamentDate,
    groupNumber: group.groupNumber,
    scheduledAt: group.scheduledAt,
    status: "scheduled",
    players: group.players,
    drawnNumbers: [],
    numberPool: generateNumberPool(),
    winner: null,
    createdAt: Date.now()
  };

  // Save match information
  await matchRef.set(match);

  // Save cards separately from public match information
  await matchRef.child("privateCards").set(cards);

  console.log(
    `Match created: Group ${group.groupNumber}`
  );

  return match;
}

// =====================================
// START MATCH
// =====================================

async function startMatch(tournamentDate, matchId) {
  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const result = await matchRef.transaction((match) => {
    if (!match || match.status !== "scheduled") {
      return;
    }

    if (Date.now() < new Date(match.scheduledAt).getTime()) {
      return;
    }

    match.status = "in_progress";
    match.startedAt = Date.now();

    return match;
  });

  if (!result.committed) {
    return false;
  }

  console.log(`Match started: ${matchId}`);

  return true;
}

// =====================================
// CALL NEXT NUMBER
// =====================================


async function callNextNumber(tournamentDate, matchId) {
  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const matchSnapshot = await matchRef.once("value");
  const match = matchSnapshot.val();

  if (!match || match.status !== "in_progress") {
    throw new Error("Match is not active.");
  }

  let drawnNumber = null;

  const poolRef = matchRef.child("numberPool");

  const result = await poolRef.transaction((pool) => {
    if (!Array.isArray(pool) || pool.length === 0) {
      return;
    }

    drawnNumber = pool[0];

    return pool.slice(1);
  });

  if (!result.committed || drawnNumber === null) {
    throw new Error("No more numbers available.");
  }

  const calledNumber = {
    number: drawnNumber,
    letter: getLetter(drawnNumber),
    calledAt: Date.now()
  };

  await matchRef.child("drawnNumbers").transaction((current) => {
    const numbers = Array.isArray(current) ? current : [];

    if (numbers.includes(drawnNumber)) {
      return;
    }

    numbers.push(drawnNumber);
    return numbers;
  });

  await matchRef.update({
    lastCalledNumber: calledNumber,
    lastCalledAt: calledNumber.calledAt,
    remainingNumbers: result.snapshot.val().length
  });

  return calledNumber;
}


// =====================================
// WINNING PATTERN VALIDATION
// =====================================

function hasWinningPattern(card, calledNumbers) {
  const called = new Set(calledNumbers);

  function marked(letter, index) {
    const number = card[letter][index];

    return number === 0 || called.has(number);
  }

  // Horizontal lines
  for (let row = 0; row < 5; row++) {
    const letters = ["B", "I", "N", "G", "O"];

    if (letters.every(letter => marked(letter, row))) {
      return true;
    }
  }

  // Vertical lines
  for (const letter of ["B", "I", "N", "G", "O"]) {
    if (card[letter].every(number =>
      number === 0 || called.has(number)
    )) {
      return true;
    }
  }

  // Diagonal from top-left to bottom-right
  const letters = ["B", "I", "N", "G", "O"];

  const diagonalOne = letters.every((letter, index) =>
    marked(letter, index)
  );

  // Diagonal from top-right to bottom-left
  const diagonalTwo = letters.every((letter, index) =>
    marked(letter, 4 - index)
  );

  if (diagonalOne || diagonalTwo) {
    return true;
  }

  // Four corners
  const corners = [
    card.B[0],
    card.O[0],
    card.B[4],
    card.O[4]
  ];

  if (corners.every(number =>
    number === 0 || called.has(number)
  )) {
    return true;
  }

  return false;
}

// =====================================
// VERIFY BINGO
// =====================================

async function verifyBingo(
  tournamentDate,
  matchId,
  telegramId
) {
  telegramId = String(telegramId);

  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const snapshot = await matchRef.once("value");
  const match = snapshot.val();

  if (!match || match.status !== "in_progress") {
    return {
      valid: false,
      reason: "Match is not active."
    };
  }

  if (
    !match.players.some(
      player => String(player.telegramId) === telegramId
    )
  ) {
    return {
      valid: false,
      reason: "Player is not part of this match."
    };
  }

  const cardSnapshot = await matchRef
    .child(`privateCards/${telegramId}`)
    .once("value");

  if (!cardSnapshot.exists()) {
    return {
      valid: false,
      reason: "Player card not found."
    };
  }

  const card = cardSnapshot.val();
  const calledNumbers = match.drawnNumbers || [];

  const valid = hasWinningPattern(
    card,
    calledNumbers
  );

  return {
    valid,
    reason: valid
      ? "Valid Bingo."
      : "Winning pattern not completed."
  };
}

// =====================================
// CLAIM WINNER - ONE WINNER LOCK
// =====================================

async function claimWinner(
  tournamentDate,
  matchId,
  telegramId
) {
  telegramId = String(telegramId);

  const verification = await verifyBingo(
    tournamentDate,
    matchId,
    telegramId
  );

  if (!verification.valid) {
    throw new Error(verification.reason);
  }

  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const winnerRef = matchRef.child("winner");

  const result = await winnerRef.transaction((winner) => {
    if (winner) {
      return;
    }

    return {
      telegramId,
      claimedAt: Date.now()
    };
  });

  if (!result.committed) {
    throw new Error("This match already has a winner.");
  }

  await matchRef.update({
    status: "completed",
    completedAt: Date.now()
  });

  console.log(
    `Winner confirmed: ${telegramId} - Match ${matchId}`
  );

  return result.snapshot.val();
}

// =====================================
// GET MATCH STATE
// =====================================

async function getMatchState(tournamentDate, matchId) {
  const snapshot = await db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  ).once("value");

  const match = snapshot.val();

  if (!match) {
    return null;
  }

  // Never send private cards or the remaining number pool
  return {
    matchId: match.matchId,
    tournamentDate: match.tournamentDate,
    groupNumber: match.groupNumber,
    scheduledAt: match.scheduledAt,
    status: match.status,
    players: match.players,
    drawnNumbers: match.drawnNumbers || [],
    lastCalledNumber: match.lastCalledNumber || null,
    remainingNumbers: match.remainingNumbers ?? 75,
    winner: match.winner || null
  };
}

module.exports = {
  DRAW_INTERVAL_MS,
  generateCard,
  createMatch,
  startMatch,
  callNextNumber,
  verifyBingo,
  claimWinner,
  getMatchState
};
