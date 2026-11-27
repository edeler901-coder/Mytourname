const crypto = require("crypto");
const { db } = require("./firebase");
const { registerPlayerForTournament } = require("./registration");

const TIME_ZONE = "Africa/Addis_Ababa";
const ENTRY_FEE = 200;
const CHECK_INTERVAL = 5 * 60 * 1000;
const PROCESSING_LEASE = 10 * 60 * 1000;
const SCHEDULE_VERSION = 4;
const MIN_DAILY_SIMULATORS = 55;
const MAX_DAILY_SIMULATORS = 75;

let schedulerStarted = false;
let schedulerTimer = null;
let registrationCycleRunning = false;

function getAddisDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return values.year + "-" + values.month + "-" + values.day;
}

function getTomorrowDate(dateString = getAddisDate()) {
  const parts = dateString.split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1))
    .toISOString()
    .slice(0, 10);
}

function getAddisDayStart(dateString) {
  const parts = dateString.split("-").map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2], -3, 0, 0, 0);
}

function getAddisDayEnd(dateString) {
  return getAddisDayStart(dateString) + 24 * 60 * 60 * 1000;
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function isSimulatorAccount(account) {
  return Boolean(
    account &&
    account.isSimulator === true &&
    account.accountType === "simulator"
  );
}

function makeRandomRegistrationTasks(playerIds, startAt, endAt, previousTasks = [], targetCount) {
  const previousById = new Map();

  for (const task of previousTasks || []) {
    if (task && task.playerId) {
      previousById.set(String(task.playerId), task);
    }
  }

  // Never remove a registration already completed for this tournament.
  const completedTasks = [...previousById.values()].filter(
    task => task.status === "completed"
  );
  const completedIds = new Set(
    completedTasks.map(task => String(task.playerId))
  );

  const selectedIds = [...completedIds];
  const needed = Math.max(0, targetCount - selectedIds.length);
  const candidates = shuffle(
    playerIds.filter(id => !completedIds.has(String(id)))
  );
  selectedIds.push(...candidates.slice(0, needed));

  const duration = Math.max(0, endAt - startAt);
  const tasks = selectedIds.map(playerId => {
    const id = String(playerId);
    const previous = previousById.get(id);

    if (previous && previous.status === "completed") return previous;

    // Random timestamp across the remaining Addis Ababa registration day.
    const runAt = duration > 0
      ? startAt + crypto.randomInt(duration + 1)
      : startAt;

    return {
      playerId: id,
      runAt,
      status: "pending",
      attempts: Number(previous && previous.attempts) || 0,
      nextAttemptAt: runAt,
      lastError: previous && previous.lastError
        ? previous.lastError
        : null
    };
  });

  return tasks.sort((a, b) => Number(a.runAt || 0) - Number(b.runAt || 0));
}
tus === "completed") tasks.push(previous);
  }

  return tasks;
}

async function getOpenTournament(tournamentDate) {
  const snapshot = await db
    .ref("tournaments/" + tournamentDate)
    .once("value");

  if (!snapshot.exists()) return null;

  const tournament = snapshot.val();

  if (
    tournament.tournamentDate !== tournamentDate ||
    tournament.registrationOpen !== true
  ) {
    return null;
  }

  const entryFee = Number(tournament.entryFee || ENTRY_FEE);
  if (!Number.isFinite(entryFee) || entryFee <= 0) {
    throw new Error("Tournament entry fee is invalid.");
  }

  return {
    ...tournament,
    entryFee
  };
}

