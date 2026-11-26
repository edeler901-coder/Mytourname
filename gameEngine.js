
const {
  TOTAL_BOARDS,
  ensureBoardCatalog
} = require("./boardCatalog");
// =====================================
// BINGO CHAMPIONS - GAME ENGINE
// =====================================

const TOTAL_NUMBERS = 75;
const DRAW_INTERVAL_MS = 5000;
const BOARD_SELECTION_MS = 100000;

const COLUMNS = ["B", "I", "N", "G", "O"];

let catalogPromise = null;

async function initializeCatalog() {
  if (!catalogPromise) {
    catalogPromise = ensureBoardCatalog().catch(error => {
      catalogPromise = null;
      throw error;
    });
  }

  return catalogPromise;
}
async function getPermanentBoard(boardNumber) {
  const snapshot = await db.ref(
    `gameConfig/boardCatalog/${boardNumber}`
  ).once("value");

  const board = snapshot.val();

  if (!board || !board.card) {
    throw new Error(`Permanent board ${boardNumber} not found.`);
  }

  return board;
}

function generateNumberPool() {
  const numbers = [];

  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    numbers.push(i);
  }

  for (let i = numbers.length - 1; i > 0; i--) {
    const j = require("crypto").randomInt(i + 1);
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }

  return numbers;
}

function getLetter(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

function getMatchRef(tournamentDate, matchId) {
  return db.ref(
    `tournaments/${tournamentDate}/matches/${matchId}`
  );
}

function isAssignedPlayer(match, telegramId) {
  return Array.isArray(match.players) &&
    match.players.some(
      player => String(player.telegramId) === String(telegramId)
    );
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

  await initializeCatalog();

  const matchRef = getMatchRef(tournamentDate, group.matchId);

  const result = await matchRef.transaction(current => {
    // Never overwrite an existing match
    if (current) return;

    return {
      matchId: group.matchId,
      tournamentDate,
      groupNumber: group.groupNumber,
      scheduledAt: group.scheduledAt,
      status: "scheduled",

      players: group.players,

      boardSelection: {
        selectedBoards: {},
        playerBoards: {}
      },

      drawnNumbers: [],
      numberPool: generateNumberPool(),

      remainingNumbers: TOTAL_NUMBERS,
      lastCalledNumber: null,
      winner: null,

      createdAt: Date.now()
    };
  });

  if (!result.committed && !result.snapshot.exists()) {
    throw new Error("Unable to create match.");
  }

  console.log(`Match initialized: Group ${group.groupNumber}`);

  return result.snapshot.val();
}

// =====================================
// OPEN BOARD SELECTION
// =====================================

async function openBoardSelection(tournamentDate, matchId) {
  const matchRef = getMatchRef(tournamentDate, matchId);

  const result = await matchRef.transaction(match => {
    if (!match || match.status !== "scheduled") {
      return;
    }

    const scheduledTime = new Date(match.scheduledAt).getTime();

    if (!Number.isFinite(scheduledTime) || Date.now() < scheduledTime) {
      return;
    }

    match.status = "board_selection";

    match.selectionStartedAt = scheduledTime;
    match.selectionEndsAt = scheduledTime + BOARD_SELECTION_MS;

    match.boardSelection = match.boardSelection || {
      selectedBoards: {},
      playerBoards: {}
    };

    return match;
  });

  if (result.committed) {
    console.log(`Board selection opened: ${matchId}`);
  }

  return result.committed;
}

// =====================================
// GET BOARD SELECTION STATE
// =====================================

async function getBoardSelectionState(
  tournamentDate,
  matchId,
  telegramId
) {
  telegramId = String(telegramId);

  const snapshot = await getMatchRef(
    tournamentDate,
    matchId
  ).once("value");

  const match = snapshot.val();

  if (!match) {
    throw new Error("Match not found.");
  }

  if (!isAssignedPlayer(match, telegramId)) {
    throw new Error("Player is not assigned to this match.");
  }

  const selection = match.boardSelection || {};
  const selectedBoards = selection.selectedBoards || {};
  const playerBoards = selection.playerBoards || {};

  const selectedBoardNumber = playerBoards[telegramId] || null;

  const availableBoards = [];

  for (let number = 1; number <= TOTAL_BOARDS; number++) {
    const owner = selectedBoards[String(number)];

    availableBoards.push({
      boardNumber: number,
      available: !owner || String(owner) === telegramId
    });
  }

  return {
    matchId,
    status: match.status,
    selectionStartedAt: match.selectionStartedAt || null,
    selectionEndsAt: match.selectionEndsAt || null,
    selectedBoardNumber,
    availableBoards
  };
}

// =====================================
// SELECT BOARD - ATOMIC RESERVATION
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
    throw new Error("Invalid board number.");
  }

  await initializeCatalog();

  const matchRef = getMatchRef(tournamentDate, matchId);

  let rejectionReason = null;

  const result = await matchRef.transaction(match => {
    rejectionReason = null;

    if (!match) {
      rejectionReason = "Match not found.";
      return;
    }

    if (match.status !== "board_selection") {
      rejectionReason = "Board selection is not open.";
      return;
    }

    if (Date.now() >= Number(match.selectionEndsAt)) {
      rejectionReason = "Board selection has closed.";
      return;
    }

    if (!isAssignedPlayer(match, telegramId)) {
      rejectionReason = "Player is not assigned to this match.";
      return;
    }

    match.boardSelection = match.boardSelection || {
      selectedBoards: {},
      playerBoards: {}
    };

    const selection = match.boardSelection;

    selection.selectedBoards = selection.selectedBoards || {};
    selection.playerBoards = selection.playerBoards || {};

    if (selection.playerBoards[telegramId]) {
      rejectionReason = "You have already selected a board.";
      return;
    }

    const boardKey = String(boardNumber);
    const existingOwner = selection.selectedBoards[boardKey];

    if (existingOwner) {
      rejectionReason = "This board has already been selected.";
      return;
    }

    // Both reservations happen in one transaction.
    selection.selectedBoards[boardKey] = telegramId;
    selection.playerBoards[telegramId] = boardNumber;

    return match;
  });

  if (!result.committed) {
    throw new Error(
      rejectionReason || "Board selection failed. Try again."
    );
  }

  console.log(
    `Player ${telegramId} selected board ${boardNumber} in ${matchId}`
  );

  return {
    success: true,
    boardNumber
  };
}

