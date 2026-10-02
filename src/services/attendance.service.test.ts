import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  normalizeYearLevelKey,
  previewAttendanceFileBase,
  type UploadedAttendanceFile,
} from "./attendance.service";

function uploadedFile(
  originalname: string,
  buffer: Buffer,
): UploadedAttendanceFile {
  return {
    originalname,
    mimetype: originalname.toLowerCase().endsWith(".csv")
      ? "text/csv"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
    size: buffer.length,
  };
}

function utf8Csv(name: string) {
  return Buffer.from(`Student ID,Name\nTC-001,${name}\n`, "utf8");
}

test("parses UTF-8 CSV without a BOM", async () => {
  const preview = await previewAttendanceFileBase(
    uploadedFile("attendance.csv", utf8Csv("Boñito")),
  );

  assert.equal(preview.rows[0]?.name, "Boñito");
});

test("parses UTF-8 CSV with a BOM", async () => {
  const buffer = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    utf8Csv("Boñito"),
  ]);
  const preview = await previewAttendanceFileBase(
    uploadedFile("attendance.csv", buffer),
  );

  assert.equal(preview.rows[0]?.name, "Boñito");
});

test("falls back to Windows-1252 for legacy CSV files", async () => {
  const buffer = Buffer.from("Student ID,Name\nTC-001,Boñito\n", "latin1");
  const preview = await previewAttendanceFileBase(
    uploadedFile("attendance.csv", buffer),
  );

  assert.equal(preview.rows[0]?.name, "Boñito");
});

test("scanner export rows keep decoded UTF-8 names", async () => {
  const payload = [
    "Name: Boñito",
    "Student ID: TC-001",
    "Year Level: 1st Year",
    "College: College of Computing Studies",
    "Program: BS Information Systems",
    "Institution: Jose Rizal Memorial State University - Tampilisan Campus",
  ].join("\n");
  const escapedPayload = payload.replace(/"/g, '""');
  const csv = [
    "Barcode,Format,Scan Date,Type",
    `"${escapedPayload}",QR_CODE,1788221485778,TEXT`,
  ].join("\n");

  const preview = await previewAttendanceFileBase(
    uploadedFile("scanner-export.csv", Buffer.from(csv, "utf8")),
  );

  assert.equal(preview.rows[0]?.name, "Boñito");
  assert.equal(preview.rows[0]?.studentId, "TC-001");
});

test("engineering FRC CSV previews ñ names correctly", async () => {
  const filePath = path.join(
    __dirname,
    "..",
    "database",
    "seeder",
    "data",
    "engineering-frc",
    "FRC__August_24_2026_.csv",
  );
  const preview = await previewAttendanceFileBase(
    uploadedFile(path.basename(filePath), fs.readFileSync(filePath)),
  );
  const names = new Set(preview.rows.map((row) => row.name));

  assert.ok(names.has("Curt Jehiel A. Nuñal"));
  assert.ok(names.has("Sharah Marie Geñoso"));
  assert.ok(names.has("Richen Villanueva Soriño"));
});

test("xlsx parsing keeps the existing buffer path", async () => {
  const worksheet = XLSX.utils.json_to_sheet([
    { "Student ID": "TC-001", Name: "Boñito" },
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const preview = await previewAttendanceFileBase(
    uploadedFile("attendance.xlsx", buffer),
  );

  assert.equal(preview.rows[0]?.name, "Boñito");
});


test("normalizes supported year level variants", () => {
  const variants: Array<[string, string]> = [
    ["1st Year", "1"], ["First Year", "1"], ["1", "1"], ["Year 1", "1"], ["1st yr", "1"], ["I", "1"],
    ["2nd Year", "2"], ["Second Year", "2"], ["2", "2"], ["Year 2", "2"], ["2nd yr", "2"], ["II", "2"],
    ["3rd Year", "3"], ["Third Year", "3"], ["3", "3"], ["Year 3", "3"], ["3rd yr", "3"], ["III", "3"],
    ["4th Year", "4"], ["Fourth Year", "4"], ["4", "4"], ["Year 4", "4"], ["4th yr", "4"], ["IV", "4"],
    ["5th Year", "5"], ["Fifth Year", "5"], ["5", "5"], ["Year 5", "5"], ["5th yr", "5"], ["V", "5"],
  ];

  for (const [value, expected] of variants) {
    assert.equal(normalizeYearLevelKey(value), expected, value);
    assert.equal(normalizeYearLevelKey(`  ${value.toUpperCase()}  `), expected, `case/spacing: ${value}`);
  }

  assert.equal(normalizeYearLevelKey("6th Year"), null);
  assert.equal(normalizeYearLevelKey("Graduate"), null);
  assert.equal(normalizeYearLevelKey(""), null);
  assert.equal(normalizeYearLevelKey(null), null);
});