async function prepareDailySchedule() {
  const registrationDate = getAddisDate();
  const tournamentDate = getTomorrowDate(registrationDate);
  const tournament = await getOpenTournament(tournamentDate);

  if (!tournament) {
    console.log("Simulator scheduler is waiting for tomorrow's tournament registration to open.");
    return null;
  }

  const simulatorSnapshot = await db.ref("simulators").once("value");
  const simulatorAccounts = simulatorSnapshot.val() || {};

  const simulatorIds = Object.entries(simulatorAccounts)
    .filter(([, account]) => isSimulatorAccount(account))
    .map(([playerId]) => String(playerId));

  if (simulatorIds.length === 0) {
    console.log("No existing simulator accounts were found. No accounts were created or changed.");
    return null;
  }

  const scheduleRef = db.ref("simulatorSchedules/" + registrationDate);
  const now = Date.now();
  const dayEnd = Math.min(
    getAddisDayEnd(registrationDate),
    Number(tournament.registrationClosesAt) || getAddisDayEnd(registrationDate)
  );

  // Pick the daily target once outside the Firebase transaction callback.
  // This keeps the target stable if Firebase retries the transaction.
  const dailyTarget = Math.min(
    simulatorIds.length,
    crypto.randomInt(
      Math.min(MIN_DAILY_SIMULATORS, simulatorIds.length),
      Math.min(MAX_DAILY_SIMULATORS, simulatorIds.length) + 1
    )
  );
  const startAt = Math.max(now, getAddisDayStart(registrationDate));
  const shuffledIds = shuffle(simulatorIds);

  const transaction = await scheduleRef.transaction(current => {
    if (
      current &&
      current.version === SCHEDULE_VERSION &&
      current.tournamentDate === tournamentDate
    ) {
      return current;
    }

    const previousTasks = current && current.tournamentDate === tournamentDate
      ? current.tasks || []
      : [];

    const tasks = makeRandomRegistrationTasks(
      shuffledIds,
      startAt,
      dayEnd,
      previousTasks,
      dailyTarget
    );

    return {
      version: SCHEDULE_VERSION,
      registrationDate,
      tournamentDate,
      totalSimulators: tasks.length,
      dailyTarget: tasks.length,
      createdAt: current && current.createdAt
        ? current.createdAt
        : now,
      updatedAt: now,
      tasks
    };
  });

  const schedule = transaction.snapshot.val();

  if (!schedule) return null;

  console.log(
    "Simulator schedule ready for " +
    tournamentDate +
    ": " +
    schedule.totalSimulators +
    " randomly selected simulator accounts for today."
  );

  return schedule;
}

function isMatchingSimulatorRegistration(registration, playerId) {
  return Boolean(
    registration &&
    registration.isSimulator === true &&
    String(registration.playerId || registration.telegramId) === String(playerId)
  );
}

async function removeUnpaidReservation(registrationRef, playerId) {
  await registrationRef.transaction(current => {
    if (
      current &&
      current.status === "processing" &&
      current.isSimulator === true &&
      String(current.playerId || current.telegramId) === String(playerId)
    ) {
      return null;
    }
    return current;
  });
}

async function registerSimulator(playerId, tournamentDate, entryFee) {
  const snapshot = await db.ref("tournaments/" + tournamentDate).once("value");
  const tournament = snapshot.val();
  if (!tournament || tournament.registrationOpen !== true) {
    return { status: "registration_closed" };
  }
  const result = await registerPlayerForTournament(
    playerId, tournament, { accountType: "simulator" }
  );
  return {
    status: result.status === "insufficient_funds"
      ? "insufficient_funds"
      : result.alreadyRegistered ? "already_registered" : "registered",
    balance: result.balance
  };
}

async function claimTask(taskRef, now) {
  // This scheduler runs as a single Render process. Read and conditionally
  // update the task directly; registerSimulator() independently protects
  // wallet charging and duplicate registrations with Firebase transactions.
  const snapshot = await taskRef.once("value");
  const current = snapshot.val();

  if (!current) return null;

  const status = current.status || "pending";
  const nextAttemptAt = Number(current.nextAttemptAt || current.runAt || 0);

  if (status === "completed") return null;

  if (status === "processing") {
    const claimedAt = Number(current.claimedAt || 0);
    if (now - claimedAt < PROCESSING_LEASE) return null;
  } else if (
    status !== "pending" &&
    status !== "skipped_insufficient_funds" &&
    status !== "failed"
  ) {
    return null;
  } else if (nextAttemptAt > now) {
    return null;
  }

  const claimId = crypto.randomUUID();
  const claimedTask = {
    ...current,
    status: "processing",
    claimId,
    claimedAt: now,
    attempts: (Number(current.attempts) || 0) + 1,
    lastAttemptAt: now
  };

  await taskRef.update(claimedTask);

  const verifiedSnapshot = await taskRef.once("value");
  const verifiedTask = verifiedSnapshot.val();

  if (!verifiedTask || verifiedTask.claimId !== claimId) return null;

  return { claimId, task: verifiedTask };
}

