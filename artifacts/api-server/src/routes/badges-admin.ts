// Dashboard admin API for the configurable badge catalogue.
// Mounted at /api/admin — requires dashboard auth.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod/v4";
import { requireDashboardAuth } from "../middlewares/dashboard-auth.js";
import { HOME_GUILD_ID } from "../bot/home-guild.js";
import { DEFAULT_BADGE_RULES, getBadgeRules, ALLOWED_TRIGGERS } from "../lib/badges/catalog.js";
import {
  getOrCreateBadgeSettings,
  updateBadgeSettings,
} from "../lib/badges/db.js";

const router: IRouter = Router();
router.use(requireDashboardAuth);

function guildOr503(res: Response): string | null {
  if (!HOME_GUILD_ID) {
    res.status(503).json({ error: "HOME_GUILD_ID is not configured." });
    return null;
  }
  return HOME_GUILD_ID;
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, res: Response): z.infer<T> | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    res.status(400).json({ error: "Invalid payload", details: result.error.issues });
    return null;
  }
  return result.data;
}

const TRIGGER_ENUM = [
  "manual", "messages", "attachments", "reactions", "streak", "collection", "trivia", "artshow",
] as const;

const badgeRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,24}$/),
  name: z.string().trim().min(1).max(64),
  emoji: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(200),
  trigger: z.enum(TRIGGER_ENUM),
  threshold: z.number().int().min(0).max(1_000_000),
  channel: z.string().nullable().optional(),
  triviaMode: z.string().nullable().optional(),
  artshowMode: z.string().nullable().optional(),
});

router.get("/badges/status", async (_req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const settings = await getOrCreateBadgeSettings(guildId);
  const rules = getBadgeRules(settings.badgeRules);
  res.json({
    settings: {
      enabled: settings.enabled,
      staffRoleId: settings.staffRoleId,
      trackChannelId: settings.trackChannelId,
      tradeChannelId: settings.tradeChannelId,
      maxAttachmentsPerPost: settings.maxAttachmentsPerPost,
      uploadCooldownSeconds: settings.uploadCooldownSeconds,
    },
    rules,
    defaults: DEFAULT_BADGE_RULES,
    triggers: ALLOWED_TRIGGERS,
  });
});

router.patch("/badges/settings", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    enabled: z.boolean().optional(),
    staffRoleId: z.string().nullable().optional(),
    trackChannelId: z.string().nullable().optional(),
    tradeChannelId: z.string().nullable().optional(),
    maxAttachmentsPerPost: z.number().int().min(1).max(10).optional(),
    uploadCooldownSeconds: z.number().int().min(0).max(300).optional(),
  }), req.body, res);
  if (!body) return;
  const settings = await updateBadgeSettings(guildId, body);
  res.json({
    settings: {
      enabled: settings.enabled,
      staffRoleId: settings.staffRoleId,
      trackChannelId: settings.trackChannelId,
      tradeChannelId: settings.tradeChannelId,
      maxAttachmentsPerPost: settings.maxAttachmentsPerPost,
      uploadCooldownSeconds: settings.uploadCooldownSeconds,
    },
  });
});

router.put("/badges/rules", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    rules: z.array(badgeRuleSchema).max(25),
  }), req.body, res);
  if (!body) return;
  const cleaned = getBadgeRules(body.rules);
  if (cleaned.length !== body.rules.length) {
    res.status(400).json({ error: "One or more badge rules failed validation." });
    return;
  }
  const ids = new Set<string>();
  for (const rule of cleaned) {
    if (ids.has(rule.id)) {
      res.status(400).json({ error: `Duplicate badge id: ${rule.id}` });
      return;
    }
    ids.add(rule.id);
  }
  const settings = await updateBadgeSettings(guildId, { badgeRules: cleaned });
  res.json({ rules: getBadgeRules(settings.badgeRules) });
});

router.post("/badges/rules/reset", async (_req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const settings = await updateBadgeSettings(guildId, { badgeRules: DEFAULT_BADGE_RULES });
  res.json({ rules: getBadgeRules(settings.badgeRules) });
});

export default router;
