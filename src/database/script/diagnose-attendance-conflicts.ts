import { closeDatabasePool, query } from "../../lib/db";

const schoolYearId = String(process.argv[2] ?? "").trim() || null;

type DuplicateStudentRow = {
  normalized_student_id: string;
  row_count: number;
  student_ids: string[];
};

type SchoolYearDuplicateKeyRow = {
  school_year_id: string | null;
  normalized_student_id: string;
  row_count: number;
};

async function run() {
  const duplicateStudents = await query<DuplicateStudentRow>(
    `
      SELECT
        LOWER(TRIM(student_id)) AS normalized_student_id,
        COUNT(*)::INT AS row_count,
        ARRAY_AGG(student_id ORDER BY updated_at DESC, created_at DESC, id DESC) AS student_ids
      FROM students
      GROUP BY LOWER(TRIM(student_id))
      HAVING COUNT(*) > 1
      ORDER BY row_count DESC, normalized_student_id
    `,
  );

  const studentJoinFanoutKeys = await query<
    SchoolYearDuplicateKeyRow & { student_ids: string[] }
  >(
    `
      WITH relevant_student_keys AS (
        SELECT DISTINCT
          ar.school_year_id,
          LOWER(TRIM(ar.student_id)) AS normalized_student_id
        FROM attendance_records ar
        WHERE ar.deleted_at IS NULL
          AND NULLIF(TRIM(ar.student_id), '') IS NOT NULL
          AND ($1::uuid IS NULL OR ar.school_year_id = $1::uuid)

        UNION

        SELECT DISTINCT
          mar.school_year_id,
          LOWER(TRIM(mar.student_id)) AS normalized_student_id
        FROM manual_attendance_records mar
        WHERE NULLIF(TRIM(mar.student_id), '') IS NOT NULL
          AND ($1::uuid IS NULL OR mar.school_year_id = $1::uuid)
      )
      SELECT
        keys.school_year_id,
        keys.normalized_student_id,
        COUNT(student.id)::INT AS row_count,
        ARRAY_AGG(
          student.student_id
          ORDER BY student.updated_at DESC, student.created_at DESC, student.id DESC
        ) AS student_ids
      FROM relevant_student_keys keys
      JOIN students student
        ON LOWER(TRIM(student.student_id)) = keys.normalized_student_id
      GROUP BY keys.school_year_id, keys.normalized_student_id
      HAVING COUNT(student.id) > 1
      ORDER BY row_count DESC, keys.normalized_student_id
    `,
    [schoolYearId],
  );

  const duplicateFinalResults = await query<
    SchoolYearDuplicateKeyRow & {
      result_ids: string[];
      import_ids: Array<string | null>;
    }
  >(
    `
      SELECT
        afr.school_year_id,
        LOWER(TRIM(afr.student_id)) AS normalized_student_id,
        COUNT(*)::INT AS row_count,
        ARRAY_AGG(
          afr.id::TEXT
          ORDER BY
            afr.source_updated_at DESC NULLS LAST,
            afr.latest_scanned_at DESC NULLS LAST,
            afr.updated_at DESC,
            afr.created_at DESC,
            afr.id DESC
        ) AS result_ids,
        ARRAY_AGG(afr.import_id::TEXT ORDER BY afr.import_id::TEXT NULLS FIRST) AS import_ids
      FROM attendance_final_results afr
      WHERE ($1::uuid IS NULL OR afr.school_year_id = $1::uuid)
        AND (
          afr.import_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM attendance_imports visible_import
            WHERE visible_import.id = afr.import_id
              AND visible_import.deleted_at IS NULL
          )
        )
      GROUP BY afr.school_year_id, LOWER(TRIM(afr.student_id))
      HAVING COUNT(*) > 1
      ORDER BY row_count DESC, normalized_student_id
    `,
    [schoolYearId],
  );

  const duplicateDerivedFinalResults = await query<
    SchoolYearDuplicateKeyRow & { result_ids: string[] }
  >(
    `
      SELECT
        school_year_id,
        LOWER(TRIM(student_id)) AS normalized_student_id,
        COUNT(*)::INT AS row_count,
        ARRAY_AGG(
          id::TEXT
          ORDER BY
            source_updated_at DESC NULLS LAST,
            latest_scanned_at DESC NULLS LAST,
            updated_at DESC,
            created_at DESC,
            id DESC
        ) AS result_ids
      FROM attendance_final_results
      WHERE import_id IS NULL
        AND ($1::uuid IS NULL OR school_year_id = $1::uuid)
      GROUP BY school_year_id, LOWER(TRIM(student_id))
      HAVING COUNT(*) > 1
      ORDER BY row_count DESC, normalized_student_id
    `,
    [schoolYearId],
  );

  console.log(
    JSON.stringify(
      {
        schoolYearId,
        duplicateStudents: duplicateStudents.rows,
        studentJoinFanoutKeys: studentJoinFanoutKeys.rows,
        duplicateFinalResults: duplicateFinalResults.rows,
        duplicateDerivedFinalResults: duplicateDerivedFinalResults.rows,
      },
      null,
      2,
    ),
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
