import { AttendanceRecord, FineRecord, FineStatus, PenaltyRecord, StudentRecord } from "../database/model/schema.model";
import { DEFAULT_PENALTIES } from "../database/seeder/penalties.seeder";
import { query } from "../lib/db";

export const ZERO_ATTENDANCE_REMARK = "Zero attendance registration from landing page.";

type ZeroAttendanceFineInput = {
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

function getAttendanceRecordCollegeScopeSql(recordAlias: string) {
  return `
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.college), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(${recordAlias}.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(${recordAlias}.college), ''),
      ''
    )))
  `;
}

const ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL =
  getAttendanceRecordCollegeScopeSql("ar");


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
        f.*,
        ar.event_id AS attendance_event_id,
        ar.remarks AS attendance_remarks
      FROM fines f
      LEFT JOIN attendance_records ar ON ar.id = f.attendance_record_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY f.created_at DESC, f.updated_at DESC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params
  );

  return result.rows;
}

async function getAttendanceEventCount(college?: string | null) {
  const result = await query<{ total: number }>(
    `
      SELECT COUNT(DISTINCT ar.event_id)::INT AS total
      FROM attendance_records ar
      WHERE ar.event_id IS NOT NULL
        AND ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} = LOWER(TRIM($1))
    `,
    [college ?? ""]
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

async function upsertZeroAttendanceRecord(input: ReturnType<typeof validateZeroAttendanceInput>, noOfAbsences: number) {
  const existing = await query<AttendanceRecord>(
    `
      SELECT *
      FROM attendance_records
      WHERE event_id IS NULL
        AND LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND remarks = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [input.studentId, ZERO_ATTENDANCE_REMARK]
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
            no_of_absences = $7,
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
        noOfAbsences
      ]
    );

    return result.rows[0];
  }

  const result = await query<AttendanceRecord>(
    `
      INSERT INTO attendance_records (
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
      VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6, $7, $8, NULL)
      RETURNING *
    `,
    [
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
        SET penalty_id = $2,
            student_id = $3,
            name = $4,
            no_of_absences = $5,
            prescribed_penalty = $6,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existing.rows[0].id,
        penalty?.id ?? null,
        attendanceRecord.student_id,
        attendanceRecord.name,
        noOfAbsences,
        prescribedPenalty
      ]
    );

    return result.rows[0];
  }

  const result = await query<FineRecord>(
    `
      INSERT INTO fines (
        attendance_record_id,
        penalty_id,
        student_id,
        name,
        no_of_absences,
        prescribed_penalty,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid')
      RETURNING *
    `,
    [
      attendanceRecord.id,
      penalty?.id ?? null,
      attendanceRecord.student_id,
      attendanceRecord.name,
      noOfAbsences,
      prescribedPenalty
    ]
  );

  return result.rows[0];
}

export async function registerZeroAttendanceFine(input: ZeroAttendanceFineInput) {
  const cleanInput = validateZeroAttendanceInput(input);
  const totalEvents = await getAttendanceEventCount(cleanInput.college);

  await upsertStudentRecord(cleanInput);

  const attendanceRecord = await upsertZeroAttendanceRecord(cleanInput, totalEvents);
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
        updated.*,
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