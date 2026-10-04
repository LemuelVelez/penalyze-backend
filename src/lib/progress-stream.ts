import type { Response } from "express";

export type ProgressStreamMessage<TProgress, TData = unknown> =
  | { type: "progress"; progress: TProgress }
  | { type: "success"; message: string; data: TData }
  | { type: "error"; message: string };

export function prepareProgressStream(res: Response, statusCode = 200) {
  res.status(statusCode);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

export function writeProgressStreamMessage<TProgress, TData = unknown>(
  res: Response,
  message: ProgressStreamMessage<TProgress, TData>,
) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify(message)}\n`);
}
