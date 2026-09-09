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
  bgCyan: "\u001b[46m",
  bgGreen: "\u001b[42m",
  bgYellow: "\u001b[43m",
  bgRed: "\u001b[41m",
  black: "\u001b[30m",
} as const;

const BOX_WIDTH = 72;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const colorEnabled =
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true");
const liveOutputEnabled = Boolean(process.stdout.isTTY) && process.env.CI !== "true";

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

function clearLiveLine() {
  if (!liveOutputEnabled) return;
  process.stdout.write("\r\u001b[2K");
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

type TaskOptions = {
  detail?: string;
  prefix?: string;
};

type LiveTask = {
  update: (message: string, detail?: string) => void;
  succeed: (message?: string, detail?: string) => void;
  fail: (message?: string, detail?: string) => void;
};

let activeTask: { redraw: () => void; clear: () => void } | null = null;

function printLine(method: "log" | "error", line: string) {
  const task = activeTask;
  task?.clear();
  console[method](line);
  task?.redraw();
}

function startTask(message: string, options: TaskOptions = {}): LiveTask {
  const startedAt = Date.now();
  let frameIndex = 0;
  let currentMessage = message;
  let currentDetail = options.detail ?? "";
  let completed = false;

  const render = () => {
    if (!liveOutputEnabled || completed) return;
    const frame = paint(SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length], ANSI.cyan);
    const prefix = options.prefix ? `${paint(options.prefix, ANSI.dim)} ` : "";
    const status = badge("PROCESSING", ANSI.bgCyan);
    const detail = currentDetail ? ` ${paint("•", ANSI.gray)} ${paint(currentDetail, ANSI.dim)}` : "";
    const elapsed = paint(` ${paint("•", ANSI.gray)} ${formatDuration(Date.now() - startedAt)}`, ANSI.dim);
    clearLiveLine();
    process.stdout.write(`${frame} ${status} ${prefix}${currentMessage}${detail}${elapsed}`);
    frameIndex += 1;
  };

  const clear = () => {
    if (!liveOutputEnabled || completed) return;
    clearLiveLine();
  };

  activeTask?.clear();
  activeTask = { redraw: render, clear };

  if (liveOutputEnabled) {
    render();
  } else {
    const prefix = options.prefix ? `${options.prefix} ` : "";
    const detail = currentDetail ? ` • ${currentDetail}` : "";
    console.log(`… ${badge("PROCESSING", ANSI.bgCyan)} ${prefix}${currentMessage}${detail}`);
  }

  const timer = liveOutputEnabled
    ? setInterval(() => {
        render();
      }, 120)
    : null;
  timer?.unref?.();

  const finish = (tone: "success" | "error", finalMessage?: string, detail?: string) => {
    if (completed) return;
    completed = true;
    if (timer) clearInterval(timer);
    clearLiveLine();
    activeTask = null;

    const duration = paint(` ${paint("•", ANSI.gray)} ${formatDuration(Date.now() - startedAt)}`, ANSI.dim);
    const finalDetail = detail ? ` ${paint("•", ANSI.gray)} ${paint(detail, ANSI.dim)}` : "";

    if (tone === "success") {
      console.log(
        `${paint("✔", ANSI.green)} ${badge("DONE", ANSI.bgGreen)} ${finalMessage ?? currentMessage}${finalDetail}${duration}`,
      );
      return;
    }

    console.error(
      `${paint("✖", ANSI.red)} ${badge("FAILED", ANSI.bgRed)} ${finalMessage ?? currentMessage}${finalDetail}${duration}`,
    );
  };

  return {
    update(nextMessage: string, detail?: string) {
      const previousMessage = currentMessage;
      const previousDetail = currentDetail;
      currentMessage = nextMessage;
      if (detail !== undefined) currentDetail = detail;

      if (!liveOutputEnabled && (previousMessage !== currentMessage || previousDetail !== currentDetail)) {
        const prefix = options.prefix ? `${options.prefix} ` : "";
        const detailText = currentDetail ? ` • ${currentDetail}` : "";
        console.log(`  ↳ ${prefix}${currentMessage}${detailText}`);
        return;
      }

      render();
    },
    succeed(finalMessage?: string, detail?: string) {
      finish("success", finalMessage, detail);
    },
    fail(finalMessage?: string, detail?: string) {
      finish("error", finalMessage, detail);
    },
  };
}

