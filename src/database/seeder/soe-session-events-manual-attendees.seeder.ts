import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import { closeDatabasePool, withTransaction } from "../../lib/db";
import {
  normalizeCollegeKey,
  refreshAttendanceFinalResults,
} from "../../services/attendance.service";
import { normalizeAttendanceEventIdentityName } from "../../services/attendance-event-identity";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const PLACEHOLDER_STUDENT_ID = "TC-20-A-00000";
const DEFAULT_COLLEGE = "School of Engineering";
const DEFAULT_PROGRAM = "Agricultural Biosystems Engineering";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SOE_COLLEGE_KEY = normalizeCollegeKey(DEFAULT_COLLEGE) ??
  "school of engineering";
const FORBIDDEN_SEEDED_EVENT_DESCRIPTION_PREFIX =
  "Seeded manual attendance event for the";
const SHARED_EVENT_EXEMPTION_REASON =
  "School of Engineering uses separate session attendance events for August 17 and August 27, 2026.";

const DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "engineering-events",
);

const ENV_FIXTURE_DIRECTORY = String(
  process.env.SOE_SESSION_EVENTS_FIXTURES_PATH ?? "",
).trim();

type SessionDirection = "log-in" | "log-out";

type FixtureDefinition = {
  fileName: string;
  eventDate: string;
  eventDateLabel: string;
  eventName: string;
  direction: SessionDirection;
  remarks: string;
  description: string;
};

const FIXTURES = [
  {
    fileName: "Opening_Program__August_17__2026_.csv",
    eventDate: "2026-08-17",
    eventDateLabel: "August 17, 2026",
    eventName: "School of Engineering Opening Program Log In",
    direction: "log-in",
    remarks:
      "Seeded as manual attendance from the August 17, 2026 School of Engineering Opening Program Log In sheet.",
    description:
      "School of Engineering session attendance imported from the August 17, 2026 Opening Program Log In sheet.",
  },
  {
    fileName: "Opening_Program__out__August_17__2026.csv",
    eventDate: "2026-08-17",
    eventDateLabel: "August 17, 2026",
    eventName: "School of Engineering Opening Program Log Out",
    direction: "log-out",
    remarks:
      "Seeded as manual attendance from the August 17, 2026 School of Engineering Opening Program Log Out sheet.",
    description:
      "School of Engineering session attendance imported from the August 17, 2026 Opening Program Log Out sheet.",
  },
  {
    fileName: "Buwan_ng_Wika__Log_in_August_27_2026_.csv",
    eventDate: "2026-08-27",
    eventDateLabel: "August 27, 2026",
    eventName: "School of Engineering Buwan ng Wika Morning Log In",
    direction: "log-in",
    remarks:
      "Seeded as manual attendance from the August 27, 2026 School of Engineering Buwan ng Wika Morning Log In sheet.",
    description:
      "School of Engineering session attendance imported from the August 27, 2026 Buwan ng Wika Morning Log In sheet.",
  },
  {
    fileName: "Buwan_ng_Wika__Out_.csv",
    eventDate: "2026-08-27",
    eventDateLabel: "August 27, 2026",
    eventName: "School of Engineering Buwan ng Wika Morning Log Out",
    direction: "log-out",
    remarks:
      "Seeded as manual attendance from the August 27, 2026 School of Engineering Buwan ng Wika Morning Log Out sheet.",
    description:
      "School of Engineering session attendance imported from the August 27, 2026 Buwan ng Wika Morning Log Out sheet.",
  },
  {
    fileName: "Buwan_ng_Wika_afternoon_in_.csv",
    eventDate: "2026-08-27",
    eventDateLabel: "August 27, 2026",
    eventName: "School of Engineering Buwan ng Wika Afternoon Log In",
    direction: "log-in",
    remarks:
      "Seeded as manual attendance from the August 27, 2026 School of Engineering Buwan ng Wika Afternoon Log In sheet.",
    description:
      "School of Engineering session attendance imported from the August 27, 2026 Buwan ng Wika Afternoon Log In sheet.",
  },
  {
    fileName: "Buwan_ng_Wika__Out__1.csv",
    eventDate: "2026-08-27",
    eventDateLabel: "August 27, 2026",
    eventName: "School of Engineering Buwan ng Wika Afternoon Log Out",
    direction: "log-out",
    remarks:
      "Seeded as manual attendance from the August 27, 2026 School of Engineering Buwan ng Wika Afternoon Log Out sheet.",
    description:
      "School of Engineering session attendance imported from the August 27, 2026 Buwan ng Wika Afternoon Log Out sheet.",
  },
] as const satisfies readonly FixtureDefinition[];

const LEGACY_BUWAN_ATTENDANCE_REMARK =
  "Seeded as manual attendance from the August 27, 2026 SOE Buwan ng Wika attendance sheet.";
const LEGACY_BUWAN_WALK_IN_REMARK =
  "Seeded as manual attendance from the August 27, 2026 SOE Buwan ng Wika walk-in attendee list.";
const LEGACY_BUWAN_EVENT_NAME = "Buwan ng Wika August 27";
const LEGACY_BUWAN_EVENT_DATE = "2026-08-27";

export const SOE_SESSION_EVENT_MANUAL_ATTENDANCE_REMARKS = FIXTURES.map(
  (fixture) => fixture.remarks,
);

export const SOE_SESSION_EVENT_SEED_MARKERS = FIXTURES.map((fixture) => ({
  eventName: fixture.eventName,
  eventDate: fixture.eventDate,
  remarks: fixture.remarks,
}));

type ScannerPayload = {
  studentId: string;
  name: string;
  nameCandidates: string[];
  yearLevel: string;
  institution: string;
};

type ManualAttendee = {
  studentId: string;
  name: string;
  nameCandidates: string[];
  yearLevel: string;
  college: string;
  program: string;
  institution: string;
  scannedAt: string;
  eventDate: string;
  eventDateLabel: string;
  sourceFile: string;
  sourceRowNumber: number;
  eventName: string;
  eventDescription: string;
  remarks: string;
  direction: SessionDirection;
};

type StudentLookup = {
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
};

type TargetEvent = {
  id: string;
  school_year_id: string;
  name: string;
  event_date: string | null;
  event_start_at: string | null;
  event_end_at: string | null;
  description: string | null;
};

type ParsedFixture = {
  fixture: (typeof FIXTURES)[number];
  rows: ManualAttendee[];
  skippedJunkRows: number;
  skippedStrayRows: number;
  skippedInvalidRows: number;
  warnings: string[];
};

type SharedEventExemption = {
  eventId: string;
  eventName: string;
  eventDate: string;
  exemptionCreated: boolean;
};

