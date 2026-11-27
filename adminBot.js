const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const { db } = require("./firebase");

const TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : "";

if (!TOKEN || !ADMIN_ID) {
  console.log("Admin bot not started: ADMIN_BOT_TOKEN or ADMIN_ID is missing.");
} else {
  const bot = new TelegramBot(TOKEN, { polling: true });
  const sessions = new Map();

  const isAdmin = id => String(id) === ADMIN_ID;

  function normalizePhone(value) {
    const phone = String(value || "").replace(/[\s()-]/g, "");
    if (/^\+251[79]\d{8}$/.test(phone)) return "0" + phone.slice(4);
    if (/^251[79]\d{8}$/.test(phone)) return "0" + phone.slice(3);
    if (/^0[79]\d{8}$/.test(phone)) return phone;
    return null;
  }

  function menu() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔎 Find player by phone", callback_data: "admin:search" }],
          [{ text: "❌ Cancel current action", callback_data: "admin:cancel" }]
        ]
      }
    };
  }

  async function findPlayer(phone) {
    const index = await db.ref("phoneNumberIndex/" + phone).once("value");
    const playerId = index.val();
    if (!playerId) return null;

    const snapshot = await db.ref("players/" + String(playerId)).once("value");
    const player = snapshot.val();
    if (!player || player.phoneVerified !== true || player.phoneNumber !== phone) {
      return null;
    }
    return { id: String(playerId), player };
  }

  bot.setMyCommands([
    { command: "start", description: "Open admin menu" },
    { command: "menu", description: "Open admin menu" },
    { command: "cancel", description: "Cancel current action" }
  ]).catch(error => console.error("Admin bot commands setup failed:", error.message));

  bot.onText(/^\/(start|menu)(?:@\w+)?$/, async msg => {
    if (!isAdmin(msg.from.id)) return;
    sessions.set(ADMIN_ID, { step: "menu" });
    await bot.sendMessage(msg.chat.id, "🔐 BINGO CHAMPIONS ADMIN\n\nChoose an admin action.", menu());
  });

  bot.onText(/^\/cancel(?:@\w+)?$/, async msg => {
    if (!isAdmin(msg.from.id)) return;
    sessions.delete(ADMIN_ID);
    await bot.sendMessage(msg.chat.id, "Current action cancelled.", menu());
  });

  bot.on("callback_query", async query => {
    if (!isAdmin(query.from.id)) {
      await bot.answerCallbackQuery(query.id, { text: "Not authorized." }).catch(() => {});
      return;
    }

    try {
      const chatId = query.message.chat.id;
      const data = String(query.data || "");

      if (data === "admin:search") {
        sessions.set(ADMIN_ID, { step: "phone" });
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "Enter the player's registered Ethiopian phone number.");
      }

      if (data === "admin:cancel") {
        sessions.delete(ADMIN_ID);
        await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
        return bot.sendMessage(chatId, "Current action cancelled.", menu());
      }

      const session = sessions.get(ADMIN_ID);
      if (data === "admin:credit" && session && session.step === "player") {
        session.step = "amount";
        sessions.set(ADMIN_ID, session);
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "Enter the amount to credit in Br (up to two decimal places).");
      }

      if (data === "admin:confirm" && session && session.step === "confirm") {
        await bot.answerCallbackQuery(query.id, { text: "Processing credit..." });

        const creditId = session.creditId;
        const playerRef = db.ref("players/" + session.playerId);
        const now = Date.now();

        const result = await playerRef.transaction(player => {
          if (!player || player.phoneVerified !== true ||
              player.phoneNumber !== session.phone) return;
          player.transactions = player.transactions || {};
          if (player.transactions[creditId]) return player;

          const balance = Number(player.balance || 0);
          if (!Number.isFinite(balance) || balance < 0) return;
          player.balance = Math.round((balance + session.amount) * 100) / 100;
          player.transactions[creditId] = {
            type: "admin_credit",
            amount: session.amount,
            status: "completed",
            adminId: ADMIN_ID,
            phoneNumber: session.phone,
            createdAt: now
          };
          return player;
        });

        const updated = result.snapshot.val();
        const transaction = updated && updated.transactions && updated.transactions[creditId];
        if (!result.committed || !transaction || transaction.type !== "admin_credit") {
          sessions.delete(ADMIN_ID);
          return bot.sendMessage(chatId, "❌ Credit was not completed. The player account may have changed. Please search again.", menu());
        }

        sessions.delete(ADMIN_ID);
        return bot.sendMessage(
          chatId,
          "✅ CREDIT COMPLETED\n\nPlayer ID: " + session.playerId +
          "\nPhone: " + session.phone +
          "\nAmount: " + session.amount.toFixed(2) + " Br" +
          "\nNew balance: " + Number(updated.balance).toFixed(2) + " Br" +
          "\nReference: " + creditId,
          menu()
        );
      }

      await bot.answerCallbackQuery(query.id, { text: "This action has expired. Start again." });
    } catch (error) {
      console.error("Admin bot callback error:", error.message);
      await bot.answerCallbackQuery(query.id, { text: "Action failed." }).catch(() => {});
      await bot.sendMessage(query.message.chat.id, "Something went wrong. Please try again.");
    }
  });

  bot.on("message", async msg => {
    if (!msg.from || !isAdmin(msg.from.id) || typeof msg.text !== "string" || msg.text.startsWith("/")) return;

    const session = sessions.get(ADMIN_ID);
    if (!session) return;

    try {
      if (session.step === "phone") {
        const phone = normalizePhone(msg.text);
        if (!phone) return bot.sendMessage(msg.chat.id, "Invalid phone number. Enter a valid number such as 0912345678 or 0712345678.");

        const found = await findPlayer(phone);
        if (!found) return bot.sendMessage(msg.chat.id, "No verified player account was found for " + phone + ". Check the number and try again, or use /cancel.");

        const player = found.player;
        sessions.set(ADMIN_ID, {
          step: "player",
          playerId: found.id,
          phone,
          balance: Number(player.balance || 0)
        });

        const playerName = player.firstName || player.username || "Player";
        return bot.sendMessage(
          msg.chat.id,
          "👤 VERIFIED PLAYER FOUND\n\nName: " + playerName +
          (player.username ? "\nUsername: @" + player.username : "") +
          "\nTelegram ID: " + found.id +
          "\nPhone: " + phone +
          "\nCurrent balance: " + Number(player.balance || 0).toFixed(2) + " Br",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Credit balance", callback_data: "admin:credit" }],
                [{ text: "❌ Cancel", callback_data: "admin:cancel" }]
              ]
            }
          }
        );
      }

      if (session.step === "amount") {
        const amount = Number(String(msg.text).replace(/,/g, "").trim());
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 ||
            Math.round(amount * 100) !== amount * 100) {
          return bot.sendMessage(msg.chat.id, "Enter a valid amount greater than 0 and up to 1,000,000 Br, with no more than two decimal places.");
        }

        const creditId = "admin_" + crypto.randomUUID();
        session.step = "confirm";
        session.amount = amount;
        session.creditId = creditId;
        sessions.set(ADMIN_ID, session);

        return bot.sendMessage(
          msg.chat.id,
          "⚠️ CONFIRM WALLET CREDIT\n\nPlayer ID: " + session.playerId +
          "\nPhone: " + session.phone +
          "\nCurrent balance: " + session.balance.toFixed(2) + " Br" +
          "\nCredit amount: " + amount.toFixed(2) + " Br" +
          "\nNew balance will be: " + (session.balance + amount).toFixed(2) + " Br" +
          "\n\nOnly confirm if these details are correct.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Confirm credit", callback_data: "admin:confirm" }],
                [{ text: "❌ Cancel", callback_data: "admin:cancel" }]
              ]
            }
          }
        );
      }
    } catch (error) {
      console.error("Admin bot message error:", error.message);
      await bot.sendMessage(msg.chat.id, "Unable to complete that action. Please try again.");
    }
  });

  bot.on("polling_error", error => console.error("Admin bot polling error:", error.message));
  console.log("Bingo Champions private admin bot started.");
}