// =====================================
// GET PLAYER'S PERMANENT BOARD
// =====================================

async function getPlayerCard(
  tournamentDate,
  matchId,
  telegramId
) {
  telegramId = String(telegramId);

  const snapshot = await getMatchRef(
    tournamentDate,
    matchId
  ).once("value");

  const match = snapshot.val();

  if (!match) {
    throw new Error("Match not found.");
  }

  if (!isAssignedPlayer(match, telegramId)) {
    throw new Error("Player is not assigned to this match.");
  }

  const boardNumber =
    match.boardSelection?.playerBoards?.[telegramId];

  if (!boardNumber) {
    throw new Error("You have not selected a board.");
  }

  const permanentBoard = await getPermanentBoard(boardNumber);

  return {
    boardNumber: permanentBoard.boardNumber,
    card: permanentBoard.card
  };
}

// =====================================
// START MATCH AFTER SELECTION CLOSES
// =====================================

async function startMatch(tournamentDate, matchId) {
  const matchRef = getMatchRef(tournamentDate, matchId);

  const result = await matchRef.transaction(match => {
    if (!match || match.status !== "board_selection") {
      return;
    }

    if (Date.now() < Number(match.selectionEndsAt)) {
      return;
    }

    match.status = "in_progress";
    match.startedAt = Date.now();

    return match;
  });

  if (result.committed) {
    console.log(`Match started: ${matchId}`);
  }

  return result.committed;
}

// =====================================
// CALL NEXT NUMBER
// =====================================