export type SeedSoeSessionEventsManualAttendeesResult = {
  alreadySeeded: boolean;
  skipped: boolean;
  missingFixtureFiles: string[];
  rowsParsed: number;
  manualAttendanceRecordsCreated: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventOrdersRenumbered: number;
  legacyRowsDeleted: number;
  legacyEventDeleted: boolean;
  skippedStrayRows: number;
  skippedJunkRows: number;
  skippedInvalidRows: number;
  unresolvedAttendees: string[];
  warnings: string[];
  exemptionsCreated: number;
  sharedEventExemptions: SharedEventExemption[];
  eventSummaries: Array<{
    eventName: string;
    eventDate: string;
    rowsParsed: number;
    inserted: number;
    stray: number;
    junk: number;
    invalid: number;
    unresolved: number;
  }>;
  eventAttendeeCounts: Array<{
    eventName: string;
    eventDate: string;
    attendeeCount: number;
  }>;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function collapseWhitespace(value: unknown) {
  return clean(value).replace(/\s+/g, " ");
}

function normalizeStudentId(value: unknown) {
  return clean(value).toUpperCase();
}

function normalizeName(value: unknown) {
  return collapseWhitespace(value).toLowerCase();
}

function normalizeDisplayName(value: unknown) {
  return collapseWhitespace(value);
}

function normalizeYearLevel(value: unknown) {
  const normalized = collapseWhitespace(value);
  const match = normalized.match(/^([1-5])(st|nd|rd|th)\s+year$/i);
  if (!match) return normalized;

  const ordinalSuffix: Record<string, string> = {
    "1": "st",
    "2": "nd",
    "3": "rd",
    "4": "th",
    "5": "th",
  };

  return `${match[1]}${ordinalSuffix[match[1]]} Year`;
}

function getFixtureDirectories() {
  const candidates = [
    ENV_FIXTURE_DIRECTORY,
    DATA_DIRECTORY,
    path.join(
      process.cwd(),
      "src",
      "database",
      "seeder",
      "data",
      "engineering-events",
    ),
    path.join(process.cwd(), "data", "engineering-events"),
  ].filter(Boolean);

  return Array.from(
    new Set(candidates.map((directory) => path.resolve(directory))),
  );
}

function findFixturePath(fileName: string) {
  for (const directory of getFixtureDirectories()) {
    const candidate = path.join(directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getMissingFixtureFiles() {
  return FIXTURES.map((fixture) => fixture.fileName).filter(
    (fileName) => !findFixturePath(fileName),
  );
}

function assertDistinctEventIdentities() {
  const seen = new Map<string, string>();

  FIXTURES.forEach((fixture) => {
    if (fixture.description.startsWith(FORBIDDEN_SEEDED_EVENT_DESCRIPTION_PREFIX)) {
      throw new Error(
        `SOE session event description must not start with "${FORBIDDEN_SEEDED_EVENT_DESCRIPTION_PREFIX}": ${fixture.eventName}.`,
      );
    }

    const identity = normalizeAttendanceEventIdentityName(fixture.eventName);
    const existing = seen.get(identity);
    if (existing) {
      throw new Error(
        `SOE session event names are not distinct after normalization: "${existing}" and "${fixture.eventName}" both normalize to "${identity}".`,
      );
    }
    seen.set(identity, fixture.eventName);
  });
}

function isJunkPayload(payload: string) {
  const normalized = clean(payload);
  return /^-?\d+$/.test(normalized) || /^[A-Za-z]$/.test(normalized);
}

function buildNameCandidates(value: unknown) {
  const name = normalizeDisplayName(value);
  if (!name) return [];

  const candidates = [name];
  const commaMatch = name.match(/^([^,]+),\s*(.+)$/);
  if (commaMatch) {
    candidates.push(
      normalizeDisplayName(`${commaMatch[2]} ${commaMatch[1]}`),
    );
  }

  const unique = new Map<string, string>();
  candidates.forEach((candidate) => {
    const key = normalizeName(candidate);
    if (key && !unique.has(key)) unique.set(key, candidate);
  });
  return Array.from(unique.values());
}

function parseLabelPayload(payload: string): ScannerPayload | null {
  const fields = new Map<string, string>();

  payload
    .replace(/\r/g, "")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
      if (!match) return;
      fields.set(match[1].trim().toLowerCase(), clean(match[2]));
    });

  if (!fields.has("name") || !fields.has("student id")) return null;

  const name = normalizeDisplayName(fields.get("name"));
  if (!name) return null;

  return {
    studentId: normalizeStudentId(fields.get("student id")),
    name,
    nameCandidates: buildNameCandidates(name),
    yearLevel: normalizeYearLevel(fields.get("year level")),
    institution: clean(fields.get("institution")) || DEFAULT_INSTITUTION,
  };
}

function parseJsonPayload(payload: string): ScannerPayload | null {
  if (!payload.trimStart().startsWith("{")) return null;

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const name = normalizeDisplayName(parsed.name);
    if (!name) return null;

    return {
      studentId: normalizeStudentId(parsed.studentId),
      name,
      nameCandidates: buildNameCandidates(name),
      yearLevel: normalizeYearLevel(parsed.yearLevel),
      institution: DEFAULT_INSTITUTION,
    };
  } catch {
    return null;
  }
}

function parsePipeNamePayload(payload: string): ScannerPayload | null {
  if (!payload.includes("|") || /\bTC-[A-Z0-9-]+\b/i.test(payload)) return null;

  const namePart = clean(payload.split("|", 1)[0]);
  if (!namePart) return null;

  const candidates = buildNameCandidates(namePart);
  if (!candidates.length || namePart.replace(/,/g, " ").split(/\s+/).length < 2) {
    return null;
  }

  return {
    studentId: "",
    name: candidates[0],
    nameCandidates: candidates,
    yearLevel: "",
    institution: DEFAULT_INSTITUTION,
  };
}

function parseNameWithTrailingId(payload: string): ScannerPayload | null {
  const singleLine = payload.replace(/\r?\n/g, " ").trim();
  const match = singleLine.match(
    /^\s*(?:Name\s*:\s*)?(.+?)\s+(TC-[A-Z0-9-]+)\s*$/i,
  );
  if (!match) return null;

  const name = normalizeDisplayName(match[1]);
  if (!name) return null;

  return {
    studentId: normalizeStudentId(match[2]),
    name,
    nameCandidates: buildNameCandidates(name),
    yearLevel: "",
    institution: DEFAULT_INSTITUTION,
  };
}

function parseDelimitedPayload(payload: string): ScannerPayload | null {
  const lineParts = payload
    .replace(/\r/g, "")
    .split(/\n|\|/)
    .map((part) => clean(part))
    .filter(Boolean);

  const exactIdIndex = lineParts.findIndex((part) =>
    /^TC-[A-Z0-9-]+$/i.test(part),
  );

  if (exactIdIndex >= 0) {
    const studentId = normalizeStudentId(lineParts[exactIdIndex]);
    const nameCandidate =
      exactIdIndex === 0 ? lineParts[1] : lineParts.slice(0, exactIdIndex).join(" ");
    const name = normalizeDisplayName(
      clean(nameCandidate).replace(/^Name\s*:\s*/i, ""),
    );
    if (!name) return null;

    return {
      studentId,
      name,
      nameCandidates: buildNameCandidates(name),
      yearLevel: "",
      institution: DEFAULT_INSTITUTION,
    };
  }

  const commaParts = payload
    .replace(/\r?\n/g, " ")
    .split(",")
    .map((part) => clean(part));
  const commaIdIndex = commaParts.findIndex((part) =>
    /^TC-[A-Z0-9-]+$/i.test(part),
  );

  if (commaIdIndex > 0) {
    const name = normalizeDisplayName(
      commaParts.slice(0, commaIdIndex).join(", "),
    );
    if (!name) return null;

    return {
      studentId: normalizeStudentId(commaParts[commaIdIndex]),
      name,
      nameCandidates: buildNameCandidates(name),
      yearLevel: "",
      institution: DEFAULT_INSTITUTION,
    };
  }

  return null;
}

function parseNameOnlyPayload(payload: string): ScannerPayload | null {
  if (/\bTC-[A-Z0-9-]+\b/i.test(payload)) return null;

  const firstLine = payload
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line))
    .find(Boolean);
  if (!firstLine) return null;

  const name = normalizeDisplayName(firstLine.replace(/^Name\s*:\s*/i, ""));
  if (name.replace(/,/g, " ").split(/\s+/).length < 2) return null;

  return {
    studentId: "",
    name,
    nameCandidates: buildNameCandidates(name),
    yearLevel: "",
    institution: DEFAULT_INSTITUTION,
  };
}

