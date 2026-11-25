
const tg = window.Telegram?.WebApp;

const API_URL = window.location.origin;

const balanceElement = document.getElementById("balance");
const playersElement = document.getElementById("players");
const registerButton = document.getElementById("registerBtn");

// Initialize Telegram
if (tg) {
  tg.ready();
  tg.expand();
}

// Load tournament settings
async function loadTournament() {
  try {
    const response = await fetch(
      `${API_URL}/api/tournament/settings`
    );

    if (!response.ok) {
      throw new Error("Could not load tournament.");
    }

    const settings = await response.json();

    registerButton.disabled = false;
    registerButton.textContent =
      `REGISTER NOW - ${settings.entryFee} BR`;

  } catch (error) {
    console.error(error);

    registerButton.disabled = true;
    registerButton.textContent = "TOURNAMENT UNAVAILABLE";
  }
}

// Load real wallet balance
async function loadBalance() {
  if (!tg || !tg.initData) {
    balanceElement.textContent = "—";
    return;
  }

  try {
    const response = await fetch(
      `${API_URL}/api/player/balance`,
      {
        headers: {
          "X-Telegram-Init-Data": tg.initData
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Wallet unavailable.");
    }

    balanceElement.textContent = result.balance;

  } catch (error) {
    console.error("Wallet error:", error);
    balanceElement.textContent = "—";
  }
}

// Register for tournament
async function registerTournament() {
  if (!tg || !tg.initData) {
    alert("Please open Bingo Champions through Telegram.");
    return;
  }

  registerButton.disabled = true;
  registerButton.textContent = "REGISTERING...";

  try {
    const response = await fetch(
      `${API_URL}/api/tournament/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Init-Data": tg.initData
        },
        body: JSON.stringify({})
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Registration failed.");
    }

    balanceElement.textContent = result.balance;
    registerButton.textContent = "REGISTERED ✓";

    alert("Congratulations! You are registered.");

  } catch (error) {
    console.error("Registration error:", error);

    alert(error.message);

    registerButton.disabled = false;
    registerButton.textContent = "REGISTER NOW";
  }
}

// Start application
loadTournament();
loadBalance();
