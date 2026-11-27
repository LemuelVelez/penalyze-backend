const cleanStudentNumber = (value: unknown) => String(value ?? "").toUpperCase().replace(/[–—]/g, "-").replace(/\s/g, "");
const digits = (value: string) => value.replace(/O/g, "0");
const fullStudentNumber = /^(?:TC-?)?([0-9O]{2})-?([A-Z])-?([0-9O]+)$/;

export function normalizeStudentNumberKey(value: unknown): string {
  const text = cleanStudentNumber(value);
  const match = /^[0-9O]+$/.test(text) ? null : fullStudentNumber.exec(text);
  return match && digits(match[3]).replace(/^0+(?=\d)/, "").length <= 5
    ? `TC-${digits(match[1])}-${match[2]}-${digits(match[3]).replace(/^0+(?=\d)/, "").padStart(5, "0")}`
    : text.replace(/[^A-Z0-9-]/g, "");
}

export type StudentNumberParts = { year?: string; letter?: string; serial: string };
function rawStudentNumberParts(value: unknown): StudentNumberParts | null {
  const text = cleanStudentNumber(value);
  const full = /^[0-9O]+$/.test(text) ? null : fullStudentNumber.exec(text);
  const serial = (value: string) => digits(value).replace(/^0+(?=\d)/, "").padStart(5, "0");
  if (full) return { year: digits(full[1]), letter: full[2], serial: serial(full[3]) };
  const partial = /^(?:TC-?([0-9O]{2})-?|([0-9O]{2})-)([0-9O]+)$/.exec(text);
  if (partial) return { year: digits(partial[1] ?? partial[2]), serial: serial(partial[3]) };
  if (/^[0-9O]+$/.test(text)) return { serial: serial(text) };
  return null;
}

export function isPlaceholderStudentNumber(value: unknown): boolean {
  return !cleanStudentNumber(value) || rawStudentNumberParts(value)?.serial === "00000" || /-00000$/.test(normalizeStudentNumberKey(value));
}

export function parseStudentNumberParts(value: unknown): StudentNumberParts | null {
  const parts = rawStudentNumberParts(value);
  return parts && parts.serial !== "00000" ? parts : null;
}

// Match the known Latin-1/Windows-1252 decoding errors repaired by migration 029.
export function repairNameMojibake(value: unknown): string {
  return String(value ?? "").replace(/Ã[±\u0091‘¡©\u00ad³º]/g, sequence => ({
    "Ã±": "ñ", "Ã\u0091": "Ñ", "Ã‘": "Ñ", "Ã¡": "á", "Ã©": "é",
    "Ã\u00ad": "í", "Ã³": "ó", "Ãº": "ú",
  } as Record<string, string>)[sequence] ?? sequence);
}

function orderedNameTokens(value: unknown): string[] {
  return repairNameMojibake(value).normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/)
    .filter(token => token.length > 1 && !["JR", "SR", "II", "III", "IV"].includes(token))
    .map(token => token === "MA" ? "MARIA" : token);
}

export function normalizeNameKey(value: unknown): string {
  return orderedNameTokens(value).sort().join(" ");
}

export function surnameTokensOverlap(name: unknown, surname: unknown): boolean {
  const uploaded = new Set(orderedNameTokens(name));
  return orderedNameTokens(surname).some(token => uploaded.has(token));
}

// Compare the given names in their original order, not the sorted name key.
// Require every surname token before accepting a joined/split given name.
export function joinedGivenNamesAgree(name: unknown, surname: unknown, givenName: unknown): boolean {
  const remaining = orderedNameTokens(name);
  const surnames = orderedNameTokens(surname);
  const given = orderedNameTokens(givenName).join("");
  if (!surnames.length || !given) return false;
  for (const token of surnames) {
    const index = remaining.indexOf(token);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.join("") === given;
}

export const nameTokens = (key: string) => [...new Set(key.split(" ").filter(Boolean))];

// At most one insertion, deletion or substitution; short tokens must match exactly.
export function nameTokensAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) i++;
    j++;
  }
  return edits + (b.length - j) <= 1;
}

// One-to-one token matching prevents one uploaded token satisfying two names.
export function sharedNameTokenCount(left: string, right: string): number {
  const a = nameTokens(left), b = nameTokens(right);
  const owners = new Map<number, number>();
  function assign(i: number, seen: Set<number>): boolean {
    for (let j = 0; j < b.length; j++) {
      if (seen.has(j) || !nameTokensAgree(a[i], b[j])) continue;
      seen.add(j);
      const owner = owners.get(j);
      if (owner === undefined || assign(owner, seen)) { owners.set(j, i); return true; }
    }
    return false;
  }
  for (let i = 0; i < a.length; i++) assign(i, new Set());
  return owners.size;
}

export function nameKeysAgree(left: string, right: string): boolean {
  const shorter = Math.min(nameTokens(left).length, nameTokens(right).length);
  return shorter >= 2 && sharedNameTokenCount(left, right) === shorter;
}

// Deletion signatures index exact and one-edit candidates; verify with nameKeysAgree.
export function nameTokenSignatures(token: string): string[] {
  return token.length < 3 ? [token] : [token, ...Array.from({ length: token.length }, (_, i) => token.slice(0, i) + token.slice(i + 1))];
}

export function masterlistNameSignatures(value: unknown): string[] {
  const tokens = orderedNameTokens(value);
  const signatures = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (let end = i + 1; end <= tokens.length; end++) {
      for (const signature of nameTokenSignatures(tokens.slice(i, end).join(""))) signatures.add(signature);
    }
  }
  return [...signatures];
}