function parseScannerPayload(payload: string): ScannerPayload | null {
  return (
    parseJsonPayload(payload) ??
    parseLabelPayload(payload) ??
    parsePipeNamePayload(payload) ??
    parseDelimitedPayload(payload) ??
    parseNameWithTrailingId(payload) ??
    parseNameOnlyPayload(payload)
  );
}

function parseCsvRows(contents: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    pushField();
    if (row.some((value) => clean(value))) rows.push(row);
    row = [];
  };

  for (let index = 0; index < contents.length; index += 1) {
    const char = contents[index];

    if (quoted) {
      if (char === '"') {
        if (contents[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) pushRow();
  return rows;
}

function parseFixtureDate(value: unknown) {
  const text = clean(value);
  const match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeParts(value: unknown) {
  const text = clean(value);
  if (!text) return null;

  const match = text.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?$/i,
  );
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const milliseconds = Number((match[4] ?? "0").padEnd(3, "0"));
  const meridiem = clean(match[5]).toUpperCase();

  if (
    minutes > 59 ||
    seconds > 59 ||
    (!meridiem && hours > 23) ||
    (meridiem && (hours < 1 || hours > 12))
  ) {
    return null;
  }

  if (meridiem === "AM" && hours === 12) hours = 0;
  if (meridiem === "PM" && hours !== 12) hours += 12;

  return { hours, minutes, seconds, milliseconds };
}

function combineManilaEventDateAndTime(eventDate: string, value: unknown) {
  const time = parseTimeParts(value);
  if (!time) return null;

  const dateMatch = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const utcMilliseconds =
    Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      time.hours,
      time.minutes,
      time.seconds,
      time.milliseconds,
    ) - MANILA_OFFSET_MS;

  const timestamp = new Date(utcMilliseconds);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

type TimestampColumnIndexes = {
  checkInDate: number;
  checkInTime: number;
  checkOutDate: number;
  checkOutTime: number;
};

function selectTimestampValues(
  values: string[],
  indexes: TimestampColumnIndexes,
  direction: SessionDirection,
) {
  const primary =
    direction === "log-in"
      ? {
          date: clean(values[indexes.checkInDate]),
          time: clean(values[indexes.checkInTime]),
          label: "CHECK-IN",
        }
      : {
          date: clean(values[indexes.checkOutDate]),
          time: clean(values[indexes.checkOutTime]),
          label: "CHECK-OUT",
        };
  const fallback =
    direction === "log-in"
      ? {
          date: clean(values[indexes.checkOutDate]),
          time: clean(values[indexes.checkOutTime]),
          label: "CHECK-OUT",
        }
      : {
          date: clean(values[indexes.checkInDate]),
          time: clean(values[indexes.checkInTime]),
          label: "CHECK-IN",
        };

  if (primary.date && primary.time) return primary;
  if (fallback.date && fallback.time) return fallback;
  if (primary.date || primary.time) return primary;
  return fallback;
}

function parseFixture(fixture: (typeof FIXTURES)[number]): ParsedFixture {
  const fixturePath = findFixturePath(fixture.fileName);
  if (!fixturePath) {
    throw new Error(`Missing SOE session fixture: ${fixture.fileName}`);
  }

  const contents = fs
    .readFileSync(fixturePath, "utf8")
    .replace(/^\uFEFF/, "");
  const csvRows = parseCsvRows(contents);
  const rawHeader = csvRows[0] ?? [];
  const header = rawHeader.map((value) => collapseWhitespace(value).toUpperCase());

  const nameColumnIndex = header.indexOf("NAME");
  const indexes: TimestampColumnIndexes = {
    checkInDate: header.indexOf("CHECK-IN DATE"),
    checkInTime: header.indexOf("CHECK-IN TIME"),
    checkOutDate: header.indexOf("CHECK-OUT DATE"),
    checkOutTime: header.indexOf("CHECK-OUT TIME"),
  };
  const requiredColumns = [
    "NAME",
    "CHECK-IN DATE",
    "CHECK-IN TIME",
    "CHECK-OUT DATE",
    "CHECK-OUT TIME",
  ];
  const missingColumns = requiredColumns.filter((column) => !header.includes(column));

  if (missingColumns.length > 0 || nameColumnIndex < 0) {
    throw new Error(
      `SOE session fixture ${fixture.fileName} is missing required CSV column(s): ${missingColumns.join(", ")}.`,
    );
  }

  const rows: ManualAttendee[] = [];
  const warnings: string[] = [];
  let skippedJunkRows = 0;
  let skippedStrayRows = 0;
  let skippedInvalidRows = 0;

  csvRows.slice(1).forEach((values, index) => {
    const sourceRowNumber = index + 2;
    const normalizedValues = [...values];
    while (normalizedValues.length < header.length) normalizedValues.push("");

    if (normalizedValues.length > header.length) {
      warnings.push(
        `Skipped ${fixture.fileName} row ${sourceRowNumber}: CSV column count did not match the header.`,
      );
      skippedInvalidRows += 1;
      return;
    }

    const payload = clean(normalizedValues[nameColumnIndex]);
    if (!payload) return;

    if (isJunkPayload(payload)) {
      skippedJunkRows += 1;
      return;
    }

    const parsedPayload = parseScannerPayload(payload);
    if (!parsedPayload) {
      warnings.push(
        `Skipped ${fixture.fileName} row ${sourceRowNumber}: attendee payload could not be parsed (${collapseWhitespace(payload)}).`,
      );
      skippedInvalidRows += 1;
      return;
    }

    const timestampValues = selectTimestampValues(
      normalizedValues,
      indexes,
      fixture.direction,
    );
    const parsedDate = parseFixtureDate(timestampValues.date);

    if (parsedDate && parsedDate !== fixture.eventDate) {
      warnings.push(
        `Skipped stray date in ${fixture.fileName} row ${sourceRowNumber}: ${parsedPayload.name} has ${timestampValues.date} ${timestampValues.time} (${timestampValues.label}), expected ${fixture.eventDate}.`,
      );
      skippedStrayRows += 1;
      return;
    }

    if (!parsedDate) {
      warnings.push(
        `Skipped ${fixture.fileName} row ${sourceRowNumber}: invalid or missing ${timestampValues.label} date for ${parsedPayload.name}.`,
      );
      skippedInvalidRows += 1;
      return;
    }

    const scannedAt = combineManilaEventDateAndTime(
      parsedDate,
      timestampValues.time,
    );
    if (!scannedAt) {
      warnings.push(
        `Skipped ${fixture.fileName} row ${sourceRowNumber}: invalid or missing ${timestampValues.label} time for ${parsedPayload.name}.`,
      );
      skippedInvalidRows += 1;
      return;
    }

    rows.push({
      studentId: normalizeStudentId(parsedPayload.studentId),
      name: normalizeDisplayName(parsedPayload.name),
      nameCandidates: parsedPayload.nameCandidates,
      yearLevel: normalizeYearLevel(parsedPayload.yearLevel),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: clean(parsedPayload.institution) || DEFAULT_INSTITUTION,
      scannedAt,
      eventDate: fixture.eventDate,
      eventDateLabel: fixture.eventDateLabel,
      sourceFile: fixture.fileName,
      sourceRowNumber,
      eventName: fixture.eventName,
      eventDescription: fixture.description,
      remarks: fixture.remarks,
      direction: fixture.direction,
    });
  });

  return {
    fixture,
    rows,
    skippedJunkRows,
    skippedStrayRows,
    skippedInvalidRows,
    warnings,
  };
}

function getEventBounds(rows: ManualAttendee[]) {
  const timestamps = rows
    .map((row) => new Date(row.scannedAt))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  if (!timestamps.length) {
    throw new Error("Cannot create an SOE session event without a valid scan timestamp.");
  }

  return {
    startAt: timestamps[0].toISOString(),
    endAt: timestamps[timestamps.length - 1].toISOString(),
  };
}

async function getTargetSchoolYearId(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM school_years
      WHERE name = $1
        AND semester = $2
      LIMIT 1
    `,
    [TARGET_SCHOOL_YEAR, TARGET_SEMESTER],
  );

  const schoolYearId = result.rows[0]?.id;
  if (!schoolYearId) {
    throw new Error(
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding SOE session attendance.`,
    );
  }

  return schoolYearId;
}

async function getOrCreateTargetEvent(
  client: PoolClient,
  schoolYearId: string,
  fixture: (typeof FIXTURES)[number],
  rows: ManualAttendee[],
) {
  const bounds = getEventBounds(rows);
  const existing = await client.query<TargetEvent>(
    `
      SELECT
        id,
        school_year_id,
        name,
        event_date::text,
        event_start_at::text,
        event_end_at::text,
        description
      FROM attendance_events
      WHERE school_year_id = $1
        AND COALESCE(
          event_date,
          timezone('Asia/Manila', event_start_at)::date,
          timezone('Asia/Manila', event_end_at)::date
        ) = $2::date
      ORDER BY created_at ASC, id ASC
    `,
    [schoolYearId, fixture.eventDate],
  );

  const targetIdentity = normalizeAttendanceEventIdentityName(fixture.eventName);
  const namedMatch = existing.rows.find(
    (event) =>
      normalizeAttendanceEventIdentityName(event.name) === targetIdentity,
  );

  if (namedMatch) {
    const updated = await client.query<TargetEvent>(
      `
        UPDATE attendance_events
        SET name = $2,
            event_date = $3::date,
            event_start_at = $4::timestamptz,
            event_end_at = $5::timestamptz,
            description = $6,
            updated_at = NOW()
        WHERE id = $1
          AND (
            name IS DISTINCT FROM $2
            OR event_date IS DISTINCT FROM $3::date
            OR event_start_at IS DISTINCT FROM $4::timestamptz
            OR event_end_at IS DISTINCT FROM $5::timestamptz
            OR description IS DISTINCT FROM $6
          )
        RETURNING
          id,
          school_year_id,
          name,
          event_date::text,
          event_start_at::text,
          event_end_at::text,
          description
      `,
      [
        namedMatch.id,
        fixture.eventName,
        fixture.eventDate,
        bounds.startAt,
        bounds.endAt,
        fixture.description,
      ],
    );

    return {
      event: updated.rows[0] ?? namedMatch,
      created: false,
      updated: Boolean(updated.rowCount),
    };
  }

  const created = await client.query<TargetEvent>(
    `
      INSERT INTO attendance_events (
        school_year_id,
        name,
        event_date,
        event_start_at,
        event_end_at,
        description,
        event_order
      )
      VALUES (
        $1,
        $2,
        $3::date,
        $4::timestamptz,
        $5::timestamptz,
        $6,
        COALESCE(
          (SELECT MAX(event_order) + 1 FROM attendance_events WHERE school_year_id = $1),
          1
        )
      )
      RETURNING
        id,
        school_year_id,
        name,
        event_date::text,
        event_start_at::text,
        event_end_at::text,
        description
    `,
    [
      schoolYearId,
      fixture.eventName,
      fixture.eventDate,
      bounds.startAt,
      bounds.endAt,
      fixture.description,
    ],
  );

  return { event: created.rows[0], created: true, updated: false };
}

type StudentResolutionDirectory = {
  exact: Map<string, StudentLookup[]>;
  firstLast: Map<string, StudentLookup[]>;
};

function normalizeNameLookupKey(value: unknown) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildExactNameLookupKeys(value: unknown) {
  const keys = new Set<string>();
  buildNameCandidates(value).forEach((candidate) => {
    const key = normalizeNameLookupKey(candidate);
    if (key) keys.add(key);
  });
  return Array.from(keys);
}

function buildFirstLastLookupKeys(value: unknown) {
  const keys = new Set<string>();
  buildNameCandidates(value).forEach((candidate) => {
    const tokens = normalizeNameLookupKey(candidate).split(" ").filter(Boolean);
    if (tokens.length < 2) return;
    keys.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
  });
  return Array.from(keys);
}

function addStudentToResolutionMap(
  map: Map<string, StudentLookup[]>,
  key: string,
  student: StudentLookup,
) {
  if (!key) return;
  const existing = map.get(key) ?? [];
  const studentId = normalizeStudentId(student.student_id);
  if (!existing.some((entry) => normalizeStudentId(entry.student_id) === studentId)) {
    existing.push(student);
    map.set(key, existing);
  }
}

function buildStudentResolutionDirectory(students: StudentLookup[]) {
  const directory: StudentResolutionDirectory = {
    exact: new Map(),
    firstLast: new Map(),
  };

  students.forEach((student) => {
    buildExactNameLookupKeys(student.name).forEach((key) =>
      addStudentToResolutionMap(directory.exact, key, student),
    );
    buildFirstLastLookupKeys(student.name).forEach((key) =>
      addStudentToResolutionMap(directory.firstLast, key, student),
    );
  });

  return directory;
}

async function loadStudentResolutionDirectory(client: PoolClient) {
  const result = await client.query<StudentLookup>(
    `
      SELECT student_id, name, year_level, college, program, institution
      FROM students
      WHERE NULLIF(TRIM(student_id), '') IS NOT NULL
        AND NULLIF(TRIM(name), '') IS NOT NULL
    `,
  );

  return buildStudentResolutionDirectory(result.rows);
}

function uniqueStudentFromKeys(
  map: Map<string, StudentLookup[]>,
  keys: string[],
): StudentLookup | null {
  const matches = new Map<string, StudentLookup>();
  keys.forEach((key) => {
    (map.get(key) ?? []).forEach((student) => {
      const studentId = normalizeStudentId(student.student_id);
      if (studentId) matches.set(studentId, student);
    });
  });
  return matches.size === 1 ? Array.from(matches.values())[0] : null;
}

function resolveStudentByExactName(
  directory: StudentResolutionDirectory,
  name: string,
): StudentLookup | null {
  return uniqueStudentFromKeys(directory.exact, buildExactNameLookupKeys(name));
}

function resolveStudentByUniqueFirstLast(
  directory: StudentResolutionDirectory,
  name: string,
): StudentLookup | null {
  return uniqueStudentFromKeys(
    directory.firstLast,
    buildFirstLastLookupKeys(name),
  );
}

function buildFixtureResolutionDirectory(parsedFixtures: ParsedFixture[]) {
  const students: StudentLookup[] = [];
  const seenIds = new Set<string>();

  parsedFixtures.forEach((parsedFixture) => {
    parsedFixture.rows.forEach((row) => {
      const studentId = normalizeStudentId(row.studentId);
      if (!studentId || studentId === PLACEHOLDER_STUDENT_ID) return;
      const dedupeKey = `${studentId}:${normalizeNameLookupKey(row.name)}`;
      if (seenIds.has(dedupeKey)) return;
      seenIds.add(dedupeKey);
      students.push({
        student_id: studentId,
        name: row.name,
        year_level: row.yearLevel || null,
        college: DEFAULT_COLLEGE,
        program: DEFAULT_PROGRAM,
        institution: row.institution || DEFAULT_INSTITUTION,
      });
    });
  });

  return buildStudentResolutionDirectory(students);
}

function resolveRows(
  rows: ManualAttendee[],
  unresolvedAttendees: string[],
  unresolvedKeys: Set<string>,
  studentDirectory: StudentResolutionDirectory,
  fixtureDirectory: StudentResolutionDirectory,
) {
  const resolvedRows: ManualAttendee[] = [];
  let unresolvedRows = 0;

  for (const row of rows) {
    const currentStudentId = normalizeStudentId(row.studentId);
    const needsNameResolution =
      !currentStudentId || currentStudentId === PLACEHOLDER_STUDENT_ID;

    if (!needsNameResolution) {
      resolvedRows.push({ ...row, studentId: currentStudentId });
      continue;
    }

    let resolvedStudent = resolveStudentByExactName(studentDirectory, row.name);

    // A placeholder scanner ID means the source explicitly identified the person
    // but did not provide a usable ID. In that case, a unique first/last match in
    // the authoritative students table is safe to use. Rows with no ID at all
    // (including the pipe-format rows) intentionally stay exact-name-only.
    if (!resolvedStudent && currentStudentId === PLACEHOLDER_STUDENT_ID) {
      resolvedStudent = resolveStudentByExactName(fixtureDirectory, row.name);
    }
    if (!resolvedStudent && currentStudentId === PLACEHOLDER_STUDENT_ID) {
      resolvedStudent = resolveStudentByUniqueFirstLast(studentDirectory, row.name);
    }
    if (!resolvedStudent && currentStudentId === PLACEHOLDER_STUDENT_ID) {
      resolvedStudent = resolveStudentByUniqueFirstLast(fixtureDirectory, row.name);
    }

    if (!resolvedStudent) {
      unresolvedRows += 1;
      const unresolvedKey = `${row.eventName}:${normalizeName(row.name)}`;
      if (!unresolvedKeys.has(unresolvedKey)) {
        unresolvedKeys.add(unresolvedKey);
        unresolvedAttendees.push(
          `${row.name} (${row.sourceFile} row ${row.sourceRowNumber}${currentStudentId ? `, ${currentStudentId}` : ""})`,
        );
      }
      continue;
    }

    resolvedRows.push({
      ...row,
      studentId: normalizeStudentId(resolvedStudent.student_id),
      name: normalizeDisplayName(resolvedStudent.name) || row.name,
      nameCandidates: buildNameCandidates(resolvedStudent.name || row.name),
      yearLevel: row.yearLevel || normalizeYearLevel(resolvedStudent.year_level),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution:
        clean(row.institution) ||
        clean(resolvedStudent.institution) ||
        DEFAULT_INSTITUTION,
    });
  }

  return { rows: resolvedRows, unresolvedRows };
}

function mergeAttendeeRows(
  rows: ManualAttendee[],
  direction: SessionDirection,
) {
  const merged = new Map<string, ManualAttendee>();

  rows.forEach((row) => {
    const key = normalizeStudentId(row.studentId);
    if (!key) return;

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...row,
        studentId: key,
        college: DEFAULT_COLLEGE,
        program: DEFAULT_PROGRAM,
      });
      return;
    }

    const existingTime = new Date(existing.scannedAt).getTime();
    const rowTime = new Date(row.scannedAt).getTime();
    const keepRow =
      direction === "log-in"
        ? rowTime < existingTime
        : rowTime > existingTime;
    const chosen = keepRow ? row : existing;
    const other = keepRow ? existing : row;

    merged.set(key, {
      ...chosen,
      studentId: key,
      name: normalizeDisplayName(chosen.name) || normalizeDisplayName(other.name),
      nameCandidates:
        chosen.nameCandidates.length > 0
          ? chosen.nameCandidates
          : other.nameCandidates,
      yearLevel:
        normalizeYearLevel(chosen.yearLevel) || normalizeYearLevel(other.yearLevel),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution:
        clean(chosen.institution) ||
        clean(other.institution) ||
        DEFAULT_INSTITUTION,
    });
  });

  return Array.from(merged.values());
}

