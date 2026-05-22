import "dotenv/config";

import { PenaltyRecord } from "../model/schema.model";
import { closeDatabasePool, query } from "../../lib/db";

export const DEFAULT_PENALTIES: Array<Pick<PenaltyRecord, "no_of_absences" | "prescribed_penalty">> = [
  {
    no_of_absences: 1,
    prescribed_penalty: "1 pad Grade 1 paper, 1 pencil"
  },
  {
    no_of_absences: 2,
    prescribed_penalty: "2 pads Grade 2 paper, 2 pencils, 1 eraser"
  },
  {
    no_of_absences: 3,
    prescribed_penalty: "3 pads Grade 3 paper, 3 pencils, 2 erasers, 1 sharpener, 1 eraser"
  },
  {
    no_of_absences: 4,
    prescribed_penalty: "2 pads Grade 4 paper, 2 pencils, 2 ballpens, 1 crayon, 1 sharpener, 1 eraser"
  },
  {
    no_of_absences: 5,
    prescribed_penalty: "2 pads intermediate paper, 2 notebooks, 2 ballpens, 1 crayon"
  },
  {
    no_of_absences: 6,
    prescribed_penalty: "2 pads Intermediate paper, 2 notebooks, 2 ballpens, 1 crayon, 2 pencils"
  },
  {
    no_of_absences: 7,
    prescribed_penalty: "1 plastic envelope with handle, 2 pads Intermediate paper, 2 notebooks"
  },
  {
    no_of_absences: 8,
    prescribed_penalty: "1 plastic envelope with handle, 2 pads Intermediate paper, 2 notebooks"
  },
  {
    no_of_absences: 9,
    prescribed_penalty: "1 plastic envelope with handle, 2 pads Intermediate paper, 3 notebooks, 2 pencils, 2 erasers, 1 sharpener"
  },
  {
    no_of_absences: 10,
    prescribed_penalty:
      "1 plastic envelope with handle, 2 pads Intermediate paper, 3 notebooks, 3 pencils, 2 erasers, 3 sharpeners, 3 ballpens, 1 crayon"
  }
];

export async function seedPenalties() {
  const seeded: PenaltyRecord[] = [];

  for (const item of DEFAULT_PENALTIES) {
    const result = await query<PenaltyRecord>(
      `
        INSERT INTO penalties (no_of_absences, prescribed_penalty)
        VALUES ($1, $2)
        ON CONFLICT (no_of_absences)
        DO UPDATE SET
          prescribed_penalty = EXCLUDED.prescribed_penalty,
          updated_at = NOW()
        RETURNING *
      `,
      [item.no_of_absences, item.prescribed_penalty]
    );

    seeded.push(result.rows[0]);
  }

  return seeded;
}

if (require.main === module) {
  seedPenalties()
    .then(async (rows) => {
      console.log(`Seeded ${rows.length} penalties.`);
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("Penalty seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}