import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import * as XLSX from "xlsx";
import type { MasterlistStatus, SchoolYearRecord, StudentMasterlistRecord, StudentMasterlistImportRecord, ParsedAttendanceRow } from "../database/model/schema.model";
import { pool, withTransaction } from "../lib/db";
import { getSchoolYearMetadataLabels, validateXlsxContainer, normalizeYearLevelKey, normalizeCollegeKey, lockAttendanceAbsenceSync, refreshDerivedAttendanceResultsForSchoolYearsWithClient, listAttendanceFinalResults, listFinalAttendanceEventRoster, syncAbsencesForStudents, ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL } from "./attendance.service";
import { getAttendanceRecordVisibilitySql } from "./attendance-result-visibility";
import { normalizeStudentNumberKey, normalizeNameKey, normalizeProgram, cleanProgram, collegeForProgram, parseStudentNumberParts, isPlaceholderStudentNumber, nameTokens, nameTokensAgree, nameKeysAgree, sharedNameTokenCount, nameTokenSignatures } from "./masterlist-normalize";

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
type Resolution = { status: MasterlistStatus; master?: StudentMasterlistRecord };
type MasterIndex = { rows: StudentMasterlistRecord[]; ids: Map<string, StudentMasterlistRecord>; names: Map<string, StudentMasterlistRecord[]>; tokens: Map<string, StudentMasterlistRecord[]>; serials: Map<string, StudentMasterlistRecord[]> };
export type MasterlistCache = Map<string, MasterIndex>;

