const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
  bgGreen: "\u001b[42m",
  bgYellow: "\u001b[43m",
  bgRed: "\u001b[41m",
  black: "\u001b[30m",
} as const;

const BOX_WIDTH = 68;
const colorEnabled =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true");

function paint(text: string, ...codes: string[]) {
  if (!colorEnabled) return text;
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function visibleLength(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function pad(text: string, width: number) {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function badge(label: string, background: string) {
  return paint(` ${label} `, ANSI.bold, background, ANSI.black);
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

export const consoleUi = {
  header(icon: string, title: string, subtitle: string) {
    const innerWidth = BOX_WIDTH - 4;
    const top = `╭${"─".repeat(BOX_WIDTH - 2)}╮`;
    const bottom = `╰${"─".repeat(BOX_WIDTH - 2)}╯`;
    const titleText = truncate(`${icon}  ${title}`, innerWidth);
    const subtitleText = truncate(subtitle, innerWidth);

    console.log("");
    console.log(paint(top, ANSI.cyan));
    console.log(
      `${paint("│", ANSI.cyan)} ${paint(pad(titleText, innerWidth), ANSI.bold)} ${paint("│", ANSI.cyan)}`,
    );
    console.log(
      `${paint("│", ANSI.cyan)} ${paint(pad(subtitleText, innerWidth), ANSI.dim)} ${paint("│", ANSI.cyan)}`,
    );
    console.log(paint(bottom, ANSI.cyan));
  },

  section(icon: string, title: string) {
    console.log("");
    console.log(`${icon}  ${paint(title, ANSI.bold, ANSI.magenta)}`);
    console.log(paint("─".repeat(BOX_WIDTH), ANSI.gray));
  },

  info(message: string) {
    console.log(`${paint("●", ANSI.cyan)} ${message}`);
  },

  success(message: string, durationMs?: number) {
    const duration = durationMs === undefined ? "" : paint(`  ${formatDuration(durationMs)}`, ANSI.dim);
    console.log(`${paint("✔", ANSI.green)} ${message}${duration}`);
  },

  warning(message: string) {
    console.log(`${paint("⚠", ANSI.yellow)} ${message}`);
  },

  skipped(message: string) {
    console.log(`${paint("↷", ANSI.yellow)} ${message}`);
  },

  progress(current: number, total: number, message: string) {
    const counter = paint(`[${String(current).padStart(String(total).length, "0")}/${total}]`, ANSI.dim);
    console.log(`${paint("◆", ANSI.cyan)} ${counter} ${message}`);
  },

  summary(rows: Array<{ label: string; value: string | number; tone?: "success" | "warning" | "info" }>) {
    console.log("");
    console.log(paint("┌─ Summary ", ANSI.bold, ANSI.cyan) + paint("─".repeat(BOX_WIDTH - 11), ANSI.gray));
    for (const row of rows) {
      const marker =
        row.tone === "success"
          ? paint("●", ANSI.green)
          : row.tone === "warning"
            ? paint("●", ANSI.yellow)
            : paint("●", ANSI.cyan);
      console.log(`${marker} ${row.label.padEnd(24)} ${paint(String(row.value), ANSI.bold)}`);
    }
    console.log(paint("└" + "─".repeat(BOX_WIDTH - 1), ANSI.gray));
  },

  completed(label: string, durationMs: number) {
    console.log("");
    console.log(`${badge("DONE", ANSI.bgGreen)} ${paint(label, ANSI.bold)} ${paint(`in ${formatDuration(durationMs)}`, ANSI.dim)}`);
    console.log("");
  },

  noChanges(message: string, durationMs: number) {
    console.log("");
    console.log(`${badge("CLEAN", ANSI.bgGreen)} ${message} ${paint(`(${formatDuration(durationMs)})`, ANSI.dim)}`);
    console.log("");
  },

  error(title: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error(`${badge("FAILED", ANSI.bgRed)} ${paint(title, ANSI.bold, ANSI.red)}`);
    console.error(paint("─".repeat(BOX_WIDTH), ANSI.red));
    console.error(`${paint("✖", ANSI.red)} ${message}`);
    if (error instanceof Error && error.stack && process.env.NODE_ENV !== "production") {
      const stack = error.stack.split("\n").slice(1, 5).join("\n");
      if (stack) console.error(paint(stack, ANSI.dim));
    }
    console.error("");
  },
};
