
const crypto = require("crypto");
const { db } = require("./firebase");
const { ensureBoardCatalog } = require("./boardCatalog");

// =====================================
// BINGO CHAMPIONS - GAME ENGINE
// =====================================

const TOTAL_NUMBERS = 75;
const TOTAL_BOARDS = 100;
const DRAW_INTERVAL_MS = 5000;
const BOARD_SELECTION_MS = 100000;

const COLUMNS = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75]
};

function toMillis(value) {
  if (typeof value === "number") return value;

  const result = new Date(value).getTime();

  if (!Number.isFinite(result)) {
    throw new Error("Invalid match scheduled time.");
  }

  return result;
}

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

// =====================================
// NUMBER DRAWING
// =====================================

function generateNumberPool() {
  const numbers = [];

  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    numbers.push(i);
  }

  return shuffle(numbers);
}

function getLetter(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

// =====================================
// MATCH CREATION
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

  // Make sure the permanent boards exist
  await ensureBoardCatalog();

  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${group.matchId}`
  );

  const existing = await matchRef.once("value");

  if (existing.exists()) {
    return existing.val();
  }

  const scheduledAt = toMillis(group.scheduledAt);

  const match = {
    matchId: group.matchId,
    tournamentDate,
    groupNumber: group.groupNumber,

    scheduledAt,

    selectionStartsAt: scheduledAt,
    selectionEndsAt: scheduledAt + BOARD_SELECTION_MS,

    status: "scheduled",

    players: group.players,

    boardSelection: {
      selectedBoards: {},
      playerBoards: {}
    },

    drawnNumbers: [],
    numberPool: generateNumberPool(),

    winner: null,
    createdAt: Date.now()
  };

  await matchRef.set(match);

  console.log(
    `Match created: Group ${group.groupNumber}`
  );

  return match;
}

// =====================================
// OPEN BOARD SELECTION
// =====================================

async function openBoardSelection(tournamentDate, matchId) {
  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const result = await matchRef.transaction((match) => {
    if (!match || match.status !== "scheduled") {
      return;
    }

    const now = Date.now();

    if (now < match.selectionStartsAt) {
      return;
    }

    if (now >= match.selectionEndsAt) {
      return;
    }

    match.status = "board_selection";

    match.boardSelection = match.boardSelection || {
      selectedBoards: {},
      playerBoards: {}
    };

    match.boardSelection.openedAt = match.selectionStartsAt;

    return match;
  });

  return result.committed;
}

// =====================================
// SELECT AND RESERVE BOARD
// =====================================

async function selectBoard(
  tournamentDate,
  matchId,
  telegramId,
  boardNumber
) {
  telegramId = String(telegramId);
  boardNumber = Number(boardNumber);

  if (
    !Number.isInteger(boardNumber) ||
    boardNumber < 1 ||
    boardNumber > TOTAL_BOARDS
  ) {
    throw new Error("Choose a board between 1 and 100.");
  }

  // Load the permanent board layout
  const boardSnapshot = await db
    .ref(`gameConfig/boardCatalog/${boardNumber}`)
    .once("value");

  if (!boardSnapshot.exists()) {
    throw new Error("Permanent board not found.");
  }

  const permanentBoard = boardSnapshot.val();

  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const result = await matchRef.transaction((match) => {
    if (!match) return;

    const now = Date.now();

    if (
      now < match.selectionStartsAt ||
      now >= match.selectionEndsAt
    ) {
      return;
    }

    if (
      match.status !== "scheduled" &&
      match.status !== "board_selection"
    ) {
      return;
    }

    const isPlayer = match.players.some(
      player => String(player.telegramId) === telegramId
    );

    if (!isPlayer) return;

    match.boardSelection = match.boardSelection || {
      selectedBoards: {},
      playerBoards: {}
    };

    const selectedBoards =
      match.boardSelection.selectedBoards || {};

    const playerBoards =
      match.boardSelection.playerBoards || {};

    // A player can only choose one board
    if (playerBoards[telegramId]) {
      return;
    }

    // A board can only belong to one player in this match
    if (selectedBoards[String(boardNumber)]) {
      return;
    }

    // Open the selection phase if the scheduler
    // has not processed the scheduled time yet.
    if (match.status === "scheduled") {
      match.status = "board_selection";
      match.boardSelection.openedAt = match.selectionStartsAt;
    }

    selectedBoards[String(boardNumber)] = {
      telegramId,
      selectedAt: now
    };

    playerBoards[telegramId] = boardNumber;

    match.boardSelection.selectedBoards = selectedBoards;
    match.boardSelection.playerBoards = playerBoards;

    // Store this player's private permanent board
    match.privateCards = match.privateCards || {};

    match.privateCards[telegramId] = permanentBoard.card;

    return match;
  });

  if (!result.committed) {
    const latest = result.snapshot.val();

    if (!latest) {
      throw new Error("Match not found.");
    }

    if (Date.now() >= latest.selectionEndsAt) {
      throw new Error("Board selection has closed.");
    }

    if (latest.boardSelection?.playerBoards?.[telegramId]) {
      throw new Error("You have already selected a board.");
    }

    if (
      latest.boardSelection?.selectedBoards?.[String(boardNumber)]
    ) {
      throw new Error("This board has already been selected.");
    }

    throw new Error("You cannot select a board for this match.");
  }

  return {
    success: true,
    boardNumber,
    card: permanentBoard.card
  };
}

// =====================================
// GET BOARD SELECTION INFORMATION
// =====================================

async function getBoardSelectionState(
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

  if (!match) {
    throw new Error("Match not found.");
  }

  const isPlayer = match.players.some(
    player => String(player.telegramId) === telegramId
  );

  if (!isPlayer) {
    throw new Error("Player is not part of this match.");
  }

  const selectedBoards =
    match.boardSelection?.selectedBoards || {};

  const playerBoards =
    match.boardSelection?.playerBoards || {};

  const selectedBoard = playerBoards[telegramId] || null;

  const availableBoards = [];

  for (let number = 1; number <= TOTAL_BOARDS; number++) {
    if (!selectedBoards[String(number)]) {
      availableBoards.push(number);
    }
  }

  return {
    matchId: match.matchId,
    status: match.status,
    selectionStartsAt: match.selectionStartsAt,
    selectionEndsAt: match.selectionEndsAt,
    serverTime: Date.now(),
    selectedCount: Object.keys(selectedBoards).length,
    totalPlayers: match.players.length,
    selectedBoard,
    availableBoards
  };
}

// =====================================
// GET PLAYER'S PRIVATE BOARD
// =====================================

async function getPlayerCard(
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

  if (!match) {
    throw new Error("Match not found.");
  }

  const isPlayer = match.players.some(
    player => String(player.telegramId) === telegramId
  );

  if (!isPlayer) {
    throw new Error("Player is not part of this match.");
  }

  const card = match.privateCards?.[telegramId];

  if (!card) {
    return null;
  }

  return {
    boardNumber:
      match.boardSelection?.playerBoards?.[telegramId] || null,
    card
  };
}

// =====================================
// START MATCH AFTER SELECTION CLOSES
// =====================================

async function startMatch(tournamentDate, matchId) {
  const matchRef = db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );

  const result = await matchRef.transaction((match) => {
    if (
      !match ||
      (
        match.status !== "scheduled" &&
        match.status !== "board_selection"
      )
    ) {
      return;
    }

    if (Date.now() < match.selectionEndsAt) {
      return;
    }

    match.status = "in_progress";

    match.startedAt = match.selectionEndsAt;
    match.boardSelection = match.boardSelection || {};
    match.boardSelection.closedAt = match.selectionEndsAt;

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

  const letters = ["B", "I", "N", "G", "O"];

  // Horizontal lines
  for (let row = 0; row < 5; row++) {
    if (letters.every(letter => marked(letter, row))) {
      return true;
    }
  }

  // Vertical lines
  for (const letter of letters) {
    if (
      card[letter].every(number =>
        number === 0 || called.has(number)
      )
    ) {
      return true;
    }
  }

  // Diagonals
  const diagonalOne = letters.every(
    (letter, index) => marked(letter, index)
  );

  const diagonalTwo = letters.every(
    (letter, index) => marked(letter, 4 - index)
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

  return corners.every(
    number => number === 0 || called.has(number)
  );
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

  const isPlayer = match.players.some(
    player => String(player.telegramId) === telegramId
  );

  if (!isPlayer) {
    return {
      valid: false,
      reason: "Player is not part of this match."
    };
  }

  const card = match.privateCards?.[telegramId];

  if (!card) {
    return {
      valid: false,
      reason: "Player did not select a board."
    };
  }

  const valid = hasWinningPattern(
    card,
    match.drawnNumbers || []
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
    if (winner) return;

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
// GET PUBLIC MATCH STATE
// =====================================

async function getMatchState(tournamentDate, matchId) {
  const snapshot = await db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  ).once("value");

  const match = snapshot.val();

  if (!match) return null;

  const selectedBoards =
    match.boardSelection?.selectedBoards || {};

  return {
    matchId: match.matchId,
    tournamentDate: match.tournamentDate,
    groupNumber: match.groupNumber,
    scheduledAt: match.scheduledAt,
    selectionStartsAt: match.selectionStartsAt,
    selectionEndsAt: match.selectionEndsAt,
    status: match.status,
    players: match.players,
    selectedBoardCount: Object.keys(selectedBoards).length,
    drawnNumbers: match.drawnNumbers || [],
    lastCalledNumber: match.lastCalledNumber || null,
    remainingNumbers: match.remainingNumbers ?? 75,
    winner: match.winner || null
  };
}

// =====================================
// EXPORTS
// =====================================

module.exports = {
  DRAW_INTERVAL_MS,
  BOARD_SELECTION_MS,
  generateNumberPool,
  createMatch,
  openBoardSelection,
  selectBoard,
  getBoardSelectionState,
  getPlayerCard,
  startMatch,
  callNextNumber,
  hasWinningPattern,
  verifyBingo,
  claimWinner,
  getMatchState
};
