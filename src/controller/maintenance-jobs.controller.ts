import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.controller";
import { prepareProgressStream, writeProgressStreamMessage } from "../lib/progress-stream";
import { cancelJob, claimJob, createOrGetJob, getJob, listJobs, runJob } from "../services/maintenance-jobs.service";

function uuid(value: unknown, optional = false): string | undefined {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw Object.assign(new Error("Invalid job or school year ID."),{statusCode:400,expose:true});
  return value;
}
export async function list(req: Request,res: Response) {
  res.json(await listJobs({kind:typeof req.query.kind === "string" ? req.query.kind : undefined,schoolYearId:uuid(req.query.schoolYearId,true),open:req.query.open === "true"}));
}
export async function get(req: Request,res: Response) { res.json(await getJob(uuid(req.params.id)!)); }
export async function create(req: AuthenticatedRequest,res: Response) {
  const kind = req.body?.kind;
  if (kind !== "masterlist_presence_rebuild" && kind !== "masterlist_reconcile") throw Object.assign(new Error("Unsupported maintenance job kind."),{statusCode:400,expose:true});
  res.json(await createOrGetJob(kind,uuid(req.body?.schoolYearId,true) ?? null,null,req.user?.sub));
}
export async function cancel(req: Request,res: Response) { res.json(await cancelJob(uuid(req.params.id)!)); }
export async function run(req: Request,res: Response,next: NextFunction) {
  let disconnected = false;
  const mark = () => { if (!res.writableEnded) disconnected = true; };
  const cancelled = () => disconnected || req.aborted || res.destroyed || res.writableEnded;
  req.on("aborted",mark); res.on("close",mark);
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  try {
    const id = uuid(req.params.id)!;
    const claimed = await claimJob(id);
    if (!cancelled()) {
      prepareProgressStream(res);
      keepAlive = setInterval(() => { if (!cancelled()) res.write("\n"); },15000);
      keepAlive.unref();
    }
    const job = await runJob(id,progress => writeProgressStreamMessage(res,{type:"progress",progress}),cancelled,claimed);
    if (!cancelled()) { writeProgressStreamMessage(res,{type:"success",message:"Maintenance completed.",data:job}); res.end(); }
  } catch (error) {
    if (!res.headersSent) { if (!cancelled()) next(error); }
    else { res.locals.auditOutcome = "failed"; if (!cancelled()) { writeProgressStreamMessage(res,{type:"error",message:"Maintenance job could not finish. Press Resume to continue."}); res.end(); } }
  } finally { if (keepAlive) clearInterval(keepAlive); req.off("aborted",mark); res.off("close",mark); }
}
