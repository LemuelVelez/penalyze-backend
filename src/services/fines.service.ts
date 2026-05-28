import {
  AttendanceRecord,
  FineRecord,
  FineStatus,
  PenaltyRecord,
  PenaltyResultRecord,
  SchoolYearRecord,
  StudentRecord
} from "../database/model/schema.model";
import { DEFAULT_PENALTIES } from "../database/seeder/penalties.seeder";
import { query } from "../lib/db";

export const ZERO_ATTENDANCE_REMARK = "Zero attendance registration from landing page.";

export type DeletedPenaltyResultsResult = {
  deletedCount: number;
  deletedRecords: PenaltyResultRecord[];
};

type ZeroAttendanceFineInput = {
  schoolYearId?: string | null;
  studentId: string;
  name: string;
  yearLevel?: string | null;
  college?: string | null;
  program?: string | null;
  institution?: string | null;
};

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

function cleanOptionalText(value: unknown) {
  const cleanValue = String(value ?? "").trim();
  return cleanValue || null;
}

function uniqueCleanTextValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
  );
}

function normalizeAcademicScopeValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function buildAcademicScopeKey(input: Pick<ReturnType<typeof validateZeroAttendanceInput>, "institution" | "college" | "program" | "yearLevel">) {
  return [input.institution, input.college, input.program, input.yearLevel]
    .map(normalizeAcademicScopeValue)
    .join("|");
}

function getAttendanceRecordScopeColumnSql(recordAlias: string, columnName: string) {
  return `
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.${columnName}), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(${recordAlias}.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(${recordAlias}.${columnName}), ''),
      ''
    )))
  `;
}

function getAttendanceRecordCollegeScopeSql(recordAlias: string) {
  return `
    CONCAT_WS(
      '|',
      ${getAttendanceRecordScopeColumnSql(recordAlias, "institution")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "college")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "program")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "year_level")}
    )
  `;
}

const ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL =
  getAttendanceRecordCollegeScopeSql("ar");

function getFineTableColumnsSql(alias: string) {
  return [
    "id",
    "school_year_id",
    "attendance_record_id",
    "penalty_id",
    "student_id",
    "name",
    "prescribed_penalty",
    "status",
    "created_at",
    "updated_at",
  ]
    .map((column) => `${alias}.${column}`)
    .join(",\n        ");
}

const FINE_RETURNING_COLUMNS_SQL = `
  id,
  school_year_id,
  attendance_record_id,
  penalty_id,
  student_id,
  name,
  prescribed_penalty,
  status,
  created_at,
  updated_at
`;


