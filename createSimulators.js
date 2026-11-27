const { db } = require("./firebase");

const STARTING_BALANCE = 10000;
const FUNDING_VERSION = 2;

const usernames = [
  // 20 Habesha names
  "Abel",
  "Dawit",
  "Nahom",
  "Henok",
  "Bereket",
  "Natnael",
  "Robel",
  "Yonatan",
  "Meron",
  "Eden",
  "Selam",
  "Ruth",
  "Liya",
  "Bethlehem",
  "Hana",
  "Sami",
  "Mikias",
  "Yared",
  "Mahlet",
  "Kalkidan",

  // 15 football players
  "Messi",
  "Ronaldo",
  "Neymar",
  "Mbappe",
  "Haaland",
  "Salah",
  "Modric",
  "Bellingham",
  "Vinicius",
  "Benzema",
  "Lewandowski",
  "DeBruyne",
  "Kane",
  "Ronaldinho",
  "Zidane",

  // 15 actors
  "LeonardoDiCaprio",
  "DenzelWashington",
  "TomCruise",
  "WillSmith",
  "KeanuReeves",
  "BradPitt",
  "JohnnyDepp",
  "MorganFreeman",
  "JackieChan",
  "RobertDowney",
  "AngelinaJolie",
  "ScarlettJohansson",
  "JasonStatham",
  "ChrisHemsworth",
  "JimCarrey",

  // 10 leaders
  "Mandela",
  "Lincoln",
  "Churchill",
  "Gandhi",
  "Ataturk",
  "Nkrumah",
  "Meles",
  "TeddyRoosevelt",
  "JFK",
  "Winston",

  // 15 singers
  "MichaelJackson",
  "Beyonce",
  "Shakira",
  "Rihanna",
  "Adele",
  "Drake",
  "Eminem",
  "TheWeeknd",
  "TaylorSwift",
  "BrunoMars",
  "ArianaGrande",
  "BobMarley",
  "TeddyAfro",
  "AsterAweke",
  "Gigi"
];

async function createSimulators() {
  if (usernames.length !== 75) {
    throw new Error("The username list must contain exactly 75 names.");
  }

  const now = Date.now();
  const updates = {};

  usernames.forEach((username, index) => {
    const id = `SIM${String(index + 1).padStart(3, "0")}`;

    updates[id] = {
      id,
      username,
      displayName: username,
      isSimulator: true,
      accountType: "simulator",
      balance: STARTING_BALANCE,
      fundingVersion: FUNDING_VERSION,
      fundedAt: now,
      createdAt: now,
      gamesPlayed: 0,
      gamesWon: 0
    };
  });

  const ref = db.ref("simulators");
  let createdCount = 0;
  let fundedCount = 0;
  let preservedBalanceCount = 0;
  let skippedCount = 0;

  const result = await ref.transaction(existing => {
    existing = existing || {};

    // Reset counters because Firebase may retry a transaction callback.
    createdCount = 0;
    fundedCount = 0;
    preservedBalanceCount = 0;
    skippedCount = 0;

    for (const [id, newAccount] of Object.entries(updates)) {
      const current = existing[id];

      if (!current) {
        existing[id] = newAccount;
        createdCount++;
        continue;
      }

      // Never modify an account unless it is already marked as a simulator.
      if (
        current.isSimulator !== true ||
        current.accountType !== "simulator"
      ) {
        skippedCount++;
        continue;
      }

      // A completed funding version is never funded a second time.
      if (Number(current.fundingVersion) >= FUNDING_VERSION) {
        continue;
      }

      const currentBalance =
        current.balance === undefined || current.balance === null
          ? 0
          : Number(current.balance);

      if (!Number.isFinite(currentBalance) || currentBalance < 0) {
        skippedCount++;
        continue;
      }

      // Give the initial balance only to an unfunded zero-balance account.
      // Preserve any positive balance already in the simulator wallet.
      if (currentBalance === 0) {
        current.balance = STARTING_BALANCE;
        fundedCount++;
      } else {
        preservedBalanceCount++;
      }

      current.fundingVersion = FUNDING_VERSION;
      current.fundedAt = now;
      existing[id] = current;
    }

    return existing;
  });

  if (!result.committed) {
    throw new Error("Firebase did not commit the simulator funding transaction.");
  }

  const finalAccounts = result.snapshot.val() || {};
  const eligibleCount = Object.values(finalAccounts).filter(account =>
    account &&
    account.isSimulator === true &&
    account.accountType === "simulator"
  ).length;

  console.log("Simulator setup and one-time funding completed.");
  console.log("Expected simulator accounts:", usernames.length);
  console.log("Eligible simulator accounts in Firebase:", eligibleCount);
  console.log("New accounts created:", createdCount);
  console.log("Existing zero-balance accounts funded:", fundedCount);
  console.log("Existing positive balances preserved:", preservedBalanceCount);
  console.log("Accounts skipped for safety:", skippedCount);

  return {
    eligibleCount,
    createdCount,
    fundedCount,
    preservedBalanceCount,
    skippedCount
  };
}

module.exports = {
  createSimulators
};