async function hydrateExistingStudents(
  client: PoolClient,
  rows: ManualAttendee[],
) {
  const normalizedIds = Array.from(
    new Set(
      rows
        .map((row) => normalizeStudentId(row.studentId).toLowerCase())
        .filter(Boolean),
    ),
  );
  if (!normalizedIds.length) return new Map<string, StudentLookup>();

  const result = await client.query<StudentLookup>(
    `
      SELECT student_id, name, year_level, college, program, institution
      FROM students
      WHERE LOWER(TRIM(student_id)) = ANY($1::text[])
    `,
    [normalizedIds],
  );

  return new Map(
    result.rows.map((row) => [normalizeStudentId(row.student_id), row]),
  );
}

function hydrateRowsWithStudents(
  rows: ManualAttendee[],
  existingStudents: Map<string, StudentLookup>,
) {
  return rows.map((row) => {
    const existingStudent = existingStudents.get(normalizeStudentId(row.studentId));
    return {
      ...row,
      name:
        normalizeDisplayName(row.name) || normalizeDisplayName(existingStudent?.name),
      yearLevel:
        normalizeYearLevel(row.yearLevel) ||
        normalizeYearLevel(existingStudent?.year_level),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution:
        clean(row.institution) ||
        clean(existingStudent?.institution) ||
        DEFAULT_INSTITUTION,
    };
  });
}

