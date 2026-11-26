import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import * as XLSX from "xlsx";
import type { MasterlistStatus, SchoolYearRecord, StudentMasterlistRecord, StudentMasterlistImportRecord, ParsedAttendanceRow, MaintenanceJob } from "../database/model/schema.model";
import { pool, withTransaction } from "../lib/db";
import { getSchoolYearMetadataLabels, validateXlsxContainer, normalizeYearLevelKey, normalizeCollegeKey, lockAttendanceAbsenceSync, refreshDerivedAttendanceResultsForSchoolYearsWithClient, refreshAttendanceFinalResultsWithClient, refreshCalculationResultsWithClient, prepareMasterlistDerivedRefresh, finishMasterlistDerivedRefresh, refreshPenaltyResultsForSchoolYearWithClient, listAttendanceFinalResults, listFinalAttendanceEventRoster, syncAbsencesForStudents, attendanceEventRosterScopeCteSql, attendanceEventParticipationCteSql } from "./attendance.service";
import { getAttendanceRecordVisibilitySql } from "./attendance-result-visibility";
import { normalizeStudentNumberKey, normalizeNameKey, normalizeProgram, cleanProgram, collegeForProgram, parseStudentNumberParts, isPlaceholderStudentNumber, nameTokens, nameTokensAgree, nameKeysAgree, sharedNameTokenCount, nameTokenSignatures, repairNameMojibake, surnameTokensOverlap, joinedGivenNamesAgree, masterlistNameMatchRank, masterlistNameSignatures } from "./masterlist-normalize";

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400, expose: true });
export type MasterlistProgress = {
  stage: "parsing" | "saving_masterlist" | "reconciling_records" | "remapping_overrides" | "updating_students" | "syncing_absences" | "refreshing_final_results" | "refreshing_calculations" | "refreshing_penalties" | "finalizing";
  percent: number;
  message: string;
  table?: string;
  processed?: number;
  total?: number;
  chunkIndex?: number;
  chunkTotal?: number;
};
type ProgressCallback = (progress: MasterlistProgress) => void;
const MASTERLIST_CHUNK_SIZE = 500;
const MASTERLIST_REFRESH_CHUNK_SIZE = 50;
function checkCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) throw Object.assign(new Error("Masterlist operation was cancelled."), { statusCode: 499 });
}
async function yieldChunk(isCancelled?: () => boolean) {
  await new Promise<void>(resolve => setImmediate(resolve));
  checkCancelled(isCancelled);
}
function progressReporter(onProgress?: ProgressCallback, isCancelled?: () => boolean): ProgressCallback {
  let percent = 0;
  return progress => {
    checkCancelled(isCancelled);
    percent = Math.max(percent, Math.min(100, Math.max(0, progress.percent)));
    onProgress?.({ ...progress, percent });
  };
}
export function isMasterlistSchoolYear(year: SchoolYearRecord | undefined | null): boolean {
  return !!year && year.semester === "first_semester" && (getSchoolYearMetadataLabels(year).some(label => /2026\s*[-–—/]\s*2027/.test(label)) || (new Date(year.starts_at).getUTCFullYear() === 2026 && new Date(year.ends_at).getUTCFullYear() === 2027));
}
export const ZERO_ATTENDANCE_MASTERLIST_MESSAGE = "Zero attendance is not needed: every masterlist student is already listed on the Attendance page with all expected events marked absent.";
export const MANUAL_ATTENDANCE_MASTERLIST_MESSAGE = "Manual attendance is disabled while the masterlist is active. Use the Attendance page: search the student, open Events, then use + / − to add or subtract events.";
export function masterlistActiveError(message: string) {
  return Object.assign(new Error(message), { statusCode: 409, expose: true, code: "MASTERLIST_ACTIVE" });
}
export async function isMasterlistActiveForSchoolYear(client: PoolClient, schoolYearId: string | null | undefined, fallback?: { eventId?: string; eventIds?: string[] }): Promise<boolean> {
  const { rows } = await client.query<{ active: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM student_masterlist ml
      WHERE (ml.school_year_id = COALESCE($1::uuid,
        CASE WHEN $3::boolean THEN COALESCE(
          (SELECT school_year_id FROM attendance_events WHERE id = $2::uuid),
          (SELECT id FROM school_years WHERE is_active ORDER BY starts_at DESC LIMIT 1)
        ) END)
        OR ml.school_year_id IN (SELECT school_year_id FROM attendance_events WHERE id = ANY($4::uuid[])))
      AND public.is_masterlist_school_year(ml.school_year_id)
    ) AS active
  `, [schoolYearId ?? null, fallback?.eventId ?? null, fallback !== undefined, fallback?.eventIds ?? []]);
  return rows[0]?.active === true;
}
export async function getMasterlistStatus(): Promise<{ active: boolean; schoolYearId: string | null; schoolYearName: string | null; studentCount: number }> {
  const client = await pool.connect();
  try {
    const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE is_active ORDER BY starts_at DESC LIMIT 1")).rows[0];
    const active = await isMasterlistActiveForSchoolYear(client, year?.id);
    const studentCount = active ? Number((await client.query<{ count: string }>("SELECT COUNT(*) AS count FROM student_masterlist WHERE school_year_id = $1", [year.id])).rows[0].count) : 0;
    return { active, schoolYearId: year?.id ?? null, schoolYearName: year?.name ?? null, studentCount };
  } finally { client.release(); }
}
async function activeYear(client: PoolClient) {
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE is_active ORDER BY starts_at DESC LIMIT 1")).rows[0];
  if (!isMasterlistSchoolYear(year)) throw bad("Masterlist is only available for the active 1st Semester, A.Y. 2026-2027.");
  return year;
}
function checkFilename(file: string, year: SchoolYearRecord) {
  if (!isMasterlistSchoolYear(year)) throw bad("The filename cannot be associated with the active school year.");
  const semesters = [...file.matchAll(/(?:\b|_)(1ST|2ND|FIRST|SECOND)[\s_-]*SEMESTER/gi)];
  const years = [...file.matchAll(/(\d{4})\s*[-–—]\s*(\d{4})/g)];
  if (semesters.some(m => !/^(1ST|FIRST)$/i.test(m[1])) || years.some(m => m[1] !== "2026" || m[2] !== "2027")) throw bad("The filename conflicts with the active school year.");
}
type Profile = { studentId: string; name: string; program?: string | null; college?: string | null };
type Resolution = { status: MasterlistStatus; master?: StudentMasterlistRecord; reason?: string };
type MasterIndex = { rows: StudentMasterlistRecord[]; ids: Map<string, StudentMasterlistRecord>; names: Map<string, StudentMasterlistRecord[]>; tokens: Map<string, StudentMasterlistRecord[]>; serials: Map<string, StudentMasterlistRecord[]> };
export type MasterlistCache = Map<string, MasterIndex>;

export async function loadMasterlist(client: PoolClient, schoolYearId: string, cache: MasterlistCache = new Map()): Promise<MasterIndex> {
  const cached = cache.get(schoolYearId); if (cached) return cached;
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE id=$1", [schoolYearId])).rows[0];
  const rows = isMasterlistSchoolYear(year) ? (await client.query<StudentMasterlistRecord>("SELECT * FROM student_masterlist WHERE school_year_id=$1", [schoolYearId])).rows : [];
  const index: MasterIndex = { rows, ids: new Map(), names: new Map(), tokens: new Map(), serials: new Map() };
  for (const row of rows) {
    row.name_key = normalizeNameKey(`${row.given_name} ${row.last_name}`);
    const parts = parseStudentNumberParts(row.student_number_key);
    if (parts) {
      index.ids.set(normalizeStudentNumberKey(row.student_number_key), row);
      const serialRows = index.serials.get(parts.serial) ?? [];
      serialRows.push(row); index.serials.set(parts.serial, serialRows);
    }
    index.names.set(row.name_key, [...(index.names.get(row.name_key) ?? []), row]);
    for (const signature of masterlistNameSignatures(`${row.given_name} ${row.last_name}`)) {
      const candidates = index.tokens.get(signature) ?? [];
      candidates.push(row); index.tokens.set(signature, candidates);
    }
  }
  cache.set(schoolYearId, index); return index;
}
function resolve(index: MasterIndex, profile: Profile): Resolution {
  if (!index.rows.length) return { status: "no_masterlist" };
  const id = normalizeStudentNumberKey(profile.studentId);
  const owner = isPlaceholderStudentNumber(profile.studentId) ? undefined : index.ids.get(id);
  const rank = (r: StudentMasterlistRecord) => masterlistNameMatchRank(profile.name, r.last_name, r.given_name);
  // An exact name candidate takes precedence over a merely fuzzy ID/name match.
  // The complete ID may disambiguate people with the same name; partial IDs
  // and self-reported college/program cannot disambiguate conflicting people.
  const possible = new Set(masterlistNameSignatures(profile.name).flatMap(signature => index.tokens.get(signature) ?? []));
  if (owner) possible.add(owner);
  const ranked = [...possible].map(master => ({ master, rank: rank(master) })).filter(r => r.rank > 0);
  const best = ranked.reduce((max, r) => Math.max(max, r.rank), 0);
  const candidates = ranked.filter(r => r.rank === best).map(r => r.master);
  if (owner && (!normalizeNameKey(profile.name) || candidates.some(r => r.id === owner.id))) {
    return { status: "matched_by_id", master: owner };
  }
  if (candidates.length === 1) {
    const master = candidates[0];
    const parts = parseStudentNumberParts(profile.studentId);
    const target = parseStudentNumberParts(master.student_number_key);
    const partialAgrees = !owner && parts && target && parts.serial === target.serial &&
      (!parts.year || parts.year === target.year) && (!parts.letter || parts.letter === target.letter);
    return { status: owner && owner.id !== master.id ? "id_name_mismatch" : partialAgrees ? "matched_by_partial_id" : "matched_by_name", master };
  }
  return { status: "unmatched", reason: candidates.length > 1
    ? "Ambiguous name: multiple masterlist students match. Correct the student ID and name."
    : owner ? "Student ID and name conflict; no unique masterlist name match."
      : "No unique masterlist student matches the uploaded ID and name." };
}
export async function resolveStudentAgainstMasterlist(client: PoolClient, schoolYearId: string, profile: Profile, cache: MasterlistCache = new Map()): Promise<Resolution> {
  return resolve(await loadMasterlist(client, schoolYearId, cache), profile);
}
export async function reconcileAttendanceRow(client: PoolClient, schoolYearId: string, row: ParsedAttendanceRow, cache: MasterlistCache): Promise<ParsedAttendanceRow> {
  const original = row.masterlist_original ?? { studentId: row.studentId, name: row.name, college: row.college, program: row.program, yearLevel: row.yearLevel };
  const result = await resolveStudentAgainstMasterlist(client, schoolYearId, original, cache);
  if (result.status === "no_masterlist") { const { masterlist_original: _original, ...unchanged } = row; return unchanged; }
  const m = result.master;
  const warnings = (row.warnings ?? []).filter(w => !w.startsWith("Masterlist: "));
  if (!m) return { ...row, masterlist_status: "unmatched", masterlist_original: original,
    warnings: [...warnings, `Masterlist: ${result.reason ?? "No unique match."}`],
    errors: row.errors.filter(e => !e.includes(": unrecognised college ")) };
  return { ...row, studentId: m.student_number, name: m.full_name, college: m.college ?? undefined,
    program: m.program ?? undefined, yearLevel: m.year_level ?? undefined,
    masterlist_status: result.status, masterlist_original: original, warnings,
    errors: row.errors.filter(e => !e.includes(": unrecognised college ") && e !== "Student ID is required." && e !== "Name is required." && e !== "A usable Student ID or Name is required.") };

}

const scopedTables = ["attendance_records", "manual_attendance_records", "attendance_requests", "attendance_final_results", "calculation_results", "penalty_results", "fines"] as const;
const profileTables = scopedTables.slice(0, 5);

// A global profile must not be inserted, updated or removed if another semester
// relies on the same identifier, including formatting variants of that identifier.
function otherTermReferences(studentIdSql: string, schoolYearSql: string) {
  return `${scopedTables.map(t => `SELECT 1 FROM ${t} WHERE school_year_id IS DISTINCT FROM ${schoolYearSql} AND public.masterlist_student_number_key(student_id)=public.masterlist_student_number_key(${studentIdSql})`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM attendance_student_event_overrides WHERE school_year_id IS DISTINCT FROM ${schoolYearSql} AND public.masterlist_student_number_key(student_key)=public.masterlist_student_number_key(${studentIdSql})`;
}
// Never overwrite a global profile with evidence belonging to another term.
export async function upsertMasterlistStudent(client: PoolClient, year: string, row: ParsedAttendanceRow) {
  const matched = row.masterlist_status !== "unmatched";
  await client.query("SELECT set_config('penalyze.masterlist_school_year',$1,true)", [year]);
  await client.query(`INSERT INTO students(student_id,name,year_level,program,college,institution)
    SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (${otherTermReferences("$1::text", "$7::uuid")})
    ON CONFLICT ((LOWER(TRIM(student_id)))) DO UPDATE SET
      student_id=CASE WHEN $8::boolean THEN EXCLUDED.student_id ELSE students.student_id END,
      name=EXCLUDED.name,
      year_level=CASE WHEN $8::boolean THEN EXCLUDED.year_level ELSE COALESCE(EXCLUDED.year_level,students.year_level) END,
      program=CASE WHEN $8::boolean THEN EXCLUDED.program ELSE COALESCE(EXCLUDED.program,students.program) END,
      college=CASE WHEN $8::boolean THEN EXCLUDED.college ELSE COALESCE(EXCLUDED.college,students.college) END,
      institution=COALESCE(EXCLUDED.institution,students.institution),updated_at=NOW()`,
    [row.studentId,row.name,row.yearLevel ?? null,row.program ?? null,row.college ?? null,row.institution ?? null,year,matched]);
  await client.query("SELECT set_config('penalyze.masterlist_school_year','',true)");
}
type Existing = { masterlist_original?: ParsedAttendanceRow["masterlist_original"] | null; masterlist_status?: MasterlistStatus | null; id: string; student_id: string; name: string; program: string | null; college: string | null; year_level: string | null };
type ReconcileUpdate = Array<{ id: string; student_id: string; name: string; year_level: string | null; program: string | null; college: string | null; masterlist_original?: ParsedAttendanceRow["masterlist_original"]; masterlist_status?: MasterlistStatus }>;
const derivedTables = ["attendance_final_results", "calculation_results", "penalty_results"] as const;
function initialSummary(schoolYear: SchoolYearRecord, index: MasterIndex) {
  return { schoolYear, masterlistRows: index.rows.length, matchedById: 0, matchedByPartialId: 0, matchedByName: 0, idNameMismatches: 0, unmatched: 0, studentsUpdated: 0, recordsUpdated: 0, unmappedPrograms: [...new Set(index.rows.filter(r => !r.college).map(r => r.program ?? ""))] };
}
type ReconcileState = {
  summary: ReturnType<typeof initialSummary>;
  seen: string[];
  aliases: Record<string, string[]>;
  changed: string[];
  unresolvedAliases: string[];
  sourceProfiles: Record<string, string[]>;
  matched: string[];
  totals: number[];
  derivedUpdates: ReconcileUpdate;
  mapping: { old: string; target: string }[];
  studentIds: string[];
  refreshKeys?: string[];
};
type ReconcileCursor = { id?: string; tableIndex: number; offset?: number; refreshOffset?: number; refreshBatchSize?: number };
async function planReconciliation(client: PoolClient, schoolYear: SchoolYearRecord, cache: MasterlistCache = new Map()): Promise<ReconcileState> {
  const index = await loadMasterlist(client, schoolYear.id, cache);
  if (!index.rows.length) throw bad("Upload a masterlist before reconciling.");
  const totals: number[] = [];
  for (const table of scopedTables) {
    const visibility = table === "attendance_records" ? ` AND ${getAttendanceRecordVisibilitySql(table)}` : "";
    const count = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table} WHERE school_year_id=$1${visibility}`, [schoolYear.id]);
    totals.push(Number(count.rows[0].count));
  }
  return { summary: initialSummary(schoolYear,index), seen: [], aliases: {}, changed: [], unresolvedAliases: [], sourceProfiles: {}, matched: [], totals, derivedUpdates: [], mapping: [], studentIds: [] };
}
async function absenceStudentIds(client: PoolClient, schoolYearId: string) {
  const rows = (await client.query<{ student_id: string }>(`SELECT student_number AS student_id FROM student_masterlist WHERE school_year_id=$1 UNION SELECT DISTINCT ar.student_id FROM attendance_records ar WHERE school_year_id=$1 AND ${getAttendanceRecordVisibilitySql("ar")} AND ar.masterlist_status IS DISTINCT FROM 'unmatched'`, [schoolYearId])).rows;
  const ids = [...new Set<string>(rows.map(row => normalizeStudentNumberKey(row.student_id).toLowerCase()).filter(Boolean))];
  return ids.sort();
}
function reconciliationStage(phase: string): MasterlistProgress["stage"] {
  if (phase === "queued") return "parsing";
  if (phase === "primary") return "reconciling_records";
  if (phase === "normalize_masterlist") return "saving_masterlist";
  if (phase.startsWith("reconcile:") || phase.startsWith("dedupe:")) return "reconciling_records";
  if (phase === "remap_overrides") return "remapping_overrides";
  if (phase === "update_students") return "updating_students";
  if (phase === "sync_absences") return "syncing_absences";
  if (phase === "refresh_final_results") return "refreshing_final_results";
  if (phase === "refresh_calculations") return "refreshing_calculations";
  if (phase === "refresh_penalties") return "refreshing_penalties";
  return "finalizing";
}
export { reconciliationStage };
async function reconcileStep(client: PoolClient, schoolYear: SchoolYearRecord, phase: string, cursor: ReconcileCursor, state: ReconcileState, rebuild: boolean, cache: MasterlistCache = new Map(), checkpointRefresh = false) {
  const summary = state.summary;
  const index = await loadMasterlist(client, schoolYear.id, cache);
  if (!index.rows.length) throw bad("Upload a masterlist before reconciling.");
  const seen = new Set(state.seen), changed = new Set(state.changed), unresolvedAliases = new Set(state.unresolvedAliases), matched = new Set(state.matched);
  const aliases = new Map(Object.entries(state.aliases).map(([key, values]) => [key, new Set(values)]));
  const sourceProfiles = new Map(Object.entries(state.sourceProfiles).map(([key, values]) => [key, new Set(values)]));
  const byId = new Map(index.rows.map(row => [row.id,row]));
  const resolutionCache = new Map<string, Resolution>();
  let nextPhase = phase, nextCursor = {...cursor}, processed = 0, total = 0, percent = 0, message = "", done = false;
  const nextTable = () => { nextCursor = {tableIndex:cursor.tableIndex+1}; nextPhase = scopedTables[nextCursor.tableIndex] ? `reconcile:${scopedTables[nextCursor.tableIndex]}` : "remap_overrides"; };
  if (phase === "normalize_masterlist") {
    const rows = (await client.query<StudentMasterlistRecord>(`SELECT * FROM student_masterlist WHERE school_year_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${MASTERLIST_CHUNK_SIZE}`, [schoolYear.id,cursor.id ?? null])).rows;
      const profiles = rows.map(row => ({
        id: row.id, name_key: normalizeNameKey(`${row.given_name} ${row.last_name}`), college: row.college ?? collegeForProgram(row.program),
        last_name: repairNameMojibake(row.last_name), given_name: repairNameMojibake(row.given_name),
        full_name: repairNameMojibake(row.full_name),
      }));
      await client.query(`UPDATE student_masterlist m SET name_key=x.name_key,last_name=x.last_name,
        given_name=x.given_name,full_name=x.full_name,college=x.college,updated_at=NOW()
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,name_key text,last_name text,given_name text,full_name text,college text)
        WHERE m.id=x.id AND (m.name_key,m.last_name,m.given_name,m.full_name,m.college)
          IS DISTINCT FROM (x.name_key,x.last_name,x.given_name,x.full_name,x.college)`, [JSON.stringify(profiles)]);
    processed = (cursor.offset ?? 0) + rows.length; total = index.rows.length;
    percent = 10 * Math.min(1,processed / Math.max(1,total)); message = `Normalizing masterlist: ${processed} / ${total}`;
    if (rows.length < MASTERLIST_CHUNK_SIZE) { const normalized = await loadMasterlist(client,schoolYear.id,new Map()); summary.unmappedPrograms = [...new Set(normalized.rows.filter(r=>!r.college).map(r=>r.program ?? ""))]; nextPhase = `reconcile:${scopedTables[0]}`; nextCursor = {tableIndex:0}; }
    else nextCursor = {tableIndex:0,id:rows[rows.length-1].id,offset:processed};
  } else if (phase.startsWith("reconcile:") || phase.startsWith("dedupe:")) {
    const table = scopedTables[cursor.tableIndex];
    if (!table) throw new Error("Invalid reconciliation table checkpoint.");
    const full = profileTables.includes(table);
    const isSource = table === "attendance_records" || table === "manual_attendance_records";
    const isDerived = derivedTables.some(value => value === table);
    const visibility = table === "attendance_records" ? ` AND ${getAttendanceRecordVisibilitySql(table)}` : "";
    total = state.totals[cursor.tableIndex];
    const grandTotal = state.totals.reduce((sum,count)=>sum+count,0);
    const completed = state.totals.slice(0,cursor.tableIndex).reduce((sum,count)=>sum+count,0);
    const updates: ReconcileUpdate = phase.startsWith("dedupe:") ? state.derivedUpdates : [];
    if (phase.startsWith("dedupe:")) {
    const scope = table === "attendance_final_results" ? ", t.import_id" : table === "calculation_results" ? ", t.calculation_scope_key" : "";
    if (["attendance_final_results", "calculation_results", "penalty_results"].includes(table)) {
      const data = JSON.stringify(updates);
      // Retain one derived record per unique key before updating IDs, prioritizing settled penalties.
      const ranking = `WITH changes AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text)), ranked AS (SELECT t.id, first_value(t.id) OVER w AS keep_id,row_number() OVER w AS rn FROM ${table} t LEFT JOIN changes c ON c.id=t.id WHERE t.school_year_id=$1 WINDOW w AS (PARTITION BY LOWER(public.masterlist_student_number_key(COALESCE(c.student_id,t.student_id)))${scope} ORDER BY ${table === "penalty_results" ? "CASE t.status WHEN 'paid' THEN 0 WHEN 'waived' THEN 1 ELSE 2 END," : ""} t.updated_at DESC,t.id DESC))`;
      if (table !== "penalty_results") await client.query(`${ranking} UPDATE penalty_results p SET source_record_id=r.keep_id FROM ranked r WHERE r.rn>1 AND p.school_year_id=$1 AND p.source_table='${table}' AND p.source_record_id=r.id`, [schoolYear.id,data]);
      const merged = await client.query(`${ranking} DELETE FROM ${table} t USING ranked r WHERE r.rn>1 AND t.id=r.id AND t.school_year_id=$1`, [schoolYear.id,data]);
      summary.recordsUpdated += merged.rowCount ?? 0;
    }
      // Deduplicate before changing unique derived keys; keep ranking and its updates atomic.
      for (let i=0; i<updates.length; i+=MASTERLIST_CHUNK_SIZE) {
        const chunk = updates.slice(i,i+MASTERLIST_CHUNK_SIZE);
      const result = await client.query(`UPDATE ${table} t SET student_id=x.student_id,name=x.name${full ? ",year_level=x.year_level,program=x.program,college=x.college" : ""}${isSource ? ",masterlist_original=x.masterlist_original,masterlist_status=x.masterlist_status" : ""},updated_at=NOW() FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text,name text,year_level text,program text,college text,masterlist_original jsonb,masterlist_status text) WHERE t.id=x.id AND t.school_year_id=$1`, [schoolYear.id,JSON.stringify(chunk)]);
      summary.recordsUpdated += result.rowCount ?? 0;
      }
      state.derivedUpdates = [];
      processed = total; nextTable();
    } else {
      const rows: Existing[] = (await client.query<Existing>(`SELECT id,student_id,name,${isSource ? "masterlist_original,masterlist_status," : ""}${full ? "program,college,year_level" : "NULL::text AS program,NULL::text AS college,NULL::text AS year_level"} FROM ${table} WHERE school_year_id=$1${visibility} AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${MASTERLIST_CHUNK_SIZE}`, [schoolYear.id,cursor.id ?? null])).rows;
      for (const row of rows) {
        const original = row.masterlist_original ?? { studentId: row.student_id, name: row.name, program: row.program ?? undefined, college: row.college ?? undefined, yearLevel: row.year_level ?? undefined };
        const profileKey = JSON.stringify([original.studentId, original.name]);
        let resolution = resolutionCache.get(profileKey);
        if (!resolution) {
          resolution = resolve(index, original);
          resolutionCache.set(profileKey, resolution);
        }
        const key = `${normalizeStudentNumberKey(original.studentId)}|${normalizeNameKey(original.name)}`;
        // Profile-less derived records can inherit a unique authoritative match from
        // the scoped source rows, but never guess between conflicting people.
        const prior = sourceProfiles.get(key);
        if (resolution.status === "unmatched" && !full && prior?.size === 1) {
          resolution = { status: "matched_by_name", master: byId.get([...prior][0]) };
        }
        if (!seen.has(key)) { seen.add(key); if (resolution.status === "matched_by_id") summary.matchedById++; else if (resolution.status === "matched_by_partial_id") summary.matchedByPartialId++; else if (resolution.status === "matched_by_name") summary.matchedByName++; else if (resolution.status === "id_name_mismatch") summary.idNameMismatches++; else summary.unmatched++; }
        const m = resolution.master;
        if (!m) {
          if (isSource) unresolvedAliases.add(normalizeStudentNumberKey(original.studentId).toLowerCase());
          if (isSource && (row.masterlist_status !== "unmatched" || !row.masterlist_original)) {
            updates.push({ ...row, student_id: original.studentId, name: original.name, college: original.college ?? null, program: original.program ?? null, year_level: original.yearLevel ?? null, masterlist_original: original, masterlist_status: "unmatched" });
          }
          continue;
        }
        if (isSource) {
          const profiles = sourceProfiles.get(key) ?? new Set<string>();
          profiles.add(m.id); sourceProfiles.set(key, profiles);
        }
        matched.add(m.student_number);
        if (isSource) {
          const alias = normalizeStudentNumberKey(original.studentId).toLowerCase();
          const targets = aliases.get(alias) ?? new Set<string>(); targets.add(m.student_number); aliases.set(alias, targets);
        }
        const resolvedName = m.full_name;
        if (row.student_id === m.student_number && row.name === resolvedName && (!full || (row.program === m.program && row.college === m.college && row.year_level === m.year_level)) && (!isSource || (row.masterlist_original && row.masterlist_status === resolution.status))) continue;
        changed.add(m.student_number);
        updates.push({ id: row.id, student_id: m.student_number, name: resolvedName, year_level: m.year_level, program: m.program, college: m.college, ...(isSource ? { masterlist_original: original, masterlist_status: resolution.status } : {}) });
      }
      if (isDerived) state.derivedUpdates.push(...updates);
      else if (updates.length) {
        const chunk = updates;
      const result = await client.query(`UPDATE ${table} t SET student_id=x.student_id,name=x.name${full ? ",year_level=x.year_level,program=x.program,college=x.college" : ""}${isSource ? ",masterlist_original=x.masterlist_original,masterlist_status=x.masterlist_status" : ""},updated_at=NOW() FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text,name text,year_level text,program text,college text,masterlist_original jsonb,masterlist_status text) WHERE t.id=x.id AND t.school_year_id=$1`, [schoolYear.id,JSON.stringify(chunk)]);
      summary.recordsUpdated += result.rowCount ?? 0;
      }
      processed = (cursor.offset ?? 0) + rows.length;
      if (rows.length < MASTERLIST_CHUNK_SIZE) {
        if (isDerived) {nextPhase = `dedupe:${table}`; nextCursor = {tableIndex:cursor.tableIndex};}
        else nextTable();
      } else nextCursor = {tableIndex:cursor.tableIndex,id:rows[rows.length-1].id,offset:processed};
    }
    percent = 10 + 50 * (grandTotal ? Math.min(1,(completed + Math.min(total,processed))/grandTotal) : 1);
    message = `Reconciling ${table}: ${processed} / ${total} rows`;
  } else if (phase === "remap_overrides") {
  await client.query(`DELETE FROM fines f USING attendance_records ar WHERE f.attendance_record_id=ar.id
    AND f.school_year_id=$1 AND ar.school_year_id=$1 AND ar.masterlist_status='unmatched' AND ${getAttendanceRecordVisibilitySql("ar")}`, [schoolYear.id]);
  await client.query(`UPDATE attendance_records ar SET no_of_absences=0,updated_at=NOW()
    WHERE ar.school_year_id=$1 AND ar.masterlist_status='unmatched' AND ar.no_of_absences<>0 AND ${getAttendanceRecordVisibilitySql("ar")}`, [schoolYear.id]);
  const overrideKeys = (await client.query<{ student_key: string }>(
    "SELECT DISTINCT student_key FROM attendance_student_event_overrides WHERE school_year_id=$1", [schoolYear.id],
  )).rows;
  for (const { student_key } of overrideKeys) {
    const alias = normalizeStudentNumberKey(student_key).toLowerCase();
    if (aliases.has(alias) || unresolvedAliases.has(alias)) continue;
    const key = normalizeStudentNumberKey(student_key);
    const master = isPlaceholderStudentNumber(student_key) ? undefined : index.ids.get(key);
    if (master) aliases.set(alias, new Set([master.student_number]));
  }
  const mapping = [...aliases].filter(([old, values]) => {
    const owner = index.ids.get(normalizeStudentNumberKey(old));
    return !owner || values.has(owner.student_number);
  }).filter(([, values]) => values.size === 1).filter(([old]) => !unresolvedAliases.has(old)).map(([old, values]) => ({ old, target: normalizeStudentNumberKey([...values][0]).toLowerCase() }));
  if (mapping.length) {
    const data = JSON.stringify(mapping);
    const rank = `WITH mapping AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(old text,target text)), ranked AS (SELECT o.id,ROW_NUMBER() OVER(PARTITION BY COALESCE(m.target,LOWER(public.masterlist_student_number_key(o.student_key))),o.event_id ORDER BY o.updated_at DESC,o.id DESC) AS rn FROM attendance_student_event_overrides o LEFT JOIN mapping m ON m.old=LOWER(public.masterlist_student_number_key(o.student_key)) WHERE o.school_year_id=$1)`;
    const merged = await client.query(`${rank} DELETE FROM attendance_student_event_overrides o USING ranked r WHERE r.rn>1 AND o.id=r.id AND o.school_year_id=$1`, [schoolYear.id,data]);
    summary.recordsUpdated += merged.rowCount ?? 0;
    const result = await client.query(`UPDATE attendance_student_event_overrides o SET student_key=m.target FROM jsonb_to_recordset($2::jsonb) AS m(old text,target text) WHERE o.school_year_id=$1 AND LOWER(public.masterlist_student_number_key(o.student_key))=m.old AND o.student_key<>m.target`, [schoolYear.id,data]);
    summary.recordsUpdated += result.rowCount ?? 0;
  }
    state.mapping = mapping;
    nextPhase = "update_students"; percent = 63; message = "Attendance overrides remapped.";
  } else if (phase === "update_students") {
    const mapping = state.mapping;
  // Batch global profiles; old identifiers are retained whenever another school year references them.
  if (matched.size) {
    await client.query("SELECT set_config('penalyze.masterlist_school_year',$1,true)",[schoolYear.id]);
    const values = JSON.stringify(index.rows.filter(row => matched.has(row.student_number)));
    const inserted = await client.query<{student_id:string}>(`INSERT INTO students(student_id,name,year_level,program,college)
      SELECT m.student_number,m.full_name,m.year_level,m.program,m.college
      FROM jsonb_to_recordset($1::jsonb) AS m(student_number text,full_name text,year_level text,program text,college text)
      WHERE NOT EXISTS (${otherTermReferences("m.student_number", "$2::uuid")})
      ON CONFLICT ((LOWER(TRIM(student_id)))) DO NOTHING RETURNING student_id`, [values,schoolYear.id]);
    const updated = await client.query<{student_id:string}>(`UPDATE students s SET student_id=m.student_number,name=m.full_name,year_level=m.year_level,program=m.program,college=m.college,updated_at=NOW()
      FROM jsonb_to_recordset($1::jsonb) AS m(student_number text,full_name text,year_level text,program text,college text)
      WHERE LOWER(TRIM(s.student_id))=LOWER(TRIM(m.student_number))
        AND (s.student_id,s.name,s.year_level,s.program,s.college) IS DISTINCT FROM (m.student_number,m.full_name,m.year_level,m.program,m.college)
        AND NOT EXISTS (${otherTermReferences("s.student_id", "$2::uuid")}) RETURNING s.student_id`, [values,schoolYear.id]);
    for (const student of [...inserted.rows,...updated.rows]) changed.add(student.student_id);
    await client.query(`DELETE FROM students s USING jsonb_to_recordset($1::jsonb) AS m(old text,target text) WHERE LOWER(TRIM(s.student_id))=m.old AND m.old<>m.target AND NOT EXISTS (${scopedTables.map(t => `SELECT 1 FROM ${t} WHERE public.masterlist_student_number_key(student_id)=public.masterlist_student_number_key(m.old)`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM attendance_student_event_overrides WHERE public.masterlist_student_number_key(student_key)=public.masterlist_student_number_key(m.old))`, [JSON.stringify(mapping)]);
  }
  await client.query("SELECT set_config('penalyze.masterlist_school_year','',true)");
  summary.studentsUpdated = changed.size;
    if (rebuild) { state.studentIds = await absenceStudentIds(client,schoolYear.id); nextPhase = "sync_absences"; nextCursor = {tableIndex:0,offset:0}; }
    else {done = true; nextPhase = "finalize";}
    percent = 68; message = "Student profiles updated.";
  } else if (phase === "sync_absences") {
    const offset = cursor.offset ?? 0;
    const chunk = state.studentIds.slice(offset,offset+RESUMABLE_ABSENCE_CHUNK_SIZE);
    if (chunk.length) await syncAbsencesForStudents(client,chunk,schoolYear.id,true,true);
    processed = offset+chunk.length; total = state.studentIds.length;
    percent = 68+12*(total ? processed/total : 1); message = `Synced absences: ${processed} / ${total} students`;
    nextCursor = {tableIndex:0,offset:processed};
    if (processed>=total) nextPhase = "refresh_final_results";
  } else if (phase === "refresh_final_results" || phase === "refresh_calculations" || phase === "refresh_penalties") {
    const final = phase === "refresh_final_results";
    const calculations = phase === "refresh_calculations";
    const start = final ? 80 : calculations ? 86 : 92;
    const end = start+6;
    const following = final ? "refresh_calculations" : calculations ? "refresh_penalties" : "finalize";
    const label = final ? "final results" : calculations ? "calculations" : "penalties";
    const completedMessage = final ? "Final attendance results refreshed." : calculations ? "Calculations refreshed." : "Penalties refreshed.";
    if (!checkpointRefresh) {
      if (final) await refreshAttendanceFinalResultsWithClient(client,{schoolYearId:schoolYear.id});
      else if (calculations) await refreshCalculationResultsWithClient(client,{schoolYearId:schoolYear.id});
      else await refreshPenaltyResultsForSchoolYearWithClient(client,schoolYear.id);
      nextPhase = following; percent = end; message = completedMessage;
    } else if (!state.refreshKeys) {
      state.refreshKeys = await prepareMasterlistDerivedRefresh(client,schoolYear.id,final || calculations);
      nextCursor = {tableIndex:0,refreshOffset:0};
      processed = 0; total = state.refreshKeys.length; percent = start;
      message = `Preparing ${label}: ${total} student keys`;
    } else {
      const offset = cursor.refreshOffset ?? 0;
      total = state.refreshKeys.length;
      if (offset < total) {
        const batchSize = cursor.refreshBatchSize ?? MASTERLIST_REFRESH_CHUNK_SIZE;
        const chunk = state.refreshKeys.slice(offset,offset+batchSize);
        const options = {schoolYearId:schoolYear.id,masterlistStudentKeys:chunk,resolveUnattachedEvents:false};
        if (final) await refreshAttendanceFinalResultsWithClient(client,options);
        else if (calculations) await refreshCalculationResultsWithClient(client,options);
        else await refreshPenaltyResultsForSchoolYearWithClient(client,schoolYear.id,undefined,chunk);
        processed = offset+chunk.length;
        nextCursor = {tableIndex:0,refreshOffset:processed,refreshBatchSize:batchSize};
        percent = start+(end-start)*processed/Math.max(1,total);
        message = `Refreshed ${label}: ${processed} / ${total} student keys`;
      } else {
        if (final || calculations) await finishMasterlistDerivedRefresh(client,schoolYear.id,final ? "attendance_final_results" : "calculation_results");
        // Refresh the key list for the next phase; never reuse an absence offset.
        delete state.refreshKeys;
        nextCursor = {tableIndex:0};
        processed = total; nextPhase = following; percent = end; message = completedMessage;
      }
    }
  } else if (phase === "finalize") {
    await client.query(`UPDATE student_masterlist_imports SET summary=$2 WHERE id=(SELECT id FROM student_masterlist_imports WHERE school_year_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)`, [schoolYear.id,JSON.stringify(summary)]);
    done = true; percent = 100; message = "Masterlist reconciled.";
  } else throw new Error("Invalid reconciliation phase.");
  state.seen = [...seen]; state.changed = [...changed]; state.unresolvedAliases = [...unresolvedAliases]; state.matched = [...matched];
  state.aliases = Object.fromEntries([...aliases].map(([key,values])=>[key,[...values]]));
  state.sourceProfiles = Object.fromEntries([...sourceProfiles].map(([key,values])=>[key,[...values]]));
  return {done,phase:nextPhase,cursor:nextCursor,state,processed,total,percent,message,result:done ? summary : undefined};
}
export async function reconcileWithClient(client: PoolClient, schoolYear: SchoolYearRecord, rebuild = true, cache: MasterlistCache = new Map(), onProgress?: ProgressCallback, isCancelled?: () => boolean) {
  const emit = progressReporter(onProgress,isCancelled);
  await client.query("SET LOCAL statement_timeout = '180s'");
  let state = await planReconciliation(client,schoolYear,cache), phase = `reconcile:${scopedTables[0]}`, cursor: ReconcileCursor = {tableIndex:0};
  while (true) {
    checkCancelled(isCancelled);
    const step = await reconcileStep(client,schoolYear,phase,cursor,state,rebuild,cache);
    emit({stage:reconciliationStage(phase),percent:step.percent,message:step.message,processed:step.processed,total:step.total});
    if (step.done) return state.summary;
    ({state,phase,cursor}=step);
    await yieldChunk(isCancelled);
  }
}
export async function planMasterlistMaintenance(client: PoolClient, job: MaintenanceJob) {
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE id=$1",[job.school_year_id])).rows[0];
  if (!isMasterlistSchoolYear(year)) throw bad("Invalid masterlist school year.");
  if (await getUploadCheckpoint(client,year.id)) throw bad("Resume or discard the unfinished masterlist upload first.");
  const state = await planReconciliation(client,year);
  return {total:state.totals.reduce((sum,count)=>sum+count,0),phase:job.kind === "masterlist_presence_rebuild" ? "normalize_masterlist" : `reconcile:${scopedTables[0]}`,cursor:{tableIndex:0},state};
}
// Only a rolled-back result batch can be reduced and replayed safely. Do not
// retry planning, the whole-term consistency audit, or other job kinds here.
export function smallerMasterlistRefreshCursor(job: MaintenanceJob): ReconcileCursor | null {
  if (job.kind !== "masterlist_presence_rebuild" && job.kind !== "masterlist_reconcile") return null;
  if (!["refresh_final_results", "refresh_calculations", "refresh_penalties"].includes(job.phase)) return null;
  const state = job.state as ReconcileState;
  const cursor = job.cursor as ReconcileCursor;
  const offset = cursor.refreshOffset;
  const size = cursor.refreshBatchSize ?? MASTERLIST_REFRESH_CHUNK_SIZE;
  if (offset === undefined || !state.refreshKeys || offset >= state.refreshKeys.length || size <= 1) return null;
  return {...cursor,refreshBatchSize:Math.max(1,Math.floor(size/2))};
}
export async function stepMasterlistMaintenance(client: PoolClient, job: MaintenanceJob) {
  const state = job.state as ReconcileState;
  return reconcileStep(client,state.summary.schoolYear,job.phase,job.cursor as ReconcileCursor,state,true,new Map(),true);
}

