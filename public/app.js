
const tg = window.Telegram?.WebApp;

const API_URL = window.location.origin;

const balanceElement = document.getElementById("balance");
const playersElement = document.getElementById("players");
const prizePoolElement = document.getElementById("prizePool");
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

    updateTournamentStats(settings);
    await loadRegistrationStatus(settings.entryFee);

  } catch (error) {
    console.error(error);

    registerButton.disabled = true;
    registerButton.textContent = "TOURNAMENT UNAVAILABLE";
  }
}


// Restore the player's registration state when the Mini App opens.
async function loadRegistrationStatus(entryFee) {
  if (!tg || !tg.initData) {
    registerButton.disabled = false;
    registerButton.classList.remove("registered");
    registerButton.textContent = `REGISTER NOW - ${entryFee} BR`;
    return;
  }

  try {
    const response = await fetch(`${API_URL}/api/tournament/status`, {
      headers: {
        "X-Telegram-Init-Data": tg.initData
      }
    });

    if (!response.ok) throw new Error("Could not check registration status.");

    const status = await response.json();

    if (status.registered) {
      setRegisteredButton();
    } else {
      registerButton.disabled = false;
      registerButton.classList.remove("registered");
      registerButton.textContent = `REGISTER NOW - ${entryFee} BR`;
    }
  } catch (error) {
    console.error("Registration status error:", error);
    registerButton.disabled = false;
    registerButton.classList.remove("registered");
    registerButton.textContent = `REGISTER NOW - ${entryFee} BR`;
  }
}

function setRegisteredButton() {
  registerButton.disabled = true;
  registerButton.classList.add("registered");
  registerButton.textContent = "REGISTERED ✓";
}

// Update the public tournament player count and prize pool
function updateTournamentStats(settings) {
  if (playersElement) {
    playersElement.textContent =
      Number(settings.registeredPlayers || 0).toLocaleString("en-US");
  }

  const totalCollected = Number(settings.grossContributions || 0);
  const collectedElement = document.getElementById("totalCollected");

  if (collectedElement) {
    collectedElement.innerHTML =
      `${totalCollected.toLocaleString("en-US")} <small>BR</small>`;
  }

  const totalPrizePool = Number(settings.prizePool || 0);

  if (prizePoolElement) {
    prizePoolElement.innerHTML =
      `${totalPrizePool.toLocaleString("en-US")} <small>BR</small>`;
  }

  const formatPrizeAmount = (amount) =>
    `${amount.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })} BR`;

  const firstPrizeElement = document.getElementById("firstPrizeAmount");
  const secondPrizeElement = document.getElementById("secondPrizeAmount");
  const thirdPrizeElement = document.getElementById("thirdPrizeAmount");

  if (firstPrizeElement) {
    firstPrizeElement.textContent = formatPrizeAmount(totalPrizePool * 0.50);
  }
  if (secondPrizeElement) {
    secondPrizeElement.textContent = formatPrizeAmount(totalPrizePool * 0.30);
  }
  if (thirdPrizeElement) {
    thirdPrizeElement.textContent = formatPrizeAmount(totalPrizePool * 0.10);
  }
}

// Refresh statistics without changing the registration button state
async function loadTournamentStats() {
  try {
    const response = await fetch(`${API_URL}/api/tournament/settings`);
    if (!response.ok) throw new Error("Could not refresh tournament statistics.");
    updateTournamentStats(await response.json());
  } catch (error) {
    console.error("Tournament statistics error:", error);
  }
}

