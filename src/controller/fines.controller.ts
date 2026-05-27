import { NextFunction, Request, Response } from "express";

import { FineStatus } from "../database/model/schema.model";
import {
  deletePenalty as deletePenaltyRecord,
  deletePenaltyResultsByIds,
  deletePenaltyResultsBySchoolYear,
  getFineSummary,
  getPenaltyByAbsences,
  listFines,
  listPenalties,
  listPenaltyResults,
  refreshPenaltyResults,
  registerZeroAttendanceFine as registerZeroAttendanceFineRecord,
  seedDefaultPenalties,
  updateFineStatus,
  updatePenalty as updatePenaltyRecord,
  updatePenaltyResult,
  updatePenaltyResultStatus,
  upsertPenalty
} from "../services/fines.service";

const fineStatuses: FineStatus[] = ["unpaid", "paid", "waived"];

function parseFineStatus(value: unknown) {
  const status = String(value ?? "").trim() as FineStatus;
  return fineStatuses.includes(status) ? status : undefined;
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getRouteParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseImportIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function parseRecordIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function getRequestRecordIds(req: Request) {
  return parseRecordIds(
    req.body?.recordIds ??
      req.body?.ids ??
      req.query.recordIds ??
      req.query.ids,
  );
}

function getRequestSchoolYearId(req: Request) {
  return String(req.body?.schoolYearId ?? req.body?.school_year_id ?? req.query.schoolYearId ?? "")
    .trim();
}

function getPenaltyPayload(req: Request) {
  return {
    noOfAbsences: Number(req.body?.noOfAbsences ?? req.body?.no_of_absences),
    prescribedPenalty: String(req.body?.prescribedPenalty ?? req.body?.prescribed_penalty ?? "").trim()
  };
}

function getPenaltyResultPayload(req: Request) {
  return {
    studentId: String(req.body?.studentId ?? req.body?.student_id ?? "").trim(),
    name: String(req.body?.name ?? "").trim(),
    noOfAbsences: Number(req.body?.noOfAbsences ?? req.body?.no_of_absences ?? 0),
    prescribedPenalty: String(req.body?.prescribedPenalty ?? req.body?.prescribed_penalty ?? "").trim(),
    status: parseFineStatus(req.body?.status),
  };
}


function getZeroAttendancePayload(req: Request) {
  return {
    schoolYearId: String(req.body?.schoolYearId ?? req.body?.school_year_id ?? "").trim(),
    studentId: String(req.body?.studentId ?? req.body?.student_id ?? "").trim(),
    name: String(req.body?.name ?? "").trim(),
    yearLevel: String(req.body?.yearLevel ?? req.body?.year_level ?? "").trim(),
    college: String(req.body?.college ?? "").trim(),
    program: String(req.body?.program ?? "").trim(),
    institution: String(req.body?.institution ?? "").trim()
  };
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
    const { noOfAbsences, prescribedPenalty } = getPenaltyPayload(req);
    const row = await upsertPenalty(noOfAbsences, prescribedPenalty);

    res.status(201).json({ message: "Penalty saved successfully.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function updatePenalty(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Penalty ID is required." });
      return;
    }

    const { noOfAbsences, prescribedPenalty } = getPenaltyPayload(req);
    const row = await updatePenaltyRecord(id, noOfAbsences, prescribedPenalty);

    res.json({ message: "Penalty updated successfully.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function deletePenalty(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Penalty ID is required." });
      return;
    }

    const row = await deletePenaltyRecord(id);
    res.json({ message: "Penalty deleted successfully.", data: row });
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

export async function registerZeroAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await registerZeroAttendanceFineRecord(getZeroAttendancePayload(req));

    res.status(201).json({ message: "Zero attendance record and fine saved successfully.", data });
  } catch (error) {
    next(error);
  }
}

export async function fines(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.query.status ? (String(req.query.status) as FineStatus) : undefined;

    if (status && !fineStatuses.includes(status)) {
      res.status(400).json({ message: "Invalid fine status." });
      return;
    }

    const schoolYearId = req.query.schoolYearId ? String(req.query.schoolYearId) : undefined;
    const studentId = req.query.studentId ? String(req.query.studentId) : undefined;
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);

    const rows = await listFines({ schoolYearId, status, studentId, limit, offset });
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function penaltyResults(req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await listPenaltyResults({
      schoolYearId: req.query.schoolYearId ? String(req.query.schoolYearId).trim() : undefined,
      status: parseFineStatus(req.query.status),
      studentId: req.query.studentId ? String(req.query.studentId).trim() : undefined,
      limit: toPositiveInt(req.query.limit, 100),
      offset: toPositiveInt(req.query.offset, 0),
    });

    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function refreshPenaltyResultRows(req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await refreshPenaltyResults({
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
    });

    res.json({ message: "Penalty results refreshed.", data: rows });
  } catch (error) {
    next(error);
  }
}


export async function updatePenaltyResultRowStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");
    const status = parseFineStatus(req.body?.status);

    if (!id) {
      res.status(400).json({ message: "Penalty result ID is required." });
      return;
    }

    if (!status) {
      res.status(400).json({ message: "Valid status is required." });
      return;
    }

    const row = await updatePenaltyResultStatus(id, status);
    res.json({ message: "Penalty result status updated.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function updatePenaltyResultRow(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Penalty result ID is required." });
      return;
    }

    const row = await updatePenaltyResult(id, getPenaltyResultPayload(req));
    res.json({ message: "Penalty result updated.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function deletePenaltyResultRow(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Penalty result ID is required." });
      return;
    }

    const result = await deletePenaltyResultsByIds([id]);
    const row = result.deletedRecords[0];

    if (!row) {
      res.status(404).json({ message: "Penalty result not found." });
      return;
    }

    res.json({ message: "Penalty result deleted.", data: row });
  } catch (error) {
    next(error);
  }
}

export async function deletePenaltyResultRows(req: Request, res: Response, next: NextFunction) {
  try {
    const ids = getRequestRecordIds(req);
    const schoolYearId = getRequestSchoolYearId(req);

    if (!ids.length && !schoolYearId) {
      res.status(400).json({
        message: "Penalty result IDs or school year ID are required.",
      });
      return;
    }

    const result = ids.length
      ? await deletePenaltyResultsByIds(ids)
      : await deletePenaltyResultsBySchoolYear(schoolYearId);

    res.json({ message: "Penalty results deleted.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const schoolYearId = req.query.schoolYearId ? String(req.query.schoolYearId) : undefined;
    const data = await getFineSummary(schoolYearId);
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