import "dotenv/config";
import { closeDatabasePool, query } from "../../lib/db";
import type { AttendanceFinalResultRecord } from "../model/schema.model";
import { listAttendanceFinalResults, setStudentEventAttendancesBatch, type StudentEventAttendanceChange } from "../../services/attendance.service";
import { reconcileMasterlist } from "../../services/masterlist.service";
import { normalizeStudentNumberKey, normalizeNameKey, nameKeysAgree } from "../../services/masterlist-normalize";

const FRC = /\b(frc|flag)\b/i;
const IP_DAY = /\bip\s*day\b|indigenous/i;
const OUT = /\bout\b/i;
const AFTERNOON = /afternoon|\bpm\b/i;

type EventPattern = { event: RegExp; session?: RegExp; latestOnly?: boolean };
type Rule =
  | { type: "perfect" }
  | { type: "presentInMatching"; pattern: EventPattern; invert?: boolean; expectedAbsences?: number }
  | { type: "absentOnlyInMatching"; pattern: EventPattern }
  | { type: "absentTotal"; number: number };
type Report = { student: string; rule: Rule };
type EventDetail = NonNullable<AttendanceFinalResultRecord["event_details"]>[number];

const REPORTS: readonly Report[] = [
  { student: "TC-24-A-00032", rule: { type: "perfect" } },
  { student: "TC-25-A-00453", rule: { type: "perfect" } },
  { student: "Jia May Vidad", rule: { type: "presentInMatching", pattern: { event: IP_DAY } } },
  { student: "Casey Calipayan Simbolon", rule: { type: "absentOnlyInMatching", pattern: { event: FRC } } },
  { student: "Jenie Estoque", rule: { type: "absentOnlyInMatching", pattern: { event: IP_DAY, session: AFTERNOON } } },
  { student: "TC-25-A-01029", rule: { type: "presentInMatching", pattern: { event: FRC }, invert: true, expectedAbsences: 4 } },
  { student: "Arjee Aguirre", rule: { type: "presentInMatching", pattern: { event: IP_DAY } } },
  { student: "TC-25-A-00479", rule: { type: "perfect" } },
  { student: "TC-25-A-00445", rule: { type: "absentOnlyInMatching", pattern: { event: IP_DAY, session: OUT, latestOnly: true } } },
  { student: "Ian Maloloy-on", rule: { type: "presentInMatching", pattern: { event: IP_DAY } } },
  { student: "Remark Rivera", rule: { type: "absentTotal", number: 2 } },
  { student: "Giecell Cabelin", rule: { type: "absentTotal", number: 2 } },
  { student: "Mary Anne Balucos", rule: { type: "absentOnlyInMatching", pattern: { event: IP_DAY, session: OUT, latestOnly: true } } },
  { student: "Keynes May C. Calibo", rule: { type: "perfect" } },
];

function matchesPattern(event: EventDetail, pattern: EventPattern) {
  return pattern.event.test(event.name) && (!pattern.session || pattern.session.test(event.name));
}

function eventTime(event: EventDetail) {
  return event.event_start_at ? new Date(event.event_start_at).getTime() : NaN;
}

async function listStudent(schoolYearId: string, studentId: string) {
  return listAttendanceFinalResults({ schoolYearId, studentId, consolidatedOnly: true, includeEventDetails: true, limit: 100 });
}

const startedAt = Date.now();
let currentStage = "Starting repair";
let stageStartedAt = startedAt;
function progress(message: string) {
  if (currentStage === message) return;
  currentStage = message;
  stageStartedAt = Date.now();
  console.log(`[${Math.floor((stageStartedAt - startedAt) / 1000)}s] ${message}`);
}
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code ? `${message} (PostgreSQL ${code})` : message;
}

type RepairPlan = {
  final: AttendanceFinalResultRecord;
  rule: Exclude<Rule, { type: "absentTotal" }>;
  matchingIds: Set<string>;
  changes: StudentEventAttendanceChange[];
};

