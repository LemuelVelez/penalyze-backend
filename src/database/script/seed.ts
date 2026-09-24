import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { seedUser } from "../seeder/users.seeder";
import { seedParticipants } from "../seeder/participants.seeder";
import { seedFrcManualAttendees } from "../seeder/frc-manual-attendees.seeder";
import { seedCafFrcManualAttendees } from "../seeder/frc-caf-manual-attendees.seeder";
import { seedLamsFrcManualAttendees } from "../seeder/frc-lams-manual-attendees.seeder";
import { seedSoeFrcManualAttendees } from "../seeder/frc-soe-manual-attendees.seeder";
import { seedScjeFrcManualAttendees } from "../seeder/frc-scje-manual-attendees.seeder";
import { seedRelinkFrcManualAttendanceEvents } from "../seeder/relink-frc-manual-attendance-events.seeder";
import {
  seedSoeSessionEventsManualAttendees,
  SOE_SESSION_EVENT_SEED_MARKERS,
} from "../seeder/soe-session-events-manual-attendees.seeder";
import { seedManualAttendanceCcsCollege } from "../seeder/manual-attendance-ccs-college.seeder";
import { closeDatabasePool, query } from "../../lib/db";
import { consoleUi, formatDuration } from "./console-ui";

const DATA_SEED_HISTORY_TABLE = "data_seed_history";
const FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-09-01-frc-manual-attendees-v1";
const CAF_FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-caf-frc-manual-attendees-v1";
const CAF_FRC_EVENT_DATES = ["2026-08-17", "2026-08-24", "2026-09-01"] as const;
const LAMS_FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-lams-frc-manual-attendees-v1";
const LAMS_FRC_EVENT_DATES = ["2026-08-24", "2026-09-01"] as const;
const SOE_FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-soe-frc-manual-attendees-v2";
const SOE_FRC_EVENT_DATES = ["2026-08-24", "2026-09-01"] as const;
const SCJE_FRC_MANUAL_ATTENDEES_SEED_KEY = "2026-scje-frc-manual-attendees-v1";
const SCJE_FRC_EVENT_DATES = ["2026-09-01"] as const;
const RELINK_FRC_MANUAL_ATTENDANCE_EVENTS_SEED_KEY =
  "2026-relink-frc-manual-attendance-events-v1";
const SOE_SESSION_EVENTS_MANUAL_ATTENDEES_V2_SEED_KEY =
  "2026-soe-session-events-manual-attendees-v2";
const SOE_SESSION_EVENTS_MANUAL_ATTENDEES_V3_SEED_KEY =
  "2026-soe-session-events-manual-attendees-v3";
