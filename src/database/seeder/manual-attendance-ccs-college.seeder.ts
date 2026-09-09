import "dotenv/config";

import { closeDatabasePool, query, withTransaction } from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";

const CANONICAL_COLLEGE = "College of Computing Studies";

export type SeedManualAttendanceCcsCollegeResult = {
  alreadySeeded: boolean;
  manualAttendanceRecordsUpdated: number;
  studentsUpdated: number;
  explicitOtherCollegeRowsSkipped: number;
  refreshedSchoolYears: number;
};

type CandidateSummary = {
  school_year_id: string | null;
};

type CountRow = {
  count: number;
};

function repairableCollegeSql(column: string) {
  return `
    LOWER(TRIM(COALESCE(${column}, ''))) !~ '^college[[:space:]]+of([[:space:]]|$)'
    AND (
      NULLIF(TRIM(${column}), '') IS NULL
      OR REGEXP_REPLACE(
        LOWER(TRIM(COALESCE(${column}, ''))),
        '[^a-z0-9]+',
        '',
        'g'
      ) = ANY(
        ARRAY[
          'ccs',
          'computingstudies',
          'collegecomputingstudies',
          'collegeofcomputingstudies',
          'computingstudiescollege'
        ]::text[]
      )
      OR LOWER(TRIM(COALESCE(${column}, ''))) ~
        '^c[[:space:]._-]*c[[:space:]._-]*s([[:space:]/_-]+.*)?$'
    )
  `;
}

function explicitOtherCollegeSql(column: string) {
  return `
    LOWER(TRIM(COALESCE(${column}, ''))) ~ '^college[[:space:]]+of([[:space:]]|$)'
    AND LOWER(TRIM(${column})) <> LOWER(TRIM($1))
  `;
}

export async function seedManualAttendanceCcsCollege(
  onProgress?: (message: string) => void,
): Promise<SeedManualAttendanceCcsCollegeResult> {
  onProgress?.(
    "Finding manual attendance with missing or CCS-style college values while preserving explicit College of … assignments",
  );

  const result = await withTransaction(async (client) => {
    const candidateResult = await client.query<CandidateSummary>(
      `
        SELECT DISTINCT mar.school_year_id
        FROM manual_attendance_records mar
        LEFT JOIN students s
          ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
        WHERE ${repairableCollegeSql("mar.college")}
          AND NOT (${explicitOtherCollegeSql("s.college")})
      `,
      [CANONICAL_COLLEGE],
    );

    const skippedResult = await client.query<CountRow>(
      `
        SELECT COUNT(*)::INT AS count
        FROM manual_attendance_records mar
        LEFT JOIN students s
          ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
        WHERE ${repairableCollegeSql("mar.college")}
          AND (${explicitOtherCollegeSql("s.college")})
      `,
      [CANONICAL_COLLEGE],
    );

    onProgress?.(
      "Normalizing eligible manual-attendance and student college values to College of Computing Studies",
    );

    const studentsResult = await client.query(
      `
        WITH candidate_students AS (
          SELECT DISTINCT LOWER(TRIM(mar.student_id)) AS student_key
          FROM manual_attendance_records mar
          LEFT JOIN students current_student
            ON LOWER(TRIM(current_student.student_id)) = LOWER(TRIM(mar.student_id))
          WHERE ${repairableCollegeSql("mar.college")}
            AND NOT (${explicitOtherCollegeSql("current_student.college")})
        )
        UPDATE students s
        SET college = $1,
            updated_at = NOW()
        FROM candidate_students candidate
        WHERE LOWER(TRIM(s.student_id)) = candidate.student_key
          AND ${repairableCollegeSql("s.college")}
      `,
      [CANONICAL_COLLEGE],
    );

    const manualResult = await client.query(
      `
        UPDATE manual_attendance_records mar
        SET college = $1,
            updated_at = NOW()
        WHERE ${repairableCollegeSql("mar.college")}
          AND NOT EXISTS (
            SELECT 1
            FROM students s
            WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
              AND (${explicitOtherCollegeSql("s.college")})
          )
      `,
      [CANONICAL_COLLEGE],
    );

    return {
      affectedSchoolYears: candidateResult.rows.map((row) => row.school_year_id),
      explicitOtherCollegeRowsSkipped: Number(skippedResult.rows[0]?.count ?? 0),
      studentsUpdated: studentsResult.rowCount ?? 0,
      manualAttendanceRecordsUpdated: manualResult.rowCount ?? 0,
    };
  });

  const changed =
    result.manualAttendanceRecordsUpdated > 0 || result.studentsUpdated > 0;

  let refreshedSchoolYears = 0;
  if (changed) {
    const uniqueSchoolYearIds = Array.from(
      new Set(result.affectedSchoolYears.filter((value): value is string => Boolean(value))),
    );
    const hasUnscopedRows = result.affectedSchoolYears.some((value) => !value);

    if (hasUnscopedRows) {
      onProgress?.(
        "Refreshing derived final attendance and penalty results for all school years because an updated manual row has no school-year ID",
      );
      await refreshAttendanceFinalResults();
      refreshedSchoolYears = 1;
    } else {
      for (const [index, schoolYearId] of uniqueSchoolYearIds.entries()) {
        onProgress?.(
          `Refreshing derived final attendance and penalty results for affected school year ${index + 1}/${uniqueSchoolYearIds.length}`,
        );
        await refreshAttendanceFinalResults({ schoolYearId });
      }
      refreshedSchoolYears = uniqueSchoolYearIds.length;
    }
  }

  return {
    alreadySeeded: !changed,
    manualAttendanceRecordsUpdated: result.manualAttendanceRecordsUpdated,
    studentsUpdated: result.studentsUpdated,
    explicitOtherCollegeRowsSkipped: result.explicitOtherCollegeRowsSkipped,
    refreshedSchoolYears,
  };
}

if (require.main === module) {
  seedManualAttendanceCcsCollege()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "Manual attendance CCS college values are already normalized."
          : `Normalized ${result.manualAttendanceRecordsUpdated} manual attendance record(s) and ${result.studentsUpdated} student record(s).`,
      );
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("Manual attendance CCS college seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
