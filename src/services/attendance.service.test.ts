import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  mergeAttendanceImportRowsByStudentAndEvent,
  previewAttendanceFileBase,
} from "./attendance.service";

const fixturePath = path.resolve(
  process.cwd(),
  "src/services/__fixtures__/attendance-import-reconciliation.xlsx",
);

test("attendance import reports invalid, merged, case-insensitive duplicate, and conflicting rows", async () => {
  const preview = await previewAttendanceFileBase({
    originalname: path.basename(fixturePath),
    mimetype:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: fs.readFileSync(fixturePath),
  });

  assert.equal(preview.rowsTotal, 8);
  assert.equal(preview.rowsValid, 7);
  assert.equal(preview.rowsInvalid, 1);

  const blankNameRow = preview.rows.find((row) => row.rowNumber === 6);
  assert.ok(blankNameRow);
  assert.deepEqual(blankNameRow.errors, ["Name is required."]);

  const validRows = preview.rows.filter((row) => row.errors.length === 0);
  const mergeResult = mergeAttendanceImportRowsByStudentAndEvent(validRows, {
    eventName: "Regression Event",
    fileName: path.basename(fixturePath),
    fileType: "xlsx",
    rows: validRows,
  });

  assert.equal(mergeResult.rows.length, 3);
  assert.equal(mergeResult.mergedRows.length, 2);
  assert.equal(mergeResult.conflictInvalidRows.length, 2);

  const exactDuplicate = mergeResult.mergedRows.find(
    (row) => row.studentId.toLowerCase() === "tc-001",
  );
  assert.deepEqual(exactDuplicate?.sourceRowNumbers, [2, 3]);

  const caseInsensitiveDuplicate = mergeResult.mergedRows.find(
    (row) => row.studentId.toLowerCase() === "tc-002",
  );
  assert.deepEqual(caseInsensitiveDuplicate?.sourceRowNumbers, [4, 5]);

  assert.deepEqual(
    mergeResult.conflictInvalidRows.map((row) => row.rowNumber),
    [8, 9],
  );
  assert.ok(
    mergeResult.conflictInvalidRows.every((row) =>
      row.errors.some((error) => error.includes("Conflicting names share Student ID")),
    ),
  );

  const mergedAwayRows = mergeResult.mergedRows.reduce(
    (total, row) => total + row.sourceRowNumbers.length - 1,
    0,
  );
  const reportedInvalidRows =
    preview.rowsInvalid + mergeResult.conflictInvalidRows.length;

  assert.equal(
    mergeResult.rows.length + mergedAwayRows + reportedInvalidRows,
    preview.rowsTotal,
  );
});
