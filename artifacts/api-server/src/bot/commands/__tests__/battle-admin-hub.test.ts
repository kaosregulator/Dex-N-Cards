import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHubComponents } from "../battle-admin.js";

const THEME_COLUMN_SQL =
  "ADD COLUMN IF NOT EXISTS battle_status_theme text NOT NULL DEFAULT 'classic'";

type RowJson = {
  components: Array<{
    type: number;
    label?: string;
    custom_id?: string;
    placeholder?: string;
    options?: Array<{ label: string; value: string; description?: string; default?: boolean }>;
  }>;
};

function hubRows(ms: number, gif = "normal"): RowJson[] {
  return buildHubComponents({ frameDelayMs: ms, battleAnimationSpeed: gif }).map(row => row.toJSON() as RowJson);
}

function expectDiscordSafe(rows: RowJson[]) {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(5);
  for (const row of rows) {
    expect(row.components.length).toBeGreaterThan(0);
    expect(row.components.length).toBeLessThanOrEqual(5);
    const selects = row.components.filter(c => c.type === 3);
    if (selects.length > 0) {
      expect(row.components).toHaveLength(1);
      for (const menu of selects) {
        const options = menu.options ?? [];
        expect(options.length).toBeGreaterThan(0);
        expect(options.length).toBeLessThanOrEqual(25);
        expect(options.filter(o => o.default)).toHaveLength(1);
        expect((menu.placeholder ?? "").length).toBeLessThanOrEqual(150);
        for (const option of options) {
          expect(option.label.length).toBeLessThanOrEqual(100);
          expect((option.description ?? "").length).toBeLessThanOrEqual(100);
          expect(option.value.length).toBeLessThanOrEqual(100);
        }
      }
    }
    for (const component of row.components) {
      if (component.type !== 2) continue;
      expect((component.label ?? "").length).toBeLessThanOrEqual(80);
      expect((component.custom_id ?? "").length).toBeLessThanOrEqual(100);
    }
  }
}

describe("battle admin hub components", () => {
  it("stays inside Discord's row, button, and select limits", () => {
    for (const ms of [950, 1000, 900, 1100, 0, 5000]) {
      expectDiscordSafe(hubRows(ms, "normal"));
      expectDiscordSafe(hubRows(ms, "custom"));
    }
  });

  it("marks a single speed preset when the saved delay sits between two presets", () => {
    const rows = hubRows(1000);
    const speed = rows.flatMap(row => row.components).find(c => c.custom_id === "battleadmin:speed");
    const defaults = (speed?.options ?? []).filter(o => o.default).map(o => o.value);
    expect(defaults).toEqual(["1100"]);
  });

  it("boot and the settings reader both add the status-layout column", () => {
    const boot = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
    const reader = readFileSync(new URL("../../battle/config-engine.ts", import.meta.url), "utf8");
    expect(boot).toContain(THEME_COLUMN_SQL);
    expect(reader).toContain(THEME_COLUMN_SQL);
  });
});
