import type { FieldDef, RepeaterDef } from "../config.js";
import type { WxrItem } from "../core/wxr.js";

export type RepeaterError = { code: "repeaterColumnCountMismatch"; repeater: string; wpId: number; counts: Record<string, number> };

export function metaValues(item: WxrItem, metaKey: string): string[] {
  return item.meta.filter((entry) => entry.key === metaKey).map((entry) => entry.value);
}

export function zipRepeater(item: WxrItem, definition: RepeaterDef, convert: (field: FieldDef, value: string) => unknown): {
  rows: Array<Record<string, unknown>>;
  error?: RepeaterError;
} {
  const columns = definition.columns.map((column) => ({ column, values: metaValues(item, column.metaKey) }));
  const counts = Object.fromEntries(columns.map(({ column, values }) => [column.metaKey, values.length]));
  const lengths = new Set(columns.map(({ values }) => values.length));
  if (lengths.size > 1) return { rows: [], error: { code: "repeaterColumnCountMismatch", repeater: definition.fieldId, wpId: item.wpId, counts } };
  const length = columns[0]?.values.length ?? 0;
  return {
    rows: Array.from({ length }, (_, index) => Object.fromEntries(columns.map(({ column, values }) => [column.fieldId, convert(column, values[index] ?? "")]))),
  };
}