async function upsertStudent(client: PoolClient, row: ManualAttendee) {
  const params = [
    row.studentId,
    row.name,
    row.yearLevel,
    DEFAULT_COLLEGE,
    DEFAULT_PROGRAM,
    row.institution || DEFAULT_INSTITUTION,
  ];

  const updated = await client.query<{ id: string }>(
    `
      UPDATE students
      SET
        name = COALESCE(NULLIF($2, ''), name),
        year_level = COALESCE(NULLIF($3, ''), year_level),
        college = COALESCE(NULLIF($4, ''), college),
        program = COALESCE(NULLIF($5, ''), program),
        institution = COALESCE(NULLIF($6, ''), institution),
        updated_at = NOW()
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND (
          name IS DISTINCT FROM COALESCE(NULLIF($2, ''), name)
          OR year_level IS DISTINCT FROM COALESCE(NULLIF($3, ''), year_level)
          OR college IS DISTINCT FROM COALESCE(NULLIF($4, ''), college)
          OR program IS DISTINCT FROM COALESCE(NULLIF($5, ''), program)
          OR institution IS DISTINCT FROM COALESCE(NULLIF($6, ''), institution)
        )
      RETURNING id
    `,
    params,
  );

  if (updated.rowCount) return true;

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM students
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      LIMIT 1
    `,
    [row.studentId],
  );
  if (existing.rows[0]) return false;

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO students (
        student_id,
        name,
        year_level,
        college,
        program,
        institution
      )
      VALUES (
        $1,
        NULLIF($2, ''),
        NULLIF($3, ''),
        NULLIF($4, ''),
        NULLIF($5, ''),
        NULLIF($6, '')
      )
      ON CONFLICT (student_id)
      DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), students.name),
        year_level = COALESCE(NULLIF(EXCLUDED.year_level, ''), students.year_level),
        college = COALESCE(NULLIF(EXCLUDED.college, ''), students.college),
        program = COALESCE(NULLIF(EXCLUDED.program, ''), students.program),
        institution = COALESCE(NULLIF(EXCLUDED.institution, ''), students.institution),
        updated_at = NOW()
      RETURNING id
    `,
    params,
  );

  return Boolean(inserted.rowCount);
}