export const consoleUi = {
  header(icon: string, title: string, subtitle: string) {
    const innerWidth = BOX_WIDTH - 4;
    const top = `╭${"─".repeat(BOX_WIDTH - 2)}╮`;
    const bottom = `╰${"─".repeat(BOX_WIDTH - 2)}╯`;
    const titleText = truncate(`${icon}  ${title}`, innerWidth);
    const subtitleText = truncate(subtitle, innerWidth);

    printLine("log", "");
    printLine("log", paint(top, ANSI.cyan));
    printLine(
      "log",
      `${paint("│", ANSI.cyan)} ${paint(pad(titleText, innerWidth), ANSI.bold)} ${paint("│", ANSI.cyan)}`,
    );
    printLine(
      "log",
      `${paint("│", ANSI.cyan)} ${paint(pad(subtitleText, innerWidth), ANSI.dim)} ${paint("│", ANSI.cyan)}`,
    );
    printLine("log", paint(bottom, ANSI.cyan));
  },

  section(icon: string, title: string) {
    printLine("log", "");
    printLine("log", `${icon}  ${paint(title, ANSI.bold, ANSI.magenta)}`);
    printLine("log", paint("─".repeat(BOX_WIDTH), ANSI.gray));
  },

  info(message: string) {
    printLine("log", `${paint("●", ANSI.cyan)} ${message}`);
  },

  detail(label: string, value: string | number) {
    printLine(
      "log",
      `  ${paint("↳", ANSI.gray)} ${paint(label, ANSI.dim)} ${paint(String(value), ANSI.bold)}`,
    );
  },

  success(message: string, durationMs?: number) {
    const duration = durationMs === undefined ? "" : paint(`  ${formatDuration(durationMs)}`, ANSI.dim);
    printLine("log", `${paint("✔", ANSI.green)} ${message}${duration}`);
  },

  warning(message: string) {
    printLine("log", `${paint("⚠", ANSI.yellow)} ${message}`);
  },

  skipped(message: string) {
    printLine("log", `${paint("↷", ANSI.yellow)} ${message}`);
  },

  progress(current: number, total: number, message: string) {
    const counter = paint(`[${String(current).padStart(String(total).length, "0")}/${total}]`, ANSI.dim);
    printLine("log", `${paint("◆", ANSI.cyan)} ${counter} ${message}`);
  },

  task(message: string, options?: TaskOptions) {
    return startTask(message, options);
  },

  summary(rows: Array<{ label: string; value: string | number; tone?: "success" | "warning" | "info" }>) {
    printLine("log", "");
    printLine("log", paint("┌─ Summary ", ANSI.bold, ANSI.cyan) + paint("─".repeat(BOX_WIDTH - 11), ANSI.gray));
    for (const row of rows) {
      const marker =
        row.tone === "success"
          ? paint("●", ANSI.green)
          : row.tone === "warning"
            ? paint("●", ANSI.yellow)
            : paint("●", ANSI.cyan);
      printLine("log", `${marker} ${row.label.padEnd(26)} ${paint(String(row.value), ANSI.bold)}`);
    }
    printLine("log", paint("└" + "─".repeat(BOX_WIDTH - 1), ANSI.gray));
  },

  completed(label: string, durationMs: number) {
    printLine("log", "");
    printLine(
      "log",
      `${badge("DONE", ANSI.bgGreen)} ${paint(label, ANSI.bold)} ${paint(`in ${formatDuration(durationMs)}`, ANSI.dim)}`,
    );
    printLine("log", "");
  },

  noChanges(message: string, durationMs: number) {
    printLine("log", "");
    printLine(
      "log",
      `${badge("CLEAN", ANSI.bgGreen)} ${message} ${paint(`(${formatDuration(durationMs)})`, ANSI.dim)}`,
    );
    printLine("log", "");
  },

  error(title: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    activeTask?.clear();
    activeTask = null;
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
