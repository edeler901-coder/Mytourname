
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
// ===================================
// BINGO CHAMPIONS - BOTTOM NAVIGATION
// ===================================

const homeSections = document.querySelectorAll(
  ".welcome, .wallet, .tournament-card, .stats"
);

const navButtons = document.querySelectorAll(".bottom-nav button");

const tabContent = document.createElement("section");
tabContent.id = "tabContent";
tabContent.style.display = "none";

document.querySelector(".app").appendChild(tabContent);

function showTab(tab) {
  navButtons.forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.tab === tab
    );
  });

  homeSections.forEach(section => {
    section.style.display = tab === "home" ? "" : "none";
  });

  tabContent.style.display = tab === "home" ? "none" : "block";

  if (tab === "brackets") {
    showBrackets();
  } else if (tab === "matches") {
  loadMyMatch();
} else if (tab === "history") {
    tabContent.innerHTML = `
      <h2>MATCH HISTORY</h2>
      <p>Your completed matches and results will appear here.</p>
    `;
  } else if (tab === "info") {
    tabContent.innerHTML = `
      <h2>TOURNAMENT INFO</h2>
      <p>Entry fee: 200 BR</p>
      <p>Groups: 32</p>
      <p>Tournament starts: 4:30 PM Addis Ababa time.</p>
    `;
  }
}

function showBrackets() {
  let groups = "";

  for (let i = 1; i <= 32; i++) {
    groups += `
      <div class="bracket-group">
        <strong>GROUP ${i}</strong>
        <span>Awaiting assignment</span>
      </div>
    `;
  }

  tabContent.innerHTML = `
    <h2>TOURNAMENT BRACKETS</h2>
    <p>32 groups · 32 qualifying places</p>

    <h3>PRELIMINARY ROUND</h3>
    <div class="bracket-grid">
      ${groups}
    </div>

    <h3>KNOCKOUT STAGES</h3>

    <div class="bracket-round">ROUND OF 32 — 32 PLAYERS</div>
    <div class="bracket-round">ROUND OF 16 — 16 PLAYERS</div>
    <div class="bracket-round">QUARTER-FINALS — 8 PLAYERS</div>
    <div class="bracket-round">SEMI-FINALS — 4 PLAYERS</div>
    <div class="bracket-round">GRAND FINAL — 2 PLAYERS</div>
  `;
}

navButtons.forEach(button => {
  button.addEventListener("click", () => {
    showTab(button.dataset.tab);
  });
});
// Load player's tournament group assignment
async function loadAssignment() {
  if (!tg || !tg.initData) return;

  try {
    const response = await fetch(
      `${API_URL}/api/player/assignment`,
      {
        headers: {
          "X-Telegram-Init-Data": tg.initData
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Assignment unavailable.");
    }

    let section = document.getElementById("assignmentInfo");

    if (!section) {
      section = document.createElement("section");
      section.id = "assignmentInfo";
      section.className = "tournament-card";
      document.querySelector(".app").appendChild(section);
    }

    if (!result.assigned) {
      section.innerHTML = `
        <h2>YOUR GROUP</h2>
        <p>Group assignments will appear after registration closes.</p>
      `;
      return;
    }

    const assignment = result.assignment;

    const time = new Date(assignment.scheduledAt)
      .toLocaleTimeString("en-GB", {
        timeZone: "Africa/Addis_Ababa",
        hour: "2-digit",
        minute: "2-digit"
      });

    section.innerHTML = `
      <h2>YOUR GROUP: ${assignment.groupNumber}</h2>
      <p>Match time: ${time}</p>
      <p>Status: ${assignment.status}</p>
    `;

  } catch (error) {
    console.error("Assignment error:", error);
  }
}

loadAssignment();
