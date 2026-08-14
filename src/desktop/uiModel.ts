export interface ConditionalUiProperty {
  ui?: { visibleWhen?: Record<string, string | number | boolean> };
}

export function visibleConfigurationKeys(
  properties: Record<string, ConditionalUiProperty>,
  values: Record<string, string | number | boolean>
): string[] {
  return Object.entries(properties)
    .filter(([, property]) => matchesVisibility(property.ui?.visibleWhen, values))
    .map(([key]) => key);
}

export function matchesVisibility(
  conditions: Record<string, string | number | boolean> | undefined,
  values: Record<string, string | number | boolean>
): boolean {
  return !conditions || Object.entries(conditions).every(([key, expected]) => values[key] === expected);
}
