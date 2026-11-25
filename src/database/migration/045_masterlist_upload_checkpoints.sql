CREATE TABLE IF NOT EXISTS public.student_masterlist_upload_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL UNIQUE REFERENCES public.school_years(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  rows_total INT NOT NULL,
  rows_valid INT NOT NULL,
  rows_invalid INT NOT NULL,
  source_rows JSONB NOT NULL,
  created_by UUID,
  phase TEXT NOT NULL DEFAULT 'staged' CHECK (phase IN ('staged','syncing','refreshing')),
  import_id UUID REFERENCES public.student_masterlist_imports(id) ON DELETE CASCADE,
  summary JSONB,
  student_ids TEXT[] NOT NULL DEFAULT '{}',
  processed INT NOT NULL DEFAULT 0 CHECK (processed >= 0 AND processed <= cardinality(student_ids)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
