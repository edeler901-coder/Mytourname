const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const { db } = require("./firebase");
const { ENTRY_FEE, PRIZE_SPLIT } = require("./tournament");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : "";
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || "";
const TELEBIRR_ACCOUNT = process.env.TELEBIRR_ACCOUNT || "";
const CBE_BIRR_ACCOUNT = process.env.CBE_BIRR_ACCOUNT || "";
const REFERRAL_REWARD = 10;

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing.");

const bot = new TelegramBot(TOKEN, { polling: true });

// Telegram's native Menu button opens the bot command list.
// /menu then displays the complete 13-button inline player menu.
bot.setMyCommands([
  { command: "menu", description: "Open all player services" },
  { command: "balance", description: "Check your balance" },
  { command: "deposit", description: "Deposit money" },
  { command: "withdraw", description: "Withdraw money" },
  { command: "cancel", description: "Cancel current operation" },
  { command: "start", description: "Start or reopen your account" }
]).catch(error => console.error("Bot commands setup failed:", error.message));

bot.setChatMenuButton({ menu_button: { type: "commands" } })
  .catch(error => console.error("Bot Menu button setup failed:", error.message));

function menu() {
  const rows = [];
  if (WEBAPP_URL && WEBAPP_URL.startsWith("https://")) {
    rows.push([{ text: "🏆 PLAY TOURNAMENT", web_app: { url: WEBAPP_URL } }]);
  }
  rows.push(
    [{ text: "💳 Deposit", callback_data: "m:deposit" }, { text: "💸 Withdraw", callback_data: "m:withdraw" }],
    [{ text: "💰 Balance", callback_data: "m:balance" }, { text: "👤 Profile", callback_data: "m:profile" }],
    [{ text: "🔁 Transfer Money", callback_data: "m:transfer" }],
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

function normalizeEthiopianPhone(value) {
  const compact = String(value || "").replace(/[\s()-]/g, "");
  if (/^\+251[79]\d{8}$/.test(compact)) return "0" + compact.slice(4);
  if (/^251[79]\d{8}$/.test(compact)) return "0" + compact.slice(3);
  if (/^0[79]\d{8}$/.test(compact)) return compact;
  return null;
}

async function isPhoneVerified(id) {
  const snap = await playerRef(id).once("value");
  const player = snap.val();
  return !!(player && player.phoneVerified === true && player.phoneNumber);
}

async function requestContact(chatId, id, firstName, referrerId) {
  await sessionRef(id).set({
    type: "registration",
    step: "contact",
    referrerId: referrerId || null,
    updatedAt: Date.now()
  });
  await bot.sendMessage(
    chatId,
    "📱 WELCOME TO BINGO CHAMPIONS\n\nBefore using the bot, please verify your phone number. Tap the button below to share your own Telegram contact. We use it to identify your account and make player-to-player transfers safer.",
    {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Contact", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}

const validAmount = value => {
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isSafeInteger(n) && n > 0 && n <= 1000000 ? n : null;
};

async function createPlayer(user, referrerId, phoneNumber) {
  const id = String(user.id);
  const result = await playerRef(id).transaction(player => {
    if (!player) {
      player = { telegramId: id, username: user.username || "", firstName: user.first_name || "", phoneNumber, phoneVerified: true, phoneVerifiedAt: Date.now(), balance: 0, createdAt: Date.now(), gamesPlayed: 0, gamesWon: 0 };
      if (referrerId && String(referrerId) !== id) player.referredBy = String(referrerId);
      return player;
    }
    if (player.phoneVerified === true && player.phoneNumber !== phoneNumber) return;
    player.username = user.username || player.username || "";
    player.firstName = user.first_name || player.firstName || "";
    player.phoneNumber = phoneNumber;
    player.phoneVerified = true;
    player.phoneVerifiedAt = player.phoneVerifiedAt || Date.now();
    if (!player.referredBy && referrerId && String(referrerId) !== id) player.referredBy = String(referrerId);
    return player;
  });
  if (!result.committed) throw new Error("This account already has a different verified phone number.");
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
    const referrerId = ref ? ref[1] : null;
    const existingSnap = await playerRef(msg.from.id).once("value");
    const existing = existingSnap.val();

    if (existing && existing.phoneVerified === true && existing.phoneNumber) {
      await playerRef(msg.from.id).update({
        username: msg.from.username || existing.username || "",
        firstName: msg.from.first_name || existing.firstName || ""
      });
      await sendHome(msg.chat.id, msg.from.first_name);
      return;
    }

    await requestContact(msg.chat.id, String(msg.from.id), msg.from.first_name, referrerId);
  } catch (e) {
    console.error("Start error:", e);
    await bot.sendMessage(msg.chat.id, "Unable to start registration. Please try again.");
  }
});
bot.onText(/^\/(menu|help)$/, async msg => {
  if (!(await isPhoneVerified(msg.from.id))) {
    return requestContact(msg.chat.id, String(msg.from.id), msg.from.first_name, null);
  }
  return sendHome(msg.chat.id, msg.from.first_name);
});
bot.onText(/^\/cancel$/, async msg => {
  try {
    const s = await session(msg.from.id);
    if (s && s.type === "withdraw" && s.step === "method" && s.flowVersion !== 2) {
      // Refund only an unfinished legacy session that had already deducted the amount.
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
  if (!(await isPhoneVerified(msg.from.id))) {
    return requestContact(msg.chat.id, String(msg.from.id), msg.from.first_name, null);
  }
  const snap = await playerRef(msg.from.id).child("balance").once("value");
  await bot.sendMessage(msg.chat.id, "💰 Your balance: " + Number(snap.val() || 0) + " Br", back());
});

bot.on("callback_query", async q => {
  const data = String(q.data || "");
  const id = String(q.from.id);
  const chatId = q.message.chat.id;
  try {
    await bot.answerCallbackQuery(q.id);
    if (data.startsWith("m:") || data.startsWith("n:") || data.startsWith("t:")) {
      if (!(await isPhoneVerified(id))) {
        await requestContact(chatId, id, q.from.first_name, null);
        return;
      }
    }

    if (data === "t:confirm" || data === "t:cancel") {
      const current = await session(id);
      if (!current || current.type !== "transfer" || current.step !== "confirmRecipient") {
        return bot.sendMessage(chatId, "This transfer session has expired. Please start again.", back());
      }
      if (data === "t:cancel") {
        await sessionRef(id).remove();
        return bot.sendMessage(chatId, "Transfer cancelled.", back());
      }
      await sessionRef(id).update({ step: "transferAmount" });
      const recipient = (await playerRef(current.recipientId).once("value")).val() || {};
      const displayName = recipient.username ? "@" + recipient.username : (recipient.firstName || "Player");
      return bot.sendMessage(chatId, "Enter the amount in Br to send to " + displayName + ".");
    }

    if (data.startsWith("m:")) {
      const action = data.slice(2);
      if (action === "home") return sendHome(chatId, q.from.first_name);
      if (action === "balance") {
        const snap = await playerRef(id).child("balance").once("value");
        return bot.sendMessage(chatId, "💰 Your balance: " + Number(snap.val() || 0) + " Br", back());
      }
      if (action === "deposit") {
        await sessionRef(id).set({ type: "deposit", step: "provider", updatedAt: Date.now() });
        return bot.sendMessage(chatId, "💳 Choose your deposit method:", {
          reply_markup: { inline_keyboard: [
            [{ text: "📱 Telebirr", callback_data: "d:telebirr" }],
            [{ text: "🏦 CBE Birr", callback_data: "d:cbe" }],
            [{ text: "⬅️ Main Menu", callback_data: "m:home" }]
          ] }
        });
      }
      if (action === "withdraw") return begin(chatId, id, "withdraw", "💸 Enter the withdrawal amount in Br.");
      if (action === "transfer") {
        await sessionRef(id).set({ type: "transfer", step: "recipientPhone", updatedAt: Date.now() });
        return bot.sendMessage(chatId, "🔁 Enter the recipient's registered Ethiopian phone number (for example: 0912345678).");
      }
      if (action === "profile") {
        const p = (await playerRef(id).once("value")).val() || {};
        return bot.sendMessage(chatId, "👤 PROFILE\n\nName: " + (p.firstName || "Player") + "\nUsername: " + (p.username ? "@" + p.username : "Not set") + "\nVerified phone: " + (p.phoneNumber || "Not verified") + "\nTelegram ID: " + id + "\nBalance: " + Number(p.balance || 0) + " Br\nMatches played: " + Number(p.gamesPlayed || 0) + "\nWins: " + Number(p.gamesWon || 0), back());
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

    if (data === "d:telebirr" || data === "d:cbe") {
      const current = await session(id);
      if (!current || current.type !== "deposit" || current.step !== "provider") {
        return bot.sendMessage(chatId, "This deposit session has expired. Please start again.", back());
      }
      const provider = data === "d:telebirr" ? "Telebirr" : "CBE Birr";
      const account = data === "d:telebirr" ? TELEBIRR_ACCOUNT : CBE_BIRR_ACCOUNT;
      if (!account) {
        return bot.sendMessage(chatId, provider + " deposit account is not configured yet. Please contact support.", back());
      }
      await sessionRef(id).set({ type: "deposit", step: "amount", provider, updatedAt: Date.now() });
      return bot.sendMessage(chatId,
        "💳 DEPOSIT — " + provider + "\n\nSend your payment to:\n" + account +
        "\n\nEnter the amount you are going to deposit in Br. After paying, enter the transaction ID from your confirmation SMS. Your deposit is verified automatically within 72 hours."
      );
    }

    if (data === "n:on" || data === "n:off") {
      await playerRef(id).update({ notificationsEnabled: data === "n:on" });
      return bot.sendMessage(chatId, "Match notifications are now " + (data === "n:on" ? "ON." : "OFF."), back());
    }

    if (data === "w:telebirr" || data === "w:cbe") {
      const current = await session(id);
      if (!current || current.type !== "withdraw" || current.step !== "method" || current.flowVersion !== 2) {
        return bot.sendMessage(chatId, "This withdrawal session has expired. Please start again.", back());
      }
      const method = data === "w:telebirr" ? "Telebirr" : "CBE Birr";
      await sessionRef(id).update({ step: "firstName", method });
      return bot.sendMessage(chatId, "Enter the first name on your " + method + " account.");
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
            p.withdrawalReservations = p.withdrawalReservations || {};
            const reservation = p.withdrawalReservations[requestId];
            if (reservation && reservation.status === "pending") {
              p.balance = Number(p.balance || 0) + Number(request.amount);
              p.withdrawalHold = Math.max(0, Number(p.withdrawalHold || 0) - Number(request.amount));
              reservation.status = "refunded";
              reservation.refundedAt = Date.now();
            } else if (!reservation) {
              // Compatibility with requests created before the hold-based flow.
              p.withdrawalRefunds = p.withdrawalRefunds || {};
              if (!p.withdrawalRefunds[requestId]) {
                p.balance = Number(p.balance || 0) + Number(request.amount);
                p.withdrawalRefunds[requestId] = { amount: Number(request.amount), refundedAt: Date.now() };
              }
            }
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
        if (request.type === "withdraw") {
          const release = await playerRef(request.telegramId).transaction(p => {
            if (!p) return p;
            p.withdrawalReservations = p.withdrawalReservations || {};
            const reservation = p.withdrawalReservations[requestId];
            if (reservation && reservation.status === "pending") {
              p.withdrawalHold = Math.max(0, Number(p.withdrawalHold || 0) - Number(request.amount));
              reservation.status = "paid";
              reservation.paidAt = Date.now();
            }
            return p;
          });
          if (!release.committed) return bot.sendMessage(chatId, "Withdrawal could not be finalized.");
        }
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
  const id = String(msg.from.id);
  try {
    if (msg.contact) {
      const current = await session(id);
      if (!current || current.type !== "registration" || current.step !== "contact") {
        return bot.sendMessage(msg.chat.id, "Please send /start first to begin phone verification.");
      }
      if (!msg.contact.user_id || String(msg.contact.user_id) !== id) {
        return bot.sendMessage(msg.chat.id, "❌ Please use the Share My Contact button to share your own Telegram contact. Another person's contact cannot be used.");
      }

      const phoneNumber = normalizeEthiopianPhone(msg.contact.phone_number);
      if (!phoneNumber) {
        return bot.sendMessage(msg.chat.id, "❌ We could not verify this as an Ethiopian mobile number. Please share a number in the format 09xxxxxxxx or 07xxxxxxxx.");
      }

      const existing = (await playerRef(id).once("value")).val();
      if (existing && existing.phoneVerified === true && existing.phoneNumber && existing.phoneNumber !== phoneNumber) {
        return bot.sendMessage(msg.chat.id, "This account already has a different verified phone number. Please contact support to update it.");
      }

      const indexRef = db.ref("phoneNumberIndex/" + phoneNumber);
      const claim = await indexRef.transaction(currentId => {
        if (currentId && String(currentId) !== id) return;
        return id;
      });

      if (!claim.committed || String(claim.snapshot.val()) !== id) {
        return bot.sendMessage(msg.chat.id, "❌ This phone number is already linked to another Bingo Champions account. Please use your own registered number.");
      }

      await createPlayer(msg.from, current.referrerId, phoneNumber);
      await sessionRef(id).remove();
      await bot.sendMessage(msg.chat.id, "✅ Phone number verified and account registered successfully.", {
        reply_markup: { remove_keyboard: true }
      });
      return sendHome(msg.chat.id, msg.from.first_name);
    }

    if (!msg.text || msg.text.startsWith("/")) return;
    const s = await session(id);
    if (!s) return;
    if (s.type === "registration" && s.step === "contact") {
      return bot.sendMessage(msg.chat.id, "Please tap the 📱 Share My Contact button below to verify your own phone number.");
    }
    if (!(await isPhoneVerified(id))) {
      return requestContact(msg.chat.id, id, msg.from.first_name, null);
    }
    const value = msg.text.trim();

    if (s.type === "deposit" && s.step === "amount") {
      const amount = Number(String(value).replace(/,/g, "").trim());
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Math.round(amount * 100) !== amount * 100) {
        return bot.sendMessage(msg.chat.id, "Enter a valid amount in Br (up to two decimal places).");
      }
      await sessionRef(id).update({ step: "transactionId", amount });
      return bot.sendMessage(msg.chat.id, "After making the payment, enter the transaction ID from your payment confirmation SMS. Do not send the whole SMS. Send /cancel to stop.");
    }
    if (s.type === "deposit" && s.step === "transactionId") {
      const transactionId = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!/^(?:[A-Z0-9]{8,24})$/.test(transactionId) || !(/[A-Z]/.test(transactionId) && /\d/.test(transactionId) || /^\d{10,24}$/.test(transactionId))) {
        return bot.sendMessage(msg.chat.id, "That transaction ID format does not look valid. Please enter the ID exactly as shown in your payment SMS.");
      }
      const paymentRef = db.ref("incomingPaymentSms/" + transactionId);
      const claim = await paymentRef.transaction(payment => {
        if (!payment || payment.status !== "available") return;
        if (Number(payment.amount) !== Number(s.amount)) return;
        if (!payment.receivedAt || Date.now() - Number(payment.transactionTime || payment.receivedAt) > 72 * 60 * 60 * 1000) return;
        if (Number(payment.transactionTime || payment.receivedAt) > Date.now() + 5 * 60 * 1000) return;
        payment.status = "claimed";
        payment.claimedBy = id;
        payment.claimedAt = Date.now();
        return payment;
      });
      let payment = claim.snapshot.val();
      if (!claim.committed || !payment || payment.claimedBy !== id || Number(payment.amount) !== Number(s.amount)) {
        await sessionRef(id).remove();
        return bot.sendMessage(msg.chat.id, "❌ We could not verify this deposit. Check the amount and transaction ID, and make sure the payment SMS was forwarded to our server within 72 hours.", back());
      }

      const creditedBefore = (await playerRef(id).child("depositCredits/" + transactionId).once("value")).exists();
      const credit = await playerRef(id).transaction(player => {
        if (!player) return;
        player.depositCredits = player.depositCredits || {};
        if (player.depositCredits[transactionId]) return player;
        player.balance = Number(player.balance || 0) + Number(s.amount);
        player.depositCredits[transactionId] = { amount: Number(s.amount), provider: s.provider, creditedAt: Date.now() };
        player.transactions = player.transactions || {};
        player.transactions[transactionId] = { type: "deposit", amount: Number(s.amount), provider: s.provider, status: "completed", createdAt: Date.now() };
        return player;
      });
      if (!credit.committed || !credit.snapshot.child("depositCredits/" + transactionId).exists()) {
        return bot.sendMessage(msg.chat.id, "Your payment was verified, but wallet credit needs attention. Please contact support and provide transaction ID " + transactionId + ".");
      }
      await paymentRef.update({ status: "credited", creditedTo: id, creditedAt: Date.now() });
      await sessionRef(id).remove();
      if (creditedBefore) {
        return bot.sendMessage(msg.chat.id, "This transaction has already been credited to your account.", back());
      }
      return bot.sendMessage(msg.chat.id, "✅ Deposit verified! " + Number(s.amount).toFixed(2) + " Br has been added to your balance.", back());
    }
    if (s.type === "withdraw" && s.step === "amount") {
      const amount = Number(String(value).replace(/,/g, "").trim());
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Math.round(amount * 100) !== amount * 100) {
        return bot.sendMessage(msg.chat.id, "Enter a valid withdrawal amount in Br (up to two decimal places).");
      }
      const wallet = (await playerRef(id).child("balance").once("value")).val();
      if (!Number.isFinite(Number(wallet)) || Number(wallet) < amount) {
        return bot.sendMessage(msg.chat.id, "Insufficient withdrawable balance. Your available balance is " + Number(wallet || 0) + " Br.");
      }
      await sessionRef(id).set({ type: "withdraw", step: "method", flowVersion: 2, amount, updatedAt: Date.now() });
      return bot.sendMessage(msg.chat.id, "Choose your withdrawal method:", {
        reply_markup: { inline_keyboard: [
          [{ text: "📱 Telebirr", callback_data: "w:telebirr" }],
          [{ text: "🏦 CBE Birr", callback_data: "w:cbe" }],
          [{ text: "⬅️ Cancel", callback_data: "m:home" }]
        ] }
      });
    }
    if (s.type === "withdraw" && s.step === "firstName" && s.flowVersion === 2) {
      if (value.length < 2 || value.length > 60 || /[0-9]/.test(value)) {
        return bot.sendMessage(msg.chat.id, "Enter a valid first name.");
      }
      await sessionRef(id).update({ step: "account", firstName: value });
      return bot.sendMessage(msg.chat.id, "Enter the " + s.method + " account phone number or account number where you want to receive the money.");
    }
    if (s.type === "withdraw" && s.step === "account" && s.flowVersion === 2) {
      const account = value.replace(/[\\s-]/g, "");
      if (!/^[0-9]{8,16}$/.test(account)) {
        return bot.sendMessage(msg.chat.id, "Enter a valid account or phone number using digits only.");
      }
      const requestId = crypto.randomUUID();
      const reservation = await playerRef(id).transaction(p => {
        if (!p || Number(p.balance || 0) < Number(s.amount)) return;
        p.balance = Number(p.balance || 0) - Number(s.amount);
        p.withdrawalHold = Number(p.withdrawalHold || 0) + Number(s.amount);
        p.withdrawalReservations = p.withdrawalReservations || {};
        if (p.withdrawalReservations[requestId]) return p;
        p.withdrawalReservations[requestId] = { amount: Number(s.amount), status: "pending", createdAt: Date.now() };
        p.transactions = p.transactions || {};
        p.transactions[requestId] = { type: "withdraw", amount: Number(s.amount), method: s.method, status: "pending", createdAt: Date.now() };
        return p;
      });
      if (!reservation.committed || !reservation.snapshot.child("withdrawalReservations/" + requestId).exists()) {
        return bot.sendMessage(msg.chat.id, "Your available balance changed. Please start the withdrawal again.", back());
      }
      const request = {
        type: "withdraw", telegramId: id, amount: Number(s.amount),
        method: s.method, firstName: s.firstName, accountNumber: account,
        status: "pending", createdAt: Date.now()
      };
      await db.ref("moneyRequests/" + requestId).set(request);
      await sessionRef(id).remove();
      await notifyAdmin(
        "💸 WITHDRAWAL REQUEST\nPlayer: " + id + "\nAmount: " + s.amount + " Br\nMethod: " + s.method +
        "\nFirst name: " + s.firstName + "\nAccount: " + account + "\nRequest: " + requestId,
        requestId, true
      );
      return bot.sendMessage(msg.chat.id, "✅ Withdrawal request submitted. " + s.amount + " Br has been placed on hold until the admin marks it paid or rejects it.", back());
    }
    if (s.type === "transfer" && s.step === "recipientPhone") {
      const phoneNumber = normalizeEthiopianPhone(value);
      if (!phoneNumber) return bot.sendMessage(msg.chat.id, "Enter a valid registered Ethiopian mobile number, such as 0912345678.");
      const ownPhone = (await playerRef(id).child("phoneNumber").once("value")).val();
      if (phoneNumber === ownPhone) {
        return bot.sendMessage(msg.chat.id, "You cannot transfer money to your own account. Enter another player's phone number.");
      }
      const indexed = (await db.ref("phoneNumberIndex/" + phoneNumber).once("value")).val();
      if (!indexed) return bot.sendMessage(msg.chat.id, "No registered player was found with that phone number. Check the number and try again.");
      const recipientId = String(indexed);
      const recipient = (await playerRef(recipientId).once("value")).val();
      if (!recipient || recipient.phoneVerified !== true || recipient.phoneNumber !== phoneNumber) {
        return bot.sendMessage(msg.chat.id, "This phone number is not linked to an active verified player account.");
      }
      const recipientName = recipient.username ? "@" + recipient.username : (recipient.firstName || "Player");
      await sessionRef(id).set({
        type: "transfer",
        step: "confirmRecipient",
        recipientId,
        recipientPhone: phoneNumber,
        updatedAt: Date.now()
      });
      return bot.sendMessage(msg.chat.id, "Please confirm the recipient before continuing.\n\nPlayer: " + recipientName + "\nPhone: " + phoneNumber, {
        reply_markup: { inline_keyboard: [[
          { text: "✅ Confirm Recipient", callback_data: "t:confirm" },
          { text: "❌ Cancel", callback_data: "t:cancel" }
        ]] }
      });
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
      const recipient = (await playerRef(s.recipientId).once("value")).val() || {};
      const recipientName = recipient.username ? "@" + recipient.username : (recipient.firstName || "Player");
      await bot.sendMessage(msg.chat.id, "✅ Transfer completed: " + amount + " Br sent to " + recipientName + ".", back());
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
    if (!p || p.phoneVerified !== true || p.notificationsEnabled === false) return false;
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
