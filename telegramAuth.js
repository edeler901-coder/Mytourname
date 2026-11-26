
const crypto = require("crypto");
const { db } = require("./firebase");

function verifyTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken || !initData || typeof initData !== "string") {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const received = Buffer.from(receivedHash, "hex");
    const calculated = Buffer.from(calculatedHash, "hex");

    if (
      received.length !== calculated.length ||
      !crypto.timingSafeEqual(received, calculated)
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));

    if (
      !Number.isFinite(authDate) ||
      authDate > Math.floor(Date.now() / 1000) + 30 ||
      Math.floor(Date.now() / 1000) - authDate > 86400
    ) {
      return null;
    }

    const userData = params.get("user");

    if (!userData) return null;

    const user = JSON.parse(userData);

    if (!user.id) return null;

    return user;
  } catch (error) {
    return null;
  }
}

async function requireTelegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  const user = verifyTelegramInitData(initData);

  if (!user) {
    return res.status(401).json({
      error: "Telegram authentication failed"
    });
  }

  try {
    const playerSnapshot = await db.ref("players/" + String(user.id)).once("value");
    const player = playerSnapshot.val();

    if (!player || player.phoneVerified !== true || !player.phoneNumber) {
      return res.status(403).json({
        error: "Phone verification is required before using Bingo Champions."
      });
    }

    req.telegramUser = user;
    next();
  } catch (error) {
    console.error("Phone verification lookup failed:", error);
    return res.status(503).json({
      error: "Unable to verify your player account. Please try again."
    });
  }
}

module.exports = {
  verifyTelegramInitData,
  requireTelegramAuth
};
