import { NextFunction, Request, Response } from "express";

import { FineStatus } from "../database/model/schema.model";
import {
  getFineSummary,
  getPenaltyByAbsences,
  listFines,
  listPenalties,
  seedDefaultPenalties,
  updateFineStatus,
  upsertPenalty
} from "../services/fines.service";

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getRouteParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

export async function penalties(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await listPenalties();
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function seedPenalties(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await seedDefaultPenalties();
    res.json({ message: "Penalties seeded successfully.", data: rows });
  } catch (error) {
    next(error);
  }
}

export async function savePenalty(req: Request, res: Response, next: NextFunction) {
  try {
    const noOfAbsences = Number(req.body?.noOfAbsences ?? req.body?.no_of_absences);
    const prescribedPenalty = String(req.body?.prescribedPenalty ?? req.body?.prescribed_penalty ?? "").trim();
    const row = await upsertPenalty(noOfAbsences, prescribedPenalty);

    res.status(201).json({ message: "Penalty saved successfully.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function matchPenalty(req: Request, res: Response, next: NextFunction) {
  try {
    const noOfAbsences = Number(getRouteParam(req, "noOfAbsences"));

    if (!Number.isInteger(noOfAbsences) || noOfAbsences <= 0) {
      res.status(400).json({ message: "No. of Absences must be a positive whole number." });
      return;
    }

    const row = await getPenaltyByAbsences(noOfAbsences);

    if (!row) {
      res.status(404).json({ message: "Penalty not found." });
      return;
    }

    res.json({ data: row });
  } catch (error) {
    next(error);
  }
}

export async function fines(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.query.status as FineStatus | undefined;
    const studentId = req.query.studentId ? String(req.query.studentId) : undefined;
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);

    const rows = await listFines({ status, studentId, limit, offset });
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function summary(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getFineSummary();
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Fine ID is required." });
      return;
    }

    const status = req.body?.status as FineStatus;
    const fine = await updateFineStatus(id, status);

    res.json({ message: "Fine status updated successfully.", data: fine });
  } catch (error) {
    next(error);
  }
}
