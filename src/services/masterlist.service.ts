import type { PoolClient } from "pg";
import * as XLSX from "xlsx";
import type { MasterlistStatus, SchoolYearRecord, StudentMasterlistRecord, StudentMasterlistImportRecord, ParsedAttendanceRow } from "../database/model/schema.model";
import { pool, withTransaction } from "../lib/db";
import { getSchoolYearMetadataLabels, validateXlsxContainer, normalizeYearLevelKey, normalizeCollegeKey, lockAttendanceAbsenceSync, refreshDerivedAttendanceResultsForSchoolYearsWithClient, listAttendanceFinalResults } from "./attendance.service";
import { normalizeStudentNumberKey, normalizeNameKey, normalizeProgram, cleanProgram, collegeForProgram } from "./masterlist-normalize";

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
export function isMasterlistSchoolYear(year: SchoolYearRecord | undefined | null): boolean {
  return !!year && year.semester === "first_semester" && (getSchoolYearMetadataLabels(year).some(label => /2026\s*[-–—/]\s*2027/.test(label)) || (new Date(year.starts_at).getUTCFullYear() === 2026 && new Date(year.ends_at).getUTCFullYear() === 2027));
}
async function activeYear(client: PoolClient) {
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE is_active ORDER BY starts_at DESC LIMIT 1")).rows[0];
  if (!isMasterlistSchoolYear(year)) throw bad("Masterlist is only available for the active 1st Semester, A.Y. 2026-2027.");
  return year;
}
function checkFilename(file: string) {
  const semesters = [...file.matchAll(/(?:\b|_)(1ST|2ND|FIRST|SECOND)[\s_-]*SEMESTER/gi)];
  const years = [...file.matchAll(/(\d{4})\s*[-–—]\s*(\d{4})/g)];
  if (semesters.some(m => !/^(1ST|FIRST)$/i.test(m[1])) || years.some(m => m[1] !== "2026" || m[2] !== "2027")) throw bad("The filename conflicts with the active school year.");
}
type Profile = { studentId: string; name: string; program?: string | null; college?: string | null };
type Resolution = { status: MasterlistStatus; master?: StudentMasterlistRecord };
type MasterIndex = { rows: StudentMasterlistRecord[]; ids: Map<string, StudentMasterlistRecord>; names: Map<string, StudentMasterlistRecord[]>; tokens: Map<string, StudentMasterlistRecord[]> };
export type MasterlistCache = Map<string, MasterIndex>;
const tokens = (key: string) => [...new Set(key.split(" ").filter(Boolean))];
const contains = (system: Set<string>, master: string) => !!master && tokens(master).every(t => system.has(t));
export async function loadMasterlist(client: PoolClient, schoolYearId: string, cache: MasterlistCache = new Map()): Promise<MasterIndex> {
  const cached = cache.get(schoolYearId); if (cached) return cached;
  const year = (await client.query<SchoolYearRecord>("SELECT * FROM school_years WHERE id=$1", [schoolYearId])).rows[0];
  const rows = isMasterlistSchoolYear(year) ? (await client.query<StudentMasterlistRecord>("SELECT * FROM student_masterlist WHERE school_year_id=$1", [schoolYearId])).rows : [];
  const index: MasterIndex = { rows, ids: new Map(), names: new Map(), tokens: new Map() };
  for (const row of rows) {
    index.ids.set(row.student_number_key, row);
    index.names.set(row.name_key, [...(index.names.get(row.name_key) ?? []), row]);
    for (const token of tokens(row.name_key)) index.tokens.set(token, [...(index.tokens.get(token) ?? []), row]);
  }
  cache.set(schoolYearId, index); return index;
}
function resolve(index: MasterIndex, profile: Profile): Resolution {
  if (!index.rows.length) return { status: "no_masterlist" };
  const id = normalizeStudentNumberKey(profile.studentId);
  const nameKey = normalizeNameKey(profile.name);
  const nameTokens = new Set(tokens(nameKey));
  const master = /-00000$/.test(id) ? undefined : index.ids.get(id);
  if (master) return { status: contains(nameTokens, master.name_key) ? "matched_by_id" : "id_name_mismatch", master };
  let candidates = [...new Set([...(index.names.get(nameKey) ?? []), ...[...nameTokens].flatMap(t => index.tokens.get(t) ?? []).filter(r => contains(nameTokens, r.name_key))])];
  if (candidates.length > 1 && profile.college) candidates = candidates.filter(r => normalizeCollegeKey(r.college) === normalizeCollegeKey(profile.college));
  if (candidates.length > 1 && profile.program) candidates = candidates.filter(r => normalizeProgram(r.program) === normalizeProgram(profile.program));
  return candidates.length === 1 ? { status: "matched_by_name", master: candidates[0] } : { status: "unmatched" };
}
export async function resolveStudentAgainstMasterlist(client: PoolClient, schoolYearId: string, profile: Profile, cache: MasterlistCache = new Map()): Promise<Resolution> {
  return resolve(await loadMasterlist(client, schoolYearId, cache), profile);
}
export async function reconcileAttendanceRow(client: PoolClient, schoolYearId: string, row: ParsedAttendanceRow, cache: MasterlistCache): Promise<ParsedAttendanceRow> {
  const result = await resolveStudentAgainstMasterlist(client, schoolYearId, row, cache);
  if (result.status === "no_masterlist") return row;
  const m = result.master;
  if (!m) return { ...row, masterlist_status: result.status };
  const changed = row.studentId !== m.student_number || row.name !== m.full_name || row.college !== (m.college ?? undefined) || row.program !== (m.program ?? undefined) || row.yearLevel !== (m.year_level ?? undefined);
  return { ...row, studentId: m.student_number, name: m.full_name, college: m.college ?? undefined, program: m.program ?? undefined, yearLevel: m.year_level ?? undefined, masterlist_status: result.status, masterlist_original: row.masterlist_original ?? (changed ? { studentId: row.studentId, name: row.name } : undefined), errors: row.errors.filter(e => !e.includes(": unrecognised college ")) };
}

