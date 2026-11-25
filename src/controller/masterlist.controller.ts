import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.controller";
import { prepareProgressStream, writeProgressStreamMessage } from "../lib/progress-stream";
import { uploadMasterlist, listMasterlist, reconcileMasterlist, deleteMasterlist, getFinalAttendance, getFinalAttendanceUnmatched, exportFinalAttendance, type MasterlistFilters, type MasterlistProgress } from "../services/masterlist.service";
function filters(req:Request):MasterlistFilters {
  const text=(key:string)=>typeof req.query[key]==="string" ? String(req.query[key]).trim() || undefined : undefined;
  const schoolYearId=text("schoolYearId");
  if (req.query.schoolYearId !== undefined && (!schoolYearId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolYearId))) throw Object.assign(new Error("Invalid schoolYearId."), { statusCode: 400, expose: true });
  const limit=Number(text("limit") ?? 50),offset=Number(text("offset") ?? 0);
  return {schoolYearId,search:text("search"),college:text("college"),program:text("program"),yearLevel:text("yearLevel"),limit:Number.isFinite(limit)?Math.max(1,Math.min(200,Math.floor(limit))):50,offset:Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0,includeUnmatched:text("includeUnmatched")==="1"};
}
export async function upload(req:AuthenticatedRequest,res:Response) { if(!req.file){res.status(400).json({message:"Choose a masterlist file."});return;} res.json(await uploadMasterlist(req.file,req.user?.sub)); }
export async function list(req:Request,res:Response) {res.json(await listMasterlist(filters(req)));}
export async function reconcile(_req:Request,res:Response) {res.json(await reconcileMasterlist());}
export async function remove(req:Request,res:Response) {
  const confirmation=typeof req.body?.confirmation === "string" ? req.body.confirmation.trim().toUpperCase() : "";
  if(confirmation!=="DELETE MASTERLIST") {res.status(400).json({message:"Type DELETE MASTERLIST to confirm deletion."});return;}
  const importId=typeof req.body?.importId === "string" ? req.body.importId : "";
  res.json(await deleteMasterlist(importId));
}
async function streamMasterlist<T>(req: Request,res: Response,next: NextFunction,work: (onProgress: (p: MasterlistProgress) => void,isCancelled: () => boolean) => Promise<T>) {
  let clientCancelled=false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const markClientCancelled=()=>{if(!res.writableEnded) clientCancelled=true;};
  req.on("aborted",markClientCancelled);
  res.on("close",markClientCancelled);
  const isCancelled=()=>clientCancelled || req.aborted || res.destroyed || res.writableEnded;
  try {
    prepareProgressStream(res,200);
    keepAlive=setInterval(()=>{if(!res.destroyed && !res.writableEnded) res.write("\n");},15_000);
    keepAlive.unref();
    const result=await work(progress=>writeProgressStreamMessage(res,{type:"progress",progress}),isCancelled);
    if(!isCancelled()) {
      writeProgressStreamMessage(res,{type:"success",message:"Masterlist reconciled.",data:result});
      res.end();
    }
  } catch(error) {
    if(res.headersSent) {
      res.locals.auditOutcome="failed";
      const exposed=error as {expose?:boolean;statusCode?:number;message?:string};
      if(!exposed?.expose && exposed?.statusCode!==499) console.error("[masterlist-progress]",error);
      writeProgressStreamMessage(res,{type:"error",message:(exposed?.expose || exposed?.statusCode===499) && exposed.message ? exposed.message : "Masterlist request failed."});
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
export async function reconcileWithProgress(req:Request,res:Response,next:NextFunction) {
  await streamMasterlist(req,res,next,reconcileMasterlist);
}
export async function finalAttendance(req:Request,res:Response) {res.json(await getFinalAttendance(filters(req)));}
export async function finalAttendanceUnmatched(req:Request,res:Response) {res.json(await getFinalAttendanceUnmatched(filters(req)));}
export async function download(req:Request,res:Response) {const result=await exportFinalAttendance(filters(req));res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="${result.filename}"`);res.send(result.buffer);}
