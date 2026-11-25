
const tg = window.Telegram?.WebApp;

const API_URL = window.location.origin;

const balanceElement = document.getElementById("balance");
const playersElement = document.getElementById("players");
const registerButton = document.getElementById("registerBtn");

// Initialize Telegram Mini App
if (tg) {
  tg.ready();
  tg.expand();

  if (tg.initData) {
    console.log("Telegram authentication data received.");
  }
}

// Show loading state
registerButton.disabled = true;
registerButton.textContent = "LOADING TOURNAMENT...";

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

    console.log("Tournament settings:", settings);

    registerButton.disabled = false;
    registerButton.textContent =
      `REGISTER NOW - ${settings.entryFee} BR`;

  } catch (error) {
    console.error(error);

    registerButton.disabled = true;
    registerButton.textContent = "TOURNAMENT UNAVAILABLE";
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
      throw new Error(
        result.error || "Registration failed."
      );
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
