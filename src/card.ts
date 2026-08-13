import { AgentEvent } from "./types";

export type FeishuCard = Record<string, unknown>;

interface CardPart {
  index: number;
  total: number;
}

export function buildFeishuCard(
  event: AgentEvent,
  markdown: string,
  includeMetadata: boolean,
  part?: CardPart
): FeishuCard {
  const source = event.source === "claude-code"
    ? "Claude Code"
    : event.source === "codex"
      ? "Codex"
      : "Agent";
  const failed = event.status === "failed";
  const progress = event.status === "progress";
  const partLabel = part && part.total > 1 ? ` · ${part.index}/${part.total}` : "";
  const sessionLabel = event.sessionName
    ? `${truncate(event.sessionName, 48)} · ${event.sessionId}`
    : event.sessionId || "未知会话";
  const header = includeMetadata
    ? {
      template: failed ? "red" : progress ? "blue" : "green",
      title: {
        tag: "plain_text",
        content: `${failed ? "❌" : progress ? "💬" : "✅"} ${source} ${failed ? "执行失败" : progress ? "实时消息" : "已完成"}`
      },
      subtitle: {
        tag: "plain_text",
        content: `${sessionLabel} · ${event.project} · ${formatTime(event.occurredAt)}${partLabel}`
      }
    }
    : {
      template: failed ? "red" : progress ? "blue" : "green",
      title: { tag: "plain_text", content: `Agent 通知${partLabel}` }
    };

  return {
    schema: "2.0",
    config: { update_multi: true },
    header,
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: includeMetadata
        ? [sessionIdElement(event), ...markdownToCardElements(markdown)]
        : markdownToCardElements(markdown)
    }
  };
}

function sessionIdElement(event: AgentEvent): Record<string, unknown> {
  const source = event.source === "claude-code" ? "Claude Code" : event.source === "codex" ? "Codex" : "Agent";
  const origin = event.inputOrigin === "feishu" ? "飞书远程" : event.inputOrigin === "local" ? "VS Code 本地" : "未标记";
  return {
    tag: "markdown",
    content: `**${source} Session ID：** \`${escapeInlineCode(event.sessionId || "未知会话")}\`\n**输入来源：** ${origin}`
  };
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

export function markdownToCardElements(markdown: string): Array<Record<string, unknown>> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const elements: Array<Record<string, unknown>> = [];
  const markdownLines: string[] = [];

  const flushMarkdown = (): void => {
    const content = markdownLines.join("\n").trim();
    markdownLines.length = 0;
    if (content) {
      elements.push({ tag: "markdown", content });
    }
  };

  for (let index = 0; index < lines.length;) {
    const headers = parseTableRow(lines[index]);
    const separator = index + 1 < lines.length ? parseTableSeparator(lines[index + 1]) : undefined;
    if (!headers || !separator || headers.length !== separator.length) {
      markdownLines.push(lines[index]);
      index += 1;
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = parseTableRow(lines[index]);
      if (!row) {
        break;
      }
      rows.push(normalizeRow(row, headers.length));
      index += 1;
    }

    if (rows.length === 0) {
      markdownLines.push(`| ${headers.join(" | ")} |`);
      markdownLines.push(`| ${separator.join(" | ")} |`);
      continue;
    }

    flushMarkdown();
    elements.push(buildTable(headers, rows));
  }

  flushMarkdown();
  return elements.length > 0
    ? elements
    : [{ tag: "markdown", content: "_没有可显示的回复内容_" }];
}

function buildTable(headers: string[], rows: string[][]): Record<string, unknown> {
  const columns = headers.map((header, index) => ({
    name: `column_${index + 1}`,
    display_name: stripInlineMarkdown(header),
    data_type: "lark_md",
    width: "auto",
    vertical_align: "top"
  }));
  const tableRows = rows.map((row) => Object.fromEntries(
    row.map((cell, index) => [`column_${index + 1}`, cell])
  ));

  return {
    tag: "table",
    page_size: Math.min(10, Math.max(1, rows.length)),
    row_height: "auto",
    row_max_height: "240px",
    freeze_first_column: headers.length > 3,
    columns,
    rows: tableRows
  };
}

function parseTableSeparator(line: string): string[] | undefined {
  const cells = parseTableRow(line);
  return cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ? cells
    : undefined;
}

function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || trimmed.startsWith("```")) {
    return undefined;
  }

  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of content) {
    if (escaped) {
      current += character === "|" ? "|" : `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) {
    current += "\\";
  }
  cells.push(current.trim());
  return cells.length > 1 ? cells : undefined;
}

function normalizeRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}
