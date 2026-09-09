import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { seedUser } from "../seeder/users.seeder";
import { seedParticipants } from "../seeder/participants.seeder";
import { seedFrcManualAttendees } from "../seeder/frc-manual-attendees.seeder";
import { seedManualAttendanceCcsCollege } from "../seeder/manual-attendance-ccs-college.seeder";
import { closeDatabasePool, query } from "../../lib/db";
import { consoleUi, formatDuration } from "./console-ui";

const DATA_SEED_HISTORY_TABLE = "data_seed_history";
const FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-09-01-frc-manual-attendees-v1";
const MANUAL_ATTENDANCE_CCS_COLLEGE_SEED_KEY =
  "manual-attendance-ccs-college-v1";

type SeederRun<T> = {
  label: string;
  icon: string;
  durationMs: number;
  result: T;
};

type SeederDefinition<T> = {
  icon: string;
  label: string;
  processing: string;
  seeder: (onProgress: (message: string) => void) => Promise<T>;
};

type OneTimeSeederDefinition<T> = SeederDefinition<T> & {
  key: string;
  bootstrapApplied?: () => Promise<boolean>;
};

type SeedHistoryRecord = {
  seed_key: string;
};

async function runSeeder<T>(
  index: number,
  total: number,
  definition: SeederDefinition<T>,
): Promise<SeederRun<T>> {
  const startedAt = Date.now();
  const prefix = `[${String(index).padStart(String(total).length, "0")}/${total}]`;
  const task = consoleUi.task(`${definition.icon}  ${definition.label}`, {
    prefix,
    detail: definition.processing,
  });

  try {
    const result = await definition.seeder((message) => {
      task.update(`${definition.icon}  ${definition.label}`, message);
    });
    const durationMs = Date.now() - startedAt;
    task.succeed(
      `${definition.icon}  ${definition.label}`,
      "Seeder completed without errors",
    );
    return {
      label: definition.label,
      icon: definition.icon,
      durationMs,
      result,
    };
  } catch (error) {
    task.fail(
      `${definition.icon}  ${definition.label}`,
      error instanceof Error ? error.message : "Seeder failed",
    );
    throw error;
  }
}

async function ensureDataSeedHistoryTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${DATA_SEED_HISTORY_TABLE} (
      seed_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isDataSeederApplied(seedKey: string) {
  const result = await query<SeedHistoryRecord>(
    `
      SELECT seed_key
      FROM ${DATA_SEED_HISTORY_TABLE}
      WHERE seed_key = $1
      LIMIT 1
    `,
    [seedKey],
  );

  return Boolean(result.rows[0]);
}

async function registerDataSeeder(seedKey: string) {
  await query(
    `
      INSERT INTO ${DATA_SEED_HISTORY_TABLE} (seed_key)
      VALUES ($1)
      ON CONFLICT (seed_key) DO NOTHING
    `,
    [seedKey],
  );
}

async function hasExistingSeptemberFrcManualAttendance() {
  const result = await query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM manual_attendance_records mar
      JOIN attendance_events ae ON ae.id = mar.event_id
      WHERE LOWER(TRIM(ae.name)) = 'flag raising ceremony'
        AND (COALESCE(ae.event_start_at, ae.event_end_at) AT TIME ZONE 'Asia/Manila')::DATE = DATE '2026-09-01'
        AND mar.remarks ILIKE 'Seeded as manual attendance from the September 1, 2026 FRC%'
    ) AS exists
  `);

  return Boolean(result.rows[0]?.exists);
}

async function bootstrapPreviouslyAppliedOneTimeSeeders(
  seeders: readonly OneTimeSeederDefinition<unknown>[],
) {
  let bootstrapped = 0;

  for (const definition of seeders) {
    if (!definition.bootstrapApplied) continue;
    if (await isDataSeederApplied(definition.key)) continue;
    if (!(await definition.bootstrapApplied())) continue;

    await registerDataSeeder(definition.key);
    bootstrapped += 1;
  }

  return bootstrapped;
}

async function getPendingOneTimeSeeders<T extends OneTimeSeederDefinition<unknown>>(
  seeders: readonly T[],
) {
  const pending: T[] = [];
  let applied = 0;

  for (const definition of seeders) {
    if (await isDataSeederApplied(definition.key)) {
      applied += 1;
    } else {
      pending.push(definition);
    }
  }

  return { pending, applied };
}

async function runSeeders() {
  const startedAt = Date.now();
  const baselineSeeders = [
    {
      icon: "👤",
      label: "Default user",
      processing:
        "Checking account state and creating the default user only when missing",
      seeder: async (onProgress: (message: string) => void) => {
        onProgress("Querying the users table for the configured default account");
        return seedUser();
      },
    },
    {
      icon: "⚖️",
      label: "Penalties",
      processing: "Comparing configured penalties with stored penalty rows",
      seeder: async (onProgress: (message: string) => void) => {
        onProgress("Querying penalty rows and inserting only missing defaults");
        return seedPenalties();
      },
    },
    {
      icon: "🎓",
      label: "Participants & attendance",
      processing:
        "Checking source path, parsing files and syncing attendance imports",
      seeder: seedParticipants,
    },
  ] as const;

  const oneTimeSeeders = [
    {
      key: FRC_MANUAL_ATTENDEES_SEED_KEY,
      icon: "🏳️",
      label: "September 1 FRC manual attendees",
      processing: "Seeding the bundled historical FRC data only once",
      seeder: seedFrcManualAttendees,
      bootstrapApplied: hasExistingSeptemberFrcManualAttendance,
    },
    {
      key: MANUAL_ATTENDANCE_CCS_COLLEGE_SEED_KEY,
      icon: "🏫",
      label: "Manual attendance CCS college normalization",
      processing:
        "Normalizing missing and CCS-style manual-attendance college values without overwriting explicit College of … assignments",
      seeder: seedManualAttendanceCcsCollege,
    },
  ] as const satisfies readonly OneTimeSeederDefinition<unknown>[];

  consoleUi.header(
    "🌱",
    "DATABASE SEEDERS",
    `Penalyze • ${baselineSeeders.length} baseline checks • ${oneTimeSeeders.length} tracked one-time seeders`,
  );

  consoleUi.section("🧭", "Seed pipeline");
  consoleUi.detail("1", "Default user account");
  consoleUi.detail("2", "Penalty configuration");
  consoleUi.detail("3", "Optional participants source from SEED_PARTICIPANTS_PATH");
  consoleUi.detail(
    "4",
    "Pending one-time data seeders only; completed historical seeders are not executed again",
  );

  consoleUi.section("⚙️", "Processing baseline seeders");
  consoleUi.info(
    "Baseline seeders remain idempotent; historical data seeders are tracked separately and run only while pending.",
  );

  const userRun = await runSeeder(1, baselineSeeders.length, baselineSeeders[0]);
  const penaltiesRun = await runSeeder(
    2,
    baselineSeeders.length,
    baselineSeeders[1],
  );
  const participantsRun = await runSeeder(
    3,
    baselineSeeders.length,
    baselineSeeders[2],
  );

  consoleUi.section("🗂️", "Checking one-time seeder state");
  const registryTask = consoleUi.task("Preparing data-seeder registry", {
    detail: DATA_SEED_HISTORY_TABLE,
  });
  await ensureDataSeedHistoryTable();
  registryTask.succeed("Data-seeder registry ready", DATA_SEED_HISTORY_TABLE);

  const bootstrapTask = consoleUi.task("Recognizing previously seeded historical data", {
    detail: "Existing September 1 FRC manual-attendance rows will be marked applied without reseeding",
  });
  const bootstrappedCount = await bootstrapPreviouslyAppliedOneTimeSeeders(
    oneTimeSeeders,
  );
  bootstrapTask.succeed(
    "Historical seed state recognized",
    `${bootstrappedCount} existing seeder${bootstrappedCount === 1 ? "" : "s"} registered without execution`,
  );

  const stateTask = consoleUi.task("Comparing one-time seeders with database history", {
    detail: `0/${oneTimeSeeders.length} checked`,
  });
  const initialState = await getPendingOneTimeSeeders(oneTimeSeeders);
  stateTask.succeed(
    "One-time seeder state checked",
    `${initialState.applied} applied • ${initialState.pending.length} pending`,
  );

  const oneTimeRuns = new Map<string, SeederRun<unknown>>();

  if (initialState.pending.length) {
    consoleUi.section("🚀", "Applying pending one-time seeders");

    for (const [index, definition] of initialState.pending.entries()) {
      const run = await runSeeder<unknown>(
        index + 1,
        initialState.pending.length,
        definition as SeederDefinition<unknown>,
      );
      await registerDataSeeder(definition.key);
      oneTimeRuns.set(definition.key, run);
    }
  } else {
    consoleUi.noChanges("No pending one-time seeders", Date.now() - startedAt);
  }

  const finalState = await getPendingOneTimeSeeders(oneTimeSeeders);
  const userResult = userRun.result;
  const penaltiesResult = penaltiesRun.result;
  const participantsResult = participantsRun.result;
  const frcRun = oneTimeRuns.get(FRC_MANUAL_ATTENDEES_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedFrcManualAttendees>>>
    | undefined;
  const ccsRun = oneTimeRuns.get(MANUAL_ATTENDANCE_CCS_COLLEGE_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedManualAttendanceCcsCollege>>>
    | undefined;

  consoleUi.section("📋", "Seeder results");

  if (userResult.alreadySeeded) {
    consoleUi.skipped("Default user already exists — no changes needed.");
  } else {
    consoleUi.success(`Created default user: ${userResult.email}`, userRun.durationMs);
  }

  if (penaltiesResult.alreadySeeded) {
    consoleUi.skipped("Penalties are already seeded — no changes needed.");
  } else {
    consoleUi.success(
      `Seeded ${penaltiesResult.seededCount} penalties.`,
      penaltiesRun.durationMs,
    );
  }

  if (participantsResult.skipped) {
    consoleUi.skipped(
      participantsResult.sourcePath
        ? `Participants skipped — source not found: ${participantsResult.sourcePath}`
        : "Participants skipped — SEED_PARTICIPANTS_PATH is not configured.",
    );
  } else if (participantsResult.alreadySeeded) {
    consoleUi.skipped(
      "Participants and attendance are already seeded — no changes needed.",
    );
  } else {
    consoleUi.success(
      `Seeded ${participantsResult.seededImports} participant import(s) and ${participantsResult.seededAttendanceRecords} attendance record(s).`,
      participantsRun.durationMs,
    );
    if (participantsResult.sourcePath) {
      consoleUi.detail("Source", participantsResult.sourcePath);
    }
    if (participantsResult.seededStudentsWithoutQr > 0) {
      consoleUi.detail(
        "No-QR participants",
        participantsResult.seededStudentsWithoutQr,
      );
    }
  }

  if (frcRun) {
    const result = frcRun.result;
    consoleUi.success(
      `Created ${result.manualAttendanceRecordsCreated} September 1 FRC manual attendance record(s) and soft-deleted ${result.legacyImportsSoftDeleted} legacy seed import(s).`,
      frcRun.durationMs,
    );
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
  } else {
    consoleUi.skipped(
      "September 1 FRC manual-attendance seeder is already applied — it was not executed again.",
    );
  }

  if (ccsRun) {
    const result = ccsRun.result;
    if (result.alreadySeeded) {
      consoleUi.skipped(
        "Manual attendance CCS college values were already normalized.",
      );
    } else {
      consoleUi.success(
        `Normalized ${result.manualAttendanceRecordsUpdated} manual attendance record(s) and ${result.studentsUpdated} linked student record(s) to College of Computing Studies.`,
        ccsRun.durationMs,
      );
    }
    if (result.explicitOtherCollegeRowsSkipped > 0) {
      consoleUi.detail(
        "Explicit other College of … rows preserved",
        result.explicitOtherCollegeRowsSkipped,
      );
    }
    if (result.refreshedSchoolYears > 0) {
      consoleUi.detail(
        "Derived attendance scopes refreshed",
        result.refreshedSchoolYears,
      );
    }
  } else {
    consoleUi.skipped(
      "Manual attendance CCS college normalization seeder is already applied — it was not executed again.",
    );
  }

  const changedBaselineSeeders = [
    userResult,
    penaltiesResult,
    participantsResult,
  ].filter((result) => !result.alreadySeeded).length;

  consoleUi.summary([
    {
      label: "Baseline changes",
      value: changedBaselineSeeders,
      tone: changedBaselineSeeders ? "success" : "info",
    },
    {
      label: "One-time applied",
      value: finalState.applied,
      tone: "success",
    },
    {
      label: "One-time pending",
      value: finalState.pending.length,
      tone: finalState.pending.length ? "warning" : "success",
    },
    {
      label: "Elapsed",
      value: formatDuration(Date.now() - startedAt),
      tone: "success",
    },
  ]);

  if (!finalState.pending.length && changedBaselineSeeders === 0) {
    consoleUi.noChanges("Seed data is already up to date", Date.now() - startedAt);
    return;
  }

  consoleUi.completed("Seeders completed successfully", Date.now() - startedAt);
}

runSeeders()
  .then(async () => {
    await closeDatabasePool();
  })
  .catch(async (error) => {
    consoleUi.error("Seeder process failed", error);
    await closeDatabasePool();
    process.exit(1);
  });
