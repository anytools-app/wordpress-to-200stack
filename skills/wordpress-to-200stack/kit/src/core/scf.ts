import { unserialize } from "php-serialize";

import type { WxrItem } from "./wxr.js";

export type ScfGroup = {
  name: string;
  repeat: boolean;
  fields: Array<{ name: string; type: string; label: string; choices?: string }>;
};

export type ScfDefinition = {
  title: string;
  groups: ScfGroup[];
  conditions: {
    postTypes: string[];
    postIds: number[];
    taxonomies?: string[];
    optionsPages?: string[];
  };
  error?: string;
};

type SerializedRecord = Record<string, unknown>;

function record(value: unknown): SerializedRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SerializedRecord : {};
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.values(value as SerializedRecord);
  return [];
}

function stringsFromSerialized(value: string | undefined): string[] {
  if (!value) return [];
  const result = unserialize(Buffer.from(value, "utf8")) as unknown;
  return values(result).map((entry) => String(entry)).filter(Boolean);
}

function firstMeta(item: WxrItem, key: string): string | undefined {
  return item.meta.find((entry) => entry.key === key)?.value;
}

function optionalSerialized(item: WxrItem, key: string): string[] | undefined {
  const value = firstMeta(item, key);
  return value ? stringsFromSerialized(value) : undefined;
}

export function extractScfDefinitions(items: WxrItem[]): ScfDefinition[] {
  return items.filter((item) => item.postType === "smart-custom-fields").map((item) => {
    const title = item.title;
    const setting = firstMeta(item, "smart-cf-setting");
    const postIds = (firstMeta(item, "smart-cf-condition-post-ids") ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);

    try {
      if (!setting) throw new Error("smart-cf-setting がありません");
      const groups = values(unserialize(Buffer.from(setting, "utf8")) as unknown).map((value): ScfGroup => {
        const group = record(value);
        return {
          name: String(group["group-name"] ?? ""),
          repeat: group.repeat === true || group.repeat === 1 || group.repeat === "1",
          fields: values(group.fields).map((value) => {
            const field = record(value);
            return {
              name: String(field.name ?? ""),
              type: String(field.type ?? ""),
              label: String(field.label ?? ""),
              choices: typeof field.choices === "string" ? field.choices : undefined,
            };
          }).filter((field) => field.name.length > 0),
        };
      });
      return {
        title,
        groups,
        conditions: {
          postTypes: optionalSerialized(item, "smart-cf-condition") ?? [],
          postIds,
          taxonomies: optionalSerialized(item, "smart-cf-taxonomies"),
          optionsPages: optionalSerialized(item, "smart-cf-options-pages"),
        },
      };
    } catch (error) {
      return {
        title,
        groups: [],
        conditions: { postTypes: [], postIds },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