async function finishTask(taskRef, claimId, updates) {
  await taskRef.transaction(current => {
    if (!current || current.claimId !== claimId) return;

    Object.assign(current, updates);
    delete current.claimId;
    delete current.claimedAt;

    return current;
  });
}

async function updateReportEntry(tournamentDate, playerId, task) {
  const reportRef = db.ref(
    "simulatorRegistrationReports/" +
    tournamentDate +
    "/simulators/" +
    playerId
  );

  await reportRef.set({
    playerId: String(playerId),
    status: task.status,
    attempts: Number(task.attempts) || 0,
    entryFee: task.entryFee || null,
    runAt: task.runAt || null,
    nextAttemptAt: task.nextAttemptAt || null,
    lastAttemptAt: task.lastAttemptAt || null,
    completedAt: task.completedAt || null,
    lastError: task.lastError || null,
    updatedAt: Date.now()
  });
}

async function rebuildDailyReport(schedule, tournament) {
  const counts = {
    total: 0,
    registered: 0,
    skipped: 0,
    pending: 0,
    failed: 0,
    processing: 0
  };

  for (const task of schedule.tasks || []) {
    if (!task) continue;
    counts.total++;

    if (task.status === "completed") counts.registered++;
    else if (task.status === "skipped_insufficient_funds") counts.skipped++;
    else if (task.status === "failed") counts.failed++;
    else if (task.status === "processing") counts.processing++;
    else counts.pending++;
  }

  await db.ref(
    "simulatorRegistrationReports/" + schedule.tournamentDate
  ).update({
    registrationDate: schedule.registrationDate,
    tournamentDate: schedule.tournamentDate,
    entryFee: Number(tournament.entryFee || ENTRY_FEE),
    checkIntervalSeconds: CHECK_INTERVAL / 1000,
    totalSimulators: counts.total,
    registered: counts.registered,
    skippedForInsufficientFunds: counts.skipped,
    pending: counts.pending,
    failed: counts.failed,
    processing: counts.processing,
    registrationOpen: tournament.registrationOpen === true,
    updatedAt: Date.now()
  });
}

