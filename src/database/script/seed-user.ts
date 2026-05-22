import "dotenv/config";

import { seedUser } from "../seeder/users.seeder";
import { closeDatabasePool } from "../../lib/db";

seedUser()
  .then(async (result) => {
    console.log(
      result.alreadySeeded
        ? `Seeded user already seeded: ${result.email}`
        : `Seeded user created: ${result.email}`
    );
    await closeDatabasePool();
  })
  .catch(async (error) => {
    console.error("Seed user failed:", error);
    await closeDatabasePool();
    process.exit(1);
  });