// Load the authenticated player's live wallet balance
async function loadPlayerBalance() {
  if (!tg || !tg.initData) {
    balanceElement.textContent = "—";
    return;
  }

  try {
    const response = await fetch(`${API_URL}/api/player/balance`, {
      headers: {
        "X-Telegram-Init-Data": tg.initData
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not load wallet balance.");
    }

    balanceElement.textContent =
      Number(result.balance || 0).toLocaleString("en-US");
  } catch (error) {
    console.error("Wallet balance error:", error);
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
      throw new Error(
        result.error || "Registration failed."
      );
    }

    balanceElement.textContent = result.balance;

    setRegisteredButton();
    await loadTournamentStats();

    alert("Congratulations! You are registered.");

  } catch (error) {
    console.error("Registration error:", error);

    alert(error.message);

    registerButton.disabled = false;
    registerButton.classList.remove("registered");
    registerButton.textContent = "REGISTER NOW";
  }
}

// Start application
loadTournament();
loadPlayerBalance();
setInterval(loadTournamentStats, 15000);
// ===================================
// BINGO CHAMPIONS - BOTTOM NAVIGATION
// ===================================

const homeSections = document.querySelectorAll(
  ".welcome-wallet-row, .tournament-card, .stats"
);

const navButtons = document.querySelectorAll(".bottom-nav button");

const tabContent = document.createElement("section");
tabContent.id = "tabContent";
tabContent.style.display = "none";

document.querySelector(".app").appendChild(tabContent);

function showTab(tab) {
  if (tab !== "brackets" && bracketCountdownInterval) {
    clearInterval(bracketCountdownInterval);
    bracketCountdownInterval = null;
  }

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

let bracketCountdownInterval = null;

function updateGroupCountdowns() {
  document.querySelectorAll("[data-group-countdown]").forEach(timer => {
    const status = String(timer.dataset.status || "scheduled").toLowerCase();
    if (status === "completed") {
      timer.textContent = "COMPLETED";
      return;
    }
    if (status === "in_progress" || status === "board_selection") {
      timer.textContent = status === "board_selection" ? "BOARD SELECTION" : "LIVE NOW";
      return;
    }
    const startAt = Date.parse(timer.dataset.startAt || "");
    if (!Number.isFinite(startAt)) {
      timer.textContent = "SCHEDULE PENDING";
      return;
    }
    const remaining = Math.max(0, startAt - Date.now());
    if (remaining === 0) {
      timer.textContent = "STARTING";
      return;
    }
    const totalSeconds = Math.floor(remaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    timer.textContent = days > 0
      ? `${days}d ${hours}h ${minutes}m`
      : hours > 0
        ? `${hours}h ${minutes}m ${seconds}s`
        : `${minutes}m ${seconds}s`;
  });
}

async function showBrackets() {
  if (bracketCountdownInterval) clearInterval(bracketCountdownInterval);
  tabContent.innerHTML = "<h2>TOURNAMENT BRACKETS</h2><p>Loading live bracket...</p>";

  function safe(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[char]);
  }

  try {
    const headers = tg && tg.initData ? { "X-Telegram-Init-Data": tg.initData } : {};
    const [bracketResponse, assignmentResponse] = await Promise.all([
      fetch(`${API_URL}/api/tournament/brackets`),
      tg && tg.initData ? fetch(`${API_URL}/api/player/assignment`, { headers }) : Promise.resolve(null)
    ]);
    const data = await bracketResponse.json();
    if (!bracketResponse.ok) throw new Error(data.error || "Bracket unavailable.");

    let myMatchId = null;
    let myMatchStatus = "scheduled";
    if (assignmentResponse) {
      const assignmentData = await assignmentResponse.json();
      if (assignmentResponse.ok && assignmentData.assigned) {
        myMatchId = assignmentData.assignment.matchId || null;
        myMatchStatus = assignmentData.matchStatus || "scheduled";
      }
    }

    const groupRows = data.groups && data.groups.length
      ? data.groups.map(group => {
          const isMyGroup = Boolean(myMatchId && group.matchId === myMatchId);
          const players = (group.players || []).map(player =>
            `<div class="group-player"><span class="group-player-dot"></span><span class="group-player-name">${safe(player.name)}</span></div>`
          ).join("");
          const status = String(group.status || "scheduled").toLowerCase();
          const canPlay = isMyGroup && ["board_selection", "in_progress"].includes(myMatchStatus);
          const scheduledDate = group.scheduledAt
            ? new Date(group.scheduledAt).toLocaleString("en-US", {
                timeZone: "Africa/Addis_Ababa",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
              })
            : "Schedule pending";
          const matchLabel = group.matchNumber || group.groupNumber;
          const buttonLabel = myMatchStatus === "board_selection" ? "PLAY — SELECT BOARD" : "PLAY MATCH";
          return `
            <article class="group-card" data-group-card data-match-id="${safe(group.matchId || "")}">
              <button type="button" class="group-card-toggle" aria-expanded="false">
                <span class="group-card-top">
                  <strong>Match #${safe(matchLabel)}</strong>
                  <span class="group-card-time">
                    <span class="group-clock-icon" aria-hidden="true">◷</span>
                    <span class="group-scheduled-date">${safe(scheduledDate)}</span>
                    <b class="group-countdown" data-group-countdown data-start-at="${safe(group.scheduledAt || "")}" data-status="${safe(status)}">Loading...</b>
                  </span>
                </span>
                <span class="group-card-meta">
                  <span class="group-status">${safe(status === "scheduled" ? "Scheduled" : status.replaceAll("_", " "))}</span>
                  <span class="group-player-count">${safe(group.playerCount)}P</span>
                  <span class="group-chevron" aria-hidden="true">⌄</span>
                </span>
              </button>
              <div class="group-card-details" hidden>
                <div class="group-player-list">${players || '<span class="group-empty">Players will appear after assignments.</span>'}</div>
                ${isMyGroup ? `<button type="button" class="group-play-button" ${canPlay ? "" : "disabled"}>${canPlay ? buttonLabel : "WAIT FOR MATCH TIME"}</button>` : ""}
                ${isMyGroup && !canPlay ? '<p class="group-wait-note">PLAY opens when your 100-second board-selection window begins.</p>' : ""}
              </div>
            </article>
          `;
        }).join("")
      : Array.from({length:32},(_,index)=>`
          <article class="group-card" data-group-card>
            <button type="button" class="group-card-toggle" aria-expanded="false">
              <span class="group-card-top"><strong>Match #${index+1}</strong><span class="group-scheduled-date">Schedule pending</span></span>
              <span class="group-card-meta"><span class="group-status">Scheduled</span><span class="group-player-count">0P</span><span class="group-chevron" aria-hidden="true">⌄</span></span>
            </button>
            <div class="group-card-details" hidden><p class="group-empty">Players will appear after assignments.</p></div>
          </article>
        `).join("");

    const stageDefinitions = [
      ["round32","ROUND OF 32 — 16 MATCHES"],
      ["round16","ROUND OF 16 — 8 MATCHES"],
      ["quarterfinals","QUARTER-FINALS — 4 MATCHES"],
      ["semifinals","SEMI-FINALS — 2 MATCHES"],
      ["final","GRAND FINAL"]
    ];
    const stageRows = stageDefinitions.map(([key,title]) => {
      const stage = data.rounds && data.rounds[key];
      if (!stage) return `<div class="bracket-round">${title} · Awaiting qualification</div>`;
      const matches = (stage.matches || []).map(match => {
        const players = (match.players || []).map(player=>safe(player.name)).join(" vs ");
        const status = safe(String(match.status||"scheduled").replaceAll("_"," ").toUpperCase());
        const result = match.winner ? " · Winner: "+safe(match.winner) : "";
        return `<div class="bracket-group"><strong>MATCH ${safe(match.matchNumber||"")}</strong><span>${players||"Players pending"}</span><small>${status}${result}</small></div>`;
      }).join("");
      return `<h3>${title}</h3><div class="bracket-grid">${matches||"<p>Matches pending</p>"}</div>`;
    }).join("");

    tabContent.innerHTML = `
      <h2>TOURNAMENT BRACKETS</h2>
      <p>${safe(data.tournamentDate)} · 32 groups · 32 qualifying places</p>
      <h3>PRELIMINARY ROUND</h3><div class="group-card-list">${groupRows}</div>
      <h3>KNOCKOUT STAGES</h3>${stageRows}
    `;

    document.querySelectorAll("[data-group-card]").forEach(card => {
      const toggle = card.querySelector(".group-card-toggle");
      const details = card.querySelector(".group-card-details");
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        details.hidden = expanded;
        card.classList.toggle("expanded", !expanded);
      });
      const play = card.querySelector(".group-play-button");
      if (play) play.addEventListener("click", openGameRoom);
    });

    updateGroupCountdowns();

    async function refreshOwnGroupPlayButton() {
      if (!tg || !tg.initData) return;
      try {
        const response = await fetch(`${API_URL}/api/player/assignment`, {
          headers: { "X-Telegram-Init-Data": tg.initData }
        });
        if (!response.ok) return;
        const current = await response.json();
        if (!current.assigned || !current.assignment.matchId) return;

        const ownCard = Array.from(document.querySelectorAll("[data-group-card]"))
          .find(card => card.dataset.matchId === current.assignment.matchId);
        if (!ownCard) return;

        const button = ownCard.querySelector(".group-play-button");
        if (!button) return;

        const status = String(current.matchStatus || "scheduled").toLowerCase();
        const active = ["board_selection", "in_progress"].includes(status);
        button.disabled = !active;
        button.textContent = status === "board_selection"
          ? "PLAY — SELECT BOARD"
          : status === "in_progress"
            ? "PLAY MATCH"
            : "WAIT FOR MATCH TIME";
        const note = ownCard.querySelector(".group-wait-note");
        if (note) note.hidden = active;
      } catch (error) {
        console.error("Group play status refresh error:", error);
      }
    }

    let lastPlayStatusRefresh = 0;
    bracketCountdownInterval = setInterval(() => {
      updateGroupCountdowns();
      if (Date.now() - lastPlayStatusRefresh >= 5000) {
        lastPlayStatusRefresh = Date.now();
        refreshOwnGroupPlayButton();
      }
    }, 1000);
  } catch(error) {
    console.error("Bracket loading error:",error);
    tabContent.innerHTML = `<h2>TOURNAMENT BRACKETS</h2><p>${safe(error.message)}</p>`;
  }
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

// Assignment details are temporarily hidden from the Home tab.


// ===================================
// MY MATCHES - LOAD PLAYER MATCH
// ===================================

let gameRoomPoll = null;

async function loadMyMatch() {
  if (!tg || !tg.initData) {
    tabContent.innerHTML = `
      <h2>MY MATCHES</h2>
      <p>Open Bingo Champions through Telegram to view your match.</p>
    `;
    return;
  }

  tabContent.innerHTML = `
    <h2>MY MATCHES</h2>
    <p>Loading your match...</p>
  `;

  try {
    const response = await fetch(`${API_URL}/api/player/match`, {
      headers: {
        "X-Telegram-Init-Data": tg.initData
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not load your match.");
    }

    if (!result.ready) {
      tabContent.innerHTML = `
        <h2>MY MATCHES</h2>
        <p>${result.message || "Your match is not available yet."}</p>
      `;
      return;
    }

    const match = result.match;

    const matchTime = new Date(match.scheduledAt)
      .toLocaleTimeString("en-GB", {
        timeZone: "Africa/Addis_Ababa",
        hour: "2-digit",
        minute: "2-digit"
      });

    const canEnter = [
      "board_selection",
      "in_progress",
      "completed"
    ].includes(match.status);

    tabContent.innerHTML = `
      <h2>YOUR MATCH</h2>

      <div class="tournament-card">
        <p>${match.roundLabel || ("GROUP " + match.groupNumber)}</p>
        <h2>Match ${match.matchId}</h2>
        <p>Scheduled time: ${matchTime}</p>
        <p>Status: ${match.status.replaceAll("_", " ").toUpperCase()}</p>
        <p>Players: ${match.playerCount}</p>

        <button id="enterMatchBtn"
          ${canEnter ? "" : "disabled"}
          style="width:100%;margin-top:15px;">
          ${canEnter ? "PLAY MATCH" : "WAIT FOR MATCH TIME"}
        </button>
      </div>
    `;

    const enterButton = document.getElementById("enterMatchBtn");

    if (canEnter) {
      enterButton.addEventListener("click", openGameRoom);
    }

  } catch (error) {
    console.error("My match error:", error);

    tabContent.innerHTML = `
      <h2>MY MATCHES</h2>
      <p>${error.message}</p>
    `;
  }
}

// ===================================
// OPEN GAME ROOM
// ===================================

async function openGameRoom() {
  if (gameRoomPoll) {
    clearInterval(gameRoomPoll);
  }

  homeSections.forEach(section => {
    section.style.display = "none";
  });

  tabContent.style.display = "none";

  const room = document.getElementById("gameRoom");
  room.hidden = false;
  document.querySelector(".app").classList.add("game-active");

  await refreshGameRoom();

  gameRoomPoll = setInterval(refreshGameRoom, 1000);
}

// ===================================
// REFRESH GAME ROOM
// ===================================

async function refreshGameRoom() {
  try {
    const response = await fetch(`${API_URL}/api/player/match`, {
      headers: {
        "X-Telegram-Init-Data": tg.initData
      }
    });

    const result = await response.json();

    if (!response.ok || !result.ready) {
      throw new Error(result.error || "Match unavailable.");
    }

    const match = result.match;
    const selection = result.selection;
    const card = result.card;

    document.getElementById("gameId").textContent = match.matchId;
    document.getElementById("gamePlayers").textContent = match.playerCount;
    document.getElementById("callsCount").textContent =
      (match.drawnNumbers || []).length;

    const selectionScreen = document.getElementById("selectionScreen");
    const liveScreen = document.getElementById("liveGameScreen");

    if (match.status === "board_selection") {
      selectionScreen.hidden = false;
      liveScreen.hidden = true;

      renderBoardChoices(selection);
      updateSelectionCountdown(selection.selectionEndsAt);

    } else if (
      match.status === "in_progress" ||
      match.status === "completed"
    ) {
      selectionScreen.hidden = true;
      liveScreen.hidden = false;

      if (card) {
        renderPlayerCard(card, match.drawnNumbers || []);
      }

      renderCalledNumbers(match.drawnNumbers || []);

      const lastCall = match.lastCalledNumber;

      document.getElementById("latestCall").textContent =
        lastCall ? `${lastCall.letter}-${lastCall.number}` : "—";

      document.getElementById("gameCountdown").textContent =
        match.status === "completed" ? "FINISHED" : "LIVE";

      if (match.status === "completed") {
        document.getElementById("bingoBtn").disabled = true;
        document.getElementById("bingoBtn").textContent = "MATCH FINISHED";
        clearInterval(gameRoomPoll);
      }
    }

  } catch (error) {
    console.error("Game room refresh error:", error);
  }
}

// ===================================
// BOARD SELECTION
// ===================================

function renderBoardChoices(selection) {
  const container = document.getElementById("boardChoices");

  if (!selection || !selection.availableBoards) return;

  container.innerHTML = "";

  document.getElementById("selectionMessage").textContent =
    selection.selectedBoardNumber
      ? `Your selected board: ${selection.selectedBoardNumber}. You can change it before time expires.`
      : "Choose one available board. Each board can be selected by only one player.";

  selection.availableBoards.forEach(board => {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "board-choice";

    if (!board.available) {
      button.classList.add("unavailable");
      button.disabled = true;
    }

    if (Number(selection.selectedBoardNumber) === board.boardNumber) {
      button.classList.add("selected");
    }

    button.textContent = board.boardNumber;

    button.addEventListener("click", async () => {
      button.disabled = true;

      try {
        const response = await fetch(`${API_URL}/api/player/select-board`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Init-Data": tg.initData
          },
          body: JSON.stringify({
            boardNumber: board.boardNumber
          })
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Board selection failed.");
        }

        await refreshGameRoom();

      } catch (error) {
        alert(error.message);
        await refreshGameRoom();
      }
    });

    container.appendChild(button);
  });
}

// ===================================
// SHARED SELECTION COUNTDOWN
// ===================================

function updateSelectionCountdown(endsAt) {
  const timer = document.getElementById("selectionTimer");

  if (!endsAt) {
    timer.textContent = "00:00";
    return;
  }

  const remaining = Math.max(0, Number(endsAt) - Date.now());

  const seconds = Math.ceil(remaining / 1000);
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsText = String(seconds % 60).padStart(2, "0");

  timer.textContent = `${minutesText}:${secondsText}`;

  if (remaining <= 0) {
    document.getElementById("selectionMessage").textContent =
      "Selection closed. Starting your match...";
  }
}

// ===================================
// RENDER PERMANENT PLAYER CARD
// ===================================

function renderPlayerCard(playerCard, drawnNumbers) {
  const grid = document.getElementById("playerCardGrid");
  const card = playerCard.card;

  if (!card) return;

  document.getElementById("playerBoardNumber").textContent =
    playerCard.boardNumber;

  const called = new Set(drawnNumbers);

  grid.innerHTML = "";

  ["B", "I", "N", "G", "O"].forEach(letter => {
    card[letter].forEach(number => {
      const cell = document.createElement("div");
      cell.className = "player-cell";

      if (number === 0) {
        cell.textContent = "FREE";
        cell.classList.add("free", "marked");
      } else {
        cell.textContent = number;

        if (called.has(number)) {
          cell.classList.add("marked");
        }
      }

      grid.appendChild(cell);
    });
  });
}

// ===================================
// RENDER CALLED NUMBERS
// ===================================


 
// ===================================
// GAME ROOM CONTROLS
// ===================================

async function claimBingo() {
  const button = document.getElementById("bingoBtn");

  if (!tg || !tg.initData || button.disabled) return;

  button.disabled = true;
  button.textContent = "VERIFYING BINGO...";

  try {
    const response = await fetch(
      `${API_URL}/api/player/claim-bingo`,
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
      throw new Error(result.error || "Bingo claim could not be verified.");
    }

    button.textContent = "BINGO CONFIRMED ✓";
    alert("BINGO CONFIRMED! You are the winner of this match.");

    await refreshGameRoom();

  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = "BINGO!";
  }
}

function leaveGameRoom() {
  if (gameRoomPoll) {
    clearInterval(gameRoomPoll);
    gameRoomPoll = null;
  }

  const room = document.getElementById("gameRoom");
  room.hidden = true;
  document.querySelector(".app").classList.remove("game-active");

  tabContent.style.display = "block";
  loadMyMatch();
}

document.getElementById("bingoBtn")
  .addEventListener("click", claimBingo);

document.getElementById("refreshGameBtn")
  .addEventListener("click", refreshGameRoom);

document.getElementById("leaveGameBtn")
  .addEventListener("click", leaveGameRoom);

function renderCalledNumbers(drawnNumbers) {
  const board = document.getElementById("calledNumbersBoard");

  board.innerHTML = "";

  for (let number = 1; number <= 75; number++) {
    const cell = document.createElement("div");

    cell.className = "called-number";

    if (drawnNumbers.includes(number)) {
      cell.classList.add("called");
    }

    cell.textContent = number;
    board.appendChild(cell);
  }
}
