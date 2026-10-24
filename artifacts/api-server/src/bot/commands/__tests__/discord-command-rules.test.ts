import { describe, expect, it } from "vitest";

// Guild registration is one bulk PUT: a single invalid option makes Discord
// answer 50035 and none of the commands update. Catch those rules here.

type Option = {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  options?: Option[];
};
type Command = Option & { type?: number };

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

async function registered(): Promise<Command[]> {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  const { buildCommands } = await import("../register.js");
  return buildCommands() as Command[];
}

function problems(node: Option, path: string, chatInput: boolean): string[] {
  const out: string[] = [];
  if (chatInput) {
    if (!NAME.test(node.name) || node.name !== node.name.toLowerCase()) out.push(`${path}: invalid name`);
    if (!node.description || node.description.length > 100) out.push(`${path}: description must be 1-100 chars`);
  }
  if ((node.options?.length ?? 0) > 25) out.push(`${path}: more than 25 options`);
  if ((node.choices?.length ?? 0) > 25) out.push(`${path}: more than 25 choices`);
  for (const c of node.choices ?? []) {
    if (!c.name || c.name.length > 100) out.push(`${path}: choice name must be 1-100 chars`);
    if (typeof c.value === "string" && c.value.length > 100) out.push(`${path}: choice value over 100 chars`);
  }

  const names = new Set<string>();
  let sawOptional = false;
  for (const opt of node.options ?? []) {
    if (names.has(opt.name)) out.push(`${path}: duplicate option "${opt.name}"`);
    names.add(opt.name);
    if (opt.type !== SUBCOMMAND && opt.type !== SUBCOMMAND_GROUP) {
      if (opt.required && sawOptional) out.push(`${path}: required "${opt.name}" comes after an optional option`);
      if (!opt.required) sawOptional = true;
    }
    out.push(...problems(opt, `${path} ${opt.name}`, true));
  }
  return out;
}

describe("Discord command payload", () => {
  it("passes Discord's option rules for every registered command", async () => {
    const commands = await registered();
    const found = commands.flatMap(c => problems(c, `/${c.name}`, (c.type ?? 1) === 1));
    expect(found).toEqual([]);
  }, 60_000);

  it("has no duplicate command names", async () => {
    const commands = await registered();
    const keys = commands.map(c => `${c.type ?? 1}:${c.name}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  }, 60_000);

  it("registers /mass_role give|remove with role and target_role", async () => {
    const commands = await registered();
    const massRole = commands.find(c => c.name === "mass_role");
    expect(massRole).toBeDefined();
    for (const sub of ["give", "remove"]) {
      const sc = massRole!.options?.find(o => o.name === sub);
      expect(sc?.options?.map(o => [o.name, o.required])).toEqual([["role", true], ["target_role", true]]);
    }
  }, 60_000);
});
