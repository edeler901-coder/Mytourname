const crypto = require("crypto");
const { db } = require("./firebase");

const TIME_ZONE = "Africa/Addis_Ababa";
const ENTRY_FEE = 200;
const CHECK_INTERVAL = 5 * 60 * 1000;
const PROCESSING_LEASE = 10 * 60 * 1000;
const SCHEDULE_VERSION = 3;

let schedulerStarted = false;
let schedulerTimer = null;

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

function makeHourlyBatchTasks(playerIds, startAt, endAt, previousTasks = []) {
  const previousById = new Map();

  for (const task of previousTasks || []) {
    if (task && task.playerId) previousById.set(String(task.playerId), task);
  }

  const remainingIds = shuffle(
    playerIds.filter(id => {
      const previous = previousById.get(String(id));
      return !previous || previous.status !== "completed";
    })
  );

  const tasks = [];
  let cursor = 0;
  let batchTime = startAt;

  while (cursor < remainingIds.length && batchTime < endAt) {
    const batchSize = crypto.randomInt(11, 17);
    const batch = remainingIds.slice(cursor, cursor + batchSize);

    for (const playerId of batch) {
      const previous = previousById.get(String(playerId));

      if (previous && previous.status === "processing") {
        tasks.push(previous);
        continue;
      }

      tasks.push({
        playerId: String(playerId),
        runAt: batchTime,
        status: "pending",
        attempts: Number(previous && previous.attempts) || 0,
        nextAttemptAt: batchTime,
        lastError: previous && previous.lastError
          ? previous.lastError
          : null
      });
    }

    cursor += batch.length;
    batchTime += 60 * 60 * 1000;
  }

  // Keep already completed registrations in the schedule/report.
  for (const playerId of playerIds) {
    const previous = previousById.get(String(playerId));
    if (previous && previous.status === "completed") tasks.push(previous);
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

  const transaction = await scheduleRef.transaction(current => {
    if (
      current &&
      current.version === SCHEDULE_VERSION &&
      current.tournamentDate === tournamentDate
    ) {
      const existingIds = new Set(
        (current.tasks || []).map(task => String(task.playerId))
      );
      const missingIds = simulatorIds.filter(id => !existingIds.has(id));

      if (missingIds.length === 0) return current;

      const previousTasks = current.tasks || [];
      const remainingStart = Math.max(now, getAddisDayStart(registrationDate));
      const tasks = makeHourlyBatchTasks(
        simulatorIds,
        remainingStart,
        dayEnd,
        previousTasks
      );

      return {
        ...current,
        version: SCHEDULE_VERSION,
        tasks,
        totalSimulators: simulatorIds.length,
        updatedAt: now
      };
    }

    const previousTasks = current && current.tournamentDate === tournamentDate
      ? current.tasks || []
      : [];

    const startAt = Math.max(now, getAddisDayStart(registrationDate));
    const tasks = makeHourlyBatchTasks(
      simulatorIds,
      startAt,
      dayEnd,
      previousTasks
    );

    return {
      version: SCHEDULE_VERSION,
      registrationDate,
      tournamentDate,
      totalSimulators: simulatorIds.length,
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
    " existing simulator accounts."
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
  const fee = Number(entryFee);
  const id = String(playerId);

  if (!Number.isFinite(fee) || fee <= 0) {
    throw new Error("Invalid simulator entry fee.");
  }

  const accountRef = db.ref("simulators/" + id);
  const tournamentRef = db.ref("tournaments/" + tournamentDate);
  const registrationRef = tournamentRef.child("registrations/" + id);
  const transactionId = "sim_entry_" + tournamentDate + "_" + id;
  const registeredAt = Date.now();

  const initialTournamentSnapshot = await tournamentRef.once("value");
  const initialTournament = initialTournamentSnapshot.val();

  if (!initialTournament || initialTournament.registrationOpen !== true) {
    return { status: "registration_closed" };
  }

  const existingRegistrationSnapshot = await registrationRef.once("value");
  const existingRegistration = existingRegistrationSnapshot.val();

  if (existingRegistration && existingRegistration.status === "registered") {
    if (!isMatchingSimulatorRegistration(existingRegistration, id)) {
      throw new Error("A non-simulator registration already uses this player ID.");
    }

    const existingAccountSnapshot = await accountRef.once("value");
    const existingAccount = existingAccountSnapshot.val();

    if (!isSimulatorAccount(existingAccount)) {
      throw new Error("Registered simulator account could not be verified.");
    }

    const recordedTransactionId =
      existingRegistration.simulatorTransactionId || transactionId;
    const recordedPayment =
      existingAccount.simulatorTransactions &&
      existingAccount.simulatorTransactions[recordedTransactionId];
    const recordedSimulatorEntry =
      existingAccount.simulatorRegistrations &&
      existingAccount.simulatorRegistrations[tournamentDate];

    const paymentVerified = Boolean(
      recordedPayment &&
      recordedPayment.type === "simulator_entry_fee" &&
      Number(recordedPayment.amount) === fee &&
      recordedPayment.status === "completed"
    );

    const legacyEntryVerified = Boolean(
      recordedSimulatorEntry &&
      recordedSimulatorEntry.status === "registered" &&
      recordedSimulatorEntry.paymentSource === "simulator_wallet" &&
      Number(recordedSimulatorEntry.entryFee) === fee
    );

    if (!paymentVerified && !legacyEntryVerified) {
      throw new Error(
        "Simulator is already registered, but its wallet payment record cannot be verified. No second charge was attempted."
      );
    }

    return { status: "already_registered" };
  }

  const reservation = await registrationRef.transaction(current => {
    if (!current) {
      return {
        telegramId: id,
        playerId: id,
        tournamentId: tournamentDate,
        tournamentDate,
        entryFee: fee,
        registeredAt,
        status: "processing",
        isSimulator: true,
        displayName: null
      };
    }

    if (
      isMatchingSimulatorRegistration(current, id) &&
      (current.status === "processing" || current.status === "registered")
    ) {
      return current;
    }

    return;
  });

  const reserved = reservation.snapshot.val();

  if (!reserved || !isMatchingSimulatorRegistration(reserved, id)) {
    throw new Error("Could not safely reserve this simulator registration.");
  }

  if (reserved.status === "registered") {
    return { status: "already_registered" };
  }

  const accountSnapshot = await accountRef.once("value");
  const accountBeforeCharge = accountSnapshot.val();

  if (!isSimulatorAccount(accountBeforeCharge)) {
    await removeUnpaidReservation(registrationRef, id);
    throw new Error("Simulator account is missing or has invalid account flags.");
  }

  const existingPayment =
    accountBeforeCharge.simulatorTransactions &&
    accountBeforeCharge.simulatorTransactions[transactionId];

  const existingSimulatorRegistration =
    accountBeforeCharge.simulatorRegistrations &&
    accountBeforeCharge.simulatorRegistrations[tournamentDate];

  if (
    existingPayment &&
    (
      existingPayment.type !== "simulator_entry_fee" ||
      Number(existingPayment.amount) !== fee ||
      existingPayment.status !== "completed"
    )
  ) {
    throw new Error("An existing simulator transaction has conflicting details.");
  }

  const legacyPaymentAlreadyRecorded = Boolean(
    existingSimulatorRegistration &&
    existingSimulatorRegistration.status === "registered" &&
    existingSimulatorRegistration.paymentSource === "simulator_wallet" &&
    Number(existingSimulatorRegistration.entryFee) === fee
  );

  if (!existingPayment && !legacyPaymentAlreadyRecorded) {
    const latestTournamentSnapshot = await tournamentRef.once("value");
    const latestTournament = latestTournamentSnapshot.val();
    const closesAt = Number(latestTournament && latestTournament.registrationClosesAt);

    if (
      !latestTournament ||
      latestTournament.registrationOpen !== true ||
      (Number.isFinite(closesAt) && closesAt > 0 && Date.now() >= closesAt)
    ) {
      await removeUnpaidReservation(registrationRef, id);
      return { status: "registration_closed" };
    }
  }

  const charge = await accountRef.transaction(account => {
    if (!isSimulatorAccount(account)) return;

    account.simulatorTransactions = account.simulatorTransactions || {};
    const prior = account.simulatorTransactions[transactionId];

    if (prior) {
      if (
        prior.type === "simulator_entry_fee" &&
        Number(prior.amount) === fee &&
        prior.status === "completed"
      ) {
        return account;
      }
      return;
    }

    account.simulatorRegistrations = account.simulatorRegistrations || {};
    const oldRegistration = account.simulatorRegistrations[tournamentDate];

    if (
      oldRegistration &&
      oldRegistration.status === "registered" &&
      oldRegistration.paymentSource === "simulator_wallet" &&
      Number(oldRegistration.entryFee) === fee
    ) {
      account.simulatorTransactions[transactionId] = {
        type: "simulator_entry_fee",
        amount: fee,
        tournamentDate,
        status: "completed",
        recoveredFromExistingRegistration: true,
        createdAt: oldRegistration.registeredAt || Date.now()
      };
      return account;
    }

    const balance = Number(account.balance);
    if (!Number.isFinite(balance) || balance < fee) return;

    account.balance = balance - fee;
    account.simulatorTransactions[transactionId] = {
      type: "simulator_entry_fee",
      amount: fee,
      tournamentDate,
      status: "completed",
      createdAt: Date.now()
    };

    return account;
  });

  let account = charge.snapshot.val();
  let payment = account &&
    account.simulatorTransactions &&
    account.simulatorTransactions[transactionId];

  if (!payment) {
    await removeUnpaidReservation(registrationRef, id);
    return { status: "insufficient_funds" };
  }

  if (
    payment.type !== "simulator_entry_fee" ||
    Number(payment.amount) !== fee ||
    payment.status !== "completed"
  ) {
    throw new Error("Simulator wallet transaction could not be verified.");
  }

  const accountRegistration = await accountRef.transaction(current => {
    if (!isSimulatorAccount(current)) return;

    current.simulatorRegistrations = current.simulatorRegistrations || {};
    const existing = current.simulatorRegistrations[tournamentDate];

    if (existing) {
      if (
        existing.status === "registered" &&
        Number(existing.entryFee) === fee &&
        existing.paymentSource === "simulator_wallet"
      ) {
        return current;
      }
      return;
    }

    current.simulatorRegistrations[tournamentDate] = {
      tournamentDate,
      entryFee: fee,
      registeredAt,
      status: "registered",
      paymentSource: "simulator_wallet",
      simulatorTransactionId: transactionId
    };

    return current;
  });

  account = accountRegistration.snapshot.val();
  const savedSimulatorRegistration =
    account &&
    account.simulatorRegistrations &&
    account.simulatorRegistrations[tournamentDate];

  if (
    !savedSimulatorRegistration ||
    savedSimulatorRegistration.status !== "registered" ||
    Number(savedSimulatorRegistration.entryFee) !== fee
  ) {
    throw new Error("Payment is saved; simulator registration recovery is required.");
  }

  const finalized = await registrationRef.transaction(current => {
    if (!isMatchingSimulatorRegistration(current, id)) return;
    current.status = "registered";
    current.entryFee = fee;
    current.registeredAt =
      savedSimulatorRegistration.registeredAt || registeredAt;
    current.completedAt = Date.now();
    current.paymentSource = "simulator_wallet";
    current.simulatorTransactionId =
      savedSimulatorRegistration.simulatorTransactionId || transactionId;
    current.displayName =
      account.displayName || account.username || id;
    current.username = account.username || account.displayName || id;
    return current;
  });

  const finalRegistration = finalized.snapshot.val();

  if (
    !finalRegistration ||
    finalRegistration.status !== "registered" ||
    !isMatchingSimulatorRegistration(finalRegistration, id)
  ) {
    throw new Error("Payment is saved; tournament registration recovery is required.");
  }

  const mirrorRef = db.ref(
    "simulatorTournaments/" + tournamentDate + "/registrations/" + id
  );

  await mirrorRef.transaction(existing => {
    if (existing && existing.status === "registered") return existing;

    return {
      playerId: id,
      username: account.username || account.displayName || id,
      displayName: account.displayName || account.username || id,
      tournamentDate,
      entryFee: fee,
      registeredAt: finalRegistration.registeredAt,
      paymentSource: "simulator_wallet",
      simulatorTransactionId: transactionId,
      status: "registered"
    };
  });

  return { status: "registered" };
}

async function claimTask(taskRef, now) {
  const claimId = crypto.randomUUID();

  const result = await taskRef.transaction(current => {
    if (!current) return;

    const status = current.status || "pending";
    const nextAttemptAt = Number(current.nextAttemptAt || current.runAt || 0);

    if (status === "completed") return;
    if (status === "processing") {
      const claimedAt = Number(current.claimedAt || 0);
      if (now - claimedAt < PROCESSING_LEASE) return;
    } else if (
      status !== "pending" &&
      status !== "skipped_insufficient_funds" &&
      status !== "failed"
    ) {
      return;
    } else if (nextAttemptAt > now) {
      return;
    }

    return {
      ...current,
      status: "processing",
      claimId,
      claimedAt: now,
      attempts: (Number(current.attempts) || 0) + 1,
      lastAttemptAt: now
    };
  });

  if (!result.committed) return null;

  return {
    claimId,
    task: result.snapshot.val()
  };
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
