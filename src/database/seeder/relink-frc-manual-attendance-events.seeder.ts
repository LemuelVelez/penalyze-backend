import "dotenv/config";

import type { PoolClient } from "pg";

import { closeDatabasePool, withTransaction } from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const SEEDED_EVENT_DESCRIPTION_PREFIX = "Seeded manual attendance event for the";

const RELINK_GROUPS = [
  {
    remarks:
      "Seeded as manual attendance from the September 1, 2026 SCJE FRC attendance sheet.",
    eventDate: "2026-09-01",
  },
  {
    remarks:
      "Seeded as manual attendance from the August 24, 2026 SOE FRC attendance sheet.",
    eventDate: "2026-08-24",
  },
  {
    remarks:
      "Seeded as manual attendance from the August 17, 2026 CAF FRC scanner list.",
    eventDate: "2026-08-17",
  },
  {
    remarks:
      "Seeded as manual attendance from the August 24, 2026 CAF FRC scanner list.",
    eventDate: "2026-08-24",
  },
  {
    remarks:
      "Seeded as manual attendance from the September 1, 2026 CAF FRC scanner list.",
    eventDate: "2026-09-01",
  },
  {
    remarks:
      "Seeded as manual attendance from the August 24, 2026 LAMS FRC attendance sheet.",
    eventDate: "2026-08-24",
  },
  {
    remarks:
      "Seeded as manual attendance from the September 1, 2026 LAMS FRC attendance sheet.",
    eventDate: "2026-09-01",
  },
  {
    remarks:
      "Seeded as manual attendance from the September 1, 2026 FRC scanner attendee list.",
    eventDate: "2026-09-01",
  },
  {
    remarks:
      "Seeded as manual attendance from the September 1, 2026 FRC no-QR attendee list.",
    eventDate: "2026-09-01",
  },
] as const;

type TargetEvent = {
  id: string;
  resolved_date: string;
};

type ManualAttendanceRecord = {
  id: string;
  school_year_id: string | null;
  event_id: string | null;
  student_id: string;
};

type DeletedEvent = {
  id: string;
  name: string;
};

export type SeedRelinkFrcManualAttendanceEventsResult = {
  alreadySeeded: boolean;
  recordsRelinked: number;
  duplicatesRemoved: number;
  emptyEventsDeleted: number;
  eventOrdersRenumbered: number;
  deletedEvents: string[];
  remarkGroups: Array<{
    remarks: string;
    eventDate: string;
    recordsRelinked: number;
    duplicatesRemoved: number;
  }>;
};

async function getTargetSchoolYearId(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM school_years
      WHERE name = $1
        AND semester = $2
      LIMIT 1
    `,
    [TARGET_SCHOOL_YEAR, TARGET_SEMESTER],
  );

  const schoolYearId = result.rows[0]?.id;
  if (!schoolYearId) {
    throw new Error(
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before relinking FRC manual attendance.`,
    );
  }

  return schoolYearId;
}

async function getCanonicalEventsByDate(
  client: PoolClient,
  schoolYearId: string,
) {
  const result = await client.query<TargetEvent>(
    `
      SELECT DISTINCT ON (resolved_date)
        id,
        resolved_date::text
      FROM (
        SELECT
          id,
          created_at,
          COALESCE(
            event_date,
            timezone('Asia/Manila', event_start_at)::date,
            timezone('Asia/Manila', event_end_at)::date
          ) AS resolved_date
        FROM attendance_events
        WHERE school_year_id = $1
      ) events
      WHERE resolved_date IS NOT NULL
      ORDER BY resolved_date ASC, created_at ASC, id ASC
    `,
    [schoolYearId],
  );

  const eventByDate = new Map<string, TargetEvent>(
    result.rows.map((event) => [event.resolved_date, event] as const),
  );
  const requiredDates = Array.from(
    new Set(RELINK_GROUPS.map((group) => group.eventDate)),
  );
  const missingDates = requiredDates.filter(
    (eventDate) => !eventByDate.has(eventDate),
  );

  if (missingDates.length) {
    throw new Error(
      `Missing canonical FRC attendance event(s) for ${missingDates.join(", ")} in ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER}.`,
    );
  }

  return eventByDate;
}

