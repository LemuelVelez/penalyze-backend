import { NextFunction, Request, Response } from "express";

import {
  activateSchoolYear,
  assignCurrentRecordsToSchoolYear,
  createSchoolYear,
  deleteSchoolYearRecords,
  listSchoolYears,
  transferSchoolYearRecords,
} from "../services/school-years.service";

function getRouteParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const cleanValue = String(value ?? "").trim();
  return cleanValue ? [cleanValue] : [];
}

export async function index(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await listSchoolYears();
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function save(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await createSchoolYear({
      name: req.body?.name,
      startsAt: req.body?.startsAt ?? req.body?.starts_at,
      endsAt: req.body?.endsAt ?? req.body?.ends_at,
      isActive: Boolean(req.body?.isActive ?? req.body?.is_active),
    });

    res.status(201).json({ message: "School year saved successfully.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "School year ID is required." });
      return;
    }

    const row = await activateSchoolYear(id);
    res.json({ message: "School year activated successfully.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function assignCurrent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "School year ID is required." });
      return;
    }

    const data = await assignCurrentRecordsToSchoolYear(id);
    res.json({ message: "Current records assigned to school year successfully.", data });
  } catch (error) {
    next(error);
  }
}

export async function deleteRecords(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "School year ID is required." });
      return;
    }

    const data = await deleteSchoolYearRecords(id);
    res.json({ message: "School-year records deleted successfully.", data });
  } catch (error) {
    next(error);
  }
}

export async function transfer(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await transferSchoolYearRecords({
      targetSchoolYearId: String(req.body?.targetSchoolYearId ?? req.body?.target_school_year_id ?? "").trim(),
      eventIds: toStringArray(req.body?.eventIds ?? req.body?.event_ids),
      importIds: toStringArray(req.body?.importIds ?? req.body?.import_ids),
      attendanceRecordIds: toStringArray(req.body?.attendanceRecordIds ?? req.body?.attendance_record_ids),
      fineIds: toStringArray(req.body?.fineIds ?? req.body?.fine_ids),
    });

    res.json({ message: "Records transferred successfully.", data });
  } catch (error) {
    next(error);
  }
}