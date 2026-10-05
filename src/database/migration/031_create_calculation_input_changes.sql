BEGIN;

CREATE TABLE IF NOT EXISTS public.calculation_input_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id UUID NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calculation_input_changes_scope_source
  ON public.calculation_input_changes (
    source_kind,
    COALESCE(school_year_id, '00000000-0000-0000-0000-000000000000'::UUID),
    COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::UUID)
  );

CREATE INDEX IF NOT EXISTS idx_calculation_input_changes_school_year_changed
  ON public.calculation_input_changes(school_year_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.mark_calculation_input_change(
  p_school_year_id UUID,
  p_source_kind TEXT,
  p_source_id UUID DEFAULT NULL,
  p_changed_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.calculation_input_changes (
    school_year_id,
    source_kind,
    source_id,
    changed_at
  ) VALUES (
    p_school_year_id,
    p_source_kind,
    p_source_id,
    p_changed_at
  )
  ON CONFLICT DO NOTHING;

  UPDATE public.calculation_input_changes
  SET changed_at = GREATEST(changed_at, p_changed_at)
  WHERE source_kind = p_source_kind
    AND school_year_id IS NOT DISTINCT FROM p_school_year_id
    AND source_id IS NOT DISTINCT FROM p_source_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_all_calculation_input_changes(
  p_source_kind TEXT,
  p_changed_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.mark_calculation_input_change(sy.id, p_source_kind, NULL, p_changed_at)
  FROM public.school_years sy;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_calculation_input_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  old_school_year_id UUID;
  new_school_year_id UUID;
  old_source_id UUID;
  new_source_id UUID;
  old_kind TEXT;
  new_kind TEXT;
  zero_remark CONSTANT TEXT := 'Zero attendance registration from landing page.';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
    old_school_year_id := NULLIF(old_row ->> 'school_year_id', '')::UUID;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
    new_school_year_id := NULLIF(new_row ->> 'school_year_id', '')::UUID;
  END IF;

  IF TG_TABLE_NAME = 'attendance_records' THEN
    IF TG_OP <> 'INSERT' THEN
      old_source_id := NULLIF(old_row ->> 'import_id', '')::UUID;
      old_kind := CASE
        WHEN LOWER(TRIM(COALESCE(old_row ->> 'remarks', ''))) = LOWER(zero_remark)
          THEN 'zero_attendance'
        ELSE 'imported'
      END;
      PERFORM public.mark_calculation_input_change(old_school_year_id, old_kind, old_source_id);
    END IF;

    IF TG_OP <> 'DELETE' THEN
      new_source_id := NULLIF(new_row ->> 'import_id', '')::UUID;
      new_kind := CASE
        WHEN LOWER(TRIM(COALESCE(new_row ->> 'remarks', ''))) = LOWER(zero_remark)
          THEN 'zero_attendance'
        ELSE 'imported'
      END;
      PERFORM public.mark_calculation_input_change(new_school_year_id, new_kind, new_source_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'manual_attendance_records' THEN
    IF TG_OP <> 'INSERT' THEN
      old_kind := CASE
        WHEN COALESCE(old_row ->> 'attendance_type', 'manual') = 'zero_attendance'
          OR LOWER(TRIM(COALESCE(old_row ->> 'remarks', ''))) = LOWER(zero_remark)
          THEN 'zero_attendance'
        ELSE 'manual'
      END;
      PERFORM public.mark_calculation_input_change(old_school_year_id, old_kind, NULL);
    END IF;

    IF TG_OP <> 'DELETE' THEN
      new_kind := CASE
        WHEN COALESCE(new_row ->> 'attendance_type', 'manual') = 'zero_attendance'
          OR LOWER(TRIM(COALESCE(new_row ->> 'remarks', ''))) = LOWER(zero_remark)
          THEN 'zero_attendance'
        ELSE 'manual'
      END;
      PERFORM public.mark_calculation_input_change(new_school_year_id, new_kind, NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_imports' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM public.mark_calculation_input_change(
        old_school_year_id,
        'imported',
        NULLIF(old_row ->> 'id', '')::UUID
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM public.mark_calculation_input_change(
        new_school_year_id,
        'imported',
        NULLIF(new_row ->> 'id', '')::UUID
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_events' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM public.mark_calculation_input_change(old_school_year_id, 'events', NULL);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM public.mark_calculation_input_change(new_school_year_id, 'events', NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_event_college_exemptions' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM public.mark_calculation_input_change(old_school_year_id, 'college_exemptions', NULL);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM public.mark_calculation_input_change(new_school_year_id, 'college_exemptions', NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_event_year_level_exemptions' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM public.mark_calculation_input_change(old_school_year_id, 'year_level_exemptions', NULL);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM public.mark_calculation_input_change(new_school_year_id, 'year_level_exemptions', NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'penalties' THEN
    PERFORM public.mark_all_calculation_input_changes('penalties');
  ELSIF TG_TABLE_NAME = 'students' THEN
    PERFORM public.mark_all_calculation_input_changes('students');
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calculation_input_attendance_records ON public.attendance_records;
CREATE TRIGGER trg_calculation_input_attendance_records
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_records
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_manual_records ON public.manual_attendance_records;
CREATE TRIGGER trg_calculation_input_manual_records
AFTER INSERT OR UPDATE OR DELETE ON public.manual_attendance_records
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_imports ON public.attendance_imports;
CREATE TRIGGER trg_calculation_input_imports
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_imports
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_events ON public.attendance_events;
CREATE TRIGGER trg_calculation_input_events
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_events
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_college_exemptions ON public.attendance_event_college_exemptions;
CREATE TRIGGER trg_calculation_input_college_exemptions
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_event_college_exemptions
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_year_level_exemptions ON public.attendance_event_year_level_exemptions;
CREATE TRIGGER trg_calculation_input_year_level_exemptions
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_event_year_level_exemptions
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_penalties ON public.penalties;
CREATE TRIGGER trg_calculation_input_penalties
AFTER INSERT OR UPDATE OR DELETE ON public.penalties
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

DROP TRIGGER IF EXISTS trg_calculation_input_students ON public.students;
CREATE TRIGGER trg_calculation_input_students
AFTER INSERT OR UPDATE OR DELETE ON public.students
FOR EACH ROW EXECUTE FUNCTION public.track_calculation_input_change();

-- Seed change timestamps from existing data, then acknowledge changes already
-- covered by calculation results that predate this tracker.
INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT
  ar.school_year_id,
  CASE
    WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      THEN 'zero_attendance'
    ELSE 'imported'
  END,
  CASE
    WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      THEN ar.import_id
    ELSE ar.import_id
  END,
  MAX(ar.updated_at)
FROM public.attendance_records ar
GROUP BY
  ar.school_year_id,
  CASE
    WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      THEN 'zero_attendance'
    ELSE 'imported'
  END,
  ar.import_id
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT
  mar.school_year_id,
  CASE
    WHEN COALESCE(mar.attendance_type, 'manual') = 'zero_attendance'
      OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      THEN 'zero_attendance'
    ELSE 'manual'
  END,
  NULL,
  MAX(mar.updated_at)
FROM public.manual_attendance_records mar
GROUP BY
  mar.school_year_id,
  CASE
    WHEN COALESCE(mar.attendance_type, 'manual') = 'zero_attendance'
      OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      THEN 'zero_attendance'
    ELSE 'manual'
  END
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT
  ai.school_year_id,
  'imported',
  ai.id,
  GREATEST(ai.created_at, COALESCE(ai.deleted_at, ai.created_at))
FROM public.attendance_imports ai
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT school_year_id, 'events', NULL, MAX(updated_at)
FROM public.attendance_events
GROUP BY school_year_id
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT school_year_id, 'college_exemptions', NULL, MAX(updated_at)
FROM public.attendance_event_college_exemptions
GROUP BY school_year_id
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT school_year_id, 'year_level_exemptions', NULL, MAX(updated_at)
FROM public.attendance_event_year_level_exemptions
GROUP BY school_year_id
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT sy.id, 'penalties', NULL, source.changed_at
FROM public.school_years sy
CROSS JOIN (SELECT MAX(updated_at) AS changed_at FROM public.penalties) source
WHERE source.changed_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.calculation_input_changes (school_year_id, source_kind, source_id, changed_at)
SELECT sy.id, 'students', NULL, source.changed_at
FROM public.school_years sy
CROSS JOIN (SELECT MAX(updated_at) AS changed_at FROM public.students) source
WHERE source.changed_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- Treat existing calculation results as the initial acknowledgement baseline.
UPDATE public.calculation_input_changes cic
SET acknowledged_at = (
  SELECT MAX(cr.calculated_at)
  FROM public.calculation_results cr
  WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
    AND (
      cic.source_id IS NULL
      OR cic.source_id = ANY(cr.import_ids)
      OR cr.calculation_scope_key = 'school_year'
    )
)
WHERE cic.source_kind = 'imported'
  AND (
    SELECT MAX(cr.calculated_at)
    FROM public.calculation_results cr
    WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
      AND (
        cic.source_id IS NULL
        OR cic.source_id = ANY(cr.import_ids)
        OR cr.calculation_scope_key = 'school_year'
      )
  ) >= cic.changed_at;

UPDATE public.calculation_input_changes cic
SET acknowledged_at = (
  SELECT MAX(cr.calculated_at)
  FROM public.calculation_results cr
  WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
    AND (
      cr.calculation_scope_key = 'school_year'
      OR cic.source_kind = ANY(
        string_to_array(
          split_part(split_part(cr.calculation_scope_key, '|', 1), ':', 2),
          ','
        )
      )
    )
)
WHERE cic.source_kind IN ('manual', 'zero_attendance')
  AND (
    SELECT MAX(cr.calculated_at)
    FROM public.calculation_results cr
    WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
      AND (
        cr.calculation_scope_key = 'school_year'
        OR cic.source_kind = ANY(
          string_to_array(
            split_part(split_part(cr.calculation_scope_key, '|', 1), ':', 2),
            ','
          )
        )
      )
  ) >= cic.changed_at;

UPDATE public.calculation_input_changes cic
SET acknowledged_at = (
  SELECT MAX(cr.calculated_at)
  FROM public.calculation_results cr
  WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
)
WHERE cic.source_kind IN (
    'events',
    'college_exemptions',
    'year_level_exemptions',
    'penalties',
    'students'
  )
  AND (
    SELECT MAX(cr.calculated_at)
    FROM public.calculation_results cr
    WHERE cr.school_year_id IS NOT DISTINCT FROM cic.school_year_id
  ) >= cic.changed_at;

COMMIT;
