const cleanStudentNumber = (value: unknown) => String(value ?? "").toUpperCase().replace(/[–—]/g, "-").replace(/\s/g, "");
const digits = (value: string) => value.replace(/O/g, "0");
const fullStudentNumber = /^(?:TC-?)?([0-9O]{2})-?([A-Z])-?([0-9O]+)$/;

export function normalizeStudentNumberKey(value: unknown): string {
  const text = cleanStudentNumber(value);
  const match = /^[0-9O]{1,5}$/.test(text) ? null : fullStudentNumber.exec(text);
  return match && match[3].length <= 5
    ? `TC-${digits(match[1])}-${match[2]}-${digits(match[3]).padStart(5, "0")}`
    : text.replace(/[^A-Z0-9-]/g, "");
}

export type StudentNumberParts = { year?: string; letter?: string; serial: string };
function rawStudentNumberParts(value: unknown): StudentNumberParts | null {
  const text = cleanStudentNumber(value);
  const full = /^[0-9O]{1,5}$/.test(text) ? null : fullStudentNumber.exec(text);
  const serial = (value: string) => digits(value).slice(-5).padStart(5, "0");
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
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
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
  return token.length < 4 ? [token] : [token, ...Array.from({ length: token.length }, (_, i) => token.slice(0, i) + token.slice(i + 1))];
}

export const cleanProgram = (value: unknown) => String(value ?? "").trim().replace(/[-\s]+$/, "");
export const normalizeProgram = (value: unknown) => cleanProgram(value).toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-");
export function collegeForProgram(value: unknown): string | null {
  const p = normalizeProgram(value);
  const bs = "BACHELOR OF SCIENCE IN ";
  if (p === bs + "AGRICULTURAL AND BIOSYSTEMS ENGINEERING") return "School of Engineering";
  if (["BUSINESS ADMINISTRATION-FINANCIAL MANAGEMENT", "AGRIBUSINESS", "AGRIBUSINESS MANAGEMENT", "HOSPITALITY MANAGEMENT"].some(x => p === bs + x)) return "College of Business Administration";
  if (["BACHELOR OF ELEMENTARY EDUCATION", "BACHELOR OF PHYSICAL EDUCATION", ...["ENGLISH", "FILIPINO", "MATHEMATICS", "SOCIAL STUDIES"].map(x => `BACHELOR OF SECONDARY EDUCATION-${x}`)].includes(p)) return "College of Teacher Education";
  if (["COMPUTER SCIENCE", "INFORMATION SYSTEMS"].some(x => p === bs + x)) return "College of Computing Studies";
  if (p.startsWith(bs + "AGRICULTURE") || p === bs + "FORESTRY") return "College of Agriculture and Forestry";
  if (p === "BACHELOR OF ARTS IN ENGLISH LANGUAGE STUDIES") return "College of Liberal Arts, Mathematics and Sciences";
  if (p === bs + "CRIMINOLOGY") return "School of Criminal Justice Education";
  return null;
}