async function callNextNumber(tournamentDate, matchId) {
  const matchRef = getMatchRef(tournamentDate, matchId);

  const snapshot = await matchRef.once("value");
  const match = snapshot.val();

  if (!match || match.status !== "in_progress") {
    throw new Error("Match is not active.");
  }

  if (match.winner) {
    throw new Error("Match already has a winner.");
  }

  let drawnNumber = null;

  const poolRef = matchRef.child("numberPool");

  const result = await poolRef.transaction(pool => {
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

  await matchRef.child("drawnNumbers").transaction(current => {
    const numbers = Array.isArray(current) ? current : [];

    if (numbers.includes(drawnNumber)) {
      return;
    }

    numbers.push(drawnNumber);
    return numbers;
  });

  await matchRef.update({
    lastCalledNumber: calledNumber,
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

  // Horizontal rows
  for (let row = 0; row < 5; row++) {
    if (COLUMNS.every(letter => marked(letter, row))) {
      return true;
    }
  }

  // Vertical columns
  for (const letter of COLUMNS) {
    if (card[letter].every(
      number => number === 0 || called.has(number)
    )) {
      return true;
    }
  }

  // Diagonals
  const diagonalOne = COLUMNS.every(
    (letter, index) => marked(letter, index)
  );

  const diagonalTwo = COLUMNS.every(
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

  const snapshot = await getMatchRef(
    tournamentDate,
    matchId
  ).once("value");

  const match = snapshot.val();

  if (!match || match.status !== "in_progress") {
    return {
      valid: false,
      reason: "Match is not active."
    };
  }

  if (!isAssignedPlayer(match, telegramId)) {
    return {
      valid: false,
      reason: "Player is not assigned to this match."
    };
  }

  const boardNumber =
    match.boardSelection?.playerBoards?.[telegramId];

  if (!boardNumber) {
    return {
      valid: false,
      reason: "Player did not select a board."
    };
  }

  const permanentBoard = await getPermanentBoard(boardNumber);

  const valid = hasWinningPattern(
    permanentBoard.card,
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

  const matchRef = getMatchRef(tournamentDate, matchId);

  const result = await matchRef.transaction(match => {
    if (
      !match ||
      match.status !== "in_progress" ||
      match.winner
    ) {
      return;
    }

    match.winner = {
      telegramId,
      claimedAt: Date.now()
    };

    match.status = "completed";
    match.completedAt = Date.now();

    return match;
  });

  if (!result.committed) {
    throw new Error("This match already has a winner.");
  }

  console.log(
    `Winner confirmed: ${telegramId} - Match ${matchId}`
  );

  return result.snapshot.val().winner;
}

// =====================================
// GET PUBLIC MATCH STATE
// =====================================

async function getMatchState(tournamentDate, matchId) {
  const snapshot = await getMatchRef(
    tournamentDate,
    matchId
  ).once("value");

  const match = snapshot.val();

  if (!match) return null;

  return {
    matchId: match.matchId,
    tournamentDate: match.tournamentDate,
    groupNumber: match.groupNumber,
    scheduledAt: match.scheduledAt,
    status: match.status,

    selectionStartedAt: match.selectionStartedAt || null,
    selectionEndsAt: match.selectionEndsAt || null,

    players: match.players,

    selectedBoardCount: Object.keys(
      match.boardSelection?.selectedBoards || {}
    ).length,

    drawnNumbers: match.drawnNumbers || [],
    lastCalledNumber: match.lastCalledNumber || null,
    remainingNumbers: match.remainingNumbers ?? TOTAL_NUMBERS,

    winner: match.winner || null
  };
}

// =====================================
// EXPORTS
// =====================================

module.exports = {
  DRAW_INTERVAL_MS,
  BOARD_SELECTION_MS,

  createMatch,
  openBoardSelection,
  getBoardSelectionState,
  selectBoard,
  getPlayerCard,

  startMatch,
  callNextNumber,

  hasWinningPattern,
  verifyBingo,
  claimWinner,

  getMatchState
};
