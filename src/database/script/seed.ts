import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { seedUser } from "../seeder/users.seeder";
import { seedParticipants } from "../seeder/participants.seeder";
import { closeDatabasePool } from "../../lib/db";

async function runSeeders() {
  console.log("Running database seeders...");

  const userResult = await seedUser();
  const penaltiesResult = await seedPenalties();
  const participantsResult = await seedParticipants();

  if (
    userResult.alreadySeeded &&
    penaltiesResult.alreadySeeded &&
    participantsResult.alreadySeeded
  ) {
    console.log("No pending seeders.");
    return;
  }

  if (!userResult.alreadySeeded) {
    console.log(`Seeded user created: ${userResult.email}`);
  }

  if (!penaltiesResult.alreadySeeded) {
    console.log(`Seeded ${penaltiesResult.seededCount} penalties.`);
  }

  if (!participantsResult.alreadySeeded) {
    console.log(
      `Seeded ${participantsResult.seededImports} participant import(s), ${participantsResult.seededAttendanceRecords} attendance record(s), including ${participantsResult.seededStudentsWithoutQr} no-QR participant(s).`,
    );
  }

  console.log("Seeders completed.");
}

runSeeders()
  .then(async () => {
    await closeDatabasePool();
  })
  .catch(async (error) => {
    console.error("Seed failed:", error);
    await closeDatabasePool();
    process.exit(1);
  });