async function relinkRemarkGroup(
  client: PoolClient,
  schoolYearId: string,
  targetEventId: string,
  remarks: string,
) {
  const sourceRows = await client.query<ManualAttendanceRecord>(
    `
      SELECT id, school_year_id, event_id, student_id
      FROM manual_attendance_records
      WHERE remarks = $1
        AND attendance_type <> 'zero_attendance'
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `,
    [remarks],
  );

  let recordsRelinked = 0;
  let duplicatesRemoved = 0;

  for (const row of sourceRows.rows) {
    const collision = await client.query<{ id: string }>(
      `
        SELECT id
        FROM manual_attendance_records
        WHERE event_id = $1
          AND id <> $2
          AND attendance_type <> 'zero_attendance'
          AND LOWER(TRIM(student_id)) = LOWER(TRIM($3))
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      [targetEventId, row.id, row.student_id],
    );

    if (collision.rows[0]) {
      const deleted = await client.query(
        `
          DELETE FROM manual_attendance_records
          WHERE id = $1
        `,
        [row.id],
      );
      duplicatesRemoved += deleted.rowCount ?? 0;
      continue;
    }

    if (row.event_id === targetEventId && row.school_year_id === schoolYearId) {
      continue;
    }

    const updated = await client.query(
      `
        UPDATE manual_attendance_records
        SET event_id = $1,
            school_year_id = $2,
            updated_at = NOW()
        WHERE id = $3
      `,
      [targetEventId, schoolYearId, row.id],
    );
    recordsRelinked += updated.rowCount ?? 0;
  }

  return { recordsRelinked, duplicatesRemoved };
}

async function deleteEmptySeederCreatedEvents(
  client: PoolClient,
  schoolYearId: string,
) {
  const result = await client.query<DeletedEvent>(
    `
      DELETE FROM attendance_events ae
      WHERE ae.school_year_id = $1
        AND ae.description LIKE $2
        AND NOT EXISTS (
          SELECT 1
          FROM manual_attendance_records mar
          WHERE mar.event_id = ae.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM attendance_records ar
          WHERE ar.event_id = ae.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM attendance_imports ai
          WHERE ai.event_id = ae.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM attendance_request_events areq
          WHERE areq.event_id = ae.id
        )
      RETURNING ae.id, ae.name
    `,
    [schoolYearId, `${SEEDED_EVENT_DESCRIPTION_PREFIX}%`],
  );

  return result.rows;
}

async function renumberEventOrder(client: PoolClient, schoolYearId: string) {
  const result = await client.query<{ id: string }>(
    `
      WITH ordered AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY school_year_id
            ORDER BY
              COALESCE(
                event_date,
                timezone('Asia/Manila', event_start_at)::date,
                timezone('Asia/Manila', event_end_at)::date
              ) ASC NULLS LAST,
              created_at ASC,
              id ASC
          ) AS next_order
        FROM attendance_events
        WHERE school_year_id = $1
      )
      UPDATE attendance_events ae
      SET event_order = ordered.next_order,
          updated_at = NOW()
      FROM ordered
      WHERE ae.id = ordered.id
        AND ae.event_order IS DISTINCT FROM ordered.next_order
      RETURNING ae.id
    `,
    [schoolYearId],
  );

  return result.rowCount ?? 0;
}

export async function seedRelinkFrcManualAttendanceEvents(
  onProgress?: (message: string) => void,
): Promise<SeedRelinkFrcManualAttendanceEventsResult> {
  onProgress?.(
    "Resolving SY 2026-2027 / First Semester and canonical FRC events by Manila-local date",
  );

  const transactionResult = await withTransaction(async (client) => {
    const schoolYearId = await getTargetSchoolYearId(client);
    const eventByDate = await getCanonicalEventsByDate(client, schoolYearId);
    const remarkGroups: SeedRelinkFrcManualAttendanceEventsResult["remarkGroups"] = [];
    let recordsRelinked = 0;
    let duplicatesRemoved = 0;

    onProgress?.(
      "Relinking historical FRC manual-attendance rows to their canonical dated events",
    );

    for (const group of RELINK_GROUPS) {
      const targetEvent = eventByDate.get(group.eventDate);
      if (!targetEvent) {
        throw new Error(`Missing canonical FRC event for ${group.eventDate}.`);
      }

      const groupResult = await relinkRemarkGroup(
        client,
        schoolYearId,
        targetEvent.id,
        group.remarks,
      );
      recordsRelinked += groupResult.recordsRelinked;
      duplicatesRemoved += groupResult.duplicatesRemoved;
      remarkGroups.push({
        remarks: group.remarks,
        eventDate: group.eventDate,
        recordsRelinked: groupResult.recordsRelinked,
        duplicatesRemoved: groupResult.duplicatesRemoved,
      });
    }

    onProgress?.(
      "Deleting only empty seeder-created duplicate events and renumbering event order",
    );
    const deletedEvents = await deleteEmptySeederCreatedEvents(
      client,
      schoolYearId,
    );
    const eventOrdersRenumbered = await renumberEventOrder(client, schoolYearId);

    return {
      schoolYearId,
      recordsRelinked,
      duplicatesRemoved,
      deletedEvents,
      eventOrdersRenumbered,
      remarkGroups,
    };
  });

  const changed =
    transactionResult.recordsRelinked > 0 ||
    transactionResult.duplicatesRemoved > 0 ||
    transactionResult.deletedEvents.length > 0 ||
    transactionResult.eventOrdersRenumbered > 0;

  if (changed) {
    onProgress?.(
      "Refreshing final attendance and penalty results after FRC event relinking",
    );
    await refreshAttendanceFinalResults({
      schoolYearId: transactionResult.schoolYearId,
    });
  } else {
    onProgress?.(
      "FRC manual-attendance event links are already repaired; no refresh is needed",
    );
  }

  return {
    alreadySeeded: !changed,
    recordsRelinked: transactionResult.recordsRelinked,
    duplicatesRemoved: transactionResult.duplicatesRemoved,
    emptyEventsDeleted: transactionResult.deletedEvents.length,
    eventOrdersRenumbered: transactionResult.eventOrdersRenumbered,
    deletedEvents: transactionResult.deletedEvents.map((event) => event.name),
    remarkGroups: transactionResult.remarkGroups,
  };
}

if (require.main === module) {
  seedRelinkFrcManualAttendanceEvents((message) => console.log(message))
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "FRC manual-attendance event links are already repaired."
          : `Relinked ${result.recordsRelinked} record(s), removed ${result.duplicatesRemoved} duplicate(s), and deleted ${result.emptyEventsDeleted} empty event(s).`,
      );
      result.remarkGroups.forEach((group) => {
        console.log(
          `${group.eventDate}: ${group.recordsRelinked} relinked, ${group.duplicatesRemoved} duplicate(s) removed — ${group.remarks}`,
        );
      });
      if (result.deletedEvents.length > 0) {
        console.log(`Deleted events: ${result.deletedEvents.join(", ")}`);
      }
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("FRC manual-attendance event relink seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
