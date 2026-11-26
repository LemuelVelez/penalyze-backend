import { savePreparedAttendanceFilesWithClient, saveAttendanceRowsWithClient, planCommittedImportMaintenance, finishCommittedImportMaintenance, type PreparedAttendanceFiles, type AttendanceBatchSaveResult } from "./attendance.service";
import type { SavedAttendanceImportResult, FineRecord } from "../database/model/schema.model";
import { reviewAttendanceRequest, reviewAttendanceRequestGroup } from "./attendance-requests.service";
import type { PoolClient } from "pg";
import type { MaintenanceJob } from "../database/model/schema.model";
import { createEventCollegeExemptions, createEventYearLevelExemptions, deleteEventExemptionsByIds, saveManualAttendanceRecords, writeStudentEventAttendancesWithClient, planStudentEventRefreshKeys, isMasterlistDerivedRefreshScope, prepareMasterlistDerivedRefresh, finishMasterlistDerivedRefresh, refreshAttendanceFinalResultsWithClient, refreshCalculationResultsWithClient, refreshPenaltyResultsForSchoolYearWithClient, repairCalculationConsistency, acknowledgeCalculationInputChangesWithClient, resolveUnattachedAttendanceEventIdsWithClient, getCalculationStatus, syncAbsencesForStudents, type MaintenanceRefreshScope, type StudentEventAttendanceChange } from "./attendance.service";
import type { JobHandler } from "./maintenance-jobs.service";

