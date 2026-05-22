import { FineRecord, FineStatus, PenaltyRecord } from "../database/model/schema.model";
import { DEFAULT_PENALTIES } from "../database/seeder/penalties.seeder";
import { query } from "../lib/db";

function validatePenaltyInput(noOfAbsences: number, prescribedPenalty: string) {
  if (!Number.isInteger(noOfAbsences) || noOfAbsences <= 0) {
    throw new Error("No. of Absences must be a positive whole number.");
  }

  const cleanPenalty = String(prescribedPenalty ?? "").trim();
  if (!cleanPenalty) {
    throw new Error("Prescribed penalty is required.");
  }

  return cleanPenalty;
}

export async function listPenalties() {
  const result = await query<PenaltyRecord>(
    `
      SELECT *
      FROM penalties
      ORDER BY no_of_absences ASC
    `
  );

  return result.rows;
}

export async function getPenaltyByAbsences(noOfAbsences: number) {
  const result = await query<PenaltyRecord>(
    `
      SELECT *
      FROM penalties
      WHERE no_of_absences <= $1
      ORDER BY no_of_absences DESC
      LIMIT 1
    `,
    [noOfAbsences]
  );

  return result.rows[0] ?? null;
}

export async function upsertPenalty(noOfAbsences: number, prescribedPenalty: string) {
  const cleanPenalty = validatePenaltyInput(noOfAbsences, prescribedPenalty);

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
    [noOfAbsences, cleanPenalty]
  );

  return result.rows[0];
}

export async function updatePenalty(id: string, noOfAbsences: number, prescribedPenalty: string) {
  const cleanPenalty = validatePenaltyInput(noOfAbsences, prescribedPenalty);

  const duplicate = await query<PenaltyRecord>(
    `
      SELECT *
      FROM penalties
      WHERE no_of_absences = $1
        AND id <> $2
      LIMIT 1
    `,
    [noOfAbsences, id]
  );

  if (duplicate.rows[0]) {
    throw new Error("A penalty for this number of absences already exists.");
  }

  const result = await query<PenaltyRecord>(
    `
      UPDATE penalties
      SET no_of_absences = $2,
          prescribed_penalty = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id, noOfAbsences, cleanPenalty]
  );

  if (!result.rows[0]) {
    throw new Error("Penalty not found.");
  }

  await query(
    `
      UPDATE fines
      SET prescribed_penalty = $2,
          updated_at = NOW()
      WHERE penalty_id = $1
    `,
    [id, cleanPenalty]
  );

  return result.rows[0];
}

export async function deletePenalty(id: string) {
  const existing = await query<PenaltyRecord>(
    `
      SELECT *
      FROM penalties
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  if (!existing.rows[0]) {
    throw new Error("Penalty not found.");
  }

  await query(
    `
      UPDATE fines
      SET penalty_id = NULL,
          updated_at = NOW()
      WHERE penalty_id = $1
    `,
    [id]
  );

  const result = await query<PenaltyRecord>(
    `
      DELETE FROM penalties
      WHERE id = $1
      RETURNING *
    `,
    [id]
  );

  return result.rows[0];
}

export async function seedDefaultPenalties() {
  const rows: PenaltyRecord[] = [];

  for (const penalty of DEFAULT_PENALTIES) {
    rows.push(await upsertPenalty(penalty.no_of_absences, penalty.prescribed_penalty));
  }

  return rows;
}

export async function listFines(options: { status?: FineStatus; studentId?: string; limit?: number; offset?: number } = {}) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(student_id)) = LOWER(TRIM($${params.length}))`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<FineRecord>(
    `
      SELECT *
      FROM fines
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, updated_at DESC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params
  );

  return result.rows;
}

export async function updateFineStatus(id: string, status: FineStatus) {
  if (!["unpaid", "paid", "waived"].includes(status)) {
    throw new Error("Invalid fine status.");
  }

  const result = await query<FineRecord>(
    `
      UPDATE fines
      SET status = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id, status]
  );

  if (!result.rows[0]) {
    throw new Error("Fine not found.");
  }

  return result.rows[0];
}

export async function getFineSummary() {
  const result = await query<{
    status: FineStatus;
    count: string;
  }>(
    `
      SELECT status, COUNT(*)::TEXT AS count
      FROM fines
      GROUP BY status
      ORDER BY status ASC
    `
  );

  return result.rows.reduce<Record<FineStatus, number>>(
    (summary: Record<FineStatus, number>, row: { status: FineStatus; count: string }) => {
      summary[row.status] = Number(row.count);
      return summary;
    },
    { unpaid: 0, paid: 0, waived: 0 }
  );
}