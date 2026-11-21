-- Allow officer-reviewed declarations of no event participation.
ALTER TABLE public.attendance_requests
  DROP CONSTRAINT IF EXISTS attendance_requests_request_type_check;

ALTER TABLE public.attendance_requests
  ADD CONSTRAINT attendance_requests_request_type_check
  CHECK (request_type IN ('event_review', 'details_correction', 'zero_attendance'));
