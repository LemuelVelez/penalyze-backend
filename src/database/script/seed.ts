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

async function runSeeder<T>(
  index: number,
  total: number,
  icon: string,
  label: string,
  seeder: () => Promise<T>,
): Promise<SeederRun<T>> {
  const startedAt = Date.now();
  consoleUi.progress(index, total, `${icon}  ${label}`);
  const result = await seeder();
  const durationMs = Date.now() - startedAt;
  consoleUi.success(`${label} finished`, durationMs);
  return { label, icon, durationMs, result };
}

async function runSeeders() {
  const startedAt = Date.now();
  const totalSeeders = 4;

  consoleUi.header(
    "🌱",
    "DATABASE SEEDERS",
    `Penalyze • preparing ${totalSeeders} deterministic seeders`,
  );
  consoleUi.section("⚙️", "Running seed pipeline");

  const userRun = await runSeeder(1, totalSeeders, "👤", "Default user", seedUser);
  const penaltiesRun = await runSeeder(2, totalSeeders, "⚖️", "Penalties", seedPenalties);
  const participantsRun = await runSeeder(
    3,
    totalSeeders,
    "🎓",
    "Participants & attendance",
    seedParticipants,
  );
  const frcAttendeesRun = await runSeeder(
    4,
    totalSeeders,
    "🏳️",
    "September 1 FRC attendees",
    seedFrcAttendees,
  );

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
    consoleUi.success(`Created default user: ${userResult.email}`);
  }

  if (penaltiesResult.alreadySeeded) {
    consoleUi.skipped("Penalties are already seeded — no changes needed.");
  } else {
    consoleUi.success(`Seeded ${penaltiesResult.seededCount} penalties.`);
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
      `Seeded ${participantsResult.seededImports} import(s) and ${participantsResult.seededAttendanceRecords} attendance record(s).`,
    );
    if (participantsResult.seededStudentsWithoutQr > 0) {
      consoleUi.info(
        `Included ${participantsResult.seededStudentsWithoutQr} participant(s) recorded without a QR scan.`,
      );
    }
  }

  if (frcAttendeesResult.alreadySeeded) {
    consoleUi.skipped("September 1 FRC attendees are already seeded — no changes needed.");
  } else {
    consoleUi.success(
      `Seeded ${frcAttendeesResult.seededImports} FRC import(s) and ${frcAttendeesResult.seededAttendanceRecords} attendance record(s).`,
    );
    if (frcAttendeesResult.seededNoQrAttendees > 0) {
      consoleUi.info(
        `Included ${frcAttendeesResult.seededNoQrAttendees} attendee(s) from the no-QR list.`,
      );
    }
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