export async function loadMasterlist(client: PoolClient, schoolYearId: string, cache: MasterlistCache = new Map()): Promise<MasterIndex> {
  const cached = cache.get(schoolYearId); if (cached) return cached;
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE id=$1", [schoolYearId])).rows[0];
  const rows = isMasterlistSchoolYear(year) ? (await client.query<StudentMasterlistRecord>("SELECT * FROM student_masterlist WHERE school_year_id=$1", [schoolYearId])).rows : [];
  const index: MasterIndex = { rows, ids: new Map(), names: new Map(), tokens: new Map(), serials: new Map() };
  for (const row of rows) {
    const parts = parseStudentNumberParts(row.student_number_key);
    if (parts) {
      index.ids.set(row.student_number_key, row);
      const serialRows = index.serials.get(parts.serial) ?? [];
      serialRows.push(row); index.serials.set(parts.serial, serialRows);
    }
    index.names.set(row.name_key, [...(index.names.get(row.name_key) ?? []), row]);
    for (const signature of new Set(nameTokens(row.name_key).flatMap(nameTokenSignatures))) {
      const candidates = index.tokens.get(signature) ?? [];
      candidates.push(row); index.tokens.set(signature, candidates);
    }
  }
  cache.set(schoolYearId, index); return index;
}
function narrowCandidates(candidates: StudentMasterlistRecord[], profile: Profile): StudentMasterlistRecord[] {
  if (candidates.length > 1 && profile.college) {
    const narrowed = candidates.filter(r => normalizeCollegeKey(r.college) === normalizeCollegeKey(profile.college));
    if (narrowed.length) candidates = narrowed;
  }
  if (candidates.length > 1 && profile.program) {
    const narrowed = candidates.filter(r => normalizeProgram(r.program) === normalizeProgram(profile.program));
    if (narrowed.length) candidates = narrowed;
  }
  return candidates;
}
function resolve(index: MasterIndex, profile: Profile): Resolution {
  if (!index.rows.length) return { status: "no_masterlist" };
  const id = normalizeStudentNumberKey(profile.studentId);
  const nameKey = normalizeNameKey(profile.name);
  const placeholder = isPlaceholderStudentNumber(profile.studentId);
  const master = placeholder ? undefined : index.ids.get(id);
  if (master) return { status: nameKeysAgree(nameKey, master.name_key) ? "matched_by_id" : "id_name_mismatch", master };
  const parts = placeholder ? null : parseStudentNumberParts(profile.studentId);
  if (parts) {
    let candidates = (index.serials.get(parts.serial) ?? []).filter(r => {
      const candidate = parseStudentNumberParts(r.student_number_key);
      return candidate && (!parts.year || candidate.year === parts.year) && (!parts.letter || candidate.letter === parts.letter);
    });
    if (nameKey) {
      candidates = candidates.filter(r =>
        nameTokens(normalizeNameKey(r.last_name)).some(surname => nameTokens(nameKey).some(token => nameTokensAgree(token, surname))) ||
        sharedNameTokenCount(nameKey, r.name_key) >= 2);
    } else {
      const college = normalizeCollegeKey(profile.college);
      candidates = college ? candidates.filter(r => normalizeCollegeKey(r.college) === college) : [];
    }
    candidates = narrowCandidates(candidates, profile);
    if (candidates.length === 1) return { status: "matched_by_partial_id", master: candidates[0] };
  }
  if (!nameKey) return { status: "unmatched" };
  const candidates = narrowCandidates([...new Set(nameTokens(nameKey).flatMap(nameTokenSignatures)
    .flatMap(signature => index.tokens.get(signature) ?? []))].filter(r =>
      !isPlaceholderStudentNumber(r.student_number_key) && nameKeysAgree(nameKey, r.name_key)), profile);
  return candidates.length === 1 ? { status: "matched_by_name", master: candidates[0] } : { status: "unmatched" };
}
export async function resolveStudentAgainstMasterlist(client: PoolClient, schoolYearId: string, profile: Profile, cache: MasterlistCache = new Map()): Promise<Resolution> {
  return resolve(await loadMasterlist(client, schoolYearId, cache), profile);
}
export async function reconcileAttendanceRow(client: PoolClient, schoolYearId: string, row: ParsedAttendanceRow, cache: MasterlistCache): Promise<ParsedAttendanceRow> {
  const result = await resolveStudentAgainstMasterlist(client, schoolYearId, row, cache);
  const m = result.master;
  if (!m) {
    const key = normalizeStudentNumberKey(row.studentId);
    const studentId = /^TC-\d{2}-[A-Z]-\d{5}$/.test(key) ? key : row.studentId;
    return { ...row, studentId, masterlist_status: result.status === "no_masterlist" ? row.masterlist_status : result.status, masterlist_original: row.masterlist_original ?? (studentId !== row.studentId ? { studentId: row.studentId, name: row.name } : undefined) };
  }
  const changed = row.studentId !== m.student_number || row.name !== m.full_name || row.college !== (m.college ?? undefined) || row.program !== (m.program ?? undefined) || row.yearLevel !== (m.year_level ?? undefined);
  return { ...row, studentId: m.student_number, name: m.full_name, college: m.college ?? undefined, program: m.program ?? undefined, yearLevel: m.year_level ?? undefined, masterlist_status: result.status, masterlist_original: row.masterlist_original ?? (changed ? { studentId: row.studentId, name: row.name } : undefined), errors: row.errors.filter(e => !e.includes(": unrecognised college ") && e !== "Student ID is required." && e !== "Name is required.") };
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
type Existing = { id: string; student_id: string; name: string; program: string | null; college: string | null; year_level: string | null };
async function reconcileWithClient(client: PoolClient, schoolYear: SchoolYearRecord, rebuild = true, cache: MasterlistCache = new Map(), onProgress?: ProgressCallback, isCancelled?: () => boolean) {
  const emit = progressReporter(onProgress, isCancelled);
  emit({ stage: "reconciling_records", percent: 10, message: "Counting attendance records…" });
  await client.query("SELECT set_config('statement_timeout','180000ms',true)");
  await client.query("SELECT set_config('lock_timeout','60000ms',true)");
  const index = await loadMasterlist(client, schoolYear.id, cache);
  if (!index.rows.length) throw bad("Upload a masterlist before reconciling.");
  const summary = { schoolYear, masterlistRows: index.rows.length, matchedById: 0, matchedByPartialId: 0, matchedByName: 0, idNameMismatches: 0, unmatched: 0, studentsUpdated: 0, recordsUpdated: 0, unmappedPrograms: [...new Set(index.rows.filter(r => !r.college).map(r => r.program ?? ""))] };
  const seen = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const changed = new Set<string>();
  const unresolvedAliases = new Set<string>();
  const sourceProfiles = new Map<string, Set<StudentMasterlistRecord>>();
  const matched = new Map<string, StudentMasterlistRecord>();
  const totals = new Map<string, number>();
  const resolutionCache = new Map<string, Resolution>();
  for (const table of scopedTables) {
    const count = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table} WHERE school_year_id=$1`, [schoolYear.id]);
    totals.set(table, Number(count.rows[0].count));
    await yieldChunk(isCancelled);
  }
  const grandTotal = [...totals.values()].reduce((sum, count) => sum + count, 0);
  let completed = 0;
  for (const table of scopedTables) {
    const full = profileTables.includes(table);
    const total = totals.get(table) ?? 0;
    const chunkTotal = Math.ceil(total / MASTERLIST_CHUNK_SIZE);
    const tableProgress = (fraction: number) => 10 + 50 * (grandTotal ? (completed + total * fraction) / grandTotal : 1);
    const updates: Array<{ id: string; student_id: string; name: string; year_level: string | null; program: string | null; college: string | null }> = [];
    let cursor: string | null = null;
    let processed = 0;
    while (true) {
      const rows: Existing[] = (await client.query<Existing>(`SELECT id,student_id,name,${full ? "program,college,year_level" : "NULL::text AS program,NULL::text AS college,NULL::text AS year_level"} FROM ${table} WHERE school_year_id=$1${cursor === null ? "" : " AND id > $2::uuid"} ORDER BY id LIMIT ${MASTERLIST_CHUNK_SIZE}`, cursor === null ? [schoolYear.id] : [schoolYear.id,cursor])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const profileKey = JSON.stringify([row.student_id, row.name, row.program, row.college]);
        let resolution = resolutionCache.get(profileKey);
        if (!resolution) {
          resolution = resolve(index, { studentId: row.student_id, name: row.name, program: row.program, college: row.college });
          resolutionCache.set(profileKey, resolution);
        }
        const key = `${normalizeStudentNumberKey(row.student_id)}|${normalizeNameKey(row.name)}`;
        // Profile-less derived records can inherit a unique authoritative match from
        // the scoped source rows, but never guess between conflicting people.
        const prior = sourceProfiles.get(key);
        if (resolution.status === "unmatched" && !full && prior?.size === 1) {
          resolution = { status: "matched_by_name", master: [...prior][0] };
        }
        if (!seen.has(key)) { seen.add(key); if (resolution.status === "matched_by_id") summary.matchedById++; else if (resolution.status === "matched_by_partial_id") summary.matchedByPartialId++; else if (resolution.status === "matched_by_name") summary.matchedByName++; else if (resolution.status === "id_name_mismatch") summary.idNameMismatches++; else summary.unmatched++; }
        const m = resolution.master;
        if (!m) {
          unresolvedAliases.add(row.student_id.trim().toLowerCase());
          const canonical = normalizeStudentNumberKey(row.student_id);
          if (/^TC-\d{2}-[A-Z]-\d{5}$/.test(canonical) && canonical !== row.student_id) {
            updates.push({ ...row, student_id: canonical });
          }
          continue;
        }
        if (full) {
          const profiles = sourceProfiles.get(key) ?? new Set<StudentMasterlistRecord>();
          profiles.add(m); sourceProfiles.set(key, profiles);
        }
        matched.set(m.student_number, m);
        const alias = row.student_id.trim().toLowerCase();
        const targets = aliases.get(alias) ?? new Set<string>(); targets.add(m.student_number); aliases.set(alias, targets);
        if (row.student_id === m.student_number && row.name === m.full_name && (!full || (row.program === m.program && row.college === m.college && row.year_level === m.year_level))) continue;
        changed.add(m.student_number);
        updates.push({ id: row.id, student_id: m.student_number, name: m.full_name, year_level: m.year_level, program: m.program, college: m.college });
      }
      processed += rows.length;
      cursor = rows[rows.length - 1].id;
      emit({ stage: "reconciling_records", percent: tableProgress(0.5 * Math.min(1,processed / Math.max(1,total))), message: `Reconciling ${table}: ${processed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} rows`, table, processed, total, chunkIndex: Math.ceil(processed / MASTERLIST_CHUNK_SIZE), chunkTotal });
      await yieldChunk(isCancelled);
    }
    if (!updates.length) {
      emit({ stage: "reconciling_records", percent: tableProgress(1), message: `Reconciled ${table}: ${processed} / ${total} rows`, table, processed, total });
      completed += total;
      continue;
    }
    const scope = table === "attendance_final_results" ? ", t.import_id" : table === "calculation_results" ? ", t.calculation_scope_key" : "";
    if (["attendance_final_results", "calculation_results", "penalty_results"].includes(table)) {
      checkCancelled(isCancelled);
      const data = JSON.stringify(updates);
      // Retain one derived record per unique key before updating IDs, prioritizing settled penalties.
      const ranking = `WITH changes AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text)), ranked AS (SELECT t.id, first_value(t.id) OVER w AS keep_id,row_number() OVER w AS rn FROM ${table} t LEFT JOIN changes c ON c.id=t.id WHERE t.school_year_id=$1 WINDOW w AS (PARTITION BY LOWER(TRIM(COALESCE(c.student_id,t.student_id)))${scope} ORDER BY ${table === "penalty_results" ? "CASE t.status WHEN 'paid' THEN 0 WHEN 'waived' THEN 1 ELSE 2 END," : ""} t.updated_at DESC,t.id DESC))`;
      if (table !== "penalty_results") await client.query(`${ranking} UPDATE penalty_results p SET source_record_id=r.keep_id FROM ranked r WHERE r.rn>1 AND p.school_year_id=$1 AND p.source_table='${table}' AND p.source_record_id=r.id`, [schoolYear.id,data]);
      const merged = await client.query(`${ranking} DELETE FROM ${table} t USING ranked r WHERE r.rn>1 AND t.id=r.id AND t.school_year_id=$1`, [schoolYear.id,data]);
      summary.recordsUpdated += merged.rowCount ?? 0;
    }
    await yieldChunk(isCancelled);
    for (let i = 0; i < updates.length; i += MASTERLIST_CHUNK_SIZE) {
      const chunk = updates.slice(i,i + MASTERLIST_CHUNK_SIZE);
      const result = await client.query(`UPDATE ${table} t SET student_id=x.student_id,name=x.name${full ? ",year_level=x.year_level,program=x.program,college=x.college" : ""},updated_at=NOW() FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text,name text,year_level text,program text,college text) WHERE t.id=x.id AND t.school_year_id=$1`, [schoolYear.id,JSON.stringify(chunk)]);
      summary.recordsUpdated += result.rowCount ?? 0;
      const applied = i + chunk.length;
      emit({ stage: "reconciling_records", percent: tableProgress(0.5 + 0.5 * applied / updates.length), message: `Updating ${table}: ${applied.toLocaleString("en-US")} / ${updates.length.toLocaleString("en-US")} rows`, table, processed: applied, total: updates.length, chunkIndex: Math.floor(i / MASTERLIST_CHUNK_SIZE) + 1, chunkTotal: Math.ceil(updates.length / MASTERLIST_CHUNK_SIZE) });
      await yieldChunk(isCancelled);
    }
    completed += total;
  }
  emit({ stage: "remapping_overrides", percent: 60, message: "Remapping attendance overrides…" });
  await yieldChunk(isCancelled);
  const overrideKeys = (await client.query<{ student_key: string }>(
    "SELECT DISTINCT student_key FROM attendance_student_event_overrides WHERE school_year_id=$1", [schoolYear.id],
  )).rows;
  for (const { student_key } of overrideKeys) {
    if (aliases.has(student_key) || unresolvedAliases.has(student_key)) continue;
    const key = normalizeStudentNumberKey(student_key);
    const master = isPlaceholderStudentNumber(student_key) ? undefined : index.ids.get(key);
    if (master) aliases.set(student_key, new Set([master.student_number]));
  }
  const mapping = [...aliases].filter(([, values]) => values.size === 1).filter(([old]) => !unresolvedAliases.has(old)).map(([old, values]) => ({ old, target: [...values][0].toLowerCase() }));
  if (mapping.length) {
    const data = JSON.stringify(mapping);
    const rank = `WITH mapping AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(old text,target text)), ranked AS (SELECT o.id,ROW_NUMBER() OVER(PARTITION BY COALESCE(m.target,o.student_key),o.event_id ORDER BY o.updated_at DESC,o.id DESC) AS rn FROM attendance_student_event_overrides o LEFT JOIN mapping m ON m.old=o.student_key WHERE o.school_year_id=$1)`;
    const merged = await client.query(`${rank} DELETE FROM attendance_student_event_overrides o USING ranked r WHERE r.rn>1 AND o.id=r.id AND o.school_year_id=$1`, [schoolYear.id,data]);
    summary.recordsUpdated += merged.rowCount ?? 0;
    const result = await client.query(`UPDATE attendance_student_event_overrides o SET student_key=m.target FROM jsonb_to_recordset($2::jsonb) AS m(old text,target text) WHERE o.school_year_id=$1 AND o.student_key=m.old AND o.student_key<>m.target`, [schoolYear.id,data]);
    summary.recordsUpdated += result.rowCount ?? 0;
  }
  emit({ stage: "updating_students", percent: 63, message: "Updating student profiles…" });
  await yieldChunk(isCancelled);
  // Batch global profiles; old identifiers are retained whenever another school year references them.
  if (matched.size) {
    await client.query("SELECT set_config('penalyze.masterlist_school_year',$1,true)",[schoolYear.id]);
    const values = JSON.stringify([...matched.values()]);
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
  if (rebuild) {
    await syncMasterlistAbsences(client, schoolYear.id, emit, isCancelled);
    await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client,[schoolYear.id], progress => {
      const stages = ["refreshing_final_results", "refreshing_calculations", "refreshing_penalties"] as const;
      const messages = ["Refreshing final attendance results…", "Refreshing calculations…", "Refreshing penalties…"];
      const step = stages.indexOf(progress.stage);
      emit({ stage: progress.stage, percent: 80 + 18 * ((progress.scopeIndex - 1) * 3 + step) / (progress.scopeTotal * 3), message: messages[step] });
    });
    await yieldChunk(isCancelled);
    emit({ stage: "finalizing", percent: 98, message: "Finalizing reconciliation…" });
  }
  return summary;
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
  const rows = (await client.query<{ student_id: string }>("SELECT DISTINCT student_id FROM attendance_records WHERE school_year_id=$1 AND deleted_at IS NULL", [schoolYearId])).rows;
  const ids = [...new Set(rows.map(row => row.student_id.trim().toLowerCase()).filter(Boolean))];
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
  for (const r of raw.slice(headerIndex+1)) {
    if (r.every(v => !String(v ?? "").trim()) || (r.map(header).includes("studentnumber") && r.map(header).includes("lastname"))) continue;
    total++;
    const get = (f:string) => String(r[headers.indexOf(f)] ?? "").trim();
    const student_number=normalizeStudentNumberKey(get("studentnumber")), student_number_key=student_number, last_name=get("lastname"), given_name=get("givenname"), middle_initial=get("middleinitial").replace(/\.+$/, "") || null;
    const program=cleanProgram(get("degreeprogram")); const year_level_key=normalizeYearLevelKey(get("yearlevel"));
    const year_level=({"1":"1st Year","2":"2nd Year","3":"3rd Year","4":"4th Year"} as Record<string,string>)[year_level_key ?? ""];
    if (!/^TC-\d{2}-[A-Z]-\d{5}$/.test(student_number_key) || isPlaceholderStudentNumber(student_number_key) || !last_name || !given_name || !year_level || ids.has(student_number_key)) { invalid++; continue; }
    ids.add(student_number_key);
    rows.push({student_number,student_number_key,last_name,given_name,middle_initial,full_name:`${last_name}, ${given_name}${middle_initial ? ` ${middle_initial}.` : ""}`,name_key:normalizeNameKey(`${given_name} ${last_name}`),program,year_level,year_level_key,college:collegeForProgram(program)});
  }
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
        const students=(await client.query<{student_id:string}>("SELECT DISTINCT LOWER(TRIM(student_id)) AS student_id FROM attendance_records WHERE school_year_id=$1 AND deleted_at IS NULL AND NULLIF(TRIM(student_id),'') IS NOT NULL ORDER BY student_id",[year.id])).rows.map(row=>row.student_id);
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

export async function reconcileMasterlist(onProgress?: ProgressCallback, isCancelled?: () => boolean) {
  const emit = progressReporter(onProgress, isCancelled);
  const result = await withTransaction(async client => {
    await client.query("SELECT set_config('statement_timeout','180000ms',true)");
    await client.query("SELECT set_config('lock_timeout','60000ms',true)");
    emit({ stage: "reconciling_records", percent: 0, message: "Waiting for the attendance database lock…" });
    await lockAttendanceAbsenceSync(client);
    emit({ stage: "reconciling_records", percent: 2, message: "Lock acquired. Checking active school year and upload state…" });
    const year = await activeYear(client);
    if (await getUploadCheckpoint(client,year.id)) throw bad("Resume or discard the unfinished masterlist upload first.");
    const summary = await reconcileWithClient(client, year, true, new Map(), emit, isCancelled);
    await client.query(`UPDATE student_masterlist_imports SET summary=$2 WHERE id=(SELECT id FROM student_masterlist_imports WHERE school_year_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)`, [year.id, JSON.stringify(summary)]);
    await yieldChunk(isCancelled);
    return summary;
  });
  onProgress?.({ stage: "finalizing", percent: 100, message: "Masterlist reconciled." });
  return result;
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
async function withFinalAttendanceSnapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120000ms'");
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
    const studentKeys=[...new Set(hasMasterlist ? pageMaster.map(r=>r.student_number_key) : pageFinals.map(r=>normalizeStudentNumberKey(r.student_id)))];
    const finals: Awaited<ReturnType<typeof listAttendanceFinalResults>> = [];
    const joined: {student_number_key:string;final_id:string|null}[] = [];
    for(let i=0;i<studentKeys.length;i+=200) {
      const keys=studentKeys.slice(i,i+200);
      finals.push(...await listAttendanceFinalResults({schoolYearId:schoolYear.id,consolidatedOnly:true,includeEventDetails:true,studentKeys:keys,limit:2147483647,offset:0},client));
      if(hasMasterlist) joined.push(...(await client.query<{student_number_key:string;final_id:string|null}>(`SELECT DISTINCT ON (m.student_number_key) m.student_number_key,f.id AS final_id FROM student_masterlist m LEFT JOIN attendance_final_results f ON f.school_year_id=m.school_year_id AND f.import_id IS NULL AND public.masterlist_student_number_key(f.student_id)=m.student_number_key WHERE m.school_year_id=$1 AND m.student_number_key = ANY($2::text[]) ORDER BY m.student_number_key,f.updated_at DESC NULLS LAST`,[schoolYear.id,keys])).rows);
    }
    const finalByUuid=new Map(finals.map(r=>[r.id,r]));
    const byId=new Map(joined.map(r=>[r.student_number_key,r.final_id ? finalByUuid.get(r.final_id) : undefined]));
    const exemptions=(await client.query<{event_id:string;college_key:string|null;year_level_key:string|null}>(`SELECT x.event_id,x.college_key,NULL::text AS year_level_key FROM attendance_event_college_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1 UNION ALL SELECT x.event_id,x.college_key,x.year_level_key FROM attendance_event_year_level_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1`,[schoolYear.id])).rows;
    const roster = new Set<string>();
    if (hasMasterlist) {
      const scope = await client.query<{ college_key: string; event_id: string }>(`WITH ${ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL} SELECT college_key,event_id FROM event_roster_scope WHERE school_year_id=$1`, [schoolYear.id]);
      for (const r of scope.rows) roster.add(`${r.college_key}|${r.event_id}`);
    } else if (pageFinals.length && exemptions.some(x=>x.college_key===null)) {
      // Without a masterlist the whole-year roster only affects globally exempt cells.
      for (const row of await listFinalAttendanceEventRoster(client,schoolYear.id)) roster.add(`${normalizeCollegeKey(row.college)}|${row.event_id}`);
    }
    function eventValues(row:{college:string|null;year_level:string|null}, final:typeof finals[number]|undefined) {
      const values:FinalRow["event_details"]={};
      const c=normalizeCollegeKey(row.college), y=normalizeYearLevelKey(row.year_level);
      const detail=new Map((final?.event_details ?? []).map(d=>[d.id,d]));
      for(const event of events) {
        const d=detail.get(event.id);
        const applies=roster.has(`${c}|${event.id}`) || !!d;
        const exempt=exemptions.some(x=>x.event_id===event.id && (x.college_key===null || normalizeCollegeKey(x.college_key)===c) && (x.year_level_key===null || normalizeYearLevelKey(x.year_level_key)===y));
        if(exempt && (applies || (!!c && exemptions.some(x=>x.event_id===event.id && x.college_key!==null && normalizeCollegeKey(x.college_key)===c)))) values[event.id]="E";
        else if(d) values[event.id]=d.attended ? "P" : "A";
        else if(applies && hasMasterlist) values[event.id]="A";
      }
      return values;
    }
    const rows:FinalRow[]=hasMasterlist ? pageMaster.map(m=>{const r=byId.get(m.student_number_key);return {student_number:m.student_number,name:m.full_name,last_name:m.last_name,given_name:m.given_name,middle_initial:m.middle_initial,program:m.program,year_level:m.year_level,college:m.college,attended_events:r?.attended_events ?? 0,expected_events:r?.expected_events ?? null,total_absences:r?.total_absences ?? null,attendance_status:r?.attendance_status ?? "No attendance record",event_details:eventValues(m,r)};}) : pageFinals.map(r=>({student_number:r.student_id,name:r.name,last_name:null,given_name:null,middle_initial:null,program:r.program,year_level:r.year_level,college:r.college,attended_events:r.attended_events,expected_events:r.expected_events,total_absences:r.total_absences,attendance_status:r.attendance_status,event_details:eventValues(r,finalByUuid.get(r.id))}));
    const includeUnmatched=exportAll || f.includeUnmatched === true;
    const unmatched=includeUnmatched ? await loadUnmatched(client,schoolYear.id,index,f) : [];
    const programRows=hasMasterlist ? index.rows : baseFinals;
    return {rows,total:hasMasterlist ? filteredMaster.length : filteredFinals.length,schoolYear,events,unmatched,unmatchedCount:includeUnmatched ? unmatched.length : null,hasMasterlist,programs:[...new Set(programRows.filter(r=>!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)).map(r=>r.program).filter((p):p is string=>!!p))].sort()};
  });
}
async function loadUnmatched(client: PoolClient, schoolYearId: string, index: MasterIndex, f: MasterlistFilters) {
    const unmatched:Array<{student_id:string;name:string;college:string|null;program:string|null;year_level:string|null;reason:string}>=[];
    if(index.rows.length) {
      const source=(await client.query<Existing>(`SELECT DISTINCT ON (LOWER(TRIM(student_id)),name) * FROM (SELECT ar.id,ar.student_id,ar.name,ar.college,ar.program,ar.year_level FROM attendance_records ar WHERE ar.school_year_id=$1 AND ${getAttendanceRecordVisibilitySql("ar")} UNION ALL SELECT id,student_id,name,college,program,year_level FROM manual_attendance_records WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_final_results WHERE school_year_id=$1 AND import_id IS NULL UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_requests WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,college,program,year_level FROM calculation_results WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,NULL::text,NULL::text,NULL::text FROM penalty_results WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,NULL::text,NULL::text,NULL::text FROM fines WHERE school_year_id=$1) q ORDER BY LOWER(TRIM(student_id)),name,(college IS NOT NULL) DESC,(program IS NOT NULL) DESC`,[schoolYearId])).rows;
      for(const row of source) if(resolve(index,{studentId:row.student_id,name:row.name,college:row.college,program:row.program}).status==="unmatched") unmatched.push({student_id:row.student_id,name:row.name,college:row.college,program:row.program,year_level:row.year_level,reason:"No unique masterlist match"});
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
