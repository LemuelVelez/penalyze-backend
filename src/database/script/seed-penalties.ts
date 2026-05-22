import "dotenv/config";

import { seedPenalties } from "../seeder/penalties.seeder";
import { closeDatabasePool } from "../../lib/db";

seedPenalties()
  .then(async (rows) => {
    console.log(`Seeded ${rows.length} penalties.`);
    await closeDatabasePool();
  })
  .catch(async (error) => {
    console.error("Seed failed:", error);
    await closeDatabasePool();
    process.exit(1);
  });