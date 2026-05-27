import { PoolClient } from "pg";

import { SchoolYearRecord } from "../database/model/schema.model";
import { query, withTransaction } from "../lib/db";
import { syncAbsencesForAttendanceRecordIds } from "./attendance.service";

export type SchoolYearInput = {
  name?: string;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
};

export type TransferSchoolYearRecordsInput = {
  targetSchoolYearId: string;
  eventIds?: string[];
  importIds?: string[];
  attendanceRecordIds?: string[];
  finalResultIds?: string[];
  manualRecordIds?: string[];
  fineIds?: string[];
  penaltyResultIds?: string[];
};

export type TransferSchoolYearRecordsResult = {
  targetSchoolYear: SchoolYearRecord;
  eventsUpdated: number;
  importsUpdated: number;
  attendanceRecordsUpdated: number;
  finesUpdated: number;
  finalResultsUpdated?: number;
  manualRecordsUpdated?: number;
  penaltyResultsUpdated?: number;
};

export type SchoolYearRecordActionResult = {
  schoolYear: SchoolYearRecord;
  eventsUpdated?: number;
  importsUpdated?: number;
  attendanceRecordsUpdated?: number;
  finesUpdated?: number;
  finalResultsUpdated?: number;
  manualRecordsUpdated?: number;
  penaltyResultsUpdated?: number;
  eventsDeleted?: number;
  importsDeleted?: number;
  attendanceRecordsDeleted?: number;
  finesDeleted?: number;
  finalResultsDeleted?: number;
  manualRecordsDeleted?: number;
  penaltyResultsDeleted?: number;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function uniqueCleanIds(values?: string[]) {
  return Array.from(new Set((values ?? []).map(cleanText).filter(Boolean)));
}

function createValidationError(message: string, statusCode = 400) {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

function getDateFromInput(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getSchoolYearRangeFromDate(value: Date = new Date()) {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const startYear = month >= 6 ? year : year - 1;
  const endYear = startYear + 1;

  return {
    name: `${startYear}-${endYear}`,
    startsAt: `${startYear}-06-01`,
    endsAt: `${endYear}-05-31`,
  };
}

function parseSchoolYearInput(input: SchoolYearInput) {
  const name = cleanText(input.name);
  const match = name.match(/^(\d{4})-(\d{4})$/);

  if (!match) {
    throw createValidationError("School year name must use the format YYYY-YYYY.");
  }

  const startYear = Number(match[1]);
  const endYear = Number(match[2]);

  if (endYear !== startYear + 1) {
    throw createValidationError("School year end year must be one year after the start year.");
  }

  const startsAt = cleanText(input.startsAt) || `${startYear}-06-01`;
  const endsAt = cleanText(input.endsAt) || `${endYear}-05-31`;
  const startsAtDate = getDateFromInput(startsAt);
  const endsAtDate = getDateFromInput(endsAt);

  if (!startsAtDate || !endsAtDate) {
    throw createValidationError("School year start and end dates must be valid dates.");
  }

  if (startsAtDate.getTime() > endsAtDate.getTime()) {
    throw createValidationError("School year start date must be before the end date.");
  }

  return {
    name,
    startsAt,
    endsAt,
    isActive: Boolean(input.isActive),
  };
}

export async function ensureSchoolYearForDate(
  client: PoolClient,
  value: Date = new Date(),
) {
  const range = getSchoolYearRangeFromDate(value);
  const result = await client.query<SchoolYearRecord>(
    `
      INSERT INTO school_years (name, starts_at, ends_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (name)
      DO UPDATE SET
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        updated_at = NOW()
      RETURNING *
    `,
    [range.name, range.startsAt, range.endsAt],
  );

  return result.rows[0];
}

async function setActiveSchoolYear(client: PoolClient, id: string) {
  await client.query("UPDATE school_years SET is_active = FALSE WHERE is_active = TRUE AND id <> $1", [id]);

  const result = await client.query<SchoolYearRecord>(
    `
      UPDATE school_years
      SET is_active = TRUE,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id],
  );

  return result.rows[0];
}

export async function getActiveOrCurrentSchoolYear(client?: PoolClient) {
  if (client) {
    const activeResult = await client.query<SchoolYearRecord>(
      `
        SELECT *
        FROM school_years
        WHERE is_active = TRUE
        ORDER BY starts_at DESC
        LIMIT 1
      `,
    );

    if (activeResult.rows[0]) return activeResult.rows[0];

    const currentSchoolYear = await ensureSchoolYearForDate(client);
    return setActiveSchoolYear(client, currentSchoolYear.id);
  }

  const activeResult = await query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      WHERE is_active = TRUE
      ORDER BY starts_at DESC
      LIMIT 1
    `,
  );

  if (activeResult.rows[0]) return activeResult.rows[0];

  return withTransaction(async (transactionClient) => {
    const currentSchoolYear = await ensureSchoolYearForDate(transactionClient);
    return setActiveSchoolYear(transactionClient, currentSchoolYear.id);
  });
}

export async function listSchoolYears(activeOnly = false) {
  const result = await query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      ${activeOnly ? "WHERE is_active = TRUE" : ""}
      ORDER BY starts_at DESC, name DESC
    `,
  );

  if (!result.rows.length && !activeOnly) {
    return withTransaction(async (client) => [await ensureSchoolYearForDate(client)]);
  }

  if (!result.rows.length && activeOnly) {
    return withTransaction(async (client) => {
      const schoolYear = await getActiveOrCurrentSchoolYear(client);
      return [schoolYear];
    });
  }

  return result.rows;
}

export async function createSchoolYear(input: SchoolYearInput) {
  const cleanInput = parseSchoolYearInput(input);

  return withTransaction(async (client) => {
    if (cleanInput.isActive) {
      await client.query("UPDATE school_years SET is_active = FALSE WHERE is_active = TRUE");
    }

    const result = await client.query<SchoolYearRecord>(
      `
        INSERT INTO school_years (name, starts_at, ends_at, is_active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name)
        DO UPDATE SET
          starts_at = EXCLUDED.starts_at,
          ends_at = EXCLUDED.ends_at,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
        RETURNING *
      `,
      [cleanInput.name, cleanInput.startsAt, cleanInput.endsAt, cleanInput.isActive],
    );

    return result.rows[0];
  });
}

export async function getSchoolYearById(client: PoolClient, id: string) {
  const cleanId = cleanText(id);
  if (!cleanId) throw createValidationError("School year ID is required.");

  const result = await client.query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      WHERE id = $1
      LIMIT 1
    `,
    [cleanId],
  );

  if (!result.rows[0]) {
    throw createValidationError("School year not found.", 404);
  }

  return result.rows[0];
}

export async function activateSchoolYear(id: string) {
  return withTransaction(async (client) => {
    await getSchoolYearById(client, id);
    await client.query("UPDATE school_years SET is_active = FALSE WHERE is_active = TRUE");

    const result = await client.query<SchoolYearRecord>(
      `
        UPDATE school_years
        SET is_active = TRUE,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id],
    );

    return result.rows[0];
  });
}


export async function updateSchoolYear(id: string, input: SchoolYearInput) {
  const cleanInput = parseSchoolYearInput(input);

  return withTransaction(async (client) => {
    await getSchoolYearById(client, id);

    if (cleanInput.isActive) {
      await client.query("UPDATE school_years SET is_active = FALSE WHERE is_active = TRUE AND id <> $1", [id]);
    }

    const result = await client.query<SchoolYearRecord>(
      `
        UPDATE school_years
        SET name = $2,
            starts_at = $3,
            ends_at = $4,
            is_active = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, cleanInput.name, cleanInput.startsAt, cleanInput.endsAt, cleanInput.isActive],
    );

    return result.rows[0];
  });
}

async function deleteSchoolYearLinkedRecords(
  client: PoolClient,
  schoolYear: SchoolYearRecord,
): Promise<SchoolYearRecordActionResult> {
  const penaltyResultDelete = await client.query(
    "DELETE FROM penalty_results WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const finalResultDelete = await client.query(
    "DELETE FROM attendance_final_results WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const manualRecordDelete = await client.query(
    "DELETE FROM manual_attendance_records WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const fineDelete = await client.query(
    "DELETE FROM fines WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const recordDelete = await client.query(
    "DELETE FROM attendance_records WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const importDelete = await client.query(
    "DELETE FROM attendance_imports WHERE school_year_id = $1",
    [schoolYear.id],
  );
  const eventDelete = await client.query(
    "DELETE FROM attendance_events WHERE school_year_id = $1",
    [schoolYear.id],
  );

  return {
    schoolYear,
    penaltyResultsDeleted: Number(penaltyResultDelete.rowCount ?? 0),
    finalResultsDeleted: Number(finalResultDelete.rowCount ?? 0),
    manualRecordsDeleted: Number(manualRecordDelete.rowCount ?? 0),
    finesDeleted: Number(fineDelete.rowCount ?? 0),
    attendanceRecordsDeleted: Number(recordDelete.rowCount ?? 0),
    importsDeleted: Number(importDelete.rowCount ?? 0),
    eventsDeleted: Number(eventDelete.rowCount ?? 0),
  };
}

export async function deleteSchoolYear(
  schoolYearId: string,
): Promise<SchoolYearRecordActionResult> {
  return withTransaction(async (client) => {
    const schoolYear = await getSchoolYearById(client, schoolYearId);
    const result = await deleteSchoolYearLinkedRecords(client, schoolYear);

    await client.query("DELETE FROM school_years WHERE id = $1", [schoolYear.id]);

    return result;
  });
}

export async function transferSchoolYearRecords(
  input: TransferSchoolYearRecordsInput,
): Promise<TransferSchoolYearRecordsResult> {
  const eventIds = uniqueCleanIds(input.eventIds);
  const importIds = uniqueCleanIds(input.importIds);
  const attendanceRecordIds = uniqueCleanIds(input.attendanceRecordIds);
  const finalResultIds = uniqueCleanIds(input.finalResultIds);
  const manualRecordIds = uniqueCleanIds(input.manualRecordIds);
  const fineIds = uniqueCleanIds(input.fineIds);
  const penaltyResultIds = uniqueCleanIds(input.penaltyResultIds);

  if (
    !eventIds.length &&
    !importIds.length &&
    !attendanceRecordIds.length &&
    !finalResultIds.length &&
    !manualRecordIds.length &&
    !fineIds.length &&
    !penaltyResultIds.length
  ) {
    throw createValidationError("Please select at least one record to transfer.");
  }

  return withTransaction(async (client) => {
    const targetSchoolYear = await getSchoolYearById(client, input.targetSchoolYearId);
    const affectedRecordIds = new Set<string>();

    const eventUpdate = eventIds.length
      ? await client.query(
          `
            UPDATE attendance_events
            SET school_year_id = $2,
                updated_at = NOW()
            WHERE id = ANY($1::uuid[])
          `,
          [eventIds, targetSchoolYear.id],
        )
      : { rowCount: 0 };

    const importUpdate = importIds.length || eventIds.length
      ? await client.query(
          `
            UPDATE attendance_imports
            SET school_year_id = $3
            WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
               OR ($2::uuid[] <> '{}'::uuid[] AND event_id = ANY($2::uuid[]))
          `,
          [importIds, eventIds, targetSchoolYear.id],
        )
      : { rowCount: 0 };

    const recordsToTransfer = await client.query<{ id: string }>(
      `
        SELECT id
        FROM attendance_records
        WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND event_id = ANY($2::uuid[]))
           OR ($3::uuid[] <> '{}'::uuid[] AND import_id = ANY($3::uuid[]))
      `,
      [attendanceRecordIds, eventIds, importIds],
    );

    recordsToTransfer.rows.forEach((row) => affectedRecordIds.add(row.id));

    const recordUpdate = affectedRecordIds.size
      ? await client.query(
          `
            UPDATE attendance_records
            SET school_year_id = $2,
                updated_at = NOW()
            WHERE id = ANY($1::uuid[])
          `,
          [Array.from(affectedRecordIds), targetSchoolYear.id],
        )
      : { rowCount: 0 };

    const fineUpdate = await client.query(
      `
        UPDATE fines
        SET school_year_id = $3,
            updated_at = NOW()
        WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND attendance_record_id = ANY($2::uuid[]))
      `,
      [fineIds, Array.from(affectedRecordIds), targetSchoolYear.id],
    );

    const finalResultUpdate = await client.query(
      `
        UPDATE attendance_final_results
        SET school_year_id = $3,
            updated_at = NOW()
        WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND import_id = ANY($2::uuid[]))
      `,
      [finalResultIds, importIds, targetSchoolYear.id],
    );

    const manualRecordUpdate = await client.query(
      `
        UPDATE manual_attendance_records
        SET school_year_id = $3,
            updated_at = NOW()
        WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND event_id = ANY($2::uuid[]))
      `,
      [manualRecordIds, eventIds, targetSchoolYear.id],
    );

    const penaltyResultUpdate = await client.query(
      `
        UPDATE penalty_results
        SET school_year_id = $3,
            updated_at = NOW()
        WHERE ($1::uuid[] <> '{}'::uuid[] AND id = ANY($1::uuid[]))
           OR ($2::uuid[] <> '{}'::uuid[] AND source_record_id = ANY($2::uuid[]))
      `,
      [penaltyResultIds, fineIds, targetSchoolYear.id],
    );

    if (affectedRecordIds.size) {
      await syncAbsencesForAttendanceRecordIds(client, Array.from(affectedRecordIds));
    }

    return {
      targetSchoolYear,
      eventsUpdated: Number(eventUpdate.rowCount ?? 0),
      importsUpdated: Number(importUpdate.rowCount ?? 0),
      attendanceRecordsUpdated: Number(recordUpdate.rowCount ?? 0),
      finesUpdated: Number(fineUpdate.rowCount ?? 0),
      finalResultsUpdated: Number(finalResultUpdate.rowCount ?? 0),
      manualRecordsUpdated: Number(manualRecordUpdate.rowCount ?? 0),
      penaltyResultsUpdated: Number(penaltyResultUpdate.rowCount ?? 0),
    };
  });
}


export async function assignCurrentRecordsToSchoolYear(
  schoolYearId: string,
): Promise<SchoolYearRecordActionResult> {
  return withTransaction(async (client) => {
    const schoolYear = await getSchoolYearById(client, schoolYearId);

    const eventUpdate = await client.query(
      `
        UPDATE attendance_events
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const importUpdate = await client.query(
      `
        UPDATE attendance_imports
        SET school_year_id = $1
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const recordUpdate = await client.query(
      `
        UPDATE attendance_records
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const fineUpdate = await client.query(
      `
        UPDATE fines
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const finalResultUpdate = await client.query(
      `
        UPDATE attendance_final_results
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const manualRecordUpdate = await client.query(
      `
        UPDATE manual_attendance_records
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    const penaltyResultUpdate = await client.query(
      `
        UPDATE penalty_results
        SET school_year_id = $1,
            updated_at = NOW()
        WHERE school_year_id IS NULL
      `,
      [schoolYear.id],
    );

    return {
      schoolYear,
      eventsUpdated: Number(eventUpdate.rowCount ?? 0),
      importsUpdated: Number(importUpdate.rowCount ?? 0),
      attendanceRecordsUpdated: Number(recordUpdate.rowCount ?? 0),
      finesUpdated: Number(fineUpdate.rowCount ?? 0),
      finalResultsUpdated: Number(finalResultUpdate.rowCount ?? 0),
      manualRecordsUpdated: Number(manualRecordUpdate.rowCount ?? 0),
      penaltyResultsUpdated: Number(penaltyResultUpdate.rowCount ?? 0),
    };
  });
}

export async function deleteSchoolYearRecords(
  schoolYearId: string,
): Promise<SchoolYearRecordActionResult> {
  return withTransaction(async (client) => {
    const schoolYear = await getSchoolYearById(client, schoolYearId);

    return deleteSchoolYearLinkedRecords(client, schoolYear);
  });
}