// A surname must be present, together with at least one given name. Compare
// both exact and single-edit forms, without trusting QR college/program fields.
export function masterlistNameMatchRank(name: unknown, surname: unknown, givenName: unknown): number {
  const uploaded = orderedNameTokens(name);
  const family = orderedNameTokens(surname);
  const given = orderedNameTokens(givenName);
  if (!family.length || !given.length || uploaded.length < 2) return 0;
  const familyKey = family.join("");
  let best = 0;
  for (let start = 0; start < uploaded.length; start++) {
    for (let end = start + 1; end <= uploaded.length; end++) {
      const candidate = uploaded.slice(start, end).join("");
      const familyExact = candidate === familyKey;
      if (!familyExact && !nameTokensAgree(candidate, familyKey)) continue;
      const rest = [...uploaded.slice(0, start), ...uploaded.slice(end)];
      if (!rest.length) continue;
      // Full given names outrank an omitted/extra middle name. Do not match
      // solely on a shared middle name when the first given names conflict.
      const full = rest.join("") === given.join("");
      const shorter = Math.min(rest.length, given.length);
      const prefix = rest.slice(0, shorter).every((token, i) => token === given[i]);
      let fuzzy = false;
      if (!full && !prefix && familyExact) {
        const left = rest.slice(0, shorter).join("");
        const right = given.slice(0, shorter).join("");
        fuzzy = nameTokensAgree(left, right);
      }
      if (familyExact && full) best = Math.max(best, 4);
      else if (familyExact && prefix) best = Math.max(best, 3);
      else if (!familyExact && full) best = Math.max(best, 2);
      else if ((familyExact && fuzzy) || (!familyExact && prefix)) best = Math.max(best, 1);
    }
  }
  return best;
}

export const cleanProgram = (value: unknown) => String(value ?? "").trim().replace(/[-\s]+$/, "");
export const normalizeProgram = (value: unknown) => cleanProgram(value).toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-");
export function collegeForProgram(value: unknown): string | null {
  const p = normalizeProgram(value).replace(/[^A-Z0-9]/g, "");
  if (/^(?:BS)?(?:AGRICULTURAL(?:AND)?BIOSYSTEMSENGINEERING|AGRICULTURALENGINEERING|ABE)$/.test(p) || /^(?:BACHELOROFSCIENCEIN)AGRICULTURAL(?:AND)?BIOSYSTEMSENGINEERING$/.test(p) || p === "BSABE") return "School of Engineering";
  if (/^(?:BSBA|BSAB|BSHM|BSABM)(?:FINANCIALMANAGEMENT|MARKETINGMANAGEMENT|HUMANRESOURCEMANAGEMENT|OPERATIONSMANAGEMENT)?$/.test(p) || /^(?:BACHELOROFSCIENCEIN|BS)(?:BUSINESSADMINISTRATION|AGRIBUSINESS|HOSPITALITYMANAGEMENT)/.test(p)) return "College of Business Administration";
  if (/^(?:BSED|BEED|BPED|BPE|BACHELOROFSECONDARYEDUCATION|BACHELOROFELEMENTARYEDUCATION|BACHELOROFPHYSICALEDUCATION|BACHELOROFSPECIALNEEDSEDUCATION|BSNED|BECED|BACHELOROFEARLYCHILDHOODEDUCATION)/.test(p)) return "College of Teacher Education";
  if (/^(?:BSCS|BSIS|BSIT|(?:BACHELOROFSCIENCEIN|BS)(?:COMPUTERSCIENCE|INFORMATIONSYSTEMS|INFORMATIONTECHNOLOGY))$/.test(p)) return "College of Computing Studies";
  if (/^(?:BSA|BSF|(?:BACHELOROFSCIENCEIN|BS)(?:AGRICULTURE|FORESTRY))/.test(p)) return "College of Agriculture and Forestry";
  if (/^(?:BAELS|ABELS|BAENGLISHLANGUAGESTUDIES|ABENGLISHLANGUAGESTUDIES|BACHELOROFARTSINENGLISHLANGUAGESTUDIES)$/.test(p)) return "College of Liberal Arts, Mathematics and Sciences";
  if (/^(?:BSCrim|BSCRIM|BSCRIMINOLOGY|BACHELOROFSCIENCEINCRIMINOLOGY)$/.test(p)) return "School of Criminal Justice Education";
  return null;
}

export function studentIdSimilarity(given: unknown, masterNumber: unknown): number {
  const a = parseStudentNumberParts(given), b = parseStudentNumberParts(masterNumber);
  if (!a || !b) return 0;
  if (a.serial === b.serial) return a.year && a.year === b.year ? 3 : 2;
  if (!a.year || a.year !== b.year || !a.letter || a.letter !== b.letter || a.serial.length !== b.serial.length) return 0;
  const differences = [...a.serial].map((digit, i) => digit === b.serial[i] ? -1 : i).filter(i => i >= 0);
  if (differences.length === 1) return 1;
  const [i, j] = differences;
  return differences.length === 2 && j === i + 1 && a.serial[i] === b.serial[j] && a.serial[j] === b.serial[i] ? 1 : 0;
}
export function programInitials(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  return /\s/.test(text) ? text.split(/\s+/).filter(w => !["OF", "IN", "AND", "THE", "MAJOR"].includes(w)).map(w => w.replace(/[^A-Z]/g, "")[0] ?? "").join("") : text.replace(/[^A-Z]/g, "");
}
export const placeholderStudentNumberMessage = (studentId: string) => `${studentId} is a placeholder ID recorded when a QR code was not scanned. It is not a real Student ID. Search using your own Student ID. Attendance recorded under a wrong or placeholder ID is moved to your real Student ID when your name matches the masterlist; if it is still missing, submit an Attendance Review using your real Student ID.`;
