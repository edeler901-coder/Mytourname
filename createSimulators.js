const { db } = require("./firebase");

const STARTING_BALANCE = 10000;
const FUNDING_VERSION = 2;
const LOW_BALANCE_TOPUP_VERSION = 1;
const MINIMUM_REGISTRATION_BALANCE = 200;

const { SIMULATORS } = require("./simulatorList");

async function createSimulators() {
  if (SIMULATORS.length !== 75) {
    throw new Error("The master simulator list must contain exactly 75 names.");
  }

  const now = Date.now();
  const updates = {};

  SIMULATORS.forEach(({ id, username, displayName }) => {

    updates[id] = {
      id,
      username,
      displayName,
      isSimulator: true,
      accountType: "simulator",
      balance: STARTING_BALANCE,
      fundingVersion: FUNDING_VERSION,
      lowBalanceTopupVersion: LOW_BALANCE_TOPUP_VERSION,
      lowBalanceToppedUpAt: now,
      fundedAt: now,
      createdAt: now,
      gamesPlayed: 0,
      gamesWon: 0
    };
  });

  const ref = db.ref("simulators");
  let createdCount = 0;
  let fundedCount = 0;
  let preservedBalanceCount = 0;
  let lowBalanceTopupCount = 0;
  let balancePreservedAfterCheckCount = 0;
  let skippedCount = 0;

  const result = await ref.transaction(existing => {
    existing = existing || {};

    // Reset counters because Firebase may retry a transaction callback.
    createdCount = 0;
    fundedCount = 0;
    preservedBalanceCount = 0;
    lowBalanceTopupCount = 0;
    balancePreservedAfterCheckCount = 0;
    skippedCount = 0;

    for (const [id, newAccount] of Object.entries(updates)) {
      const current = existing[id];

      if (!current) {
        existing[id] = newAccount;
        createdCount++;
        continue;
      }

      // Never modify an account unless it is already marked as a simulator.
      if (
        current.isSimulator !== true ||
        current.accountType !== "simulator"
      ) {
        skippedCount++;
        continue;
      }

      const currentBalance =
        current.balance === undefined || current.balance === null
          ? 0
          : Number(current.balance);

      if (!Number.isFinite(currentBalance) || currentBalance < 0) {
        skippedCount++;
        continue;
      }

      // Complete the original one-time funding only for accounts that
      // have not received that funding version yet.
      if ((Number(current.fundingVersion) || 0) < FUNDING_VERSION) {
        if (currentBalance === 0) {
          current.balance = STARTING_BALANCE;
          fundedCount++;
        } else {
          preservedBalanceCount++;
        }

        current.fundingVersion = FUNDING_VERSION;
        current.fundedAt = now;
      }

      // One-time repair: top up only simulator wallets that cannot pay
      // the 200 Br registration fee. Never reduce a positive balance.
      if ((Number(current.lowBalanceTopupVersion) || 0) < LOW_BALANCE_TOPUP_VERSION) {
        const balanceBeforeTopup = Number(current.balance);

        if (balanceBeforeTopup < MINIMUM_REGISTRATION_BALANCE) {
          current.balance = STARTING_BALANCE;
          lowBalanceTopupCount++;
        } else {
          balancePreservedAfterCheckCount++;
        }

        current.lowBalanceTopupVersion = LOW_BALANCE_TOPUP_VERSION;
        current.lowBalanceToppedUpAt = now;
      }

      existing[id] = current;
    }

    return existing;
  });

  if (!result.committed) {
    throw new Error("Firebase did not commit the simulator funding transaction.");
  }

  const finalAccounts = result.snapshot.val() || {};
  const eligibleCount = Object.values(finalAccounts).filter(account =>
    account &&
    account.isSimulator === true &&
    account.accountType === "simulator"
  ).length;

  console.log("Simulator setup and one-time funding completed.");
  console.log("Expected simulator accounts:", SIMULATORS.length);
  console.log("Eligible simulator accounts in Firebase:", eligibleCount);
  console.log("New accounts created:", createdCount);
  console.log("Existing zero-balance accounts funded:", fundedCount);
  console.log("Existing positive balances preserved during initial funding:", preservedBalanceCount);
  console.log("Low-balance simulator wallets topped up:", lowBalanceTopupCount);
  console.log("Simulator wallets already holding at least 200 Br:", balancePreservedAfterCheckCount);
  console.log("Accounts skipped for safety:", skippedCount);

  return {
    eligibleCount,
    createdCount,
    fundedCount,
    preservedBalanceCount,
    lowBalanceTopupCount,
    balancePreservedAfterCheckCount,
    skippedCount
  };
}

module.exports = {
  createSimulators
};
