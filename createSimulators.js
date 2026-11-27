
const { db } = require("./firebase");

const STARTING_BALANCE = 10000;

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
      fundingVersion: 1,
      createdAt: now,
      gamesPlayed: 0,
      gamesWon: 0
    };
  });

  const ref = db.ref("simulators");

  const result = await ref.transaction((existing) => {
    existing = existing || {};

    for (const [id, account] of Object.entries(updates)) {
      if (!existing[id]) {
        existing[id] = account;
      }
    }

    return existing;
  });

  console.log("Simulator setup completed.");
  console.log("Total usernames:", usernames.length);
  console.log("Firebase accounts:", Object.keys(result.snapshot.val()).length);

  return true;
}

module.exports = {
  createSimulators
};
