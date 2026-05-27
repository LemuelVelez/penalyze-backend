export const TABLES = {
  users: "users",
  students: "students",
  schoolYears: "school_years",
  attendanceEvents: "attendance_events",
  attendanceImports: "attendance_imports",
  attendanceRecords: "attendance_records",
  attendanceFinalResults: "attendance_final_results",
  calculationResults: "calculation_results",
  manualAttendanceRecords: "manual_attendance_records",
  penalties: "penalties",
  penaltyResults: "penalty_results",
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

export type SchoolYearRecord = {
  id: string;
  name: string;
  starts_at: Date | string;
  ends_at: Date | string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

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
  school_year_id: string | null;
  name: string;
  event_start_at: Date | string | null;
  event_end_at: Date | string | null;
  description: string | null;
  attendees_count: number;
  event_order: number;
  created_at: Date;
  updated_at: Date;
};

export type AttendanceImportRecord = {
  id: string;
  school_year_id: string | null;
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
  school_year_id: string | null;
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

export type ManualAttendanceType = "manual" | "zero_attendance";

export type ManualAttendanceRecord = {
  id: string;
  school_year_id: string | null;
  event_id: string | null;
  event_name?: string | null;
  attendance_type: ManualAttendanceType;
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

export type AttendanceFinalResultRecord = {
  id: string;
  school_year_id: string | null;
  import_id: string | null;
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
  attended_events: number;
  total_absences: number;
  attendance_status: string;
  latest_scanned_at: Date | string | null;
  source_updated_at: Date | string | null;
  created_at: Date;
  updated_at: Date;
};

export type CalculationResultRecord = {
  id: string;
  school_year_id: string | null;
  calculation_scope_key: string;
  import_ids: string[];
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
  attended_events: number;
  imported_absences: number;
  manual_absences: number;
  total_absences: number;
  attendance_status: string;
  penalty_id: string | null;
  prescribed_penalty: string | null;
  source_record_count: number;
  latest_scanned_at: Date | string | null;
  source_updated_at: Date | string | null;
  calculated_at: Date | string;
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
  school_year_id: string | null;
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

export type PenaltyResultRecord = {
  id: string;
  school_year_id: string | null;
  student_id: string;
  name: string;
  no_of_absences: number;
  penalty_id: string | null;
  prescribed_penalty: string;
  status: FineStatus;
  source_table: string | null;
  source_record_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AttendanceImportInput = {
  schoolYearId?: string;
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
  attendanceType?: ManualAttendanceType;
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