async function insertManualAttendanceRow(
  client: PoolClient,
  schoolYearId: string,
  eventId: string,
  row: ManualAttendee,
) {
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO manual_attendance_records (
        school_year_id,
        event_id,
        attendance_type,
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
      VALUES (
        $1,
        $2,
        'manual',
        $3,
        $4,
        NULLIF($5, ''),
        $6,
        $7,
        NULLIF($8, ''),
        0,
        $9,
        $10::timestamptz
      )
      RETURNING id
    `,
    [
      schoolYearId,
      eventId,
      row.studentId,
      row.name,
      row.yearLevel,
      DEFAULT_COLLEGE,
      DEFAULT_PROGRAM,
      row.institution || DEFAULT_INSTITUTION,
      row.remarks,
      row.scannedAt,
    ],
  );

  return inserted.rowCount ?? 0;
}

async function deleteSeederOwnedRows(
  client: PoolClient,
  eventIds: string[],
) {
  if (!eventIds.length) return 0;

  const deleted = await client.query(
    `
      DELETE FROM manual_attendance_records
      WHERE event_id = ANY($1::uuid[])
        AND remarks = ANY($2::text[])
    `,
    [eventIds, [...SOE_SESSION_EVENT_MANUAL_ATTENDANCE_REMARKS]],
  );

  return deleted.rowCount ?? 0;
}

async function retireLegacyBuwanData(
  client: PoolClient,
  schoolYearId: string,
) {
  const deletedLegacyRows = await client.query(
    `
      DELETE FROM manual_attendance_records
      WHERE remarks = ANY($1::text[])
    `,
    [[LEGACY_BUWAN_ATTENDANCE_REMARK, LEGACY_BUWAN_WALK_IN_REMARK]],
  );

  const candidates = await client.query<TargetEvent>(
    `
      SELECT
        id,
        school_year_id,
        name,
        event_date::text,
        event_start_at::text,
        event_end_at::text,
        description
      FROM attendance_events
      WHERE school_year_id = $1
        AND COALESCE(
          event_date,
          timezone('Asia/Manila', event_start_at)::date,
          timezone('Asia/Manila', event_end_at)::date
        ) = $2::date
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `,
    [schoolYearId, LEGACY_BUWAN_EVENT_DATE],
  );

  const legacyEvents = candidates.rows.filter(
    (event) =>
      clean(event.name).toLowerCase() === LEGACY_BUWAN_EVENT_NAME.toLowerCase(),
  );
  const warnings: string[] = [];
  let legacyEventDeleted = false;

  for (const event of legacyEvents) {
    const references = await client.query<{
      attendance_records: string;
      manual_records: string;
      request_events: string;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::text
            FROM attendance_records ar
            LEFT JOIN attendance_imports ai ON ai.id = ar.import_id
            WHERE ar.event_id = $1 OR ai.event_id = $1
          ) AS attendance_records,
          (
            SELECT COUNT(*)::text
            FROM manual_attendance_records mar
            WHERE mar.event_id = $1
          ) AS manual_records,
          (
            SELECT COUNT(*)::text
            FROM attendance_request_events areq
            WHERE areq.event_id = $1
          ) AS request_events
      `,
      [event.id],
    );
    const reference = references.rows[0];
    const attendanceRecords = Number(reference?.attendance_records ?? 0);
    const manualRecords = Number(reference?.manual_records ?? 0);
    const requestEvents = Number(reference?.request_events ?? 0);

    if (attendanceRecords || manualRecords || requestEvents) {
      warnings.push(
        `Legacy event "${event.name}" was kept because it is still referenced (${attendanceRecords} attendance record(s), ${manualRecords} manual record(s), ${requestEvents} attendance request event(s)).`,
      );
      continue;
    }

    const deleted = await client.query(
      `DELETE FROM attendance_events WHERE id = $1`,
      [event.id],
    );
    legacyEventDeleted = legacyEventDeleted || Boolean(deleted.rowCount);
  }

  return {
    legacyRowsDeleted: deletedLegacyRows.rowCount ?? 0,
    legacyEventDeleted,
    warnings,
  };
}

