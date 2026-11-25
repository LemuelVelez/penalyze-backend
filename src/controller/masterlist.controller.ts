import type { Request, Response } from "express";
import { uploadMasterlist, listMasterlist, reconcileMasterlist, deleteMasterlist, getFinalAttendance, exportFinalAttendance, type MasterlistFilters } from "../services/masterlist.service";
function filters(req:Request):MasterlistFilters {
  const text=(key:string)=>typeof req.query[key]==="string" ? String(req.query[key]).trim() || undefined : undefined;
  const limit=Number(text("limit") ?? 50),offset=Number(text("offset") ?? 0);
  return {schoolYearId:text("schoolYearId"),search:text("search"),college:text("college"),program:text("program"),yearLevel:text("yearLevel"),limit:Number.isFinite(limit)?Math.max(1,Math.min(200,Math.floor(limit))):50,offset:Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0};
}
export async function upload(req:Request,res:Response) { if(!req.file){res.status(400).json({message:"Choose a masterlist file."});return;} res.json(await uploadMasterlist(req.file,req.user?.sub)); }
export async function list(req:Request,res:Response) {res.json(await listMasterlist(filters(req)));}
export async function reconcile(_req:Request,res:Response) {res.json(await reconcileMasterlist());}
export async function remove(_req:Request,res:Response) {res.json(await deleteMasterlist());}
export async function finalAttendance(req:Request,res:Response) {res.json(await getFinalAttendance(filters(req)));}
export async function download(req:Request,res:Response) {const result=await exportFinalAttendance(filters(req));res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="${result.filename}"`);res.send(result.buffer);}
