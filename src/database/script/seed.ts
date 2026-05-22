import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { seedUser } from "../seeder/users.seeder";
import { closeDatabasePool } from "../../lib/db";

async function runSeeders() {
  console.log("Running database seeders...");

  const userResult = await seedUser();
  console.log(
    userResult.alreadySeeded
      ? `Seeded user already seeded: ${userResult.email}`
      : `Seeded user created: ${userResult.email}`
  );

  const penaltiesResult = await seedPenalties();
  console.log(
    penaltiesResult.alreadySeeded
      ? "Penalties already seeded."
      : `Seeded ${penaltiesResult.seededCount} penalties.`
  );

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