async function processDueRegistrations() {
  if (registrationCycleRunning) {
    console.log("Simulator registration cycle skipped: previous cycle is still running.");
    return;
  }
  registrationCycleRunning = true;

  try {
    const registrationDate = getAddisDate();
    const tournamentDate = getTomorrowDate(registrationDate);

    const prepared = await prepareDailySchedule();
    if (!prepared) return;

    const scheduleSnapshot = await db
      .ref("simulatorSchedules/" + registrationDate)
      .once("value");

    const schedule = scheduleSnapshot.val();
    if (!schedule || schedule.tournamentDate !== tournamentDate) return;

    const tournament = await getOpenTournament(tournamentDate);

    if (!tournament) {
      const tournamentSnapshot = await db
        .ref("tournaments/" + tournamentDate)
        .once("value");
      const closedTournament = tournamentSnapshot.val();

      if (closedTournament) {
        await rebuildDailyReport(schedule, {
          ...closedTournament,
          registrationOpen: false
        });
      }
      return;
    }

    const now = Date.now();
    const closingAt = Number(tournament.registrationClosesAt) ||
      getAddisDayEnd(registrationDate);

    const taskList = schedule.tasks || [];
    const dueTasks = taskList.filter(task =>
      task &&
      Number(task.runAt) <= now &&
      (task.status || "pending") !== "completed" &&
      Number(task.nextAttemptAt || task.runAt || 0) <= now
    );
    const earliestTask = taskList
      .filter(Boolean)
      .sort((a, b) => Number(a.runAt || 0) - Number(b.runAt || 0))[0];

    console.log("Simulator scheduler check:", {
      tournamentDate,
      currentAddisTime: new Date(now).toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa" }),
      totalTasks: taskList.length,
      dueTasks: dueTasks.length,
      earliestRunAtAddis: earliestTask
        ? new Date(Number(earliestTask.runAt)).toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa" })
        : null,
      earliestTaskStatus: earliestTask ? earliestTask.status || "pending" : null,
      registrationClosesAtAddis: new Date(closingAt).toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa" })
    });

    if (now >= closingAt) {
      await rebuildDailyReport(schedule, {
        ...tournament,
        registrationOpen: false
      });
      return;
    }

    for (let index = 0; index < (schedule.tasks || []).length; index++) {
      const task = schedule.tasks[index];
      if (!task || Number(task.runAt) > now) continue;

      const status = task.status || "pending";
      if (status === "completed") continue;
      if (
        status !== "processing" &&
        Number(task.nextAttemptAt || task.runAt || 0) > now
      ) {
        continue;
      }

      const taskRef = db.ref(
        "simulatorSchedules/" + registrationDate + "/tasks/" + index
      );

      const claim = await claimTask(taskRef, now);
      if (!claim) {
        const currentTaskSnapshot = await taskRef.once("value");
        const currentTask = currentTaskSnapshot.val() || {};
        console.log("Simulator task was not claimed:", {
          playerId: task.playerId,
          status: currentTask.status || "pending",
          runAt: currentTask.runAt || null,
          nextAttemptAt: currentTask.nextAttemptAt || null,
          claimedAt: currentTask.claimedAt || null,
          currentTime: now
        });
        continue;
      }

      const playerId = String(claim.task.playerId);

      try {
        console.log(
          "Attempting simulator registration:",
          playerId,
          "for",
          tournamentDate
        );

        const result = await registerSimulator(
          playerId,
          tournamentDate,
          tournament.entryFee
        );

        console.log(
          "Simulator registration result:",
          playerId,
          result.status
        );

        if (
          result.status === "registered" ||
          result.status === "already_registered"
        ) {
          await finishTask(taskRef, claim.claimId, {
            status: "completed",
            entryFee: tournament.entryFee,
            completedAt: Date.now(),
            lastError: null
          });
        } else if (result.status === "insufficient_funds") {
          await finishTask(taskRef, claim.claimId, {
            status: "skipped_insufficient_funds",
            entryFee: tournament.entryFee,
            nextAttemptAt: Date.now() + CHECK_INTERVAL,
            lastError: null
          });
        } else if (result.status === "registration_closed") {
          await finishTask(taskRef, claim.claimId, {
            status: "pending",
            nextAttemptAt: closingAt,
            lastError: "Waiting for an open registration window."
          });
        }

      } catch (error) {
        console.error(
          "Simulator registration attempt failed for " +
          playerId +
          ": " +
          error.message
        );

        await finishTask(taskRef, claim.claimId, {
          status: "failed",
          nextAttemptAt: Date.now() + CHECK_INTERVAL,
          lastError: String(error.message || error).slice(0, 500)
        });
      }

      const latestTask = await taskRef.once("value");
      if (latestTask.exists()) {
        await updateReportEntry(
          tournamentDate,
          playerId,
          latestTask.val()
        );
      }
    }

    const latestSchedule = await db
      .ref("simulatorSchedules/" + registrationDate)
      .once("value");

    if (latestSchedule.exists()) {
      await rebuildDailyReport(latestSchedule.val(), tournament);
    }

  } catch (error) {
    console.error("Simulator scheduler cycle failed:", error);
  } finally {
    registrationCycleRunning = false;
  }
}

function startSimulatorScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;
  console.log(
    "Simulator registration scheduler started. It checks every 5 minutes."
  );

  processDueRegistrations();

  schedulerTimer = setInterval(
    processDueRegistrations,
    CHECK_INTERVAL
  );

  if (schedulerTimer && typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
}

module.exports = {
  startSimulatorScheduler,
  prepareDailySchedule,
  processDueRegistrations,
  registerSimulator
};