// Called inside the existing upload transaction, after its raw rows are saved.
// The caller holds the attendance synchronization lock and owns the derived refresh.
export async function reconcileMasterlistForAttendanceUpload(client: PoolClient, schoolYearId: string, cache: MasterlistCache) {
  const index = await loadMasterlist(client, schoolYearId, cache);
  if (!index.rows.length) return false;
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE id=$1", [schoolYearId])).rows[0];
  if (!isMasterlistSchoolYear(year)) return false;
  await reconcileWithClient(client, year, false, cache);
  return true;
}

export async function syncMasterlistAbsences(client: PoolClient, schoolYearId: string, onProgress?: ProgressCallback, isCancelled?: () => boolean) {
  const emit = progressReporter(onProgress, isCancelled);
  emit({ stage: "syncing_absences", percent: 68, message: "Preparing absence synchronization…" });
  const rows = (await client.query<{ student_id: string }>(`SELECT student_number AS student_id FROM student_masterlist WHERE school_year_id=$1 UNION SELECT DISTINCT ar.student_id FROM attendance_records ar WHERE school_year_id=$1 AND ${getAttendanceRecordVisibilitySql("ar")} AND ar.masterlist_status IS DISTINCT FROM 'unmatched'`, [schoolYearId])).rows;
  const ids = [...new Set<string>(rows.map(row => normalizeStudentNumberKey(row.student_id).toLowerCase()).filter(Boolean))];
  type SyncResult = Awaited<ReturnType<typeof syncAbsencesForStudents>>;
  const records = new Map<string, SyncResult["records"][number]>();
  const fines = new Map<string, SyncResult["fines"][number]>();
  const chunkSize = 250;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i,i + chunkSize);
    const chunkIndex = Math.floor(i / chunkSize) + 1;
    const chunkTotal = Math.ceil(ids.length / chunkSize);
    emit({ stage: "syncing_absences", percent: 68 + 12 * i / ids.length, message: `Syncing absences: ${i} / ${ids.length} students`, processed: i, total: ids.length, chunkIndex, chunkTotal });
    await yieldChunk(isCancelled);
    const result = await syncAbsencesForStudents(client, chunk, schoolYearId, true);
    for (const record of result.records) records.set(record.id,record);
    for (const fine of result.fines) fines.set(fine.id,fine);
    const processed = i + chunk.length;
    emit({ stage: "syncing_absences", percent: 68 + 12 * processed / ids.length, message: `Syncing absences: ${processed} / ${ids.length} students`, processed, total: ids.length, chunkIndex: Math.floor(i / chunkSize) + 1, chunkTotal: Math.ceil(ids.length / chunkSize) });
    await yieldChunk(isCancelled);
  }
  if (!ids.length) emit({ stage: "syncing_absences", percent: 80, message: "No absences to synchronize." });
  return { records: [...records.values()], fines: [...fines.values()] };
}