type DerivedOptions = Parameters<typeof refreshCalculationResultsWithClient>[1] & {importId?:string};
type RepairOptions = Parameters<typeof repairCalculationConsistency>[0];
type Input = {operation:string;body:Record<string,unknown>;actor?:RepairOptions["actor"]; finalResultId?:string;requestId?:string};
type State = { fines?:FineRecord[]; scopes:MaintenanceRefreshScope[]; result?:unknown; scopeIndex:number; offset:number; refreshKeys?:string[] | null; refreshOffset?:number; refreshPlanPending?:boolean };
const EVENT_REFRESH_BATCH_SIZE = 50;
const EVENT_REFRESH_PHASES = ["refresh_final_results", "refresh_calculations", "refresh_penalties"];
type EventRefreshCursor = { scopeIndex?:number; offset?:number; refreshBatchSize?:number };
export function smallerEventRefreshCursor(job: MaintenanceJob) {
  if (job.kind !== "final_result_event_batch" || !EVENT_REFRESH_PHASES.includes(job.phase)) return null;
  const state = job.state as State;
  const cursor = job.cursor as EventRefreshCursor;
  const remaining = (state.refreshKeys?.length ?? 0) - (state.refreshOffset ?? 0);
  const size = Math.min(cursor.refreshBatchSize ?? EVENT_REFRESH_BATCH_SIZE, remaining);
  if (size <= 1) return null;
  return {...cursor,refreshBatchSize:Math.max(1,Math.floor(size/2))};
}
const validation = (message:string) => Object.assign(new Error(message),{statusCode:400,expose:true});
export function attendanceMaintenanceHandler(kind:string):JobHandler {
  return {kind, async plan(_client,job) {
    if (!job.input) throw validation("Missing saved operation input.");
    return {phase:"primary",total:0,cursor:{},state:{scopes:[],scopeIndex:0,offset:0}};
  }, async step(client:PoolClient,job:MaintenanceJob) {
    const input = job.input as Input;
    const state = job.state as State;
    const options = input.body as DerivedOptions;
    let phase = job.phase, percent=Number(job.percent), message="", done=false;
    const primary = {client,defer:(scope:MaintenanceRefreshScope)=>state.scopes.push(scope)};
    if (phase === "primary") {
      if (kind === "event_exemptions") {
        if (input.operation === "college") state.result=await createEventCollegeExemptions(input.body,primary);
        else if(input.operation === "year_level") state.result=await createEventYearLevelExemptions(input.body,primary);
        else if(input.operation === "remove") state.result=await deleteEventExemptionsByIds(input.body,primary);
        else throw validation("Invalid exemption operation.");
      } else if(kind === "manual_batch") state.result=await saveManualAttendanceRecords(input.body,undefined,primary);
      else if(kind === "final_result_event_batch") {
        const {schoolYearId,...result}=await writeStudentEventAttendancesWithClient(client,input.finalResultId ?? "",input.body.changes as StudentEventAttendanceChange[],job.created_by ?? undefined);
        state.result=result;
        if(result.updatedCount) {
          state.scopes.push({schoolYearId});
          state.refreshPlanPending=true;
          state.refreshOffset=0;
        }
      } else if(kind === "attendance_import_save") {
        if(input.operation === "files")state.result=await savePreparedAttendanceFilesWithClient(client,input.body as unknown as PreparedAttendanceFiles,undefined,true);
        else {
          const prepared=input.body as unknown as {input:Parameters<typeof saveAttendanceRowsWithClient>[1];preview:Parameters<typeof saveAttendanceRowsWithClient>[2]};
          state.result=await saveAttendanceRowsWithClient(client,{...prepared.input,deferDerivedRefresh:true},prepared.preview,new Map(),true);
        }
        const imports=input.operation==="files"?(state.result as AttendanceBatchSaveResult).files.flatMap(file=>file.result?[file.result]:[]):[state.result as SavedAttendanceImportResult];
        state.scopes=await planCommittedImportMaintenance(client,imports);state.fines=[];
      } else if(kind === "request_group_review") {
        if(input.operation === "single") state.result=await reviewAttendanceRequest(input.requestId,job.created_by,input.body as Parameters<typeof reviewAttendanceRequest>[2],undefined,undefined,primary);
        else state.result=await reviewAttendanceRequestGroup(job.created_by,input.body as Parameters<typeof reviewAttendanceRequestGroup>[1],undefined,undefined,primary);
      } else if(kind === "derived_refresh") {
        if(input.operation === "repair") {state.result=await repairCalculationConsistency({...options,actor:input.actor},primary);done=true;}
        else if(input.operation === "calculations") {
          await resolveUnattachedAttendanceEventIdsWithClient(client,job.school_year_id);
          const status=await getCalculationStatus(options,client);
          if(!status.pending) throw Object.assign(new Error("Calculation is already up to date. Add or change attendance data before calculating again."),{statusCode:409,expose:true});
          state.result=await refreshCalculationResultsWithClient(client,{...options,resolveUnattachedEvents:false});
          await acknowledgeCalculationInputChangesWithClient(client,options);
          state.scopes.push({schoolYearId:job.school_year_id});
        } else if(input.operation === "final") state.scopes.push({schoolYearId:job.school_year_id});
        else if(input.operation === "penalties") state.scopes.push({schoolYearId:job.school_year_id});
        else throw validation("Invalid derived refresh operation.");
      } else throw validation("Unsupported saved operation.");
      phase=state.scopes.length ? (kind === "derived_refresh" && input.operation === "penalties" ? "refresh_penalties" : "sync_absences") : "finalize";
      percent=25;message="Primary changes saved.";
    } else if(phase === "finalize") {
      if(kind==="attendance_import_save"){
        const imports=input.operation==="files"?(state.result as AttendanceBatchSaveResult).files.flatMap(file=>file.result?[file.result]:[]):[state.result as SavedAttendanceImportResult];
        await finishCommittedImportMaintenance(client,imports,state.fines??[]);
        if(input.operation==="files"){const batch=state.result as AttendanceBatchSaveResult;batch.finesCreated=imports.reduce((sum,item)=>sum+item.createdFines.length,0);batch.syncWarnings=[];}
        else (state.result as SavedAttendanceImportResult).syncWarnings=[];
      }
      if(kind === "final_result_event_batch" && state.result && typeof state.result === "object") {
        state.result={...state.result,requiresTableRefresh:state.scopes.length>0 && (state.refreshKeys === null || (state.refreshKeys?.length??0)>1)};
      }
      done=true;percent=100;message="Attendance operation completed.";
    }
    else {
      const scope=state.scopes[state.scopeIndex];
      const schoolYearId=scope.schoolYearId ?? undefined;
      if(phase === "sync_absences") {
        const ids=scope.studentIds ?? [];
        const chunk=ids.slice(state.offset,state.offset+25);
        if(chunk.length){const synced=await syncAbsencesForStudents(client,chunk,schoolYearId,scope.scopeFines,true);if(kind==="attendance_import_save"){const fines=new Map((state.fines??[]).map(fine=>[fine.id,fine]));for(const fine of synced.fines)fines.set(fine.id,fine);state.fines=[...fines.values()];}}
        state.offset+=chunk.length;
        percent=25+25*(ids.length ? state.offset/ids.length : 1);message=`Absences synchronized: ${state.offset} / ${ids.length}`;
        if(state.offset>=ids.length){if(scope.skipRefresh){state.scopeIndex++;state.offset=0;phase=state.scopeIndex<state.scopes.length?"sync_absences":"finalize";}else phase="refresh_final_results";}
      } else if(kind === "final_result_event_batch" && schoolYearId && EVENT_REFRESH_PHASES.includes(phase) && state.refreshKeys !== null) {
        const final=phase === "refresh_final_results";
        const calculations=phase === "refresh_calculations";
        const start=final?50:calculations?65:80;
        const end=final?65:calculations?80:95;
        const label=final?"final attendance results":calculations?"calculations":"penalties";
        if(state.refreshKeys === undefined) {
          // Existing paused jobs already committed their overrides. Prepare a
          // full key list without reapplying the primary write.
          if(state.refreshPlanPending) {
            const saved=state.result as Awaited<ReturnType<typeof writeStudentEventAttendancesWithClient>>;
            state.refreshKeys=await planStudentEventRefreshKeys(client,schoolYearId,saved.studentId,saved.changes.filter(change=>change.updated));
            delete state.refreshPlanPending;
          } else {
            state.refreshKeys=await isMasterlistDerivedRefreshScope(client,schoolYearId)
              ? await prepareMasterlistDerivedRefresh(client,schoolYearId,false) : null;
          }
          state.refreshOffset=0;
          message=state.refreshKeys === null ? "Preparing legacy attendance refresh." : `Preparing ${label}: ${state.refreshKeys.length} students.`;
          percent=start;
        } else {
          const keys=state.refreshKeys;
          const offset=state.refreshOffset??0;
          const batchSize=(job.cursor as EventRefreshCursor).refreshBatchSize??EVENT_REFRESH_BATCH_SIZE;
          const chunk=keys.slice(offset,offset+batchSize);
          if(chunk.length) {
            const opts={schoolYearId,masterlistStudentKeys:chunk,resolveUnattachedEvents:false,logConsistencyViolation:false};
            if(final) await refreshAttendanceFinalResultsWithClient(client,opts);
            else if(calculations) await refreshCalculationResultsWithClient(client,opts);
            else await refreshPenaltyResultsForSchoolYearWithClient(client,schoolYearId,undefined,chunk);
            state.refreshOffset=offset+chunk.length;
            percent=start+(end-start)*state.refreshOffset/Math.max(keys.length,1);
            message=`Refreshed ${label}: ${state.refreshOffset} / ${keys.length} students.`;
          } else {
            if(final || calculations) await finishMasterlistDerivedRefresh(client,schoolYearId,final?"attendance_final_results":"calculation_results");
            phase=final?"refresh_calculations":calculations?"refresh_penalties":"finalize";
            state.refreshOffset=0;
            percent=end;message=`Finished ${label}.`;
          }
        }
      } else if(phase === "refresh_final_results") {
        const rows=await refreshAttendanceFinalResultsWithClient(client,kind==="derived_refresh"&&input.operation==="final"?{...options,schoolYearId}:{schoolYearId});
        if(kind==="derived_refresh"&&input.operation==="final")state.result=rows;
        phase=kind==="derived_refresh"?"refresh_penalties":"refresh_calculations";percent=65;message="Final attendance results refreshed.";
      } else if(phase === "refresh_calculations") {
        await refreshCalculationResultsWithClient(client,{schoolYearId});phase="refresh_penalties";percent=80;message="Calculations refreshed.";
      } else if(phase === "refresh_penalties") {
        const rows=await refreshPenaltyResultsForSchoolYearWithClient(client,schoolYearId);
        if(kind==="derived_refresh"&&input.operation==="penalties")state.result=rows;
        state.scopeIndex++;state.offset=0;phase=state.scopeIndex<state.scopes.length?"sync_absences":"finalize";percent=95;message="Penalties refreshed.";
      } else throw validation("Invalid maintenance checkpoint.");
    }
    const refreshCursor=kind === "final_result_event_batch" && phase===job.phase ? {refreshBatchSize:(job.cursor as EventRefreshCursor).refreshBatchSize} : {};
    return {done,phase,cursor:{scopeIndex:state.scopeIndex,offset:state.offset,...refreshCursor},state,processed:state.refreshOffset??state.offset,total:state.refreshKeys?.length??state.scopes[state.scopeIndex]?.studentIds?.length??0,percent,message,result:done?state.result:undefined};
  }};
}
