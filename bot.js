
const TelegramBot = require("node-telegram-bot-api");
const { db } = require("./firebase");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

if (!TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing.");
}

if (!WEBAPP_URL || !WEBAPP_URL.startsWith("https://")) {
  throw new Error("A valid HTTPS WEBAPP_URL is required.");
}

const bot = new TelegramBot(TOKEN, {
  polling: true
});

// Create or update player account
async function createPlayer(user) {
  const playerRef = db.ref(`players/${user.id}`);

  await playerRef.transaction((player) => {
    if (!player) {
      return {
        telegramId: String(user.id),
        username: user.username || "",
        firstName: user.first_name || "",
        balance: 0,
        createdAt: Date.now(),
        gamesPlayed: 0,
        gamesWon: 0
      };
    }

    player.username = user.username || player.username || "";
    player.firstName = user.first_name || player.firstName || "";

    return player;
  });

  return playerRef.once("value");
}

// Main menu
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🎮 PLAY TOURNAMENT",
            web_app: {
              url: WEBAPP_URL
            }
          }
        ],
        [
          {
            text: "💰 MY BALANCE",
            callback_data: "balance"
          }
        ]
      ]
    }
  };
}

// Start command
bot.onText(/^\/start$/, async (msg) => {
  try {
    await createPlayer(msg.from);

    bot.sendMessage(
      msg.chat.id,
      `Welcome ${msg.from.first_name || "Player"}!\n\nWelcome to Bingo Tournament.\n\nRegister and compete to win prizes!`,
      mainMenu()
    );
  } catch (error) {
    console.error("Start error:", error);

    bot.sendMessage(
      msg.chat.id,
      "Unable to open your account. Please try again."
    );
  }
});

// Balance command
bot.onText(/^\/balance$/, async (msg) => {
  try {
    const snapshot = await db
      .ref(`players/${msg.from.id}/balance`)
      .once("value");

    const balance = snapshot.val() || 0;

    bot.sendMessage(
      msg.chat.id,
      `💰 Your wallet balance: ${balance} Br`,
      mainMenu()
    );
  } catch (error) {
    console.error("Balance error:", error);

    bot.sendMessage(
      msg.chat.id,
      "Unable to check your balance. Please try again."
    );
  }
});

// Play command
bot.onText(/^\/play$/, async (msg) => {
  try {
    await createPlayer(msg.from);

    bot.sendMessage(
      msg.chat.id,
      "Ready to compete? Open the tournament below.",
      mainMenu()
    );
  } catch (error) {
    console.error("Play error:", error);

    bot.sendMessage(
      msg.chat.id,
      "Unable to open the tournament. Please try again."
    );
  }
});

// Balance button
bot.on("callback_query", async (query) => {
  if (query.data !== "balance") return;

  try {
    const snapshot = await db
      .ref(`players/${query.from.id}/balance`)
      .once("value");

    const balance = snapshot.val() || 0;

    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      query.message.chat.id,
      `💰 Your wallet balance: ${balance} Br`
    );
  } catch (error) {
    console.error("Balance button error:", error);

    await bot.answerCallbackQuery(query.id, {
      text: "Unable to check balance."
    });
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

console.log("Bingo Tournament Telegram Bot started.");

module.exports = bot;