export async function uploadMasterlist(file: {originalname: string;buffer: Buffer}, actor?: string, onProgress?: ProgressCallback, isCancelled?: () => boolean) {
  const emit = progressReporter(onProgress, isCancelled);
  emit({ stage: "parsing", percent: 0, message: "Parsing masterlist…" });
  await yieldChunk(isCancelled);
  let workbook: XLSX.WorkBook;
  const extension = file.originalname.trim().toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (!file.buffer.length || file.buffer.length > 5 * 1024 * 1024) throw bad("Invalid masterlist size. Upload a file no larger than 5 MB.");
  if (extension !== ".xlsx" && extension !== ".csv") throw bad("Unsupported file. Please upload an .xlsx or .csv file.");
  const options = { cellFormula: false, cellHTML: false, sheetRows: 20001 };
  if (extension === ".xlsx") {
    if (!file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw bad("Invalid XLSX file signature.");
    try { validateXlsxContainer(file.buffer); }
    catch { throw bad("Invalid or oversized XLSX workbook archive."); }
    try { workbook = XLSX.read(file.buffer, { ...options, type: "buffer" }); }
    catch { throw bad("Unable to read the XLSX masterlist."); }
  } else {
    if (file.buffer.some(byte => byte < 0x09 || (byte > 0x0d && byte < 0x20))) throw bad("Invalid CSV text data.");
    let csv: string;
    try { csv = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); }
    catch { csv = new TextDecoder("windows-1252").decode(file.buffer); }
    try { workbook = XLSX.read(csv, { ...options, type: "string", raw: true }); }
    catch { throw bad("Unable to read the CSV masterlist."); }
  }
  const sheet = workbook.Sheets.Sheet1 ?? (/\.csv$/i.test(file.originalname) ? workbook.Sheets[workbook.SheetNames[0]] : undefined);
  if (!sheet) throw bad("Masterlist must contain Sheet1.");
  if (!sheet["!ref"]) throw bad("Masterlist is empty.");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r - range.s.r >= 20000 || range.e.c - range.s.c > 255) throw bad("Masterlist exceeds sheet limits.");
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:"",raw:false,blankrows:true});
  const header = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s/g, "");
  const headerIndex = raw.slice(0,20).findIndex(r => r.map(header).includes("studentnumber") && r.map(header).includes("lastname"));
  if (headerIndex < 0) throw bad("Masterlist header not found.");
  const headers = raw[headerIndex].map(header);
  const fields = ["studentnumber","lastname","givenname","middleinitial","degreeprogram","yearlevel"];
  if (fields.some(f => !headers.includes(f))) throw bad("Missing required masterlist column.");
  const rows: Array<Omit<StudentMasterlistRecord,"id"|"school_year_id"|"import_id"|"created_at"|"updated_at">> = [];
  const ids = new Set<string>(); let total=0, invalid=0;
  const invalidRows: string[] = [];
  for (const [offset, r] of raw.slice(headerIndex+1).entries()) {
    if (r.every(v => !String(v ?? "").trim()) || (r.map(header).includes("studentnumber") && r.map(header).includes("lastname"))) continue;
    total++;
    const get = (f:string) => String(r[headers.indexOf(f)] ?? "").trim();
    const student_number=normalizeStudentNumberKey(get("studentnumber")), student_number_key=student_number, last_name=repairNameMojibake(get("lastname")), given_name=repairNameMojibake(get("givenname")), middle_initial=get("middleinitial").replace(/\.+$/, "") || null;
    const program=cleanProgram(get("degreeprogram")); const year_level_key=normalizeYearLevelKey(get("yearlevel"));
    const year_level=({"1":"1st Year","2":"2nd Year","3":"3rd Year","4":"4th Year","5":"5th Year"} as Record<string,string>)[year_level_key ?? ""];
    const suppliedCollege = headers.includes("college") ? get("college") : "";
    const knownColleges = ["College of Business Administration", "College of Teacher Education", "College of Computing Studies", "College of Agriculture and Forestry", "College of Liberal Arts, Mathematics and Sciences", "School of Engineering", "School of Criminal Justice Education"];
    const college = suppliedCollege ? knownColleges.find(c => normalizeCollegeKey(c) === normalizeCollegeKey(suppliedCollege)) ?? null : collegeForProgram(program);
    const reasons = [
      !/^TC-\d{2}-[A-Z]-\d{5}$/.test(student_number_key) || isPlaceholderStudentNumber(student_number_key) ? "invalid student number" : "",
      !last_name || !given_name ? "missing name" : "", !year_level ? "invalid year level" : "",
      ids.has(student_number_key) ? "duplicate student number" : "", !college ? `unmapped degree program or college (${program || "blank"}${suppliedCollege ? ` / ${suppliedCollege}` : ""})` : "",
    ].filter(Boolean);
    if (reasons.length) { invalid++; invalidRows.push(`Row ${headerIndex + offset + 2}: ${student_number || "no ID"}: ${reasons.join(", ")}`); continue; }
    ids.add(student_number_key);
    rows.push({student_number,student_number_key,last_name,given_name,middle_initial,full_name:`${last_name}, ${given_name}${middle_initial ? ` ${middle_initial}.` : ""}`,name_key:normalizeNameKey(`${given_name} ${last_name}`),program,year_level,year_level_key,college});
  }
  if (invalidRows.length) throw bad(`Masterlist not replaced. Correct ${invalidRows.length} invalid row(s): ${invalidRows.join("; ")}`);
  if (!rows.length) throw bad("No valid masterlist students found.");
  emit({ stage: "parsing", percent: 5, message: `Parsed ${rows.length} valid students.` });
  const hash = createHash("sha256").update(file.buffer).digest("hex");
  const jobId = await withTransaction(async client => {
    await lockAttendanceAbsenceSync(client);
    const year = await activeYear(client);
    checkFilename(file.originalname,year);
    checkCancelled(isCancelled);
    await client.query("SELECT set_config('statement_timeout','180000ms',true)");
    const existing = await getUploadCheckpoint(client,year.id);
    if (existing) {
      if (existing.file_hash !== hash) throw bad("An unfinished masterlist upload exists. Resume it or discard it before uploading another file.");
      return existing.id;
    }
    const result = await client.query<{id:string}>(`INSERT INTO student_masterlist_upload_jobs(school_year_id,file_name,file_hash,rows_total,rows_valid,rows_invalid,source_rows,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,[year.id,file.originalname,hash,total,rows.length,invalid,JSON.stringify(rows),actor ?? null]);
    return result.rows[0].id;
  });
  return resumeMasterlistUpload(jobId,emit,isCancelled);
}

type MasterlistSummary = Awaited<ReturnType<typeof reconcileWithClient>>;
type UploadResult = { import: StudentMasterlistImportRecord; schoolYear: SchoolYearRecord; summary: MasterlistSummary };
type SourceRow = Omit<StudentMasterlistRecord,"id"|"school_year_id"|"import_id"|"created_at"|"updated_at">;
type UploadCheckpoint = {
  id:string; file_name:string; file_hash:string; rows_total:number; rows_valid:number; rows_invalid:number;
  phase:"staged"|"syncing"|"refreshing"; import_id:string|null; processed:number; total_students:number;
};
type UploadStep = { done:false; progress:MasterlistProgress } | { done:true; result:UploadResult };
const RESUMABLE_ABSENCE_CHUNK_SIZE = 25;

async function getUploadCheckpoint(client:PoolClient,schoolYearId:string) {
  return (await client.query<UploadCheckpoint>(`SELECT id,file_name,file_hash,rows_total,rows_valid,rows_invalid,phase,import_id,processed,cardinality(student_ids) AS total_students FROM student_masterlist_upload_jobs WHERE school_year_id=$1`,[schoolYearId])).rows[0] ?? null;
}
function absenceCheckpoint(processed:number,total:number):MasterlistProgress {
  return { stage:"syncing_absences",percent:total ? 68+12*processed/total : 80,message:`Saved absence synchronization: ${processed} / ${total} students`,processed,total, ...(total ? {chunkIndex:Math.max(1,Math.ceil(processed/RESUMABLE_ABSENCE_CHUNK_SIZE)),chunkTotal:Math.ceil(total/RESUMABLE_ABSENCE_CHUNK_SIZE)} : {}) };
}

// The source snapshot, identity reconciliation, and each absence batch have
// separate durable checkpoints. The checkpoint and its writes commit together.
// Keep identity remapping/deduplication and the derived refresh atomic.
export async function resumeMasterlistUpload(jobId:string,onProgress?:ProgressCallback,isCancelled?:()=>boolean):Promise<UploadResult> {
  const emit=progressReporter(onProgress,isCancelled);
  let announced=false;
  while (true) {
    checkCancelled(isCancelled);
    const step=await withTransaction<UploadStep>(async client=>{
      await lockAttendanceAbsenceSync(client);
      await client.query("SELECT set_config('statement_timeout','180000ms',true)");
      const year=await activeYear(client);
      const job=await getUploadCheckpoint(client,year.id);
      if (!job || job.id!==jobId) throw bad("The saved upload changed or was removed. Refresh the masterlist and try again.");
      checkCancelled(isCancelled);
      if (!announced) {
        if (job.phase==="staged") emit({stage:"saving_masterlist",percent:5,message:`${job.rows_valid} students saved in the upload checkpoint.`});
        else if (job.phase==="syncing") emit(absenceCheckpoint(job.processed,job.total_students));
        else emit({stage:"refreshing_final_results",percent:80,message:"Resuming the saved results refresh…"});
        announced=true;
      }
      if (job.phase==="staged") {
        const source=(await client.query<{source_rows:SourceRow[];created_by:string|null}>("SELECT source_rows,created_by FROM student_masterlist_upload_jobs WHERE id=$1",[job.id])).rows[0];
        const imported=(await client.query<StudentMasterlistImportRecord>("INSERT INTO student_masterlist_imports(school_year_id,file_name,rows_total,rows_valid,rows_invalid,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[year.id,job.file_name,job.rows_total,job.rows_valid,job.rows_invalid,source.created_by])).rows[0];
        await client.query("DELETE FROM student_masterlist WHERE school_year_id=$1",[year.id]);
        for (let i=0;i<source.source_rows.length;i+=MASTERLIST_CHUNK_SIZE) {
          const chunk=source.source_rows.slice(i,i+MASTERLIST_CHUNK_SIZE);
          await client.query(`INSERT INTO student_masterlist(school_year_id,import_id,student_number,student_number_key,last_name,given_name,middle_initial,full_name,name_key,program,year_level,year_level_key,college) SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(student_number text,student_number_key text,last_name text,given_name text,middle_initial text,full_name text,name_key text,program text,year_level text,year_level_key text,college text)`,[year.id,imported.id,JSON.stringify(chunk)]);
          const processed=i+chunk.length;
          emit({stage:"saving_masterlist",percent:5+5*processed/job.rows_valid,message:`Publishing masterlist: ${processed} / ${job.rows_valid} students`,processed,total:job.rows_valid,chunkIndex:Math.floor(i/MASTERLIST_CHUNK_SIZE)+1,chunkTotal:Math.ceil(job.rows_valid/MASTERLIST_CHUNK_SIZE)});
          await yieldChunk(isCancelled);
        }
        const summary=await reconcileWithClient(client,year,false,new Map(),emit,isCancelled);
        const students=(await client.query<{student_id:string}>(`SELECT DISTINCT LOWER(public.masterlist_student_number_key(ar.student_id)) AS student_id FROM attendance_records ar WHERE school_year_id=$1 AND ${getAttendanceRecordVisibilitySql("ar")} AND ar.masterlist_status IS DISTINCT FROM 'unmatched' AND NULLIF(TRIM(student_id),'') IS NOT NULL ORDER BY student_id`,[year.id])).rows.map(row=>row.student_id);
        await client.query("UPDATE student_masterlist_upload_jobs SET phase=$2,import_id=$3,summary=$4::jsonb,student_ids=$5::text[],source_rows='[]'::jsonb,processed=0,updated_at=NOW() WHERE id=$1",[job.id,students.length ? "syncing" : "refreshing",imported.id,JSON.stringify(summary),students]);
        await yieldChunk(isCancelled);
        return {done:false,progress:absenceCheckpoint(0,students.length)};
      }
      if (job.phase==="syncing") {
        const chunk=(await client.query<{ids:string[]}>("SELECT student_ids[($2::int):($3::int)] AS ids FROM student_masterlist_upload_jobs WHERE id=$1",[job.id,job.processed+1,job.processed+RESUMABLE_ABSENCE_CHUNK_SIZE])).rows[0].ids;
        if (!chunk.length) throw new Error("Invalid saved absence checkpoint.");
        emit({...absenceCheckpoint(job.processed,job.total_students),message:`Syncing absences: ${job.processed} / ${job.total_students} students`,chunkIndex:Math.floor(job.processed/RESUMABLE_ABSENCE_CHUNK_SIZE)+1});
        await syncAbsencesForStudents(client,chunk,year.id,true);
        const processed=job.processed+chunk.length;
        await client.query("UPDATE student_masterlist_upload_jobs SET processed=$2,phase=$3,updated_at=NOW() WHERE id=$1",[job.id,processed,processed===job.total_students ? "refreshing" : "syncing"]);
        await yieldChunk(isCancelled);
        return {done:false,progress:absenceCheckpoint(processed,job.total_students)};
      }
      const saved=(await client.query<{summary:MasterlistSummary|null}>("SELECT summary FROM student_masterlist_upload_jobs WHERE id=$1",[job.id])).rows[0];
      if (!saved.summary || !job.import_id) throw new Error("Invalid saved masterlist reconciliation checkpoint.");
      await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client,[year.id],progress=>{
        const stages=["refreshing_final_results","refreshing_calculations","refreshing_penalties"] as const;
        const messages=["Refreshing final attendance results…","Refreshing calculations…","Refreshing penalties…"];
        const index=stages.indexOf(progress.stage);
        emit({stage:progress.stage,percent:80+6*index,message:messages[index]});
      });
      await yieldChunk(isCancelled);
      emit({stage:"finalizing",percent:98,message:"Finalizing reconciliation…"});
      const imported=(await client.query<StudentMasterlistImportRecord>("UPDATE student_masterlist_imports SET summary=$2::jsonb WHERE id=$1 AND school_year_id=$3 RETURNING *",[job.import_id,JSON.stringify(saved.summary),year.id])).rows[0];
      if (!imported) throw new Error("The saved masterlist import no longer exists.");
      await client.query("DELETE FROM student_masterlist_upload_jobs WHERE id=$1",[job.id]);
      checkCancelled(isCancelled);
      return {done:true,result:{import:imported,schoolYear:year,summary:saved.summary}};
    });
    if (step.done) {
      onProgress?.({stage:"finalizing",percent:100,message:"Masterlist reconciled."});
      return step.result;
    }
    emit(step.progress);
    await yieldChunk(isCancelled);
  }
}

export const discardMasterlistUpload=(jobId:string)=>withTransaction(async client=>{
  await lockAttendanceAbsenceSync(client);
  const year=await activeYear(client);
  const job=await getUploadCheckpoint(client,year.id);
  if (!job || job.id!==jobId) throw bad("The saved upload changed. Refresh and try again.");
  if (job.phase!=="staged") throw bad("This upload has already published records. Resume it or use Delete masterlist to start over.");
  await client.query("DELETE FROM student_masterlist_upload_jobs WHERE id=$1",[job.id]);
  return {schoolYear:year,discardedRows:job.rows_valid};
});

export async function reconcileMasterlist(onProgress?: ProgressCallback, isCancelled?: () => boolean, actor?: string) {
  const year = await withTransaction(activeYear);
  const { createOrGetJob, runJob } = await import("./maintenance-jobs.service");
  const job = await createOrGetJob("masterlist_reconcile",year.id,null,actor);
  const finished = await runJob(job.id,onProgress,isCancelled);
  if (finished.status !== "completed") throw bad("Reconciliation paused. Resume the saved job.");
  return finished.result as MasterlistSummary;
}
export const deleteMasterlist = (importId: string) => withTransaction(async client => {
  await lockAttendanceAbsenceSync(client);
  const year = await activeYear(client);
  const latest = (await client.query<StudentMasterlistImportRecord>("SELECT * FROM student_masterlist_imports WHERE school_year_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [year.id])).rows[0];
  if (!latest || latest.id !== importId) throw bad("The masterlist changed since this page was loaded. Refresh and try again.");
  const pending=await getUploadCheckpoint(client,year.id);
  if (pending?.phase==="staged") throw bad("Discard the unfinished upload before deleting the published masterlist.");
  if (pending && pending.import_id!==importId) throw bad("The masterlist changed since this page was loaded. Refresh and try again.");
  const result = await client.query("DELETE FROM student_masterlist WHERE school_year_id=$1", [year.id]);
  if (pending) await client.query("DELETE FROM student_masterlist_upload_jobs WHERE id=$1",[pending.id]);
  await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client, [year.id]);
  return { schoolYear: year, deletedRows: result.rowCount ?? 0 };
});

export type MasterlistFilters = { schoolYearId?: string; search?: string; college?: string; yearLevel?: string; program?: string; limit?: number; offset?: number; includeUnmatched?: boolean };
function matchesSearch(studentNumber: string, name: string, search?: string) {
  const text = search?.trim();
  if (!text) return true;
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
  const searchKey = normalizeNameKey(text);
  const studentNameTokens = new Set(nameTokens(normalizeNameKey(name)));
  return fold(`${studentNumber} ${name}`).includes(fold(text)) ||
    (searchKey !== "" && nameTokens(searchKey).every(token => studentNameTokens.has(token))) ||
    (/^TC[-\s–—]*\d/i.test(text) && normalizeStudentNumberKey(studentNumber) === normalizeStudentNumberKey(text));
}
function filterRows<T extends {college: string|null; program: string|null; year_level: string|null; student_number: string; name?: string|null; full_name?: string}>(rows:T[],f:MasterlistFilters) {
  return rows.filter(r => (!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)) && (!f.yearLevel || normalizeYearLevelKey(r.year_level)===normalizeYearLevelKey(f.yearLevel)) && (!f.program || normalizeProgram(r.program)===normalizeProgram(f.program)) && matchesSearch(r.student_number, r.full_name ?? r.name ?? "", f.search));
}
const sortRows = <T extends {college:string|null;program:string|null;year_level:string|null;last_name:string|null;given_name:string|null;name?:string|null}>(rows:T[]) => rows.sort((a,b) => [a.college,a.program,a.year_level,a.last_name ?? a.name,a.given_name].map(v=>v??"").join("\0").localeCompare([b.college,b.program,b.year_level,b.last_name ?? b.name,b.given_name].map(v=>v??"").join("\0")));
export async function listMasterlist(f:MasterlistFilters) {
  const client=await pool.connect(); try {
    const years=(await client.query<SchoolYearRecord>("SELECT * FROM school_years ORDER BY is_active DESC, starts_at DESC")).rows;
    const schoolYear=years.find(isMasterlistSchoolYear) ?? null;
    const index=schoolYear ? await loadMasterlist(client,schoolYear.id) : null;
    const rows=sortRows(filterRows(index?.rows ?? [],f));
    const latest=schoolYear && index?.rows.length ? (await client.query<StudentMasterlistImportRecord>("SELECT * FROM student_masterlist_imports WHERE school_year_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[schoolYear.id])).rows[0] : null;
    const checkpoint=schoolYear ? await getUploadCheckpoint(client,schoolYear.id) : null;
    const pendingUpload=checkpoint ? {id:checkpoint.id,fileName:checkpoint.file_name,rowsValid:checkpoint.rows_valid,phase:checkpoint.phase,processed:checkpoint.processed,totalStudents:checkpoint.total_students,percent:checkpoint.phase==="staged" ? 5 : checkpoint.phase==="refreshing" ? 80 : absenceCheckpoint(checkpoint.processed,checkpoint.total_students).percent} : null;
    return {rows:rows.slice(f.offset ?? 0,(f.offset ?? 0)+(f.limit ?? 50)),total:rows.length,schoolYear,import:latest,pendingUpload};
  } finally {client.release();}
}

type EventColumn = { id:string; name:string; event_order:number|null; event_start_at:string|null };
type FinalRow = { student_number:string; name:string; last_name:string|null; given_name:string|null; middle_initial:string|null; program:string|null; year_level:string|null; college:string|null; attended_events:number; expected_events:number|null; total_absences:number|null; attendance_status:string; event_details:Record<string,"P"|"A"|"E"> };
async function withFinalAttendanceSnapshot<T>(work: (client: PoolClient) => Promise<T>, exportAll = false): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(exportAll ? "SET LOCAL statement_timeout = '120000ms'" : "SET LOCAL statement_timeout = '30000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
    console.error("[final-attendance]", error);
    throw error;
  } finally {
    client.release(releaseError);
  }
}
async function finalAttendanceSchoolYear(client: PoolClient, f: MasterlistFilters) {
  const schoolYear=(await client.query<SchoolYearRecord>(`SELECT * FROM school_years WHERE ${f.schoolYearId ? "id=$1" : "is_active"} ORDER BY starts_at DESC LIMIT 1`,f.schoolYearId ? [f.schoolYearId] : [])).rows[0];
  if (!schoolYear) throw bad("School year not found.");
  return schoolYear;
}
export async function getFinalAttendance(f:MasterlistFilters, exportAll=false) {
  return withFinalAttendanceSnapshot(async client => {
    const schoolYear=await finalAttendanceSchoolYear(client,f);
    const pending=await getUploadCheckpoint(client,schoolYear.id);
    if (pending && pending.phase!=="staged") throw Object.assign(new Error("Final attendance is being rebuilt. Resume the unfinished masterlist upload before viewing or exporting results."),{statusCode:409,expose:true});
    const index=await loadMasterlist(client,schoolYear.id);
    const hasMasterlist=index.rows.length>0;
    const events=(await client.query<EventColumn>("SELECT id,name,event_order,event_start_at FROM attendance_events WHERE school_year_id=$1 ORDER BY event_order NULLS LAST,COALESCE(event_start_at,event_end_at) NULLS LAST,name",[schoolYear.id])).rows;
    const baseFinals=hasMasterlist ? [] : await listAttendanceFinalResults({schoolYearId:schoolYear.id,consolidatedOnly:true,limit:2147483647,offset:0},client);
    const filteredMaster=sortRows(filterRows(index.rows,f));
    const filteredFinals=sortRows(filterRows(baseFinals.map(r=>({...r,student_number:r.student_id,last_name:null,given_name:null})),f));
    const start=f.offset ?? 0, end=start+(f.limit ?? 50);
    const pageMaster=exportAll ? filteredMaster : filteredMaster.slice(start,end);
    const pageFinals=exportAll ? filteredFinals : filteredFinals.slice(start,end);
    const studentKeys=[...new Set(hasMasterlist ? pageMaster.map(r=>normalizeStudentNumberKey(r.student_number)) : pageFinals.map(r=>normalizeStudentNumberKey(r.student_id)))];
    // Calculate the event/college roster once for the selected semester, and
    // reuse it for every page student (and every batch when exporting).
    const eventRosterScope=hasMasterlist || studentKeys.length
      ? (await client.query<{college_key:string;event_id:string}>(`WITH ${attendanceEventRosterScopeCteSql("$1")} SELECT college_key,event_id FROM event_roster_scope`,[schoolYear.id])).rows
      : [];
    const finals: Awaited<ReturnType<typeof listAttendanceFinalResults>> = [];
    const participation = new Map<string, Set<string>>();
    for (let i = 0; i < studentKeys.length; i += 200) {
      const keys = studentKeys.slice(i, i + 200);
      if (hasMasterlist) {
        // The masterlist view derives every cell and count from actual evidence.
        // Do not fetch stored final rows and repeat the per-student event scans.
        const observed = await client.query<{normalized_student_id:string;event_id:string}>(
          `WITH ${attendanceEventParticipationCteSql(true)} SELECT normalized_student_id,event_id FROM event_participation`,
          [keys.map(key => key.toLowerCase()), schoolYear.id],
        );
        for (const record of observed.rows) {
          const eventIds = participation.get(record.normalized_student_id) ?? new Set<string>();
          eventIds.add(record.event_id);
          participation.set(record.normalized_student_id, eventIds);
        }
      } else {
        finals.push(...await listAttendanceFinalResults({schoolYearId:schoolYear.id,consolidatedOnly:true,includeEventDetails:true,eventRosterScope,studentKeys:keys,limit:2147483647,offset:0},client));
      }
    }
    const finalByUuid = new Map(finals.map(r => [r.id, r]));
    const exemptions=(await client.query<{event_id:string;college_key:string|null;year_level_key:string|null}>(`SELECT x.event_id,x.college_key,NULL::text AS year_level_key FROM attendance_event_college_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1 UNION ALL SELECT x.event_id,x.college_key,x.year_level_key FROM attendance_event_year_level_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1`,[schoolYear.id])).rows;
    const roster = new Set<string>();
    if (hasMasterlist) {
      for (const r of eventRosterScope) roster.add(`${r.college_key}|${r.event_id}`);
    } else if (pageFinals.length && exemptions.some(x=>x.college_key===null)) {
      // Without a masterlist the whole-year roster only affects globally exempt cells.
      for (const row of await listFinalAttendanceEventRoster(client,schoolYear.id)) roster.add(`${normalizeCollegeKey(row.college)}|${row.event_id}`);
    }
    function eventValues(row:{college:string|null;year_level:string|null}, final:typeof finals[number]|undefined, studentKey?:string) {
      const values:FinalRow["event_details"]={};
      const c=normalizeCollegeKey(row.college), y=normalizeYearLevelKey(row.year_level);
      const detail=new Map((final?.event_details ?? []).map(d=>[d.id,d]));
      for(const event of events) {
        const d=detail.get(event.id);
        const observed=studentKey ? participation.get(normalizeStudentNumberKey(studentKey).toLowerCase())?.has(event.id) === true : false;
        const applies=roster.has(`${c}|${event.id}`) || (!hasMasterlist && !!d) || observed;
        const exempt=exemptions.some(x=>x.event_id===event.id && (x.college_key===null || normalizeCollegeKey(x.college_key)===c) && (x.year_level_key===null || normalizeYearLevelKey(x.year_level_key)===y));
        if(exempt && (applies || (!!c && exemptions.some(x=>x.event_id===event.id && x.college_key!==null && normalizeCollegeKey(x.college_key)===c)))) values[event.id]="E";
        else if(hasMasterlist && observed) values[event.id]="P";
        else if(applies && hasMasterlist) values[event.id]="A";
        else if(d) values[event.id]=d.attended ? "P" : "A";
      }
      return values;
    }
    const rows:FinalRow[]=hasMasterlist ? pageMaster.map(m=>{
      const event_details=eventValues(m,undefined,m.student_number_key);
      const values=Object.values(event_details);
      const attended_events=values.filter(value=>value==="P").length;
      const total_absences=values.filter(value=>value==="A").length;
      const expected_events=attended_events+total_absences;
      return {student_number:m.student_number,name:m.full_name,last_name:m.last_name,given_name:m.given_name,middle_initial:m.middle_initial,program:m.program,year_level:m.year_level,college:m.college,attended_events,expected_events,total_absences,attendance_status:expected_events===0 ? "No attendance record" : total_absences>0 ? "with_absences" : "perfect_attendance",event_details};
    }) : pageFinals.map(r=>({student_number:r.student_id,name:r.name,last_name:null,given_name:null,middle_initial:null,program:r.program,year_level:r.year_level,college:r.college,attended_events:r.attended_events,expected_events:r.expected_events,total_absences:r.total_absences,attendance_status:r.attendance_status,event_details:eventValues(r,finalByUuid.get(r.id))}));
    const includeUnmatched=exportAll || f.includeUnmatched === true;
    const unmatched=includeUnmatched ? await loadUnmatched(client,schoolYear.id,index,f) : [];
    const programRows=hasMasterlist ? index.rows : baseFinals;
    return {rows,total:hasMasterlist ? filteredMaster.length : filteredFinals.length,schoolYear,events,unmatched,unmatchedCount:includeUnmatched ? unmatched.length : null,hasMasterlist,programs:[...new Set(programRows.filter(r=>!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)).map(r=>r.program).filter((p):p is string=>!!p))].sort()};
  }, exportAll);
}
async function loadUnmatched(client: PoolClient, schoolYearId: string, index: MasterIndex, f: MasterlistFilters) {
    const unmatched:Array<{student_id:string;name:string;college:string|null;program:string|null;year_level:string|null;reason:string}>=[];
    if(index.rows.length) {
      const source=(await client.query<Existing>(`SELECT DISTINCT ON (LOWER(TRIM(student_id)),name) * FROM (SELECT ar.id,COALESCE(ar.masterlist_original->>'studentId',ar.student_id) AS student_id,COALESCE(ar.masterlist_original->>'name',ar.name) AS name,COALESCE(ar.masterlist_original->>'college',ar.college) AS college,COALESCE(ar.masterlist_original->>'program',ar.program) AS program,COALESCE(ar.masterlist_original->>'yearLevel',ar.year_level) AS year_level FROM attendance_records ar WHERE ar.school_year_id=$1 AND ${getAttendanceRecordVisibilitySql("ar")} UNION ALL SELECT id,COALESCE(masterlist_original->>'studentId',student_id),COALESCE(masterlist_original->>'name',name),COALESCE(masterlist_original->>'college',college),COALESCE(masterlist_original->>'program',program),COALESCE(masterlist_original->>'yearLevel',year_level) FROM manual_attendance_records WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_final_results WHERE school_year_id=$1 AND import_id IS NULL UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_requests WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,college,program,year_level FROM calculation_results WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,NULL::text,NULL::text,NULL::text FROM penalty_results WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,NULL::text,NULL::text,NULL::text FROM fines WHERE school_year_id=$1) q ORDER BY LOWER(TRIM(student_id)),name,(college IS NOT NULL) DESC,(program IS NOT NULL) DESC`,[schoolYearId])).rows;
      for(const row of source) if(resolve(index,{studentId:row.student_id,name:row.name,college:row.college,program:row.program}).status==="unmatched") unmatched.push({student_id:row.student_id,name:row.name,college:row.college,program:row.program,year_level:row.year_level,reason:resolve(index,{studentId:row.student_id,name:row.name,college:row.college,program:row.program}).reason ?? "No unique masterlist match"});
    }
    const filteredUnmatched=unmatched.filter(r=>(!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)) && (!f.yearLevel || normalizeYearLevelKey(r.year_level)===normalizeYearLevelKey(f.yearLevel)) && (!f.program || normalizeProgram(r.program)===normalizeProgram(f.program)) && matchesSearch(r.student_id,r.name,f.search));
    return filteredUnmatched;
}
export async function getFinalAttendanceUnmatched(f: MasterlistFilters) {
  return withFinalAttendanceSnapshot(async client => {
    const schoolYear=await finalAttendanceSchoolYear(client,f);
    const pending=await getUploadCheckpoint(client,schoolYear.id);
    if (pending && pending.phase!=="staged") throw Object.assign(new Error("Final attendance is being rebuilt. Resume the unfinished masterlist upload before viewing or exporting results."),{statusCode:409,expose:true});
    const index=await loadMasterlist(client,schoolYear.id);
    const rows=await loadUnmatched(client,schoolYear.id,index,f);
    const offset=f.offset ?? 0;
    return {rows:rows.slice(offset,offset+(f.limit ?? 50)),total:rows.length};
  });
}
export async function exportFinalAttendance(f:MasterlistFilters) {
  const result=await getFinalAttendance(f,true);
  const headers=["Student Number","Last Name","Given Name","Middle Initial","Program","Year Level","College",...result.events.map(e=>e.name),"Attended Events","Expected Events","Total Absences","Status"];
  const sheet=XLSX.utils.aoa_to_sheet([headers,...result.rows.map(r=>[r.student_number,r.last_name ?? r.name,r.given_name,r.middle_initial,r.program,r.year_level,r.college,...result.events.map(e=>r.event_details[e.id] ?? ""),r.attended_events,r.expected_events,r.total_absences,r.attendance_status])]);
  sheet["!cols"]=headers.map((h,i)=>({wch:i===4?55:i===6?45:Math.max(14,Math.min(30,h.length+2))}));
  // SheetJS CE does not serialize freeze panes; modify the generated ZIP using its bundled CFB utility.
  const workbook=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook,sheet,"Final Attendance");
  if(result.hasMasterlist){const other=XLSX.utils.aoa_to_sheet([["Student ID","Name","College","Program","Reason"],...result.unmatched.map(r=>[r.student_id,r.name,r.college,r.program,r.reason])]); other["!cols"]=[{wch:22},{wch:36},{wch:45},{wch:55},{wch:35}]; XLSX.utils.book_append_sheet(workbook,other,"Unmatched");}
  const generated:Buffer=XLSX.write(workbook,{type:"buffer",bookType:"xlsx"});
  const cfb=(XLSX as unknown as {CFB:{read:(data:Buffer,options:{type:string})=>{FullPaths:string[];FileIndex:{content:Uint8Array;size:number}[]};write:(archive:unknown,options:{type:string;fileType:string;compression:boolean})=>Buffer}}).CFB;
  const archive=cfb.read(generated,{type:"buffer"});
  for(let i=0;i<archive.FullPaths.length;i++) {
    if(!/\/xl\/worksheets\/sheet\d+\.xml$/.test(archive.FullPaths[i])) continue;
    const entry=archive.FileIndex[i];
    const pane='<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
    let xml=Buffer.from(entry.content).toString("utf8");
    if(/<sheetView\b[^>]*\/>/.test(xml)) xml=xml.replace(/<sheetView\b([^>]*?)\/>/,`<sheetView$1>${pane}</sheetView>`);
    else if(/<sheetView\b[^>]*>/.test(xml)) xml=xml.replace(/<sheetView\b[^>]*>/,match=>match+pane);
    else xml=xml.replace(/<sheetData[ >]/,match=>`<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>${match}`);
    entry.content=Buffer.from(xml);entry.size=entry.content.length;
  }
  const buffer=cfb.write(archive,{type:"buffer",fileType:"zip",compression:true});
  return {buffer,filename:`final-attendance-${result.schoolYear.name}-${result.schoolYear.semester}.xlsx`.replace(/[^a-zA-Z0-9._ -]/g,"-")};
}
