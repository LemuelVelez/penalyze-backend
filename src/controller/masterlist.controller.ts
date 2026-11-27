import { pool } from "../lib/db";
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.controller";
import { prepareProgressStream, writeProgressStreamMessage } from "../lib/progress-stream";
import { getMasterlistStatus, uploadMasterlist, resumeMasterlistUpload, discardMasterlistUpload, listMasterlist, reconcileMasterlist, deleteMasterlist, getFinalAttendance, getFinalAttendanceUnmatched, getAutoCorrectedStudents, reassignStudentAttendance, exportFinalAttendance, type MasterlistFilters, type MasterlistProgress } from "../services/masterlist.service";
function filters(req:Request):MasterlistFilters {
  const text=(key:string)=>typeof req.query[key]==="string" ? String(req.query[key]).trim() || undefined : undefined;
  const schoolYearId=text("schoolYearId");
  if (req.query.schoolYearId !== undefined && (!schoolYearId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolYearId))) throw Object.assign(new Error("Invalid schoolYearId."), { statusCode: 400, expose: true });
  const limit=Number(text("limit") ?? 50),offset=Number(text("offset") ?? 0);
  return {schoolYearId,search:text("search"),college:text("college"),program:text("program"),yearLevel:text("yearLevel"),limit:Number.isFinite(limit)?Math.max(1,Math.min(200,Math.floor(limit))):50,offset:Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0,includeUnmatched:text("includeUnmatched")==="1"};
}
export async function upload(req:AuthenticatedRequest,res:Response) { if(!req.file){res.status(400).json({message:"Choose a masterlist file."});return;} res.json(await uploadMasterlist(req.file,req.user?.sub)); }
export async function list(req:Request,res:Response) {res.json(await listMasterlist(filters(req)));}
export async function reconcile(req:AuthenticatedRequest,res:Response) {res.json(await reconcileMasterlist(undefined,undefined,req.user?.sub));}
export async function remove(req:Request,res:Response) {
  const confirmation=typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toUpperCase() : "";
  if(confirmation!=="DELETE MASTERLIST") {res.status(400).json({message:"Type DELETE MASTERLIST to confirm deletion."});return;}
  const importId=typeof req.body?.importId === "string" ? req.body.importId : "";
  res.json(await deleteMasterlist(importId));
}
async function streamMasterlist<T>(req: Request,res: Response,next: NextFunction,work: (onProgress: (p: MasterlistProgress) => void,isCancelled: () => boolean) => Promise<T>) {
  let clientCancelled=false;
  let lastProgress: MasterlistProgress | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const markClientCancelled=()=>{if(!res.writableEnded) clientCancelled=true;};
  req.on("aborted",markClientCancelled);
  res.on("close",markClientCancelled);
  const isCancelled=()=>clientCancelled || req.aborted || res.destroyed || res.writableEnded;
  try {
    prepareProgressStream(res,200);
    keepAlive=setInterval(()=>{if(!res.destroyed && !res.writableEnded) res.write("\n");},15_000);
    keepAlive.unref();
    const result=await work(progress=>{
      lastProgress=progress;
      writeProgressStreamMessage(res,{type:"progress",progress});
    },isCancelled);
    if(!isCancelled()) {
      writeProgressStreamMessage(res,{type:"success",message:"Masterlist reconciled.",data:result});
      res.end();
    }
  } catch(error) {
    if(res.headersSent) {
      res.locals.auditOutcome="failed";
      const exposed=error as {expose?:boolean;statusCode?:number;message?:string;code?:string};
      const stage=lastProgress?.stage.replace(/_/g," ") ?? "starting";
      const chunk=lastProgress?.chunkIndex !== undefined && lastProgress.chunkTotal !== undefined ? ` (chunk ${lastProgress.chunkIndex} of ${lastProgress.chunkTotal})` : "";
      const code=typeof exposed?.code === "string" && /^[0-9A-Z]{5}$/.test(exposed.code) ? exposed.code : undefined;
      if(!exposed?.expose && exposed?.statusCode!==499) console.error("[masterlist-progress]",{stage,chunk,code},error);
      const reason=code === "57014" ? "Database query timed out." : code === "55P03" ? "Database lock timed out." : code === "40P01" || code === "40001" ? "Database transaction conflicted with another operation." : code === "23505" ? "A duplicate record conflicts with reconciliation." : code ? `Database error (${code}).` : "Masterlist request failed.";
      const message=(exposed?.expose || exposed?.statusCode===499) && exposed.message ? exposed.message : `${reason} Failed during ${stage}${chunk}. Refresh the masterlist to see saved upload progress before retrying.`;
      writeProgressStreamMessage(res,{type:"error",message});
      if(!res.destroyed && !res.writableEnded) res.end();
    } else next(error);
  } finally {
    if(keepAlive) clearInterval(keepAlive);
    req.off("aborted",markClientCancelled);
    res.off("close",markClientCancelled);
  }
}
export async function uploadWithProgress(req:AuthenticatedRequest,res:Response,next:NextFunction) {
  const file=req.file;
  if(!file){res.status(400).json({message:"Choose a masterlist file."});return;}
  await streamMasterlist(req,res,next,(onProgress,isCancelled)=>uploadMasterlist(file,req.user?.sub,onProgress,isCancelled));
}
export async function resumeUploadWithProgress(req:Request,res:Response,next:NextFunction) {
  const jobId=typeof req.body?.jobId === "string" ? req.body.jobId : "";
  if(!jobId){res.status(400).json({message:"Choose a saved masterlist upload."});return;}
  await streamMasterlist(req,res,next,(onProgress,isCancelled)=>resumeMasterlistUpload(jobId,onProgress,isCancelled));
}
export async function discardUpload(req:Request,res:Response) {
  const confirmation=typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toUpperCase() : "";
  if(confirmation!=="DISCARD UPLOAD"){res.status(400).json({message:"Type DISCARD UPLOAD to confirm deletion."});return;}
  const jobId=typeof req.body?.jobId === "string" ? req.body.jobId : "";
  res.json(await discardMasterlistUpload(jobId));
}
export async function reconcileWithProgress(req:AuthenticatedRequest,res:Response,next:NextFunction) {
  await streamMasterlist(req,res,next,(progress,cancelled)=>reconcileMasterlist(progress,cancelled,req.user?.sub));
}
export async function finalAttendance(req:Request,res:Response) {res.json(await getFinalAttendance(filters(req)));}
export async function finalAttendanceUnmatched(req:Request,res:Response) {res.json(await getFinalAttendanceUnmatched(filters(req)));}
export async function download(req:Request,res:Response) {const result=await exportFinalAttendance(filters(req));res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="${result.filename}"`);res.send(result.buffer);}

export async function status(req: AuthenticatedRequest, res: Response) {
  const status = await getMasterlistStatus();
  const rebuildJob = req.user?.role === "admin" ? (await pool.query(`SELECT id,CASE WHEN status='running' AND heartbeat_at < clock_timestamp() - INTERVAL '5 minutes' THEN 'paused' ELSE status END AS status,phase,percent::float8 AS percent,message,last_error FROM maintenance_jobs WHERE kind='masterlist_presence_rebuild' AND school_year_id=$1 AND status IN ('pending','running','paused','failed') ORDER BY updated_at DESC LIMIT 1`,[status.schoolYearId])).rows[0] ?? null : null;
  res.json({...status,rebuildJob});
}
export async function publicStatus(_req: Request, res: Response) { const { active } = await getMasterlistStatus(); res.json({ active }); }

export async function reassign(req:Request,res:Response) {
  const text=(key:string)=>typeof req.body?.[key]==="string" ? req.body[key].trim() : "";
  const schoolYearId=text("schoolYearId"), originalStudentId=text("originalStudentId"), originalName=text("originalName"), studentNumber=text("studentNumber");
  if (!schoolYearId || !originalStudentId || !originalName || !studentNumber) {res.status(400).json({message:"schoolYearId, originalStudentId, originalName and studentNumber are required."});return;}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolYearId)) {res.status(400).json({message:"Invalid schoolYearId."});return;}
  res.json(await reassignStudentAttendance({schoolYearId,originalStudentId,originalName,studentNumber}));
}
export async function finalAttendanceCorrected(req:Request,res:Response) {res.json(await getAutoCorrectedStudents(filters(req)));}