function getSchoolYearRangeFromDate(value: Date = new Date()) {
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

async function ensureCurrentSchoolYear() {
  const active = await query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      WHERE is_active = TRUE
      ORDER BY starts_at DESC
      LIMIT 1
    `,
  );

  if (active.rows[0]) return active.rows[0];

  const range = getSchoolYearRangeFromDate();
  const result = await query<SchoolYearRecord>(
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

async function resolveSchoolYearId(schoolYearId?: string | null) {
  const cleanSchoolYearId = cleanOptionalText(schoolYearId);

  if (cleanSchoolYearId) {
    const result = await query<SchoolYearRecord>(
      `
        SELECT *
        FROM school_years
        WHERE id = $1
        LIMIT 1
      `,
      [cleanSchoolYearId],
    );

    if (!result.rows[0]) {
      throw new Error("School year not found.");
    }

    return result.rows[0].id;
  }

  return (await ensureCurrentSchoolYear()).id;
}

function validateZeroAttendanceInput(input: ZeroAttendanceFineInput) {
  const studentId = String(input.studentId ?? "").trim();
  const name = String(input.name ?? "").trim();

  if (!studentId) {
    throw new Error("Student ID is required.");
  }

  if (!name) {
    throw new Error("Name is required.");
  }

  return {
    schoolYearId: cleanOptionalText(input.schoolYearId),
    studentId,
    name,
    yearLevel: cleanOptionalText(input.yearLevel),
    college: cleanOptionalText(input.college),
    program: cleanOptionalText(input.program),
    institution: cleanOptionalText(input.institution)
  };
}

export async function listPenalties() {
  const result = await query<PenaltyRecord>(
    `
      SELECT *
      FROM penalties
      ORDER BY no_of_absences ASC
    `,
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

  await query(
    `
      UPDATE penalty_results
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

  await query(
    `
      UPDATE penalty_results
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

export async function listFines(options: { schoolYearId?: string; status?: FineStatus; studentId?: string; limit?: number; offset?: number } = {}) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`f.school_year_id = $${params.length}`);
  }

  if (options.status) {
    params.push(options.status);
    clauses.push(`f.status = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(f.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<FineRecord>(
    `
      SELECT
        ${getFineTableColumnsSql("f")},
        COALESCE(ar.no_of_absences, 0)::INT AS no_of_absences,
        ar.event_id AS attendance_event_id,
        ae.name AS attendance_event_name,
        ae.event_order AS attendance_event_order,
        ae.event_start_at AS attendance_event_start_at,
        ae.event_end_at AS attendance_event_end_at,
        ar.remarks AS attendance_remarks
      FROM fines f
      LEFT JOIN attendance_records ar ON ar.id = f.attendance_record_id
      LEFT JOIN attendance_events ae ON ae.id = ar.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, f.created_at) ASC,
        f.student_id ASC,
        f.created_at ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params
  );

  return result.rows;
}

async function getAttendanceEventCount(input: ReturnType<typeof validateZeroAttendanceInput>, schoolYearId: string) {
  const result = await query<{ total: number }>(
    `
      SELECT COUNT(DISTINCT ae.id)::INT AS total
      FROM attendance_events ae
      WHERE ae.school_year_id = $2::uuid
        AND EXISTS (
          SELECT 1
          FROM attendance_records ar
          WHERE ar.event_id = ae.id
            AND ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} = $1::TEXT
        )
    `,
    [buildAcademicScopeKey(input), schoolYearId]
  );

  return Number(result.rows[0]?.total ?? 0);
}

async function upsertStudentRecord(input: ReturnType<typeof validateZeroAttendanceInput>) {
  const result = await query<StudentRecord>(
    `
      INSERT INTO students (student_id, name, year_level, college, program, institution)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (student_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        year_level = EXCLUDED.year_level,
        college = EXCLUDED.college,
        program = EXCLUDED.program,
        institution = EXCLUDED.institution,
        updated_at = NOW()
      RETURNING *
    `,
    [input.studentId, input.name, input.yearLevel, input.college, input.program, input.institution]
  );

  return result.rows[0];
}

async function upsertZeroAttendanceRecord(input: ReturnType<typeof validateZeroAttendanceInput>, schoolYearId: string, noOfAbsences: number) {
  const existing = await query<AttendanceRecord>(
    `
      SELECT *
      FROM attendance_records
      WHERE event_id IS NULL
        AND school_year_id = $3
        AND LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND remarks = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [input.studentId, ZERO_ATTENDANCE_REMARK, schoolYearId]
  );

  if (existing.rows[0]) {
    const result = await query<AttendanceRecord>(
      `
        UPDATE attendance_records
        SET name = $2,
            year_level = $3,
            college = $4,
            program = $5,
            institution = $6,
            school_year_id = $7,
            no_of_absences = $8,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existing.rows[0].id,
        input.name,
        input.yearLevel,
        input.college,
        input.program,
        input.institution,
        schoolYearId,
        noOfAbsences
      ]
    );

    return result.rows[0];
  }

  const result = await query<AttendanceRecord>(
    `
      INSERT INTO attendance_records (
        school_year_id,
        import_id,
        event_id,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        no_of_absences,
        remarks,
        scanned_at
      )
      VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
      RETURNING *
    `,
    [
      schoolYearId,
      input.studentId,
      input.name,
      input.yearLevel,
      input.college,
      input.program,
      input.institution,
      noOfAbsences,
      ZERO_ATTENDANCE_REMARK
    ]
  );

  return result.rows[0];
}

async function upsertFineForZeroAttendance(attendanceRecord: AttendanceRecord, penalty: PenaltyRecord | null) {
  const noOfAbsences = Number(attendanceRecord.no_of_absences || 0);

  if (noOfAbsences <= 0) {
    return null;
  }

  const prescribedPenalty = penalty?.prescribed_penalty ?? "No prescribed penalty configured.";

  const existing = await query<FineRecord>(
    `
      SELECT *
      FROM fines
      WHERE attendance_record_id = $1
      LIMIT 1
    `,
    [attendanceRecord.id]
  );

  if (existing.rows[0]) {
    const result = await query<FineRecord>(
      `
        UPDATE fines
        SET school_year_id = $2,
            penalty_id = $3,
            student_id = $4,
            name = $5,
            prescribed_penalty = $6,
            updated_at = NOW()
        WHERE id = $1
        RETURNING ${FINE_RETURNING_COLUMNS_SQL}, $7::INT AS no_of_absences
      `,
      [
        existing.rows[0].id,
        attendanceRecord.school_year_id,
        penalty?.id ?? null,
        attendanceRecord.student_id,
        attendanceRecord.name,
        prescribedPenalty,
        noOfAbsences
      ]
    );

    return result.rows[0];
  }

  const result = await query<FineRecord>(
    `
      INSERT INTO fines (
        school_year_id,
        attendance_record_id,
        penalty_id,
        student_id,
        name,
        prescribed_penalty,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid')
      RETURNING ${FINE_RETURNING_COLUMNS_SQL}, $7::INT AS no_of_absences
    `,
    [
      attendanceRecord.school_year_id,
      attendanceRecord.id,
      penalty?.id ?? null,
      attendanceRecord.student_id,
      attendanceRecord.name,
      prescribedPenalty,
      noOfAbsences
    ]
  );

  return result.rows[0];
}

export async function registerZeroAttendanceFine(input: ZeroAttendanceFineInput) {
  const cleanInput = validateZeroAttendanceInput(input);
  const schoolYearId = await resolveSchoolYearId(cleanInput.schoolYearId);
  const totalEvents = await getAttendanceEventCount(cleanInput, schoolYearId);

  await upsertStudentRecord(cleanInput);

  const attendanceRecord = await upsertZeroAttendanceRecord(cleanInput, schoolYearId, totalEvents);
  const penalty = totalEvents > 0 ? await getPenaltyByAbsences(totalEvents) : null;
  const fine = await upsertFineForZeroAttendance(attendanceRecord, penalty);

  return {
    attendanceRecord,
    fine: fine
      ? {
          ...fine,
          attendance_event_id: attendanceRecord.event_id ?? null,
          attendance_remarks: attendanceRecord.remarks ?? null
        }
      : null,
    totalEvents,
    penalty
  };
}

export async function updateFineStatus(id: string, status: FineStatus) {
  if (!["unpaid", "paid", "waived"].includes(status)) {
    throw new Error("Invalid fine status.");
  }

  const result = await query<FineRecord>(
    `
      WITH updated AS (
        UPDATE fines
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      )
      SELECT
        ${getFineTableColumnsSql("updated")},
        COALESCE(ar.no_of_absences, 0)::INT AS no_of_absences,
        ar.event_id AS attendance_event_id,
        ar.remarks AS attendance_remarks
      FROM updated
      LEFT JOIN attendance_records ar ON ar.id = updated.attendance_record_id
    `,
    [id, status]
  );

  if (!result.rows[0]) {
    throw new Error("Fine not found.");
  }

  return result.rows[0];
}

export async function getFineSummary(schoolYearId?: string) {
  const result = await query<{
    status: FineStatus;
    count: string;
  }>(
    `
      SELECT status, COUNT(*)::TEXT AS count
      FROM fines
      ${schoolYearId ? "WHERE school_year_id = $1" : ""}
      GROUP BY status
      ORDER BY status ASC
    `,
    schoolYearId ? [schoolYearId] : [],
  );

  return result.rows.reduce<Record<FineStatus, number>>(
    (summary: Record<FineStatus, number>, row: { status: FineStatus; count: string }) => {
      summary[row.status] = Number(row.count);
      return summary;
    },
    { unpaid: 0, paid: 0, waived: 0 }
  );
}


type ListPenaltyResultsOptions = {
  schoolYearId?: string;
  status?: FineStatus;
  studentId?: string;
  limit?: number;
  offset?: number;
};

function normalizeImportIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function getCalculationScopeKey(importIds: string[]) {
  return importIds.length ? importIds.join(":") : "";
}

export async function listPenaltyResults(options: ListPenaltyResultsOptions = {}) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`pr.school_year_id = $${params.length}`);
  }

  if (options.status) {
    params.push(options.status);
    clauses.push(`pr.status = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(pr.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<PenaltyResultRecord>(
    `
      SELECT
        pr.*,
        COALESCE(afr.college, cr.college, mar.college) AS college,
        COALESCE(afr.program, cr.program, mar.program) AS program,
        COALESCE(manual_event.event_order, calculation_event.event_order) AS event_order,
        COALESCE(manual_event.event_start_at, calculation_event.event_start_at, afr.latest_scanned_at) AS event_start_at,
        COALESCE(manual_event.event_end_at, calculation_event.event_end_at, afr.latest_scanned_at) AS event_end_at
      FROM penalty_results pr
      LEFT JOIN attendance_final_results afr
        ON pr.source_table = 'attendance_final_results'
        AND afr.id = pr.source_record_id
      LEFT JOIN calculation_results cr
        ON pr.source_table = 'calculation_results'
        AND cr.id = pr.source_record_id
      LEFT JOIN manual_attendance_records mar
        ON pr.source_table = 'manual_attendance_records'
        AND mar.id = pr.source_record_id
      LEFT JOIN attendance_events manual_event ON manual_event.id = mar.event_id
      LEFT JOIN LATERAL (
        SELECT
          MIN(ae.event_order) AS event_order,
          MIN(ae.event_start_at) AS event_start_at,
          MIN(ae.event_end_at) AS event_end_at,
          MIN(COALESCE(ae.event_start_at, ae.event_end_at, ai.created_at)) AS event_sort_at
        FROM attendance_imports ai
        LEFT JOIN attendance_events ae ON ae.id = ai.event_id
        WHERE ai.id = ANY(COALESCE(cr.import_ids, ARRAY[]::uuid[]))
      ) calculation_event ON TRUE
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        COALESCE(manual_event.event_order, calculation_event.event_order) ASC NULLS LAST,
        COALESCE(
          manual_event.event_start_at,
          manual_event.event_end_at,
          calculation_event.event_sort_at,
          pr.updated_at,
          pr.created_at
        ) ASC,
        pr.student_id ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}

export async function refreshPenaltyResults(options: {
  schoolYearId?: string;
  importIds?: string[];
} = {}) {
  const schoolYearId = cleanOptionalText(options.schoolYearId);

  const result = await query<PenaltyResultRecord>(
    `
      WITH totals AS (
        SELECT
          afr.school_year_id,
          afr.student_id,
          afr.name,
          afr.total_absences::INT AS no_of_absences,
          penalty.id AS penalty_id,
          COALESCE(penalty.prescribed_penalty, 'No prescribed penalty configured.') AS prescribed_penalty,
          'attendance_final_results'::TEXT AS source_table,
          afr.id AS source_record_id
        FROM attendance_final_results afr
        LEFT JOIN LATERAL (
          SELECT id, prescribed_penalty
          FROM penalties
          WHERE no_of_absences <= afr.total_absences
          ORDER BY no_of_absences DESC
          LIMIT 1
        ) penalty ON afr.total_absences > 0
        WHERE ($1::uuid IS NULL OR afr.school_year_id = $1::uuid)
          AND afr.total_absences > 0
      )
      INSERT INTO penalty_results (
        school_year_id,
        student_id,
        name,
        no_of_absences,
        penalty_id,
        prescribed_penalty,
        status,
        source_table,
        source_record_id
      )
      SELECT
        school_year_id,
        student_id,
        name,
        no_of_absences,
        penalty_id,
        prescribed_penalty,
        'unpaid',
        source_table,
        source_record_id
      FROM totals
      ON CONFLICT (school_year_id, (LOWER(TRIM(student_id))))
      DO UPDATE SET
        name = EXCLUDED.name,
        no_of_absences = EXCLUDED.no_of_absences,
        penalty_id = EXCLUDED.penalty_id,
        prescribed_penalty = EXCLUDED.prescribed_penalty,
        source_table = EXCLUDED.source_table,
        source_record_id = EXCLUDED.source_record_id,
        updated_at = NOW()
      RETURNING *
    `,
    [schoolYearId],
  );

  await query(
    `
      DELETE FROM penalty_results pr
      WHERE ($1::uuid IS NULL OR pr.school_year_id = $1::uuid)
        AND pr.source_table = 'attendance_final_results'
        AND NOT EXISTS (
          SELECT 1
          FROM attendance_final_results afr
          WHERE afr.school_year_id IS NOT DISTINCT FROM pr.school_year_id
            AND LOWER(TRIM(afr.student_id)) = LOWER(TRIM(pr.student_id))
            AND afr.total_absences > 0
        )
    `,
    [schoolYearId],
  );

  return result.rows;
}

export async function updatePenaltyResultStatus(id: string, status: FineStatus) {
  if (!["unpaid", "paid", "waived"].includes(status)) {
    throw new Error("Invalid penalty result status.");
  }

  const result = await query<PenaltyResultRecord>(
    `
      UPDATE penalty_results
      SET status = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id, status],
  );

  if (!result.rows[0]) {
    throw new Error("Penalty result not found.");
  }

  return result.rows[0];
}

export async function updatePenaltyResult(
  id: string,
  input: {
    studentId?: string;
    name?: string;
    noOfAbsences?: number;
    prescribedPenalty?: string;
    status?: FineStatus;
  },
) {
  const studentId = cleanOptionalText(input.studentId);
  const name = cleanOptionalText(input.name);
  const noOfAbsences = Number(input.noOfAbsences ?? 0);
  const prescribedPenalty = cleanOptionalText(input.prescribedPenalty);
  const status = input.status;

  if (!Number.isInteger(noOfAbsences) || noOfAbsences < 0) {
    throw new Error("No. of absences must be a whole number.");
  }

  if (status && !["unpaid", "paid", "waived"].includes(status)) {
    throw new Error("Invalid penalty result status.");
  }

  if (!prescribedPenalty && noOfAbsences > 0) {
    throw new Error("Prescribed penalty is required.");
  }

  const matchedPenalty =
    noOfAbsences > 0 ? await getPenaltyByAbsences(noOfAbsences) : null;

  const result = await query<PenaltyResultRecord>(
    `
      UPDATE penalty_results
      SET student_id = COALESCE($2, student_id),
          name = COALESCE($3, name),
          no_of_absences = $4,
          penalty_id = $5,
          prescribed_penalty = COALESCE($6, prescribed_penalty),
          status = COALESCE($7, status),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      studentId,
      name,
      noOfAbsences,
      matchedPenalty?.id ?? null,
      prescribedPenalty ?? matchedPenalty?.prescribed_penalty ?? null,
      status ?? null,
    ],
  );

  if (!result.rows[0]) {
    throw new Error("Penalty result not found.");
  }

  return result.rows[0];
}

export async function deletePenaltyResultsByIds(
  ids: string[],
): Promise<DeletedPenaltyResultsResult> {
  const uniqueIds = uniqueCleanTextValues(ids);

  if (!uniqueIds.length) {
    return {
      deletedCount: 0,
      deletedRecords: [],
    };
  }

  const result = await query<PenaltyResultRecord>(
    `
      DELETE FROM penalty_results
      WHERE id = ANY($1::uuid[])
      RETURNING *
    `,
    [uniqueIds],
  );

  return {
    deletedCount: result.rows.length,
    deletedRecords: result.rows,
  };
}

export async function deletePenaltyResultsBySchoolYear(
  schoolYearId: string,
): Promise<DeletedPenaltyResultsResult> {
  const scopedSchoolYearId = cleanOptionalText(schoolYearId);

  if (!scopedSchoolYearId) {
    return {
      deletedCount: 0,
      deletedRecords: [],
    };
  }

  const result = await query<PenaltyResultRecord>(
    `
      DELETE FROM penalty_results
      WHERE school_year_id = $1
      RETURNING *
    `,
    [scopedSchoolYearId],
  );

  return {
    deletedCount: result.rows.length,
    deletedRecords: result.rows,
  };
}