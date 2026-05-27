BEGIN;

ALTER TABLE public.attendance_events
  ADD COLUMN IF NOT EXISTS event_order INTEGER;

WITH ordered_events AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY school_year_id
      ORDER BY
        COALESCE(event_start_at, event_end_at, created_at) ASC,
        created_at ASC,
        id ASC
    ) AS next_order
  FROM public.attendance_events
)
UPDATE public.attendance_events event
SET event_order = ordered_events.next_order
FROM ordered_events
WHERE event.id = ordered_events.id
  AND event.event_order IS NULL;

ALTER TABLE public.attendance_events
  ALTER COLUMN event_order SET DEFAULT 1,
  ALTER COLUMN event_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_events_school_year_order
  ON public.attendance_events(school_year_id, event_order);

COMMIT;