const scopedTables = ["attendance_records", "manual_attendance_records", "attendance_requests", "attendance_final_results", "calculation_results", "penalty_results", "fines"] as const;
const profileTables = scopedTables.slice(0, 5);
// Never overwrite a global profile with evidence belonging to another term.
export async function upsertMasterlistStudent(client: PoolClient, year: string, row: ParsedAttendanceRow) {
  await client.query("SELECT set_config('penalyze.masterlist_school_year',$1,true)",[year]);
  await client.query(`INSERT INTO students(student_id,name,year_level,program,college,institution) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT ((LOWER(TRIM(student_id)))) DO UPDATE SET student_id=EXCLUDED.student_id,name=EXCLUDED.name,year_level=EXCLUDED.year_level,program=EXCLUDED.program,college=EXCLUDED.college,updated_at=NOW()
    WHERE NOT EXISTS (${scopedTables.map(t => `SELECT 1 FROM ${t} WHERE school_year_id IS DISTINCT FROM $7::uuid AND LOWER(TRIM(student_id))=LOWER(TRIM($1))`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM attendance_student_event_overrides WHERE school_year_id IS DISTINCT FROM $7::uuid AND student_key=LOWER(TRIM($1)))`, [row.studentId,row.name,row.yearLevel ?? null,row.program ?? null,row.college ?? null,row.institution ?? null,year]);
  await client.query("SELECT set_config('penalyze.masterlist_school_year','',true)");
}
type Existing = { id: string; student_id: string; name: string; program: string | null; college: string | null; year_level: string | null };
async function reconcileWithClient(client: PoolClient, schoolYear: SchoolYearRecord) {
  await client.query("SELECT set_config('statement_timeout','180000ms',true)");
  const index = await loadMasterlist(client, schoolYear.id);
  if (!index.rows.length) throw bad("Upload a masterlist before reconciling.");
  const summary = { schoolYear, masterlistRows: index.rows.length, matchedById: 0, matchedByName: 0, idNameMismatches: 0, unmatched: 0, studentsUpdated: 0, recordsUpdated: 0, unmappedPrograms: [...new Set(index.rows.filter(r => !r.college).map(r => r.program ?? ""))] };
  const seen = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const changed = new Set<string>();
  const matched = new Map<string, StudentMasterlistRecord>();
  for (const table of scopedTables) {
    const full = profileTables.includes(table);
    const rows = (await client.query<Existing>(`SELECT id,student_id,name,${full ? "program,college,year_level" : "NULL::text AS program,NULL::text AS college,NULL::text AS year_level"} FROM ${table} WHERE school_year_id=$1`, [schoolYear.id])).rows;
    const updates: Array<{ id: string; student_id: string; name: string; year_level: string | null; program: string | null; college: string | null }> = [];
    for (const row of rows) {
      const resolution = resolve(index, { studentId: row.student_id, name: row.name, program: row.program, college: row.college });
      const key = `${normalizeStudentNumberKey(row.student_id)}|${normalizeNameKey(row.name)}`;
      if (!seen.has(key)) { seen.add(key); if (resolution.status === "matched_by_id") summary.matchedById++; else if (resolution.status === "matched_by_name") summary.matchedByName++; else if (resolution.status === "id_name_mismatch") summary.idNameMismatches++; else summary.unmatched++; }
      const m = resolution.master; if (!m) continue;
      matched.set(m.student_number, m);
      const alias = row.student_id.trim().toLowerCase();
      const targets = aliases.get(alias) ?? new Set<string>(); targets.add(m.student_number); aliases.set(alias, targets);
      if (row.student_id === m.student_number && row.name === m.full_name && (!full || (row.program === m.program && row.college === m.college && row.year_level === m.year_level))) continue;
      changed.add(m.student_number);
      updates.push({ id: row.id, student_id: m.student_number, name: m.full_name, year_level: m.year_level, program: m.program, college: m.college });
    }
    if (!updates.length) continue;
    const data = JSON.stringify(updates);
    const scope = table === "attendance_final_results" ? ", t.import_id" : table === "calculation_results" ? ", t.calculation_scope_key" : "";
    if (["attendance_final_results", "calculation_results", "penalty_results"].includes(table)) {
      // Retain one derived record per unique key before updating IDs, prioritizing settled penalties.
      const ranking = `WITH changes AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text)), ranked AS (SELECT t.id, first_value(t.id) OVER w AS keep_id,row_number() OVER w AS rn FROM ${table} t LEFT JOIN changes c ON c.id=t.id WHERE t.school_year_id=$1 WINDOW w AS (PARTITION BY LOWER(TRIM(COALESCE(c.student_id,t.student_id)))${scope} ORDER BY ${table === "penalty_results" ? "CASE t.status WHEN 'paid' THEN 0 WHEN 'waived' THEN 1 ELSE 2 END," : ""} t.updated_at DESC,t.id DESC))`;
      if (table !== "penalty_results") await client.query(`${ranking} UPDATE penalty_results p SET source_record_id=r.keep_id FROM ranked r WHERE r.rn>1 AND p.school_year_id=$1 AND p.source_table='${table}' AND p.source_record_id=r.id`, [schoolYear.id,data]);
      await client.query(`${ranking} DELETE FROM ${table} t USING ranked r WHERE r.rn>1 AND t.id=r.id AND t.school_year_id=$1`, [schoolYear.id,data]);
    }
    const result = await client.query(`UPDATE ${table} t SET student_id=x.student_id,name=x.name${full ? ",year_level=x.year_level,program=x.program,college=x.college" : ""},updated_at=NOW() FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,student_id text,name text,year_level text,program text,college text) WHERE t.id=x.id AND t.school_year_id=$1`, [schoolYear.id,data]);
    summary.recordsUpdated += result.rowCount ?? 0;
  }
  const mapping = [...aliases].filter(([, values]) => values.size === 1).map(([old, values]) => ({ old, target: [...values][0].toLowerCase() }));
  if (mapping.length) {
    const data = JSON.stringify(mapping);
    const rank = `WITH mapping AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(old text,target text)), ranked AS (SELECT o.id,ROW_NUMBER() OVER(PARTITION BY COALESCE(m.target,o.student_key),o.event_id ORDER BY o.updated_at DESC,o.id DESC) AS rn FROM attendance_student_event_overrides o LEFT JOIN mapping m ON m.old=o.student_key WHERE o.school_year_id=$1)`;
    await client.query(`${rank} DELETE FROM attendance_student_event_overrides o USING ranked r WHERE r.rn>1 AND o.id=r.id AND o.school_year_id=$1`, [schoolYear.id,data]);
    const result = await client.query(`UPDATE attendance_student_event_overrides o SET student_key=m.target FROM jsonb_to_recordset($2::jsonb) AS m(old text,target text) WHERE o.school_year_id=$1 AND o.student_key=m.old AND o.student_key<>m.target`, [schoolYear.id,data]);
    summary.recordsUpdated += result.rowCount ?? 0;
  }
  // Batch global profiles; old identifiers are retained whenever another school year references them.
  if (matched.size) {
    await client.query("SELECT set_config('penalyze.masterlist_school_year',$1,true)",[schoolYear.id]);
    const values = JSON.stringify([...matched.values()]);
    await client.query(`INSERT INTO students(student_id,name,year_level,program,college) SELECT student_number,full_name,year_level,program,college FROM jsonb_to_recordset($1::jsonb) AS m(student_number text,full_name text,year_level text,program text,college text) ON CONFLICT ((LOWER(TRIM(student_id)))) DO NOTHING`, [values]);
    await client.query(`UPDATE students s SET student_id=m.student_number,name=m.full_name,year_level=m.year_level,program=m.program,college=m.college,updated_at=NOW() FROM jsonb_to_recordset($1::jsonb) AS m(student_number text,full_name text,year_level text,program text,college text) WHERE LOWER(TRIM(s.student_id))=LOWER(TRIM(m.student_number)) AND NOT EXISTS (${scopedTables.map(t => `SELECT 1 FROM ${t} WHERE school_year_id IS DISTINCT FROM $2::uuid AND LOWER(TRIM(student_id))=LOWER(TRIM(s.student_id))`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM attendance_student_event_overrides WHERE school_year_id IS DISTINCT FROM $2::uuid AND student_key=LOWER(TRIM(s.student_id)))`, [values,schoolYear.id]);
    await client.query(`DELETE FROM students s USING jsonb_to_recordset($1::jsonb) AS m(old text,target text) WHERE LOWER(TRIM(s.student_id))=m.old AND m.old<>m.target AND NOT EXISTS (${scopedTables.map(t => `SELECT 1 FROM ${t} WHERE LOWER(TRIM(student_id))=m.old`).join(" UNION ALL ")} UNION ALL SELECT 1 FROM attendance_student_event_overrides WHERE student_key=m.old)`, [JSON.stringify(mapping)]);
  }
  await client.query("SELECT set_config('penalyze.masterlist_school_year','',true)");
  summary.studentsUpdated = changed.size;
  await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client,[schoolYear.id]);
  return summary;
}

