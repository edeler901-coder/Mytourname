
const { db } = require("./firebase");

const TOTAL_BOARDS = 100;

const COLUMNS = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75]
};

function seededRandom(seed) {
  let state = seed >>> 0;

  return function () {
    state += 0x6D2B79F5;

    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(value) {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function shuffle(items, random) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function generateBoard(boardNumber, attempt = 0) {
  const seed = hashSeed(
    `BINGO-CHAMPIONS-BOARD-V1-${boardNumber}-${attempt}`
  );

  const random = seededRandom(seed);
  const card = {};

  for (const [letter, range] of Object.entries(COLUMNS)) {
    const numbers = [];

    for (let number = range[0]; number <= range[1]; number++) {
      numbers.push(number);
    }

    card[letter] = shuffle(numbers, random).slice(0, 5);
  }

  card.N[2] = 0;

  return card;
}

function generateBoardCatalog() {
  const catalog = {};
  const usedLayouts = new Set();

  for (let boardNumber = 1; boardNumber <= TOTAL_BOARDS; boardNumber++) {
    let attempt = 0;
    let card;
    let signature;

    do {
      card = generateBoard(boardNumber, attempt);
      signature = JSON.stringify(card);
      attempt++;
    } while (usedLayouts.has(signature));

    usedLayouts.add(signature);

    catalog[String(boardNumber)] = {
      boardNumber,
      card
    };
  }

  return catalog;
}

async function ensureBoardCatalog() {
  const catalogRef = db.ref("gameConfig/boardCatalog");
  const generated = generateBoardCatalog();

  const result = await catalogRef.transaction((current) => {
    const catalog = current || {};

    for (let number = 1; number <= TOTAL_BOARDS; number++) {
      const key = String(number);

      if (!catalog[key]) {
        catalog[key] = generated[key];
      }
    }

    return catalog;
  });

  if (!result.committed) {
    throw new Error("Unable to initialize permanent board catalog.");
  }

  console.log("Permanent Bingo boards ready: 100");

  return result.snapshot.val();
}

// GET ONE PERMANENT BOARD BY NUMBER
async function getBoardByNumber(boardNumber) {
  boardNumber = Number(boardNumber);

  if (
    !Number.isInteger(boardNumber) ||
    boardNumber < 1 ||
    boardNumber > TOTAL_BOARDS
  ) {
    throw new Error("Invalid board number.");
  }

  const catalog = await ensureBoardCatalog();
  const board = catalog[String(boardNumber)];

  if (!board || !board.card) {
    throw new Error(`Board ${boardNumber} was not found.`);
  }

  return board;
}

module.exports = {
  TOTAL_BOARDS,
  generateBoard,
  generateBoardCatalog,
  ensureBoardCatalog,
  getBoardByNumber
};
