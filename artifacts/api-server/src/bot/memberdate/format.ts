/** Human tenure strings: "5 months", "1 year, 2 months", "3 days". */

export type TenureParts = {
  totalMs: number;
  years: number;
  months: number;
  days: number;
  label: string;
};

const MS_DAY = 86_400_000;

/** Approximate calendar tenure from a start date to `now`. */
export function formatTenure(from: Date | number, now: Date | number = Date.now()): TenureParts {
  const start = typeof from === "number" ? from : from.getTime();
  const end = typeof now === "number" ? now : now.getTime();
  const totalMs = Math.max(0, end - start);

  const startDate = new Date(start);
  const endDate = new Date(end);

  let years = endDate.getUTCFullYear() - startDate.getUTCFullYear();
  let months = endDate.getUTCMonth() - startDate.getUTCMonth();
  let days = endDate.getUTCDate() - startDate.getUTCDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 0));
    days += prevMonth.getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) {
    years = 0;
    months = 0;
    days = 0;
  }

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  if (parts.length === 0) {
    const wholeDays = Math.floor(totalMs / MS_DAY);
    if (wholeDays <= 0) parts.push("less than a day");
    else parts.push(`${wholeDays} day${wholeDays === 1 ? "" : "s"}`);
  } else if (years === 0 && days > 0) {
    parts.push(`${days} day${days === 1 ? "" : "s"}`);
  }

  return { totalMs, years, months, days, label: parts.join(", ") };
}

export function discordTimestamp(ms: number | Date | null | undefined, style: "D" | "R" | "f" = "D"): string {
  if (ms == null) return "Unknown";
  const n = typeof ms === "number" ? ms : ms.getTime();
  if (!Number.isFinite(n) || n <= 0) return "Unknown";
  return `<t:${Math.floor(n / 1000)}:${style}>`;
}

export type TenureFilterKey =
  | "any"
  | "1m"
  | "3m"
  | "6m"
  | "1y"
  | "2y"
  | "5y";

export const TENURE_FILTER_CHOICES: { name: string; value: TenureFilterKey }[] = [
  { name: "Any time", value: "any" },
  { name: "At least 1 month", value: "1m" },
  { name: "At least 3 months", value: "3m" },
  { name: "At least 6 months", value: "6m" },
  { name: "At least 1 year", value: "1y" },
  { name: "At least 2 years", value: "2y" },
  { name: "At least 5 years", value: "5y" },
];

/** Minimum age in ms for a filter key. `any` → 0. */
export function tenureFilterMinMs(key: TenureFilterKey | string | null | undefined): number {
  switch (key) {
    case "1m": return 30 * MS_DAY;
    case "3m": return 90 * MS_DAY;
    case "6m": return 182 * MS_DAY;
    case "1y": return 365 * MS_DAY;
    case "2y": return 2 * 365 * MS_DAY;
    case "5y": return 5 * 365 * MS_DAY;
    default: return 0;
  }
}

export function tenureFilterLabel(key: TenureFilterKey | string | null | undefined): string {
  return TENURE_FILTER_CHOICES.find(c => c.value === key)?.name ?? "Any time";
}
