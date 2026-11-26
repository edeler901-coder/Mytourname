const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const { db } = require("./firebase");
const { ENTRY_FEE, PRIZE_SPLIT } = require("./tournament");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : "";
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || "";
const DEPOSIT_INSTRUCTIONS = process.env.DEPOSIT_INSTRUCTIONS || "Contact the official support team for deposit payment details.";
const REFERRAL_REWARD = 10;

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing.");

const bot = new TelegramBot(TOKEN, { polling: true });

function menu() {
  const rows = [];
  if (WEBAPP_URL && WEBAPP_URL.startsWith("https://")) {
    rows.push([{ text: "🏆 PLAY TOURNAMENT", web_app: { url: WEBAPP_URL } }]);
  }
  rows.push(
    [{ text: "💳 Deposit", callback_data: "m:deposit" }, { text: "💸 Withdraw", callback_data: "m:withdraw" }],
    [{ text: "👤 Profile", callback_data: "m:profile" }, { text: "🔁 Transfer Money", callback_data: "m:transfer" }],
    [{ text: "📖 Instructions", callback_data: "m:instructions" }, { text: "🎮 My Matches", callback_data: "m:matches" }],
    [{ text: "🧾 Transaction History", callback_data: "m:history" }, { text: "🏅 Tournament Results", callback_data: "m:results" }],
    [{ text: "🎁 Bonus & Referrals", callback_data: "m:referrals" }, { text: "🔔 Notifications", callback_data: "m:notifications" }],
    [{ text: "🆘 Support", callback_data: "m:support" }]
  );
  return { reply_markup: { inline_keyboard: rows } };
}
const back = () => ({ reply_markup: { inline_keyboard: [[{ text: "⬅️ Main Menu", callback_data: "m:home" }]] } });
const playerRef = id => db.ref("players/" + String(id));
const sessionRef = id => db.ref("botSessions/" + String(id));
const validAmount = value => {
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isSafeInteger(n) && n > 0 && n <= 1000000 ? n : null;
};

async function createPlayer(user, referrerId) {
  const id = String(user.id);
  const result = await playerRef(id).transaction(player => {
    if (!player) {
      player = { telegramId: id, username: user.username || "", firstName: user.first_name || "", balance: 0, createdAt: Date.now(), gamesPlayed: 0, gamesWon: 0 };
      if (referrerId && String(referrerId) !== id) player.referredBy = String(referrerId);
      return player;
    }
    player.username = user.username || player.username || "";
    player.firstName = user.first_name || player.firstName || "";
    if (!player.referredBy && referrerId && String(referrerId) !== id) player.referredBy = String(referrerId);
    return player;
  });
  return result.snapshot.val();
}
async function sendHome(chatId, firstName) {
  await bot.sendMessage(chatId, "🏆 BINGO CHAMPIONS\nWelcome " + (firstName || "Player") + "!\n\nChoose a service:", menu());
}
async function session(id) {
  const s = await sessionRef(id).once("value");
  return s.val();
}
async function begin(chatId, id, type, prompt) {
  await sessionRef(id).set({ type, step: "amount", updatedAt: Date.now() });
  await bot.sendMessage(chatId, prompt);
}
async function notifyAdmin(message, requestId, withdraw) {
  if (!ADMIN_ID) {
    console.warn("ADMIN_ID is not configured; money request saved without admin notification.");
    return;
  }
  const buttons = [[
    { text: withdraw ? "Mark Paid" : "Approve Deposit", callback_data: "a:approve:" + requestId },
    { text: "Reject", callback_data: "a:reject:" + requestId }
  ]];
  try { await bot.sendMessage(ADMIN_ID, message, { reply_markup: { inline_keyboard: buttons } }); }
  catch (e) { console.error("Admin notification failed:", e.message); }
}
async function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = {};
  parts.forEach(p => v[p.type] = p.value);
  return v.year + "-" + v.month + "-" + v.day;
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  try {
    const payload = (match && match[1] || "").trim();
    const ref = /^ref_(\d+)$/.exec(payload);
    await createPlayer(msg.from, ref ? ref[1] : null);
    await sendHome(msg.chat.id, msg.from.first_name);
  } catch (e) {
    console.error("Start error:", e);
    await bot.sendMessage(msg.chat.id, "Unable to open your account. Please try again.");
  }
});
bot.onText(/^\/(menu|help)$/, msg => sendHome(msg.chat.id, msg.from.first_name));
bot.onText(/^\/cancel$/, async msg => {
  try {
    const s = await session(msg.from.id);
    if (s && s.type === "withdraw" && s.step === "method") {
      await playerRef(msg.from.id).transaction(p => {
        if (!p) return p;
        p.balance = Number(p.balance || 0) + Number(s.amount || 0);
        return p;
      });
    }
    await sessionRef(msg.from.id).remove();
    await bot.sendMessage(msg.chat.id, "Operation cancelled.", back());
  } catch (e) { console.error("Cancel error:", e); }
});
bot.onText(/^\/balance$/, async msg => {
  const snap = await playerRef(msg.from.id).child("balance").once("value");
  await bot.sendMessage(msg.chat.id, "💰 Your balance: " + Number(snap.val() || 0) + " Br", back());
});

