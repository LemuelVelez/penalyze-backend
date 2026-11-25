export function normalizeStudentNumberKey(value: unknown): string {
  const text = String(value ?? "").toUpperCase().replace(/[–—]/g, "-").replace(/\s/g, "");
  const match = /^TC-?(\d{2})-?([A-Z])-?(\d{1,5})$/.exec(text);
  return match ? `TC-${match[1]}-${match[2]}-${match[3].padStart(5, "0")}` : text.replace(/[^A-Z0-9-]/g, "");
}

export function normalizeNameKey(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(token => token.length > 1).sort().join(" ");
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
  if (p === bs + "AGRICULTURE" || p.startsWith(bs + "AGRICULTURE-") || p === bs + "FORESTRY") return "College of Agriculture and Forestry";
  if (p === "BACHELOR OF ARTS IN ENGLISH LANGUAGE STUDIES") return "College of Liberal Arts, Mathematics and Sciences";
  if (p === bs + "CRIMINOLOGY") return "School of Criminal Justice Education";
  return null;
}
