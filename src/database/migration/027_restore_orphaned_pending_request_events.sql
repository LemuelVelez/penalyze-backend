BEGIN;

WITH orphaned_events AS (
  SELECT
    ar.school_year_id,
    LOWER(REGEXP_REPLACE(TRIM(are.event_name), '\s+', ' ', 'g')) AS normalized_event_name,
    MIN(TRIM(are.event_name)) AS event_name
  FROM public.attendance_request_events are
  JOIN public.attendance_requests ar ON ar.id = are.request_id
  WHERE ar.status = 'pending'
    AND are.event_id IS NULL
    AND NULLIF(TRIM(are.event_name), '') IS NOT NULL
  GROUP BY
    ar.school_year_id,
    LOWER(REGEXP_REPLACE(TRIM(are.event_name), '\s+', ' ', 'g'))
),
missing_events AS (
  SELECT
    orphaned.school_year_id,
    orphaned.normalized_event_name,
    orphaned.event_name,
    ROW_NUMBER() OVER (
      PARTITION BY orphaned.school_year_id
      ORDER BY orphaned.event_name
    ) AS restore_order
  FROM orphaned_events orphaned
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.attendance_events event
    WHERE event.school_year_id = orphaned.school_year_id
      AND LOWER(REGEXP_REPLACE(TRIM(event.name), '\s+', ' ', 'g')) =
          orphaned.normalized_event_name
  )
),
current_max_order AS (
  SELECT
    school_year_id,
    COALESCE(MAX(event_order), 0) AS max_order
  FROM public.attendance_events
  GROUP BY school_year_id
)
INSERT INTO public.attendance_events (
  school_year_id,
  name,
  description,
  event_order
)
SELECT
  missing.school_year_id,
  missing.event_name,
  'Restored automatically from a pending attendance review request.',
  COALESCE(current_order.max_order, 0) + missing.restore_order
FROM missing_events missing
LEFT JOIN current_max_order current_order
  ON current_order.school_year_id = missing.school_year_id;

UPDATE public.attendance_request_events request_event
SET event_id = (
  SELECT event.id
  FROM public.attendance_requests request
  JOIN public.attendance_events event
    ON event.school_year_id = request.school_year_id
   AND LOWER(REGEXP_REPLACE(TRIM(event.name), '\s+', ' ', 'g')) =
       LOWER(REGEXP_REPLACE(TRIM(request_event.event_name), '\s+', ' ', 'g'))
  WHERE request.id = request_event.request_id
  ORDER BY event.event_order ASC, event.created_at ASC, event.id ASC
  LIMIT 1
)
WHERE request_event.event_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.attendance_requests request
    JOIN public.attendance_events event
      ON event.school_year_id = request.school_year_id
     AND LOWER(REGEXP_REPLACE(TRIM(event.name), '\s+', ' ', 'g')) =
         LOWER(REGEXP_REPLACE(TRIM(request_event.event_name), '\s+', ' ', 'g'))
    WHERE request.id = request_event.request_id
  );

COMMIT;
