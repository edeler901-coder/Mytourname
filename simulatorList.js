// Master simulator identity list.
// Firebase remains the live store for balances, transactions and registrations.
const USERNAMES = [
  "Abel", "Dawit", "Nahom", "Henok", "Bereket", "Natnael", "Robel",
  "Yonatan", "Meron", "Eden", "Selam", "Ruth", "Liya", "Bethlehem",
  "Hana", "Sami", "Mikias", "Yared", "Mahlet", "Kalkidan",
  "Messi", "Ronaldo", "Neymar", "Mbappe", "Haaland", "Salah", "Modric",
  "Bellingham", "Vinicius", "Benzema", "Lewandowski", "DeBruyne", "Kane",
  "Ronaldinho", "Zidane",
  "LeonardoDiCaprio", "DenzelWashington", "TomCruise", "WillSmith",
  "KeanuReeves", "BradPitt", "JohnnyDepp", "MorganFreeman", "JackieChan",
  "RobertDowney", "AngelinaJolie", "ScarlettJohansson", "JasonStatham",
  "ChrisHemsworth", "JimCarrey",
  "Mandela", "Lincoln", "Churchill", "Gandhi", "Ataturk", "Nkrumah",
  "Meles", "TeddyRoosevelt", "JFK", "Winston",
  "MichaelJackson", "Beyonce", "Shakira", "Rihanna", "Adele", "Drake",
  "Eminem", "TheWeeknd", "TaylorSwift", "BrunoMars", "ArianaGrande",
  "BobMarley", "TeddyAfro", "AsterAweke", "Gigi"
];

if (USERNAMES.length !== 75) {
  throw new Error("The master simulator list must contain exactly 75 names.");
}

const SIMULATORS = USERNAMES.map((username, index) => ({
  id: `SIM${String(index + 1).padStart(3, "0")}`,
  username,
  displayName: username
}));

module.exports = { SIMULATORS };