const SOE_SESSION_EVENTS_MANUAL_ATTENDEES_SEED_KEY =
  "2026-soe-session-events-manual-attendees-v4";
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
  shouldRegister?: (result: unknown) => boolean;
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
  const result = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        JOIN attendance_events ae ON ae.id = mar.event_id
        JOIN school_years sy ON sy.id = ae.school_year_id
        WHERE sy.name = $1
          AND sy.semester = $2
          AND (
            ae.event_date = $3::date
            OR timezone('Asia/Manila', ae.event_start_at)::date = $3::date
            OR timezone('Asia/Manila', ae.event_end_at)::date = $3::date
          )
          AND LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($4))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
          AND mar.remarks ILIKE 'Seeded as manual attendance from the September 1, 2026 FRC%'
      ) AS exists
    `,
    [
      "2026-2027",
      "first_semester",
      "2026-09-01",
      "College of Computing Studies",
    ],
  );

  return Boolean(result.rows[0]?.exists);
}

async function hasExistingCafFrcManualAttendance() {
  const result = await query<{ event_count: string }>(
    `
      SELECT COUNT(*)::text AS event_count
      FROM unnest($1::date[]) AS target(event_date)
      WHERE EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        JOIN attendance_events ae ON ae.id = mar.event_id
        JOIN school_years sy ON sy.id = ae.school_year_id
        WHERE sy.name = $2
          AND sy.semester = $3
          AND (
            ae.event_date = target.event_date
            OR timezone('Asia/Manila', ae.event_start_at)::date = target.event_date
            OR timezone('Asia/Manila', ae.event_end_at)::date = target.event_date
          )
          AND LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($4))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
    `,
    [
      [...CAF_FRC_EVENT_DATES],
      "2026-2027",
      "first_semester",
      "College of Agriculture and Forestry",
    ],
  );

  return Number(result.rows[0]?.event_count ?? 0) === CAF_FRC_EVENT_DATES.length;
}

async function hasExistingLamsFrcManualAttendance() {
  const result = await query<{ event_count: string }>(
    `
      SELECT COUNT(*)::text AS event_count
      FROM unnest($1::date[]) AS target(event_date)
      WHERE EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        JOIN attendance_events ae ON ae.id = mar.event_id
        JOIN school_years sy ON sy.id = ae.school_year_id
        WHERE sy.name = $2
          AND sy.semester = $3
          AND (
            ae.event_date = target.event_date
            OR timezone('Asia/Manila', ae.event_start_at)::date = target.event_date
            OR timezone('Asia/Manila', ae.event_end_at)::date = target.event_date
          )
          AND LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($4))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
    `,
    [
      [...LAMS_FRC_EVENT_DATES],
      "2026-2027",
      "first_semester",
      "College of Liberal Arts, Mathematics and Sciences",
    ],
  );

  return Number(result.rows[0]?.event_count ?? 0) === LAMS_FRC_EVENT_DATES.length;
}

async function hasExistingSoeFrcManualAttendance() {
  const result = await query<{ event_count: string }>(
    `
      SELECT COUNT(*)::text AS event_count
      FROM unnest($1::date[]) AS target(event_date)
      WHERE EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        JOIN attendance_events ae ON ae.id = mar.event_id
        JOIN school_years sy ON sy.id = ae.school_year_id
        WHERE sy.name = $2
          AND sy.semester = $3
          AND (
            ae.event_date = target.event_date
            OR timezone('Asia/Manila', ae.event_start_at)::date = target.event_date
            OR timezone('Asia/Manila', ae.event_end_at)::date = target.event_date
          )
          AND LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($4))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
    `,
    [
      [...SOE_FRC_EVENT_DATES],
      "2026-2027",
      "first_semester",
      "School of Engineering",
    ],
  );

  return Number(result.rows[0]?.event_count ?? 0) === SOE_FRC_EVENT_DATES.length;
}

async function hasExistingScjeFrcManualAttendance() {
  const result = await query<{ event_count: string }>(
    `
      SELECT COUNT(*)::text AS event_count
      FROM unnest($1::date[]) AS target(event_date)
      WHERE EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        JOIN attendance_events ae ON ae.id = mar.event_id
        JOIN school_years sy ON sy.id = ae.school_year_id
        WHERE sy.name = $2
          AND sy.semester = $3
          AND (
            ae.event_date = target.event_date
            OR timezone('Asia/Manila', ae.event_start_at)::date = target.event_date
            OR timezone('Asia/Manila', ae.event_end_at)::date = target.event_date
          )
          AND LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($4))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
    `,
    [
      [...SCJE_FRC_EVENT_DATES],
      "2026-2027",
      "first_semester",
      "School of Criminal Justice Education",
    ],
  );

  return Number(result.rows[0]?.event_count ?? 0) === SCJE_FRC_EVENT_DATES.length;
}

async function hasExistingSoeSessionManualAttendance() {
  const result = await query<{ marker_count: string }>(
    `
      SELECT COUNT(*)::text AS marker_count
      FROM unnest($3::text[], $4::date[], $5::text[])
        AS marker(event_name, event_date, remarks)
      WHERE EXISTS (
        SELECT 1
        FROM attendance_events ae
        JOIN school_years sy ON sy.id = ae.school_year_id
        JOIN manual_attendance_records mar ON mar.event_id = ae.id
        WHERE sy.name = $1
          AND sy.semester = $2
          AND ae.name = marker.event_name
          AND COALESCE(
            ae.event_date,
            timezone('Asia/Manila', ae.event_start_at)::date,
            timezone('Asia/Manila', ae.event_end_at)::date
          ) = marker.event_date
          AND mar.remarks = marker.remarks
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
    `,
    [
      "2026-2027",
      "first_semester",
      SOE_SESSION_EVENT_SEED_MARKERS.map((marker) => marker.eventName),
      SOE_SESSION_EVENT_SEED_MARKERS.map((marker) => marker.eventDate),
      SOE_SESSION_EVENT_SEED_MARKERS.map((marker) => marker.remarks),
    ],
  );

  return (
    Number(result.rows[0]?.marker_count ?? 0) ===
    SOE_SESSION_EVENT_SEED_MARKERS.length
  );
}

async function hasExistingSoeSessionManualAttendanceForV4() {
  // A database that already ran v2 or v3 must execute v4 once. v4 recreates
  // any SOE session events that were later collapsed through Review Merge and
  // authoritatively puts this seeder's rows back on their six source sessions.
  if (
    (await isDataSeederApplied(SOE_SESSION_EVENTS_MANUAL_ATTENDEES_V2_SEED_KEY)) ||
    (await isDataSeederApplied(SOE_SESSION_EVENTS_MANUAL_ATTENDEES_V3_SEED_KEY))
  ) {
    return false;
  }

  return hasExistingSoeSessionManualAttendance();
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
      key: CAF_FRC_MANUAL_ATTENDEES_SEED_KEY,
      icon: "🌾",
      label: "CAF FRC manual attendees",
      processing:
        "Seeding the bundled Agriculture and Forestry FRC workbooks into manual attendance only once",
      seeder: seedCafFrcManualAttendees,
      bootstrapApplied: hasExistingCafFrcManualAttendance,
    },
    {
      key: LAMS_FRC_MANUAL_ATTENDEES_SEED_KEY,
      icon: "📚",
      label: "LAMS FRC manual attendees",
      processing:
        "Seeding the bundled Liberal Arts, Mathematics and Sciences FRC attendance sheets into manual attendance only once",
      seeder: seedLamsFrcManualAttendees,
      bootstrapApplied: hasExistingLamsFrcManualAttendance,
    },
    {
      key: SOE_FRC_MANUAL_ATTENDEES_SEED_KEY,
      icon: "⚙️",
      label: "SOE manual attendees",
      processing:
        "Seeding the bundled School of Engineering FRC attendance into manual attendance only once",
      seeder: seedSoeFrcManualAttendees,
      bootstrapApplied: hasExistingSoeFrcManualAttendance,
    },
    {
      key: SCJE_FRC_MANUAL_ATTENDEES_SEED_KEY,
      icon: "🛡️",
      label: "SCJE FRC manual attendees",
      processing:
        "Seeding the bundled School of Criminal Justice Education FRC attendance sheet into manual attendance only once",
      seeder: seedScjeFrcManualAttendees,
      bootstrapApplied: hasExistingScjeFrcManualAttendance,
    },
    {
      key: RELINK_FRC_MANUAL_ATTENDANCE_EVENTS_SEED_KEY,
      icon: "🔗",
      label: "Relink FRC manual attendance events",
      processing:
        "Relinking historical FRC manual attendance to canonical dated events only once",
      seeder: seedRelinkFrcManualAttendanceEvents,
    },
    {
      key: SOE_SESSION_EVENTS_MANUAL_ATTENDEES_SEED_KEY,
      icon: "🕘",
      label: "SOE session manual attendees",
      processing:
        "Restoring six SOE-only session events after accidental Review Merge, replacing seeded rows authoritatively, retiring legacy August 27 data, and adding shared-event exemptions only once",
      seeder: seedSoeSessionEventsManualAttendees,
      bootstrapApplied: hasExistingSoeSessionManualAttendanceForV4,
      shouldRegister: (result) =>
        !(result as Awaited<ReturnType<typeof seedSoeSessionEventsManualAttendees>>)
          .skipped,
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
    detail: "Existing historical manual-attendance rows will be marked applied without reseeding",
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
      const oneTimeDefinition =
        definition as OneTimeSeederDefinition<unknown>;
      const shouldRegister =
        !oneTimeDefinition.shouldRegister ||
        oneTimeDefinition.shouldRegister(run.result);
      if (shouldRegister) {
        await registerDataSeeder(definition.key);
      }
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
  const cafFrcRun = oneTimeRuns.get(CAF_FRC_MANUAL_ATTENDEES_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedCafFrcManualAttendees>>>
    | undefined;
  const lamsFrcRun = oneTimeRuns.get(LAMS_FRC_MANUAL_ATTENDEES_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedLamsFrcManualAttendees>>>
    | undefined;
  const soeFrcRun = oneTimeRuns.get(SOE_FRC_MANUAL_ATTENDEES_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedSoeFrcManualAttendees>>>
    | undefined;
  const scjeFrcRun = oneTimeRuns.get(SCJE_FRC_MANUAL_ATTENDEES_SEED_KEY) as
    | SeederRun<Awaited<ReturnType<typeof seedScjeFrcManualAttendees>>>
    | undefined;
  const relinkFrcRun = oneTimeRuns.get(
    RELINK_FRC_MANUAL_ATTENDANCE_EVENTS_SEED_KEY,
  ) as
    | SeederRun<Awaited<ReturnType<typeof seedRelinkFrcManualAttendanceEvents>>>
    | undefined;
  const soeSessionRun = oneTimeRuns.get(
    SOE_SESSION_EVENTS_MANUAL_ATTENDEES_SEED_KEY,
  ) as
    | SeederRun<Awaited<ReturnType<typeof seedSoeSessionEventsManualAttendees>>>
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

  if (cafFrcRun) {
    const result = cafFrcRun.result;
    consoleUi.success(
      `Created ${result.manualAttendanceRecordsCreated} CAF FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      cafFrcRun.durationMs,
    );
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} CAF attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
  } else {
    consoleUi.skipped(
      "CAF FRC manual-attendance seeder is already applied — it was not executed again.",
    );
  }

  if (lamsFrcRun) {
    const result = lamsFrcRun.result;
    consoleUi.success(
      `Created ${result.manualAttendanceRecordsCreated} LAMS FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      lamsFrcRun.durationMs,
    );
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} LAMS attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
  } else {
    consoleUi.skipped(
      "LAMS FRC manual-attendance seeder is already applied — it was not executed again.",
    );
  }

  if (soeFrcRun) {
    const result = soeFrcRun.result;
    if (result.alreadySeeded) {
      consoleUi.skipped(
        "SOE manual attendance is already seeded — no new records were created.",
      );
    } else {
      consoleUi.success(
        `Created ${result.manualAttendanceRecordsCreated} SOE manual attendance record(s) across August 24 FRC and September 1 FRC, plus ${result.eventsCreated} event(s).`,
        soeFrcRun.durationMs,
      );
    }
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} SOE attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
  } else {
    consoleUi.skipped(
      "SOE manual-attendance seeder is already applied — it was not executed again.",
    );
  }

  if (scjeFrcRun) {
    const result = scjeFrcRun.result;
    if (result.alreadySeeded) {
      consoleUi.skipped(
        "SCJE FRC manual attendance is already seeded — no new records were created.",
      );
    } else {
      consoleUi.success(
        `Created ${result.manualAttendanceRecordsCreated} SCJE FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
        scjeFrcRun.durationMs,
      );
    }
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} SCJE attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
  } else {
    consoleUi.skipped(
      "SCJE FRC manual-attendance seeder is already applied — it was not executed again.",
    );
  }

  if (relinkFrcRun) {
    const result = relinkFrcRun.result;
    const summary = `${result.recordsRelinked} record(s) relinked • ${result.duplicatesRemoved} duplicate(s) removed • ${result.emptyEventsDeleted} empty event(s) deleted`;

    if (result.alreadySeeded) {
      consoleUi.skipped(
        `FRC manual-attendance event links were already correct — ${summary}.`,
      );
    } else {
      consoleUi.success(
        `Repaired FRC manual-attendance event links: ${summary}.`,
        relinkFrcRun.durationMs,
      );
    }

    result.remarkGroups.forEach((group) => {
      consoleUi.detail(
        group.remarks,
        `${group.recordsRelinked} relinked • ${group.duplicatesRemoved} duplicate(s) removed`,
      );
    });

    if (result.deletedEvents.length > 0) {
      consoleUi.detail("Empty events deleted", result.deletedEvents.join(", "));
    }
  } else {
    consoleUi.skipped(
      "FRC manual-attendance event relink seeder is already applied — it was not executed again.",
    );
  }

  if (soeSessionRun) {
    const result = soeSessionRun.result;
    const skipSummary = `${result.skippedStrayRows} stray-date • ${result.skippedJunkRows} junk • ${result.skippedInvalidRows} invalid`;

    if (result.skipped) {
      consoleUi.warning(
        `SOE session manual attendance remains pending — missing fixture file(s): ${result.missingFixtureFiles.join(", ")}`,
      );
    } else if (result.alreadySeeded) {
      consoleUi.skipped(
        `SOE session manual attendance was already correct — ${skipSummary}.`,
      );
    } else {
      consoleUi.success(
        `Inserted ${result.manualAttendanceRecordsCreated} SOE session manual attendance record(s), created ${result.eventsCreated} event(s), and deleted ${result.legacyRowsDeleted} legacy row(s).`,
        soeSessionRun.durationMs,
      );
    }

    if (!result.skipped) {
      consoleUi.detail("Skipped source rows", skipSummary);
      result.eventSummaries.forEach((event) => {
        consoleUi.detail(
          event.eventName,
          `parsed ${event.rowsParsed} • inserted ${event.inserted} • stray ${event.stray} • junk ${event.junk} • invalid ${event.invalid} • unresolved ${event.unresolved}`,
        );
      });
      consoleUi.detail("Legacy rows deleted", result.legacyRowsDeleted);
      consoleUi.detail(
        "Legacy Buwan ng Wika event deleted",
        result.legacyEventDeleted ? "yes" : "no",
      );
      consoleUi.detail("SOE exemptions created", result.exemptionsCreated);
    }
    result.eventAttendeeCounts.forEach((event) => {
      consoleUi.detail(
        event.eventName,
        `${event.attendeeCount} attendee(s)`,
      );
    });
    if (result.unresolvedAttendees.length > 0) {
      consoleUi.warning(
        `Could not safely resolve ${result.unresolvedAttendees.length} SOE session attendee(s): ${result.unresolvedAttendees.join(", ")}`,
      );
    }
    if (result.warnings.length > 0) {
      result.warnings.forEach((warning) => consoleUi.warning(warning));
    }
    result.sharedEventExemptions.forEach((event) => {
      consoleUi.detail(
        `SOE exemption: ${event.eventDate} ${event.eventName}`,
        event.exemptionCreated ? "created" : "already present",
      );
    });
  } else {
    consoleUi.skipped(
      "SOE session manual-attendance seeder is already applied — it was not executed again.",
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
