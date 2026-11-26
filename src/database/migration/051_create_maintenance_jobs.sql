SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS public.maintenance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','failed','completed','cancelled')),
  phase TEXT NOT NULL DEFAULT 'queued',
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  input JSONB,
  result JSONB,
  processed INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  message TEXT,
  last_error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  runner_token UUID,
  heartbeat_at TIMESTAMPTZ,
  created_by UUID,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_jobs_open
  ON public.maintenance_jobs (kind, COALESCE(school_year_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending','running','paused','failed');
CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status ON public.maintenance_jobs (status, updated_at DESC);
INSERT INTO public.maintenance_jobs(kind, school_year_id)
SELECT 'masterlist_presence_rebuild', sy.id FROM public.school_years sy
WHERE public.is_masterlist_school_year(sy.id)
AND EXISTS (SELECT 1 FROM public.student_masterlist m WHERE m.school_year_id=sy.id)
ON CONFLICT DO NOTHING;
