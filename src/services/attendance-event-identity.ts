export type AttendanceEventIdentityInput = {
  name?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
};

export type AttendanceEventIdentityMatch = {
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

const TOKEN_EXPANSIONS: Record<string, string[]> = {
  gen: ["general"],
  genl: ["general"],
  assy: ["assembly"],
  asm: ["assembly"],
  frc: ["flag", "raising", "ceremony"],
  dept: ["department"],
  mtg: ["meeting"],
  orient: ["orientation"],
};

const NOISE_TOKENS = new Set([
  "batch",
  "section",
  "sec",
  "part",
  "group",
  "scanner",
  "scan",
  "copy",
  "file",
  "attendance",
  "am",
  "pm",
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
]);

function clean(value: unknown) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoiseToken(token: string) {
  return (
    NOISE_TOKENS.has(token) ||
    /^\d{1,4}$/.test(token) ||
    /^\d+(st|nd|rd|th)$/.test(token)
  );
}

export function normalizeAttendanceEventIdentityName(value: unknown) {
  const tokens = clean(value)
    .split(" ")
    .filter(Boolean)
    .flatMap((token) => TOKEN_EXPANSIONS[token] ?? [token])
    .filter((token) => !isNoiseToken(token));

  return tokens.join(" ");
}

function levenshtein(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function editSimilarity(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  return maxLength ? 1 - levenshtein(left, right) / maxLength : 0;
}

function parseTime(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

// Month and day are removed from the *fuzzy name* key below. However, they
// must still participate in event identity: September 2 and October 2 are
// different events even when every other word in their titles is identical.
// Only compare dates when both names provide an unambiguous month + day.
const CALENDAR_MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

type ExplicitEventDate = { month: number; day: number; year: number | null };

function explicitEventDate(name: unknown): ExplicitEventDate | null {
  const tokens = clean(name).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const month = CALENDAR_MONTHS[tokens[index]];
    if (!month) continue;
    const dayText = tokens[index + 1];
    if (!/^\d{1,2}$/.test(dayText)) continue;
    const day = Number(dayText);
    if (day < 1 || day > 31) continue;
    const yearText = tokens[index + 2];
    const year = /^20\d{2}$/.test(yearText ?? "") ? Number(yearText)
      : /^\d{2}$/.test(yearText ?? "") ? 2000 + Number(yearText)
        : null;
    // Reject invalid month/day pairs instead of comparing impossible dates.
    const checkYear = year ?? 2024; // Leap year accepts February 29 without an explicit year.
    const valid = new Date(Date.UTC(checkYear, month - 1, day));
    if (valid.getUTCMonth() !== month - 1 || valid.getUTCDate() !== day) continue;
    return { month, day, year };
  }
  return null;
}

/** Prevent an automatic merge across differently dated occurrences. */
export function haveConflictingAttendanceEventDates(
  incoming: AttendanceEventIdentityInput,
  existing: AttendanceEventIdentityInput,
): boolean {
  const incomingDate = explicitEventDate(incoming.name);
  const existingDate = explicitEventDate(existing.name);
  if (incomingDate && existingDate && (
    incomingDate.month !== existingDate.month ||
    incomingDate.day !== existingDate.day ||
    (incomingDate.year !== null && existingDate.year !== null && incomingDate.year !== existingDate.year)
  )) return true;

  // A name without a date can still describe a recurring event. Use scheduled
  // times only when both sides provide them; never guess a schedule.
  const incomingSchedule = parseTime(incoming.startAt) ?? parseTime(incoming.endAt);
  const existingSchedule = parseTime(existing.startAt) ?? parseTime(existing.endAt);
  return Boolean(incomingSchedule && existingSchedule &&
    Math.abs(incomingSchedule.getTime() - existingSchedule.getTime()) > 1.25 * 86_400_000);
}

function getScheduleScore(
  incoming: AttendanceEventIdentityInput,
  existing: AttendanceEventIdentityInput,
) {
  const incomingStart = parseTime(incoming.startAt);
  const incomingEnd = parseTime(incoming.endAt);
  const existingStart = parseTime(existing.startAt);
  const existingEnd = parseTime(existing.endAt);
  const incomingDate = incomingStart ?? incomingEnd;
  const existingDate = existingStart ?? existingEnd;
  const reasons: string[] = [];

  if (!incomingDate || !existingDate) {
    return { score: 0.5, comparable: false, reasons };
  }

  const dayDifference = Math.abs(incomingDate.getTime() - existingDate.getTime()) / 86_400_000;
  const sameDay = dayKey(incomingDate) === dayKey(existingDate);

  if (!sameDay && dayDifference > 1.25) {
    return {
      score: 0,
      comparable: true,
      reasons: ["event dates are far apart"],
    };
  }

  let score = sameDay ? 0.7 : 0.3;
  if (sameDay) reasons.push("same event date");

  if (incomingStart && existingStart) {
    const minutes = Math.abs(incomingStart.getTime() - existingStart.getTime()) / 60_000;
    if (minutes <= 15) {
      score += 0.2;
      reasons.push("start times are within 15 minutes");
    } else if (minutes <= 60) {
      score += 0.1;
      reasons.push("start times are within one hour");
    }
  }

  if (incomingStart && incomingEnd && existingStart && existingEnd) {
    const overlaps =
      incomingStart.getTime() <= existingEnd.getTime() &&
      existingStart.getTime() <= incomingEnd.getTime();
    if (overlaps) {
      score += 0.1;
      reasons.push("event time windows overlap");
    }
  }

  return { score: Math.min(score, 1), comparable: true, reasons };
}

export function scoreAttendanceEventIdentity(
  incoming: AttendanceEventIdentityInput,
  existing: AttendanceEventIdentityInput,
): AttendanceEventIdentityMatch {
  const incomingName = normalizeAttendanceEventIdentityName(incoming.name);
  const existingName = normalizeAttendanceEventIdentityName(existing.name);
  const reasons: string[] = [];

  if (!incomingName || !existingName) {
    return { score: 0, confidence: "low", reasons: ["missing event name"] };
  }

  if (haveConflictingAttendanceEventDates(incoming, existing)) {
    return { score: 0, confidence: "low", reasons: ["event dates are different; do not auto-merge"] };
  }

  const incomingTokens = new Set(incomingName.split(" ").filter(Boolean));
  const existingTokens = new Set(existingName.split(" ").filter(Boolean));
  const intersection = [...incomingTokens].filter((token) => existingTokens.has(token)).length;
  const minimumSize = Math.max(1, Math.min(incomingTokens.size, existingTokens.size));
  const unionSize = Math.max(1, new Set([...incomingTokens, ...existingTokens]).size);
  const containment = intersection / minimumSize;
  const jaccard = intersection / unionSize;
  const edit = editSimilarity(incomingName, existingName);
  let nameScore = containment * 0.5 + jaccard * 0.3 + edit * 0.2;

  if (incomingName === existingName) {
    nameScore = 1;
    reasons.push("normalized event names match");
  } else if (containment >= 0.8) {
    reasons.push("event names share most meaningful words");
  } else if (edit >= 0.75) {
    reasons.push("event names are textually similar");
  }

  const schedule = getScheduleScore(incoming, existing);
  reasons.push(...schedule.reasons);

  let score = schedule.comparable
    ? nameScore * 0.72 + schedule.score * 0.28
    : nameScore * 0.82;

  if (schedule.comparable && schedule.score === 0) score *= 0.45;
  score = Math.max(0, Math.min(1, score));

  const confidence = score >= 0.82 ? "high" : score >= 0.66 ? "medium" : "low";
  return {
    score: Number(score.toFixed(4)),
    confidence,
    reasons: reasons.length ? reasons : ["weak event similarity"],
  };
}