export async function uploadMasterlist(file: {originalname: string;buffer: Buffer}, actor?: string) {
  checkFilename(file.originalname);
  let workbook: XLSX.WorkBook;
  try {
    if (!file.buffer.length || file.buffer.length > 5 * 1024 * 1024) throw bad("Invalid masterlist size.");
    if (/\.xlsx$/i.test(file.originalname)) validateXlsxContainer(file.buffer);
    else if (file.buffer.includes(0)) throw bad("Invalid CSV text.");
    workbook = XLSX.read(file.buffer, {type:"buffer", cellFormula:false,cellHTML:false,sheetRows:20001});
  } catch { throw bad("Unable to read masterlist."); }
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
    const student_number=get("studentnumber"), student_number_key=normalizeStudentNumberKey(student_number), last_name=get("lastname"), given_name=get("givenname"), middle_initial=get("middleinitial").replace(/\.+$/, "") || null;
    const program=cleanProgram(get("degreeprogram")); const year_level_key=normalizeYearLevelKey(get("yearlevel"));
    const year_level=({"1":"1st Year","2":"2nd Year","3":"3rd Year","4":"4th Year"} as Record<string,string>)[year_level_key ?? ""];
    if (!/^TC-\d{2}-[A-Z]-\d{5}$/.test(student_number_key) || !last_name || !given_name || !year_level || ids.has(student_number_key)) { invalid++; continue; }
    ids.add(student_number_key);
    rows.push({student_number,student_number_key,last_name,given_name,middle_initial,full_name:`${last_name}, ${given_name}${middle_initial ? ` ${middle_initial}.` : ""}`,name_key:normalizeNameKey(`${given_name} ${last_name}`),program,year_level,year_level_key,college:collegeForProgram(program)});
  }
  if (!rows.length) throw bad("No valid masterlist students found.");
  return withTransaction(async client => {
    await lockAttendanceAbsenceSync(client); const schoolYear=await activeYear(client);
    const imported=(await client.query<StudentMasterlistImportRecord>("INSERT INTO student_masterlist_imports(school_year_id,file_name,rows_total,rows_valid,rows_invalid,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[schoolYear.id,file.originalname,total,rows.length,invalid,actor ?? null])).rows[0];
    await client.query("DELETE FROM student_masterlist WHERE school_year_id=$1",[schoolYear.id]);
    await client.query(`INSERT INTO student_masterlist(school_year_id,import_id,student_number,student_number_key,last_name,given_name,middle_initial,full_name,name_key,program,year_level,year_level_key,college) SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(student_number text,student_number_key text,last_name text,given_name text,middle_initial text,full_name text,name_key text,program text,year_level text,year_level_key text,college text)`,[schoolYear.id,imported.id,JSON.stringify(rows)]);
    const summary=await reconcileWithClient(client,schoolYear);
    const saved=(await client.query<StudentMasterlistImportRecord>("UPDATE student_masterlist_imports SET summary=$2 WHERE id=$1 RETURNING *",[imported.id,JSON.stringify(summary)])).rows[0];
    return {import:saved,schoolYear,summary};
  });
}
export const reconcileMasterlist = () => withTransaction(async client => { await lockAttendanceAbsenceSync(client); return reconcileWithClient(client,await activeYear(client)); });
export const deleteMasterlist = () => withTransaction(async client => { await lockAttendanceAbsenceSync(client); const year=await activeYear(client); await client.query("DELETE FROM student_masterlist WHERE school_year_id=$1",[year.id]); return {schoolYear:year}; });

export type MasterlistFilters = { schoolYearId?: string; search?: string; college?: string; yearLevel?: string; program?: string; limit?: number; offset?: number };
function filterRows<T extends {college: string|null; program: string|null; year_level: string|null; student_number: string; name?: string|null; full_name?: string}>(rows:T[],f:MasterlistFilters) {
  return rows.filter(r => (!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)) && (!f.yearLevel || normalizeYearLevelKey(r.year_level)===normalizeYearLevelKey(f.yearLevel)) && (!f.program || normalizeProgram(r.program).includes(normalizeProgram(f.program))) && (!f.search || `${r.student_number} ${r.full_name ?? r.name ?? ""}`.toLowerCase().includes(f.search.toLowerCase())));
}
const sortRows = <T extends {college:string|null;program:string|null;year_level:string|null;last_name:string|null;given_name:string|null;name?:string|null}>(rows:T[]) => rows.sort((a,b) => [a.college,a.program,a.year_level,a.last_name ?? a.name,a.given_name].map(v=>v??"").join("\0").localeCompare([b.college,b.program,b.year_level,b.last_name ?? b.name,b.given_name].map(v=>v??"").join("\0")));
export async function listMasterlist(f:MasterlistFilters) {
  const client=await pool.connect(); try {
    const years=(await client.query<SchoolYearRecord>("SELECT * FROM school_years ORDER BY is_active DESC, starts_at DESC")).rows;
    const schoolYear=years.find(isMasterlistSchoolYear) ?? null;
    const index=schoolYear ? await loadMasterlist(client,schoolYear.id) : null;
    const rows=sortRows(filterRows(index?.rows ?? [],f));
    const latest=schoolYear && index?.rows.length ? (await client.query<StudentMasterlistImportRecord>("SELECT * FROM student_masterlist_imports WHERE school_year_id=$1 ORDER BY created_at DESC LIMIT 1",[schoolYear.id])).rows[0] : null;
    return {rows:rows.slice(f.offset ?? 0,(f.offset ?? 0)+(f.limit ?? 50)),total:rows.length,schoolYear,import:latest};
  } finally {client.release();}
}

