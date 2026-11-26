import { attendanceMaintenanceHandler } from "./attendance-maintenance.service";
import { randomUUID } from "node:crypto";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { PoolClient } from "pg";
import type { MaintenanceJob } from "../database/model/schema.model";
import { jobPool, withJobTransaction } from "../lib/db";
import { tryLockAttendanceAbsenceSync } from "./attendance.service";
import { planMasterlistMaintenance, stepMasterlistMaintenance, reconciliationStage, type MasterlistProgress } from "./masterlist.service";

type JobPlan = { total: number; phase: string; cursor: object; state: object };
type JobStep = JobPlan & { done: boolean; processed: number; percent: number; message: string; result?: unknown };
export type JobHandler = { kind: string; plan(client: PoolClient, job: MaintenanceJob): Promise<JobPlan>; step(client: PoolClient, job: MaintenanceJob): Promise<JobStep> };
const handlers = new Map<string, JobHandler>();
export function registerJobHandler(handler: JobHandler) { handlers.set(handler.kind, handler); }
for (const kind of ["masterlist_presence_rebuild", "masterlist_reconcile"]) {
  registerJobHandler({kind, plan:planMasterlistMaintenance, step:stepMasterlistMaintenance});
}
for (const kind of ["derived_refresh","event_exemptions","manual_batch","final_result_event_batch","request_group_review","attendance_import_save"]) registerJobHandler(attendanceMaintenanceHandler(kind));
const openStatus = "status IN ('pending','running','paused','failed')";
const conflict = () => Object.assign(new Error("This job is already running in another tab."), {statusCode:409,expose:true});
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message),{statusCode,expose:true});
function requireHandler(kind: string) {
  const handler = handlers.get(kind);
  if (!handler) throw bad("Unsupported maintenance job kind.");
  return handler;
}
function normalized(job: MaintenanceJob): MaintenanceJob {
  return {...job,percent:Number(job.percent)};
}
export async function createOrGetJob(kind: string, schoolYearId: string | null, input: unknown = null, actor?: string) {
  requireHandler(kind);
  if (kind.startsWith("masterlist_") && !schoolYearId) throw bad("Choose a school year.");
  return withJobTransaction(async client => {
    // The partial unique index arbitrates simultaneous requests. A second
    // statement obtains the winner under READ COMMITTED after a conflict.
    const inserted = await client.query<MaintenanceJob>(`INSERT INTO maintenance_jobs(kind,school_year_id,input,created_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING RETURNING *`,[kind,schoolYearId,JSON.stringify(input ?? null),actor ?? null]);
    if (inserted.rows[0]) return normalized(inserted.rows[0]);
    const existing = await client.query<MaintenanceJob>(`SELECT * FROM maintenance_jobs WHERE kind=$1 AND school_year_id IS NOT DISTINCT FROM $2::uuid AND ${openStatus}`,[kind,schoolYearId]);
    if (!existing.rows[0]) throw bad("The previous job just finished. Try again.",409);
    if (input != null) {
      const same = await client.query<{same:boolean}>("SELECT input IS NOT DISTINCT FROM $2::jsonb AS same FROM maintenance_jobs WHERE id=$1",[existing.rows[0].id,JSON.stringify(input)]);
      if(!same.rows[0]?.same) throw bad("Another saved operation is open. Resume it before submitting a new operation.",409);
    }
    return normalized(existing.rows[0]);
  });
}
export async function getJob(id: string) {
  const job = (await jobPool.query<MaintenanceJob>("SELECT * FROM maintenance_jobs WHERE id=$1",[id])).rows[0];
  if (!job) throw bad("Maintenance job not found.",404);
  return normalized(job);
}
export async function listJobs(filters: { kind?: string; schoolYearId?: string; open?: boolean } = {}) {
  const {rows} = await jobPool.query<MaintenanceJob>(`SELECT *, CASE WHEN status='running' AND heartbeat_at < clock_timestamp() - INTERVAL '2 minutes' THEN 'paused' ELSE status END AS status FROM maintenance_jobs WHERE ($1::text IS NULL OR kind=$1) AND ($2::uuid IS NULL OR school_year_id=$2) AND (NOT $3::boolean OR ${openStatus}) ORDER BY updated_at DESC`,[filters.kind ?? null,filters.schoolYearId ?? null,filters.open ?? false]);
  return rows.map(normalized);
}
export async function claimJob(id: string) {
  const token = randomUUID();
  const job = await withJobTransaction(async client => (await client.query<MaintenanceJob>(`UPDATE maintenance_jobs SET status='running',runner_token=$2,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),started_at=COALESCE(started_at,NOW()),attempts=attempts+1,last_error=NULL WHERE id=$1 AND (status IN ('pending','paused','failed') OR (status='running' AND heartbeat_at < clock_timestamp() - INTERVAL '2 minutes')) RETURNING *`,[id,token])).rows[0]);
  if (!job) throw conflict();
  return normalized(job);
}
function safeError(error: unknown) {
  const raw = error as {code?:string;expose?:boolean;message?:string};
  const code = typeof raw?.code === "string" && /^[0-9A-Z]{5}$/.test(raw.code) ? ` (${raw.code})` : "";
  return raw?.expose && raw.message ? `${raw.message}${code}` : `Maintenance step failed${code}. Press Resume to continue from the saved checkpoint.`;
}
export async function runJob(id: string, onProgress?: (progress: MasterlistProgress) => void, isCancelled: () => boolean = () => false, claimed?: MaintenanceJob): Promise<MaintenanceJob> {
  let job = claimed ?? await claimJob(id);
  const token = job.runner_token;
  const handler = requireHandler(job.kind);
  const emit = (message: string, phase = job.phase) => onProgress?.({stage:reconciliationStage(phase),percent:Number(job.percent),message,processed:job.processed,total:job.total});
  try {
    while (!isCancelled()) {
      const previousPhase = job.phase;
      const checkpoint = await withJobTransaction(async client => {
        const acquired = await tryLockAttendanceAbsenceSync(client);
        const current = (await client.query<MaintenanceJob>("SELECT * FROM maintenance_jobs WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if (!current || current.runner_token !== token || current.status !== "running") throw conflict();
        if (!acquired) {
          await client.query("UPDATE maintenance_jobs SET heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND runner_token=$2",[id,token]);
          return null;
        }
        // Plan has its own checkpoint; no plan or step is replayed after commit.
        const step: JobStep = current.phase === "queued"
          ? {...await handler.plan(client,current),done:false,processed:0,percent:0,message:"Maintenance planned."}
          : await handler.step(client,current);
        return (await client.query<MaintenanceJob>(`UPDATE maintenance_jobs SET phase=$3,cursor=$4::jsonb,state=$5::jsonb,processed=$6,total=$7,percent=CASE WHEN $10 THEN 100 ELSE GREATEST(percent,$8) END,message=$9,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),status=CASE WHEN $10 THEN 'completed' ELSE 'running' END,completed_at=CASE WHEN $10 THEN NOW() ELSE completed_at END,runner_token=CASE WHEN $10 THEN NULL ELSE runner_token END,result=CASE WHEN $10 THEN $11::jsonb ELSE result END WHERE id=$1 AND runner_token=$2 RETURNING *`,[id,token,step.phase,JSON.stringify(step.cursor),JSON.stringify(step.state),step.processed,step.total,step.percent,step.message,step.done,JSON.stringify(step.result ?? null)])).rows[0];
      });
      if (!checkpoint) { emit("Waiting for another attendance operation…"); await setTimeout(2000); continue; }
      job = normalized(checkpoint);
      if (job.status === "completed") { emit(job.message ?? "Maintenance completed.","finalize"); return job; }
      emit(job.message ?? "Checkpoint saved.",previousPhase === "queued" ? job.phase : previousPhase);
      await setImmediate();
    }
    const paused = (await jobPool.query<MaintenanceJob>("UPDATE maintenance_jobs SET status='paused',runner_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND runner_token=$2 RETURNING *",[id,token])).rows[0];
    return paused ? normalized(paused) : getJob(id);
  } catch (error) {
    console.error(`[maintenance-job ${id}] ${job.phase}`,error);
    const message = safeError(error);
    try { await jobPool.query("UPDATE maintenance_jobs SET status='failed',last_error=$3,runner_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND runner_token=$2",[id,token,message]); }
    catch (checkpointError) { console.error(`[maintenance-job ${id}] Unable to save failure`,checkpointError); }
    const raw = error as {statusCode?:number;expose?:boolean;code?:string};
    if(raw?.expose && raw.statusCode && raw.statusCode<500) throw error;
    throw bad(`${message} Resume the job to continue.`,503);
  }
}
export async function cancelJob(id: string) {
  const job = (await jobPool.query<MaintenanceJob>(`UPDATE maintenance_jobs SET status='cancelled',runner_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status IN ('pending','paused','failed') RETURNING *`,[id])).rows[0];
  if (!job) throw bad("Only pending, paused or failed jobs can be cancelled.",409);
  return normalized(job);
}
export async function recoverMaintenanceJobs() {
  await jobPool.query("UPDATE maintenance_jobs SET status='paused',runner_token=NULL,updated_at=clock_timestamp() WHERE status='running' AND heartbeat_at < clock_timestamp() - INTERVAL '2 minutes'");
}

export async function runSubmittedJob<T>(kind:string,schoolYearId:string|null,input:unknown,actor?:string,onProgress?:(progress:MasterlistProgress)=>void,isCancelled?:()=>boolean):Promise<T> {
  const job=await createOrGetJob(kind,schoolYearId,input,actor);
  const result=await runJob(job.id,onProgress,isCancelled);
  if(result.status!=="completed")throw bad("Operation paused. Resume the saved job.",409);
  return result.result as T;
}
