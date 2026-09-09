import "dotenv/config";

import { PoolClient } from "pg";

import { closeDatabasePool, pool } from "../../lib/db";
import { refreshDerivedAttendanceResultsForSchoolYearsWithClient } from "../../services/attendance.service";

const DEFAULT_STUDENT_ID = "TC-24-A-00407";

async function readStudentDiagnosticState(
  client: PoolClient,
  studentId: string,
) {
  const normalizedStudentId = studentId.trim().toLowerCase();

  const finalResults = await client.query(
    `
      SELECT id, school_year_id, import_id, total_absences, attendance_status,
             created_at, updated_at
        FROM attendance_final_results
       WHERE LOWER(TRIM(student_id)) = $1
       ORDER BY school_year_id NULLS FIRST, created_at, id
    `,
    [normalizedStudentId],
  );

  const penaltyResults = await client.query(
    `
      SELECT id, school_year_id, status, no_of_absences, source_table,
             source_record_id
        FROM penalty_results
       WHERE LOWER(TRIM(student_id)) = $1
       ORDER BY school_year_id NULLS FIRST, created_at, id
    `,
    [normalizedStudentId],
  );

  const attendanceRecords = await client.query(
    `
      SELECT ar.id, ar.import_id, ar.event_id, ar.school_year_id, ar.no_of_absences,
             ar.deleted_at, ai.deleted_at AS import_deleted_at
        FROM attendance_records ar
        LEFT JOIN attendance_imports ai ON ai.id = ar.import_id
       WHERE LOWER(TRIM(ar.student_id)) = $1
       ORDER BY ar.school_year_id NULLS FIRST, ar.created_at, ar.id
    `,
    [normalizedStudentId],
  );

  const manualAttendanceRecords = await client.query(
    `
      SELECT id, school_year_id, event_id, no_of_absences, attendance_type
        FROM manual_attendance_records
       WHERE LOWER(TRIM(student_id)) = $1
       ORDER BY school_year_id NULLS FIRST, created_at, id
    `,
    [normalizedStudentId],
  );

  return {
    finalResults: finalResults.rows,
    penaltyResults: penaltyResults.rows,
    attendanceRecords: attendanceRecords.rows,
    manualAttendanceRecords: manualAttendanceRecords.rows,
  };
}

async function run() {
  const studentId = String(process.argv[2] ?? DEFAULT_STUDENT_ID).trim();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint)",
    );

    const before = await readStudentDiagnosticState(client, studentId);
    console.log(
      JSON.stringify(
        {
          studentId,
          phase: "before-repair",
          ...before,
        },
        null,
        2,
      ),
    );

    await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client, [
      undefined,
    ]);

    const after = await readStudentDiagnosticState(client, studentId);
    console.log(
      JSON.stringify(
        {
          studentId,
          phase: "after-repair",
          ...after,
        },
        null,
        2,
      ),
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run()
  .then(closeDatabasePool)
  .catch(async (error) => {
    console.error(error);
    await closeDatabasePool();
    process.exit(1);
  });