type EventColumn = { id:string; name:string; event_order:number|null; event_start_at:string|null };
type FinalRow = { student_number:string; name:string; last_name:string|null; given_name:string|null; middle_initial:string|null; program:string|null; year_level:string|null; college:string|null; attended_events:number; expected_events:number|null; total_absences:number|null; attendance_status:string; event_details:Record<string,"P"|"A"|"E"> };
export async function getFinalAttendance(f:MasterlistFilters, exportAll=false) {
  const client=await pool.connect();
  try {
    const schoolYear=(await client.query<SchoolYearRecord>(`SELECT * FROM school_years WHERE ${f.schoolYearId ? "id=$1" : "is_active"} ORDER BY starts_at DESC LIMIT 1`,f.schoolYearId ? [f.schoolYearId] : [])).rows[0];
    if (!schoolYear) throw bad("School year not found.");
    const index=await loadMasterlist(client,schoolYear.id);
    const hasMasterlist=index.rows.length>0;
    const events=(await client.query<EventColumn>("SELECT id,name,event_order,event_start_at FROM attendance_events WHERE school_year_id=$1 ORDER BY event_order NULLS LAST,COALESCE(event_start_at,event_end_at) NULLS LAST,name",[schoolYear.id])).rows;
    const finals=await listAttendanceFinalResults({schoolYearId:schoolYear.id,consolidatedOnly:true,includeEventDetails:true,limit:2147483647,offset:0},client);
    const finalByUuid=new Map(finals.map(r=>[r.id,r]));
    const joined=hasMasterlist ? (await client.query<{student_number_key:string;final_id:string|null}>(`SELECT DISTINCT ON (m.student_number_key) m.student_number_key,f.id AS final_id FROM student_masterlist m LEFT JOIN attendance_final_results f ON f.school_year_id=m.school_year_id AND f.import_id IS NULL AND UPPER(TRIM(f.student_id))=UPPER(TRIM(m.student_number)) WHERE m.school_year_id=$1 ORDER BY m.student_number_key,f.updated_at DESC NULLS LAST`,[schoolYear.id])).rows : [];
    const byId=new Map(joined.map(r=>[r.student_number_key,r.final_id ? finalByUuid.get(r.final_id) : undefined]));
    const exemptions=(await client.query<{event_id:string;college_key:string|null;year_level_key:string|null}>(`SELECT x.event_id,x.college_key,NULL::text AS year_level_key FROM attendance_event_college_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1 UNION ALL SELECT x.event_id,x.college_key,x.year_level_key FROM attendance_event_year_level_exemptions x JOIN attendance_events e ON e.id=x.event_id WHERE e.school_year_id=$1`,[schoolYear.id])).rows;
    const roster=new Set<string>();
    for(const row of finals) for(const d of row.event_details ?? []) roster.add(`${normalizeCollegeKey(row.college)}|${d.id}`);
    function eventValues(row:{college:string|null;year_level:string|null}, final:typeof finals[number]|undefined) {
      const values:FinalRow["event_details"]={};
      const c=normalizeCollegeKey(row.college), y=normalizeYearLevelKey(row.year_level);
      const detail=new Map((final?.event_details ?? []).map(d=>[d.id,d]));
      for(const event of events) {
        const d=detail.get(event.id);
        const applies=roster.has(`${c}|${event.id}`) || !!d;
        const exempt=exemptions.some(x=>x.event_id===event.id && (x.college_key===null || normalizeCollegeKey(x.college_key)===c) && (x.year_level_key===null || normalizeYearLevelKey(x.year_level_key)===y));
        if(exempt && (applies || exemptions.some(x=>x.event_id===event.id && normalizeCollegeKey(x.college_key)===c))) values[event.id]="E";
        else if(d) values[event.id]=d.attended ? "P" : "A";
        else if(applies && hasMasterlist) values[event.id]="A";
      }
      return values;
    }
    const rows:FinalRow[]=hasMasterlist ? index.rows.map(m=>{const r=byId.get(m.student_number_key);return {student_number:m.student_number,name:m.full_name,last_name:m.last_name,given_name:m.given_name,middle_initial:m.middle_initial,program:m.program,year_level:m.year_level,college:m.college,attended_events:r?.attended_events ?? 0,expected_events:r?.expected_events ?? null,total_absences:r?.total_absences ?? null,attendance_status:r?.attendance_status ?? "No attendance record",event_details:eventValues(m,r)};}) : finals.map(r=>({student_number:r.student_id,name:r.name,last_name:null,given_name:null,middle_initial:null,program:r.program,year_level:r.year_level,college:r.college,attended_events:r.attended_events,expected_events:r.expected_events,total_absences:r.total_absences,attendance_status:r.attendance_status,event_details:eventValues(r,r)}));
    const unmatched:Array<{student_id:string;name:string;college:string|null;program:string|null;reason:string}>=[];
    if(hasMasterlist) {
      const source=(await client.query<Existing>(`SELECT DISTINCT ON (LOWER(TRIM(student_id)),name) * FROM (SELECT id,student_id,name,college,program,year_level FROM attendance_records WHERE school_year_id=$1 AND deleted_at IS NULL UNION ALL SELECT id,student_id,name,college,program,year_level FROM manual_attendance_records WHERE school_year_id=$1 UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_final_results WHERE school_year_id=$1 AND import_id IS NULL UNION ALL SELECT id,student_id,name,college,program,year_level FROM attendance_requests WHERE school_year_id=$1) q ORDER BY LOWER(TRIM(student_id)),name`,[schoolYear.id])).rows;
      for(const row of source) if(resolve(index,{studentId:row.student_id,name:row.name,college:row.college,program:row.program}).status==="unmatched") unmatched.push({student_id:row.student_id,name:row.name,college:row.college,program:row.program,reason:"No unique masterlist match"});
    }
    const filtered=sortRows(filterRows(rows,f));
    const filteredUnmatched=unmatched.filter(r=>(!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)) && (!f.program || normalizeProgram(r.program).includes(normalizeProgram(f.program))) && (!f.search || `${r.student_id} ${r.name}`.toLowerCase().includes(f.search.toLowerCase())));
    return {rows:exportAll ? filtered : filtered.slice(f.offset ?? 0,(f.offset ?? 0)+(f.limit ?? 50)),total:filtered.length,schoolYear,events,unmatched:filteredUnmatched,hasMasterlist,programs:[...new Set(rows.filter(r=>!f.college || normalizeCollegeKey(r.college)===normalizeCollegeKey(f.college)).map(r=>r.program).filter((p):p is string=>!!p))].sort()};
  } finally {client.release();}
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