bot.on("callback_query", async q => {
  const data = String(q.data || "");
  const id = String(q.from.id);
  const chatId = q.message.chat.id;
  try {
    await bot.answerCallbackQuery(q.id);
    if (data.startsWith("m:")) {
      const action = data.slice(2);
      if (action === "home") return sendHome(chatId, q.from.first_name);
      if (action === "deposit") return begin(chatId, id, "deposit", "💳 Enter the deposit amount in Br.");
      if (action === "withdraw") return begin(chatId, id, "withdraw", "💸 Enter the withdrawal amount in Br.");
      if (action === "transfer") return begin(chatId, id, "transfer", "🔁 Enter the recipient's Telegram ID.");
      if (action === "profile") {
        const p = (await playerRef(id).once("value")).val() || {};
        return bot.sendMessage(chatId, "👤 PROFILE\n\nName: " + (p.firstName || "Player") + "\nUsername: " + (p.username ? "@" + p.username : "Not set") + "\nTelegram ID: " + id + "\nBalance: " + Number(p.balance || 0) + " Br\nMatches played: " + Number(p.gamesPlayed || 0) + "\nWins: " + Number(p.gamesWon || 0), back());
      }
      if (action === "instructions") {
        return bot.sendMessage(chatId, "📖 HOW TO PLAY\n\n1. Open Play Tournament.\n2. Register before registration closes. Entry fee: " + ENTRY_FEE + " Br.\n3. Check My Matches for your group and schedule.\n4. Select an available Bingo board during the 100-second selection window.\n5. The server starts the game and calls numbers automatically.\n6. Press BINGO only when your board has a valid winning pattern.\n\nPrize split: 1st " + PRIZE_SPLIT.first + "%, 2nd " + PRIZE_SPLIT.second + "%, 3rd " + PRIZE_SPLIT.third + "%, house " + PRIZE_SPLIT.house + "%.", back());
      }
      if (action === "notifications") {
        const p = (await playerRef(id).once("value")).val() || {};
        const enabled = p.notificationsEnabled !== false;
        return bot.sendMessage(chatId, "🔔 MATCH NOTIFICATIONS\n\nStatus: " + (enabled ? "ON" : "OFF") + "\n\nChoose whether to receive match-start and board-selection alerts.", {
          reply_markup: { inline_keyboard: [
            [{ text: "Turn ON", callback_data: "n:on" }, { text: "Turn OFF", callback_data: "n:off" }],
            [{ text: "⬅️ Main Menu", callback_data: "m:home" }]
          ] }
        });
      }
      if (action === "support") {
        const contact = SUPPORT_USERNAME ? "\n\nSupport: @" + SUPPORT_USERNAME.replace(/^@/, "") : "\n\nPlease use the official support channel.";
        return bot.sendMessage(chatId, "🆘 SUPPORT\n\nFor account, payment, or tournament help." + contact, back());
      }
      if (action === "history") {
        const snap = await playerRef(id).child("transactions").orderByChild("createdAt").limitToLast(10).once("value");
        const list = Object.values(snap.val() || {}).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
        const body = list.length ? list.map(t => (t.type || "Transaction") + ": " + (t.amount || 0) + " Br — " + (t.status || "recorded")).join("\n") : "No transactions recorded yet.";
        return bot.sendMessage(chatId, "🧾 TRANSACTION HISTORY\n\n" + body, back());
      }
      if (action === "referrals") {
        const p = (await playerRef(id).once("value")).val() || {};
        const countSnap = await db.ref("players").orderByChild("referredBy").equalTo(id).once("value");
        const paid = Object.values(p.referralRewards || {}).filter(x => x && x.status === "paid").length;
        const me = await bot.getMe();
        const link = "https://t.me/" + me.username + "?start=ref_" + id;
        return bot.sendMessage(chatId, "🎁 BONUS & REFERRALS\n\nYour invitation link:\n" + link + "\n\nInvited players: " + Object.keys(countSnap.val() || {}).length + "\nSuccessful rewards: " + paid + "\nReward: " + REFERRAL_REWARD + " Br per successful referral.\n\nReward is credited after the invited player completes their first successful tournament registration.", back());
      }
      if (action === "matches") {
        const date = await getAddisDate();
        const snap = await db.ref("tournaments/" + date + "/playerAssignments/" + id).once("value");
        const a = snap.val();
        const body = a ? "Today's tournament: " + date + "\nGroup: " + a.groupNumber + "\nMatch: " + a.matchId + "\nStatus: " + a.status : "No match assignment found for today yet.";
        return bot.sendMessage(chatId, "🎮 MY MATCHES\n\n" + body, back());
      }
      if (action === "results") {
        const tournamentSnap = await db.ref("tournaments").orderByKey().limitToLast(10).once("value");
        const tournaments = tournamentSnap.val() || {};
        const wins = [];
        for (const [date, tournament] of Object.entries(tournaments).reverse()) {
          const groups = tournament && tournament.groups || {};
          for (const group of Object.values(groups)) {
            if (!group || !group.matchId) continue;
            const matchSnap = await db.ref("tournaments/" + date + "/matches/" + group.matchId).once("value");
            const match = matchSnap.val();
            if (match && match.winner && String(match.winner.telegramId) === id) {
              wins.push("🏆 " + date + " — Group " + group.groupNumber);
            }
          }
        }
        return bot.sendMessage(chatId, wins.length ? "🏅 YOUR RECENT WINS\n\n" + wins.join("\n") : "No wins have been recorded for your account yet.", back());
      }
    }

    if (data === "n:on" || data === "n:off") {
      await playerRef(id).update({ notificationsEnabled: data === "n:on" });
      return bot.sendMessage(chatId, "Match notifications are now " + (data === "n:on" ? "ON." : "OFF."), back());
    }

    if (data.startsWith("a:") && ADMIN_ID && id === ADMIN_ID) {
      const parts = data.split(":");
      const decision = parts[1], requestId = parts[2];
      const ref = db.ref("moneyRequests/" + requestId);
      const snap = await ref.once("value");
      const request = snap.val();
      if (!request || request.status !== "pending") return bot.sendMessage(chatId, "This request is no longer pending.");
      if (decision === "reject") {
        if (request.type === "withdraw") {
          await playerRef(request.telegramId).transaction(p => {
            if (!p) return p;
            p.withdrawalRefunds = p.withdrawalRefunds || {};
            if (p.withdrawalRefunds[requestId]) return p;
            p.balance = Number(p.balance || 0) + Number(request.amount);
            p.withdrawalRefunds[requestId] = { amount: Number(request.amount), refundedAt: Date.now() };
            p.transactions = p.transactions || {};
            if (p.transactions[requestId]) p.transactions[requestId].status = "refunded";
            return p;
          });
        }
        await ref.update({ status: "rejected", reviewedAt: Date.now(), reviewedBy: id });
        await bot.sendMessage(request.telegramId, "Your " + request.type + " request was rejected. Any reserved withdrawal amount has been returned.");
        return bot.sendMessage(chatId, "Request rejected.");
      }
      if (decision === "approve") {
        if (request.type === "deposit") {
          const credit = await playerRef(request.telegramId).transaction(p => {
            if (!p) return p;
            p.depositCredits = p.depositCredits || {};
            if (p.depositCredits[requestId]) return p;
            p.balance = Number(p.balance || 0) + Number(request.amount);
            p.depositCredits[requestId] = { amount: Number(request.amount), creditedAt: Date.now() };
            p.transactions = p.transactions || {};
            p.transactions[requestId] = { type: "deposit", amount: Number(request.amount), status: "approved", createdAt: Date.now() };
            return p;
          });
          if (!credit.committed) return bot.sendMessage(chatId, "Deposit could not be credited.");
        }
        const finalStatus = request.type === "withdraw" ? "paid" : "approved";
        await ref.update({ status: finalStatus, reviewedAt: Date.now(), reviewedBy: id });
        await playerRef(request.telegramId).child("transactions/" + requestId).update({
          status: finalStatus,
          reviewedAt: Date.now()
        });
        await bot.sendMessage(request.telegramId, request.type === "withdraw"
          ? "✅ Your withdrawal of " + request.amount + " Br has been marked paid by the admin."
          : "✅ Your deposit of " + request.amount + " Br has been credited to your wallet.");
        return bot.sendMessage(chatId, request.type === "withdraw" ? "Withdrawal marked paid." : "Deposit approved and credited.");
      }
    }
  } catch (e) {
    console.error("Bot callback error:", e);
    try { await bot.answerCallbackQuery(q.id, { text: "Action failed." }); } catch (_) {}
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const id = String(msg.from.id);
  try {
    const s = await session(id);
    if (!s) return;
    const value = msg.text.trim();

    if (s.type === "deposit" && s.step === "amount") {
      const amount = validAmount(value);
      if (!amount) return bot.sendMessage(msg.chat.id, "Enter a valid whole-number amount in Br.");
      await sessionRef(id).set({ type: "deposit", step: "reference", amount });
      return bot.sendMessage(msg.chat.id, DEPOSIT_INSTRUCTIONS + "\n\nAfter paying, send your transaction reference/ID. Send /cancel to stop.");
    }
    if (s.type === "deposit" && s.step === "reference") {
      if (value.length < 3 || value.length > 120) return bot.sendMessage(msg.chat.id, "Enter a valid transaction reference.");
      const requestId = crypto.randomUUID();
      await db.ref("moneyRequests/" + requestId).set({ type: "deposit", telegramId: id, amount: s.amount, reference: value, status: "pending", createdAt: Date.now() });
      await db.ref("players/" + id + "/transactions/" + requestId).set({ type: "deposit", amount: s.amount, status: "pending", createdAt: Date.now() });
      await sessionRef(id).remove();
      await notifyAdmin("💳 DEPOSIT REQUEST\nPlayer: " + id + "\nAmount: " + s.amount + " Br\nReference: " + value + "\nRequest: " + requestId, requestId, false);
      return bot.sendMessage(msg.chat.id, "✅ Deposit request submitted. Your balance updates after admin verification.", back());
    }
    if (s.type === "withdraw" && s.step === "amount") {
      const amount = validAmount(value);
      if (!amount) return bot.sendMessage(msg.chat.id, "Enter a valid whole-number amount in Br.");
      const debit = await playerRef(id).transaction(p => {
        if (!p || !Number.isFinite(p.balance) || p.balance < amount) return;
        p.balance -= amount;
        return p;
      });
      if (!debit.committed) return bot.sendMessage(msg.chat.id, "Insufficient balance.");
      await sessionRef(id).set({ type: "withdraw", step: "method", amount });
      return bot.sendMessage(msg.chat.id, "Enter payment method and account/phone number (example: Telebirr 09xxxxxxxx). Send /cancel to return the reserved amount.");
    }
    if (s.type === "withdraw" && s.step === "method") {
      if (value.length < 5 || value.length > 100) return bot.sendMessage(msg.chat.id, "Enter valid payment details.");
      const requestId = crypto.randomUUID();
      await db.ref("moneyRequests/" + requestId).set({ type: "withdraw", telegramId: id, amount: s.amount, paymentDetails: value, status: "pending", createdAt: Date.now() });
      await db.ref("players/" + id + "/transactions/" + requestId).set({ type: "withdraw", amount: s.amount, status: "pending", createdAt: Date.now() });
      await sessionRef(id).remove();
      await notifyAdmin("💸 WITHDRAWAL REQUEST\nPlayer: " + id + "\nAmount: " + s.amount + " Br\nPayment details: " + value + "\nRequest: " + requestId, requestId, true);
      return bot.sendMessage(msg.chat.id, "✅ Withdrawal request submitted. The amount is reserved pending admin review.", back());
    }
    if (s.type === "transfer" && s.step === "amount") {
      if (!/^\d{5,20}$/.test(value) || value === id) return bot.sendMessage(msg.chat.id, "Enter a valid recipient Telegram ID, not your own.");
      const recipient = (await playerRef(value).once("value")).val();
      if (!recipient) return bot.sendMessage(msg.chat.id, "Player not found. Ask them to open the bot first.");
      await sessionRef(id).set({ type: "transfer", step: "transferAmount", recipientId: value });
      return bot.sendMessage(msg.chat.id, "Enter the amount in Br to send to player " + value + ".");
    }
    if (s.type === "transfer" && s.step === "transferAmount") {
      const amount = validAmount(value);
      if (!amount) return bot.sendMessage(msg.chat.id, "Enter a valid whole-number amount in Br.");
      const transferId = crypto.randomUUID();
      const sender = playerRef(id);
      const debit = await sender.transaction(p => {
        if (!p) return;
        p.transactions = p.transactions || {};
        if (p.transactions[transferId]) return p;
        if (!Number.isFinite(p.balance) || p.balance < amount) return;
        p.balance -= amount;
        p.transactions[transferId] = { type: "transfer_sent", amount, to: s.recipientId, status: "completed", createdAt: Date.now() };
        return p;
      });
      if (!debit.committed) return bot.sendMessage(msg.chat.id, "Transfer failed. Check your balance.");
      const credit = await playerRef(s.recipientId).transaction(p => {
        if (!p) return;
        p.transactions = p.transactions || {};
        if (p.transactions[transferId]) return p;
        p.balance = Number(p.balance || 0) + amount;
        p.transactions[transferId] = { type: "transfer_received", amount, from: id, status: "completed", createdAt: Date.now() };
        return p;
      });
      if (!credit.committed) {
        await sender.transaction(p => {
          if (!p) return p;
          p.balance = Number(p.balance || 0) + amount;
          if (p.transactions && p.transactions[transferId]) p.transactions[transferId].status = "refunded";
          return p;
        });
        await sessionRef(id).remove();
        return bot.sendMessage(msg.chat.id, "Transfer failed. The amount has been returned.");
      }
      await sessionRef(id).remove();
      await bot.sendMessage(msg.chat.id, "✅ Transfer completed: " + amount + " Br sent to " + s.recipientId + ".", back());
      await bot.sendMessage(s.recipientId, "💰 You received " + amount + " Br from another player.");
    }
  } catch (e) {
    console.error("Bot message handler error:", e);
    await bot.sendMessage(msg.chat.id, "Something went wrong. Please try again or contact support.");
  }
});

bot.notifyPlayer = async (telegramId, message) => {
  try {
    const p = (await playerRef(telegramId).once("value")).val();
    if (!p || p.notificationsEnabled === false) return false;
    await bot.sendMessage(String(telegramId), message);
    return true;
  } catch (error) {
    console.error("Player notification failed:", error.message);
    return false;
  }
};

bot.on("polling_error", error => console.error("Telegram polling error:", error.message));
console.log("Bingo Champions player bot started.");
module.exports = bot;