async function renumberEventOrder(client: PoolClient, schoolYearId: string) {
  const result = await client.query<{ id: string }>(
    `
      WITH ordered AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY school_year_id
            ORDER BY
              COALESCE(
                event_date,
                timezone('Asia/Manila', event_start_at)::date,
                timezone('Asia/Manila', event_end_at)::date
              ) ASC NULLS LAST,
              created_at ASC,
              id ASC
          ) AS next_order
        FROM attendance_events
        WHERE school_year_id = $1
      )
      UPDATE attendance_events ae
      SET event_order = ordered.next_order,
          updated_at = NOW()
      FROM ordered
      WHERE ae.id = ordered.id
        AND ae.event_order IS DISTINCT FROM ordered.next_order
      RETURNING ae.id
    `,
    [schoolYearId],
  );

  return result.rowCount ?? 0;
}

async function ensureSharedEventExemptions(
  client: PoolClient,
  schoolYearId: string,
) {
  const candidateEvents = await client.query<{
    id: string;
    name: string;
    resolved_date: string;
  }>(
    `
      SELECT DISTINCT
        ae.id,
        ae.name,
        COALESCE(
          ae.event_date,
          timezone('Asia/Manila', ae.event_start_at)::date,
          timezone('Asia/Manila', ae.event_end_at)::date
        )::text AS resolved_date
      FROM attendance_events ae
      WHERE ae.school_year_id = $1
        AND COALESCE(
          ae.event_date,
          timezone('Asia/Manila', ae.event_start_at)::date,
          timezone('Asia/Manila', ae.event_end_at)::date
        ) = ANY($2::date[])
      ORDER BY resolved_date ASC, ae.name ASC, ae.id ASC
    `,
    [schoolYearId, ["2026-08-17", "2026-08-27"]],
  );

  const soeNameIdentity = normalizeAttendanceEventIdentityName(DEFAULT_COLLEGE);
  const sharedEvents = candidateEvents.rows.filter(
    (event) => {
      const identity = normalizeAttendanceEventIdentityName(event.name);
      return !identity.includes(soeNameIdentity) && !identity.startsWith("soe ");
    },
  );
  const result: SharedEventExemption[] = [];

  for (const event of sharedEvents) {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO attendance_event_college_exemptions (
          school_year_id,
          event_id,
          college_key,
          college_label,
          reason
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (event_id, college_key) DO NOTHING
        RETURNING id
      `,
      [
        schoolYearId,
        event.id,
        SOE_COLLEGE_KEY,
        DEFAULT_COLLEGE,
        SHARED_EVENT_EXEMPTION_REASON,
      ],
    );

    result.push({
      eventId: event.id,
      eventName: event.name,
      eventDate: event.resolved_date,
      exemptionCreated: Boolean(inserted.rowCount),
    });
  }

  return result;
}

async function getEventAttendeeCount(client: PoolClient, eventId: string) {
  const result = await client.query<{ attendee_count: string }>(
    `
      SELECT COUNT(DISTINCT LOWER(TRIM(student_id)))::text AS attendee_count
      FROM manual_attendance_records
      WHERE event_id = $1
        AND COALESCE(attendance_type, 'manual') <> 'zero_attendance'
    `,
    [eventId],
  );

  return Number(result.rows[0]?.attendee_count ?? 0);
}

export async function seedSoeSessionEventsManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedSoeSessionEventsManualAttendeesResult> {
  onProgress?.("Verifying SOE session event names and CSV fixtures");
  assertDistinctEventIdentities();
  const missingFixtureFiles = getMissingFixtureFiles();

  if (missingFixtureFiles.length > 0) {
    onProgress?.(
      `SOE session seeder remains pending because ${missingFixtureFiles.length} fixture file(s) are missing`,
    );
    return {
      alreadySeeded: false,
      skipped: true,
      missingFixtureFiles,
      rowsParsed: 0,
      manualAttendanceRecordsCreated: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
      eventOrdersRenumbered: 0,
      legacyRowsDeleted: 0,
      legacyEventDeleted: false,
      skippedStrayRows: 0,
      skippedJunkRows: 0,
      skippedInvalidRows: 0,
      unresolvedAttendees: [],
      warnings: [
        `Missing SOE session fixture file(s): ${missingFixtureFiles.join(", ")}. Add them under src/database/seeder/data/engineering-events or set SOE_SESSION_EVENTS_FIXTURES_PATH to the directory containing all six CSVs.`,
      ],
      exemptionsCreated: 0,
      sharedEventExemptions: [],
      eventSummaries: [],
      eventAttendeeCounts: [],
    };
  }

  onProgress?.("Parsing six SOE session attendance CSV fixtures");
  const parsedFixtures = FIXTURES.map((fixture) => parseFixture(fixture));
  const rowsParsed = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.rows.length,
    0,
  );
  const skippedJunkRows = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.skippedJunkRows,
    0,
  );
  const skippedStrayRows = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.skippedStrayRows,
    0,
  );
  const skippedInvalidRows = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.skippedInvalidRows,
    0,
  );
  const parseWarnings = parsedFixtures.flatMap(
    (parsedFixture) => parsedFixture.warnings,
  );

  const transactionResult = await withTransaction(async (client) => {
    const schoolYearId = await getTargetSchoolYearId(client);
    const unresolvedAttendees: string[] = [];
    const unresolvedKeys = new Set<string>();
    const studentDirectory = await loadStudentResolutionDirectory(client);
    const fixtureDirectory = buildFixtureResolutionDirectory(parsedFixtures);
    const eventByName = new Map<string, TargetEvent>();
    const eventAttendeeCounts: SeedSoeSessionEventsManualAttendeesResult["eventAttendeeCounts"] = [];
    const eventSummaries: SeedSoeSessionEventsManualAttendeesResult["eventSummaries"] = [];
    let eventsCreated = 0;
    let eventsUpdated = 0;
    let manualAttendanceRecordsCreated = 0;
    let studentsChanged = 0;

    onProgress?.("Creating or updating the six SOE-only session events");
    for (const parsedFixture of parsedFixtures) {
      const targetEvent = await getOrCreateTargetEvent(
        client,
        schoolYearId,
        parsedFixture.fixture,
        parsedFixture.rows,
      );
      if (targetEvent.created) eventsCreated += 1;
      if (targetEvent.updated) eventsUpdated += 1;
      eventByName.set(parsedFixture.fixture.eventName, targetEvent.event);
    }

    onProgress?.("Replacing only this seeder's rows on the six SOE session events");
    await deleteSeederOwnedRows(
      client,
      Array.from(eventByName.values()).map((event) => event.id),
    );

    for (const parsedFixture of parsedFixtures) {
      const event = eventByName.get(parsedFixture.fixture.eventName);
      if (!event) {
        throw new Error(
          `Missing SOE session event after creation: ${parsedFixture.fixture.eventName}.`,
        );
      }

      const resolved = resolveRows(
        parsedFixture.rows,
        unresolvedAttendees,
        unresolvedKeys,
        studentDirectory,
        fixtureDirectory,
      );
      const mergedRows = mergeAttendeeRows(
        resolved.rows,
        parsedFixture.fixture.direction,
      );
      const existingStudents = await hydrateExistingStudents(client, mergedRows);
      const hydratedRows = hydrateRowsWithStudents(mergedRows, existingStudents);
      let insertedForEvent = 0;

      for (const row of hydratedRows) {
        if (await upsertStudent(client, row)) studentsChanged += 1;
        const inserted = await insertManualAttendanceRow(
          client,
          schoolYearId,
          event.id,
          row,
        );
        insertedForEvent += inserted;
        manualAttendanceRecordsCreated += inserted;
      }

      eventSummaries.push({
        eventName: parsedFixture.fixture.eventName,
        eventDate: parsedFixture.fixture.eventDate,
        rowsParsed: parsedFixture.rows.length,
        inserted: insertedForEvent,
        stray: parsedFixture.skippedStrayRows,
        junk: parsedFixture.skippedJunkRows,
        invalid: parsedFixture.skippedInvalidRows,
        unresolved: resolved.unresolvedRows,
      });
    }

    onProgress?.("Deleting legacy SOE Buwan ng Wika rows and retiring the old shared-looking event when safe");
    const legacy = await retireLegacyBuwanData(client, schoolYearId);

    onProgress?.("Exempting SOE from every non-SOE August 17/27 event");
    const sharedEventExemptions = await ensureSharedEventExemptions(
      client,
      schoolYearId,
    );
    const exemptionsCreated = sharedEventExemptions.filter(
      (entry) => entry.exemptionCreated,
    ).length;

    const eventOrdersRenumbered = await renumberEventOrder(client, schoolYearId);

    for (const fixture of FIXTURES) {
      const event = eventByName.get(fixture.eventName);
      if (!event) continue;
      eventAttendeeCounts.push({
        eventName: fixture.eventName,
        eventDate: fixture.eventDate,
        attendeeCount: await getEventAttendeeCount(client, event.id),
      });
    }

    return {
      schoolYearId,
      eventsCreated,
      eventsUpdated,
      eventOrdersRenumbered,
      manualAttendanceRecordsCreated,
      studentsChanged,
      unresolvedAttendees,
      legacy,
      exemptionsCreated,
      sharedEventExemptions,
      eventSummaries,
      eventAttendeeCounts,
    };
  });

  onProgress?.(
    "Refreshing final attendance and penalty results after SOE session changes",
  );
  await refreshAttendanceFinalResults({
    schoolYearId: transactionResult.schoolYearId,
  });

  return {
    alreadySeeded: false,
    skipped: false,
    missingFixtureFiles: [],
    rowsParsed,
    manualAttendanceRecordsCreated:
      transactionResult.manualAttendanceRecordsCreated,
    eventsCreated: transactionResult.eventsCreated,
    eventsUpdated: transactionResult.eventsUpdated,
    eventOrdersRenumbered: transactionResult.eventOrdersRenumbered,
    legacyRowsDeleted: transactionResult.legacy.legacyRowsDeleted,
    legacyEventDeleted: transactionResult.legacy.legacyEventDeleted,
    skippedStrayRows,
    skippedJunkRows,
    skippedInvalidRows,
    unresolvedAttendees: transactionResult.unresolvedAttendees,
    warnings: [...parseWarnings, ...transactionResult.legacy.warnings],
    exemptionsCreated: transactionResult.exemptionsCreated,
    sharedEventExemptions: transactionResult.sharedEventExemptions,
    eventSummaries: transactionResult.eventSummaries,
    eventAttendeeCounts: transactionResult.eventAttendeeCounts,
  };
}
if (require.main === module) {
  seedSoeSessionEventsManualAttendees((message) => console.log(message))
    .then(async (result) => {
      if (result.skipped) {
        console.warn(
          `SOE session attendance remains pending because fixture files are missing: ${result.missingFixtureFiles.join(", ")}`,
        );
      } else {
        console.log(
          `Inserted ${result.manualAttendanceRecordsCreated} SOE session manual attendance record(s), created ${result.eventsCreated} event(s), and deleted ${result.legacyRowsDeleted} legacy row(s).`,
        );
        result.eventSummaries.forEach((event) => {
          console.log(
            `${event.eventName}: parsed ${event.rowsParsed}, inserted ${event.inserted}, stray ${event.stray}, junk ${event.junk}, invalid ${event.invalid}, unresolved ${event.unresolved}.`,
          );
        });
        console.log(
          `Legacy rows deleted: ${result.legacyRowsDeleted}; legacy event deleted: ${result.legacyEventDeleted ? "yes" : "no"}; exemptions created: ${result.exemptionsCreated}.`,
        );
      }
      result.eventAttendeeCounts.forEach((event) => {
        console.log(`${event.eventName}: ${event.attendeeCount} attendee(s)`);
      });
      if (result.unresolvedAttendees.length > 0) {
        console.warn(
          `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
        );
      }
      result.warnings.forEach((warning) => console.warn(warning));
      result.sharedEventExemptions.forEach((event) => {
        console.warn(
          `SOE shared-event exemption ${event.exemptionCreated ? "created" : "already present"}: ${event.eventDate} — ${event.eventName}`,
        );
      });
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("SOE session manual-attendance seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
