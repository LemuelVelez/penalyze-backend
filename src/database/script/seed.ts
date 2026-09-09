import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { seedUser } from "../seeder/users.seeder";
import { seedParticipants } from "../seeder/participants.seeder";
import { seedFrcAttendees } from "../seeder/frc-attendees.seeder";
import { closeDatabasePool } from "../../lib/db";
import { consoleUi, formatDuration } from "./console-ui";

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
    task.succeed(`${definition.icon}  ${definition.label}`, "Seeder completed without errors");
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

async function runSeeders() {
  const startedAt = Date.now();
  const seeders = [
    {
      icon: "👤",
      label: "Default user",
      processing: "Checking account state and creating the default user only when missing",
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
      processing: "Checking source path, parsing files and syncing attendance imports",
      seeder: seedParticipants,
    },
    {
      icon: "🏳️",
      label: "September 1 FRC attendees",
      processing: "Checking bundled attendee files, resolving the event and syncing attendance",
      seeder: seedFrcAttendees,
    },
  ] as const;
  const totalSeeders = seeders.length;

  consoleUi.header(
    "🌱",
    "DATABASE SEEDERS",
    `Penalyze • ${totalSeeders} idempotent seed step${totalSeeders === 1 ? "" : "s"} • safe to run repeatedly`,
  );

  consoleUi.section("🧭", "Seed pipeline");
  consoleUi.detail("1", "Default user account");
  consoleUi.detail("2", "Penalty configuration");
  consoleUi.detail("3", "Optional participants source from SEED_PARTICIPANTS_PATH");
  consoleUi.detail("4", "Bundled September 1 FRC attendee data");

  consoleUi.section("⚙️", "Processing seeders");
  consoleUi.info("The active line stays visible and updates elapsed time until each seeder finishes.");

  const userRun = await runSeeder(1, totalSeeders, seeders[0]);
  const penaltiesRun = await runSeeder(2, totalSeeders, seeders[1]);
  const participantsRun = await runSeeder(3, totalSeeders, seeders[2]);
  const frcAttendeesRun = await runSeeder(4, totalSeeders, seeders[3]);

  const userResult = userRun.result;
  const penaltiesResult = penaltiesRun.result;
  const participantsResult = participantsRun.result;
  const frcAttendeesResult = frcAttendeesRun.result;
  const allAlreadySeeded =
    userResult.alreadySeeded &&
    penaltiesResult.alreadySeeded &&
    participantsResult.alreadySeeded &&
    frcAttendeesResult.alreadySeeded;

  consoleUi.section("📋", "Seeder results");

  if (userResult.alreadySeeded) {
    consoleUi.skipped("Default user already exists — no changes needed.");
  } else {
    consoleUi.success(`Created default user: ${userResult.email}`, userRun.durationMs);
  }

  if (penaltiesResult.alreadySeeded) {
    consoleUi.skipped("Penalties are already seeded — no changes needed.");
  } else {
    consoleUi.success(`Seeded ${penaltiesResult.seededCount} penalties.`, penaltiesRun.durationMs);
  }

  if (participantsResult.skipped) {
    consoleUi.skipped(
      participantsResult.sourcePath
        ? `Participants skipped — source not found: ${participantsResult.sourcePath}`
        : "Participants skipped — SEED_PARTICIPANTS_PATH is not configured.",
    );
  } else if (participantsResult.alreadySeeded) {
    consoleUi.skipped("Participants and attendance are already seeded — no changes needed.");
  } else {
    consoleUi.success(
      `Seeded ${participantsResult.seededImports} participant import(s) and ${participantsResult.seededAttendanceRecords} attendance record(s).`,
      participantsRun.durationMs,
    );
    if (participantsResult.sourcePath) {
      consoleUi.detail("Source", participantsResult.sourcePath);
    }
    if (participantsResult.seededStudentsWithoutQr > 0) {
      consoleUi.detail("No-QR participants", participantsResult.seededStudentsWithoutQr);
    }
  }

  if (frcAttendeesResult.alreadySeeded) {
    consoleUi.skipped("September 1 FRC attendees are already seeded — no changes needed.");
  } else {
    consoleUi.success(
      `Seeded ${frcAttendeesResult.seededImports} FRC import(s) and ${frcAttendeesResult.seededAttendanceRecords} attendance record(s).`,
      frcAttendeesRun.durationMs,
    );
    consoleUi.detail("No-QR attendees inserted", frcAttendeesResult.seededNoQrAttendees);
    if (frcAttendeesResult.skippedNoStudentId > 0) {
      consoleUi.warning(
        `Skipped ${frcAttendeesResult.skippedNoStudentId} no-QR attendee(s) without a student ID.`,
      );
    }
  }

  const changedSeeders = [
    userResult,
    penaltiesResult,
    participantsResult,
    frcAttendeesResult,
  ].filter((result) => !result.alreadySeeded).length;

  consoleUi.summary([
    { label: "Seeders executed", value: totalSeeders, tone: "info" },
    {
      label: "Changed data",
      value: changedSeeders,
      tone: changedSeeders ? "success" : "info",
    },
    { label: "No-op / skipped", value: totalSeeders - changedSeeders, tone: "info" },
    { label: "Elapsed", value: formatDuration(Date.now() - startedAt), tone: "success" },
  ]);

  if (allAlreadySeeded) {
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
