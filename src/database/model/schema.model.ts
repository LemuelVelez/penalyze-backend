export const TABLES = {
  users: "users",
  students: "students",
  attendanceEvents: "attendance_events",
  attendanceImports: "attendance_imports",
  attendanceRecords: "attendance_records",
  penalties: "penalties",
  fines: "fines",
} as const;

export type UserRole = "admin" | "officer";
export type ImportStatus = "previewed" | "saved" | "failed";
export type AttendanceImportProgressStage =
  | "preparing"
  | "parsing"
  | "validating"
  | "saving"
  | "syncing"
  | "completed"
  | "cancelled";
export type FineStatus = "unpaid" | "paid" | "waived";

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
};

export type StudentRecord = {
  id: string;
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AttendanceEventRecord = {
  id: string;
  name: string;
  event_start_at: Date | string | null;
  event_end_at: Date | string | null;
  description: string | null;
  attendees_count: number;
  created_at: Date;
  updated_at: Date;
};

export type AttendanceImportRecord = {
  id: string;
  event_id: string | null;
  event_name?: string | null;
  file_name: string;
  file_type: string;
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  status: ImportStatus;
  created_at: Date;
};

export type AttendanceRecord = {
  id: string;
  import_id: string | null;
  event_id: string | null;
  event_name?: string | null;
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
  no_of_absences: number;
  remarks: string | null;
  scanned_at: Date | string | null;
  created_at: Date;
  updated_at: Date;
};

export type PenaltyRecord = {
  id: string;
  no_of_absences: number;
  prescribed_penalty: string;
  created_at: Date;
  updated_at: Date;
};

export type FineRecord = {
  id: string;
  attendance_record_id: string | null;
  penalty_id: string | null;
  student_id: string;
  name: string;
  no_of_absences?: number;
  prescribed_penalty: string;
  status: FineStatus;
  attendance_event_id?: string | null;
  attendance_remarks?: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AttendanceImportInput = {
  eventId?: string;
  eventName?: string;
  eventStartAt?: string;
  eventEndAt?: string;
  scannedAt?: string;
  studentId: string;
  name: string;
  yearLevel?: string;
  college?: string;
  program?: string;
  institution?: string;
  noOfAbsences?: number;
  remarks?: string;
};

export type ParsedAttendanceRow = AttendanceImportInput & {
  rowNumber: number;
  errors: string[];
  raw: Record<string, unknown>;
};

export type AttendancePreviewResult = {
  fileName: string;
  fileType: string;
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  rows: ParsedAttendanceRow[];
};

export type AttendanceImportProgress = {
  stage: AttendanceImportProgressStage;
  percent: number;
  message: string;
  processedRows: number;
  totalRows: number;
  savedRecords: number;
  createdFines: number;
};

export type SavedAttendanceImportResult = AttendancePreviewResult & {
  importId: string;
  event: AttendanceEventRecord | null;
  savedRecords: AttendanceRecord[];
  createdFines: FineRecord[];
};

export const ACCEPTED_ATTENDANCE_EXTENSIONS = [
  ".xlsx",
  ".xls",
  ".csv",
  ".txt",
  ".docx",
  ".doc",
] as const;
export const REQUIRED_ATTENDANCE_FIELDS = ["studentId", "name"] as const;