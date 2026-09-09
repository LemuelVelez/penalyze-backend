function assertSqlAlias(alias: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }

  return alias;
}

export function getAttendanceFinalResultVisibilitySql(alias = "afr") {
  const finalResultAlias = assertSqlAlias(alias);

  return `(
    ${finalResultAlias}.id IS NOT NULL
    AND (
      ${finalResultAlias}.import_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM attendance_imports visible_import
        WHERE visible_import.id = ${finalResultAlias}.import_id
          AND visible_import.deleted_at IS NULL
      )
    )
  )`;
}

export function getAttendanceRecordVisibilitySql(alias = "ar") {
  const attendanceRecordAlias = assertSqlAlias(alias);

  return `(
    ${attendanceRecordAlias}.deleted_at IS NULL
    AND (
      ${attendanceRecordAlias}.import_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM attendance_imports visible_record_import
        WHERE visible_record_import.id = ${attendanceRecordAlias}.import_id
          AND visible_record_import.deleted_at IS NULL
      )
    )
  )`;
}
