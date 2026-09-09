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