async function main() {
  console.log("Penalyze • reported student attendance repair");
  progress("Connecting to PostgreSQL and finding the active school year…");
  const active = (await query<{ id: string }>("SELECT id FROM school_years WHERE is_active ORDER BY starts_at DESC LIMIT 1")).rows[0];
  if (!active) throw new Error("No active school year.");
  progress(`Reconciling the active school year ${active.id}…`);
  const reconciliation = await reconcileMasterlist(update => {
    progress(`[Reconciliation ${Math.floor(update.percent)}%] ${update.message}`);
  });
  if (reconciliation.schoolYear.id !== active.id) throw new Error("The active school year changed during reconciliation.");
  const schoolYearId = active.id;
  progress(`Reconciliation committed: ${reconciliation.recordsUpdated} record updates. Loading student identities…`);
  // Load only identities for the name lookup; event details are loaded for each
  // uniquely resolved student immediately before making changes.
  const identities = await listAttendanceFinalResults({ schoolYearId, consolidatedOnly: true, limit: 2147483647 });
  const needsAdmin: string[] = [];
  const plans: RepairPlan[] = [];
  for (const [index, { student, rule }] of REPORTS.entries()) {
    progress(`Checking reported student ${index + 1}/${REPORTS.length}: ${student}…`);
    const byId = /^TC-\d{2}-[A-Z]-\d{5}$/.test(student);
    const candidates = byId
      ? await listStudent(schoolYearId, normalizeStudentNumberKey(student))
      : identities.filter(row => nameKeysAgree(normalizeNameKey(student), normalizeNameKey(row.name)));
    if (candidates.length !== 1) {
      const note = `${student}: ${candidates.length} matches${candidates.length ? ` (${candidates.map(row => `${row.student_id} ${row.name}`).join("; ")})` : ""}; skipped.`;
      needsAdmin.push(note); console.log(note); continue;
    }
    const candidate = candidates[0];
    const rows = byId ? candidates : await listStudent(schoolYearId, candidate.student_id);
    if (rows.length !== 1) {
      const note = `${student}: final result is no longer unique; skipped.`;
      needsAdmin.push(note); console.log(note); continue;
    }
    const final = rows[0];
    const label = `${final.student_id} ${final.name}`;
    const before = final.total_absences;
    const details = final.event_details ?? [];
    const missed = details.filter(event => !event.attended);
    const summary = (count: number, after: number, suffix = "") => console.log(`${label}: ${count} event(s) changed; absences ${before} → ${after}${suffix}`);
    if (rule.type === "absentTotal") {
      if (before === rule.number) summary(0, before, " (OK)");
      else {
        needsAdmin.push(`${label}: expected ${rule.number}, found ${before}; missed events: ${missed.map(e => `${e.name} (${e.id})`).join("; ") || "none listed"}`);
        summary(0, before, " (NEEDS ADMIN CHOICE)");
      }
      continue;
    }
    if (!details.length && before > 0) {
      needsAdmin.push(`${label}: no event details available for ${before} absences.`);
      summary(0, before, " (NEEDS ADMIN CHOICE)"); continue;
    }
    let matching = rule.type === "perfect" ? [] : details.filter(event => matchesPattern(event, rule.pattern));
    if (rule.type !== "perfect" && !matching.length && !(rule.type === "presentInMatching" && rule.invert)) {
      needsAdmin.push(`${label}: no eligible event matched the expected event pattern.`);
      summary(0, before, " (NEEDS ADMIN CHOICE)"); continue;
    }
    if (rule.type !== "perfect" && rule.pattern.latestOnly && matching.length > 1) {
      // Never choose based on array order or a missing/ambiguous timestamp.
      matching = [...matching].sort((a, b) => eventTime(b) - eventTime(a));
      if (matching.some(event => !Number.isFinite(eventTime(event))) || eventTime(matching[0]) === eventTime(matching[1])) {
        needsAdmin.push(`${label}: latest IP Day OUT cannot be identified uniquely: ${matching.map(e => `${e.name} (${e.id}, ${e.event_start_at ?? "no start time"})`).join("; ")}`);
        summary(0, before, " (NEEDS ADMIN CHOICE)"); continue;
      }
      matching = [matching[0]];
    }
    if (rule.type !== "perfect" && rule.pattern.latestOnly && matching.length) {
      console.log(`${label}: using IP Day OUT ${matching[0].name} (${matching[0].id}, ${matching[0].event_start_at ?? "no start time"})`);
    }
    const matchingIds = new Set(matching.map(event => event.id));
    const changes: StudentEventAttendanceChange[] = [];
    for (const event of details) {
      const isMatch = matchingIds.has(event.id);
      let attended: boolean;
      if (rule.type === "perfect") attended = true;
      else if (rule.type === "absentOnlyInMatching") attended = !isMatch;
      else {
        if (rule.invert ? isMatch : !isMatch) continue;
        attended = true;
      }
      if (attended !== event.attended) changes.push({ eventId: event.id, attended });
    }
    plans.push({ final, rule, matchingIds, changes });
  }

  // Do not let two reported names silently select the same actual student.
  const plannedCounts = new Map<string, number>();
  for (const plan of plans) plannedCounts.set(plan.final.id, (plannedCounts.get(plan.final.id) ?? 0) + 1);
  const uniquePlans = plans.filter(plan => {
    if (plannedCounts.get(plan.final.id) === 1) return true;
    needsAdmin.push(`${plan.final.student_id} ${plan.final.name}: multiple reports resolved to the same student; skipped.`);
    return false;
  });
  const pending = uniquePlans.filter(plan => plan.changes.length > 0);
  const savedCounts = new Map<string, number>();
  const failedPlans = new Map<string, string>();
  if (pending.length) {
    progress(`Applying ${pending.reduce((total, plan) => total + plan.changes.length, 0)} event corrections across ${pending.length} students in one transaction…`);
    const saved = await setStudentEventAttendancesBatch(schoolYearId,
      pending.map(plan => ({ finalResultId: plan.final.id, changes: plan.changes })), progress);
    for (const result of saved) {
      if (result.saved) savedCounts.set(result.finalResultId, result.saved.updatedCount);
      else failedPlans.set(result.finalResultId, result.error);
    }
    progress("Repair batch committed. Verifying final absence totals…");
  } else {
    progress("No automatic event corrections required. Checking results…");
  }

  for (const [index, { final, rule, matchingIds, changes }] of uniquePlans.entries()) {
    const label = `${final.student_id} ${final.name}`;
    const before = final.total_absences;
    const details = final.event_details ?? [];
    const count = savedCounts.get(final.id) ?? 0;
    const summary = (count: number, after: number, suffix = "") => console.log(`${label}: ${count} event(s) changed; absences ${before} → ${after}${suffix}`);
    progress(`Verifying student ${index + 1}/${uniquePlans.length}: ${label}…`);
    const failure = failedPlans.get(final.id);
    if (failure) {
      needsAdmin.push(`${label}: ${failure}`);
      summary(0, before, " (NEEDS ADMIN CHOICE; correction rejected)");
      continue;
    }
    try {
      const refreshedRows = changes.length ? await listStudent(schoolYearId, final.student_id) : [final];
      const refreshed = refreshedRows.length === 1 ? refreshedRows[0] : undefined;
      if (!refreshed) {
        needsAdmin.push(`${label}: override saved but final result is unavailable; verify the current totals.`);
        console.log(`${label}: ${count} event(s) changed; absences ${before} → unavailable`); continue;
      }
      summary(count, refreshed.total_absences, changes.length ? ` (${changes.map(change => `${details.find(e => e.id === change.eventId)?.name}: ${change.attended ? "present" : "absent"}`).join("; ")})` : " (no changes)");
      if (rule.type === "presentInMatching" && rule.expectedAbsences !== undefined) {
        const frcAbsences = (refreshed.event_details ?? []).filter(e => FRC.test(e.name) && !e.attended).length;
        if (frcAbsences !== rule.expectedAbsences || refreshed.total_absences !== rule.expectedAbsences) {
          needsAdmin.push(`${label}: expected ${rule.expectedAbsences} FRC absences, found ${frcAbsences} FRC / ${refreshed.total_absences} total; FRC events were not changed.`);
        }
      } else if ((rule.type === "perfect" && refreshed.total_absences !== 0) || (rule.type === "absentOnlyInMatching" && refreshed.total_absences !== matchingIds.size)) {
        needsAdmin.push(`${label}: remaining calculated absence total ${refreshed.total_absences} differs from the expected total; inspect source/roster.`);
      }
    } catch (error) {
      needsAdmin.push(`${label}: ${describeError(error)}`);
      console.log(`${label}: ${count} event(s) changed; absences ${before} → unverified`);
      process.exitCode = 1;
    }
  }
  console.log("\nNEEDS ADMIN CHOICE");
  for (const note of needsAdmin) console.log(note);
  if (!needsAdmin.length) console.log("None");
  progress("Repair finished.");
}

// PostgreSQL statements can legitimately take time. Print the actual current
// operation and elapsed time while awaiting I/O; never claim a write succeeded
// before its transaction commits.
const heartbeat = setInterval(() => {
  console.log(`[${Math.floor((Date.now() - startedAt) / 1000)}s] Still processing: ${currentStage} (${Math.floor((Date.now() - stageStartedAt) / 1000)}s in this stage)`);
}, 10000);
heartbeat.unref();
main().catch(error => {
  console.error(`Repair stopped during ${currentStage}: ${describeError(error)}`);
  console.error("Any uncommitted transaction was rolled back. Previously committed reconciliation remains saved; the repair can be rerun.");
  process.exitCode = 1;
}).finally(async () => {
  clearInterval(heartbeat);
  await closeDatabasePool();
});
