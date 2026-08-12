import { ReceiveIdType } from "./types";

export function parseIdList(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,，;；]+/).map((entry) => entry.trim()).filter(Boolean)));
}

export function validateIdListInput(
  value: string,
  prefix: "ou_" | "oc_",
  label: string,
  required: boolean
): string | undefined {
  const identifiers = parseIdList(value);
  if (required && identifiers.length === 0) {
    return `至少填写一个${label}`;
  }
  const invalid = identifiers.find((identifier) => !identifier.startsWith(prefix));
  return invalid ? `${label}必须以 ${prefix} 开头：${invalid}` : undefined;
}

export function validateReceiveIdInput(value: string, type: ReceiveIdType): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return "通知目标不能为空";
  }
  if (type === "chat_id" && !normalized.startsWith("oc_")) {
    return "群聊 chat_id 必须以 oc_ 开头";
  }
  if (type === "open_id" && !normalized.startsWith("ou_")) {
    return "用户 open_id 必须以 ou_ 开头";
  }
  if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return "邮箱格式无效";
  }
  return undefined;
}
