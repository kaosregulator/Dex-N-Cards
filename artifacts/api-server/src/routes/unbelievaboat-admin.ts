// Dashboard admin API for UnbelievaBoat + Pets addon.
// Mounted at /api/admin — requires dashboard auth. Does not mutate DN Cards gameplay.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod/v4";
import { requireDashboardAuth } from "../middlewares/dashboard-auth.js";
import { HOME_GUILD_ID } from "../bot/home-guild.js";
import { isUbConfigured, ubApi, UbApiError } from "../lib/unbelievaboat/client.js";
import {
  getOrCreateUbSettings,
  updateUbSettings,
  listRoleLinks,
  createRoleLink,
  updateRoleLink,
  deleteRoleLink,
  listCatalog,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
  writeUbAudit,
  listUbAudit,
} from "../lib/unbelievaboat/db.js";
import {
  getOrCreatePetSettings,
  updatePetSettings,
  petLeaderboard,
  listAlivePets,
} from "../bot/pets/engine.js";

const router: IRouter = Router();
router.use(requireDashboardAuth);

function guildOr503(res: Response): string | null {
  if (!HOME_GUILD_ID) {
    res.status(503).json({ error: "HOME_GUILD_ID is not configured." });
    return null;
  }
  return HOME_GUILD_ID;
}

function actorId(res: { locals?: { _dashboardUser?: { id?: number; username?: string } | null } }): string {
  const u = res.locals?._dashboardUser;
  return u?.username ? `dash:${u.username}` : u?.id != null ? `dash:${u.id}` : "dash:admin";
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, res: Response): z.infer<T> | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    res.status(400).json({ error: "Invalid payload", details: result.error.issues });
    return null;
  }
  return result.data;
}

function ubErr(res: Response, err: unknown) {
  if (err instanceof UbApiError) {
    res.status(err.status === 503 ? 503 : err.status >= 400 && err.status < 600 ? err.status : 502)
      .json({ error: err.message, details: err.body, retryAfterMs: err.retryAfterMs });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Unexpected error" });
}

// ── Status / settings ────────────────────────────────────────────────────────
router.get("/ub/status", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const settings = await getOrCreateUbSettings(guildId);
  const petSettings = await getOrCreatePetSettings(guildId);
  let guild = null;
  let permissions = null;
  let apiError: string | null = null;
  if (isUbConfigured() && settings.enabled) {
    try {
      guild = await ubApi.getGuild(settings.ubGuildId);
      try { permissions = await ubApi.getPermissions(settings.ubGuildId); } catch { /* optional */ }
    } catch (err) {
      apiError = err instanceof Error ? err.message : "UB API unreachable";
    }
  }
  res.json({
    configured: isUbConfigured(),
    settings,
    petSettings,
    guild,
    permissions,
    apiError,
    docs: "https://api-docs.unbelievaboat.com/reference/reference",
  });
});

router.patch("/ub/settings", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    ubGuildId: z.string().min(5).optional(),
    enabled: z.boolean().optional(),
    leaderboardSort: z.enum(["cash", "bank", "total"]).optional(),
    petsSpendUb: z.boolean().optional(),
    currencyLabel: z.string().max(32).nullable().optional(),
  }), req.body, res);
  if (!body) return;
  const settings = await updateUbSettings(guildId, body);
  await writeUbAudit(guildId, actorId(res), "settings_update", body);
  res.json({ settings });
});

router.patch("/ub/pet-settings", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    enabled: z.boolean().optional(),
    growthHours: z.number().int().min(1).max(168).optional(),
    maxNeglects: z.number().int().min(1).max(20).optional(),
    hungerDecayPerHour: z.number().int().min(0).max(50).optional(),
    cleanlinessDecayPerHour: z.number().int().min(0).max(50).optional(),
    happinessDecayPerHour: z.number().int().min(0).max(50).optional(),
    hatchCost: z.number().int().min(0).optional(),
    challengeWager: z.number().int().min(0).optional(),
  }), req.body, res);
  if (!body) return;
  const petSettings = await updatePetSettings(guildId, body);
  await writeUbAudit(guildId, actorId(res), "pet_settings_update", body);
  res.json({ petSettings });
});

// ── Leaderboard / users ──────────────────────────────────────────────────────
router.get("/ub/leaderboard", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "Set UNBELIEVABOAT_TOKEN on Railway to load the live leaderboard." });
    return;
  }
  const settings = await getOrCreateUbSettings(guildId);
  const sort = (String(req.query["sort"] ?? settings.leaderboardSort) as "cash" | "bank" | "total");
  const page = req.query["page"] ? Number(req.query["page"]) : 1;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : 50;
  try {
    const data = await ubApi.getLeaderboard(settings.ubGuildId, { sort, page, limit });
    res.json({ sort, data });
  } catch (err) {
    ubErr(res, err);
  }
});

router.get("/ub/users/:userId", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const settings = await getOrCreateUbSettings(guildId);
  try {
    const balance = await ubApi.getUserBalance(settings.ubGuildId, req.params["userId"]!);
    let inventory: unknown[] = [];
    try { inventory = await ubApi.getInventory(settings.ubGuildId, req.params["userId"]!); } catch { /* */ }
    res.json({ balance, inventory });
  } catch (err) {
    ubErr(res, err);
  }
});

router.patch("/ub/users/:userId", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const body = parse(z.object({
    cash: z.number().int().optional(),
    bank: z.number().int().optional(),
    reason: z.string().max(200).optional(),
    mode: z.enum(["patch", "set"]).default("patch"),
  }), req.body, res);
  if (!body) return;
  if (body.cash === undefined && body.bank === undefined) {
    res.status(400).json({ error: "Provide cash and/or bank." });
    return;
  }
  const settings = await getOrCreateUbSettings(guildId);
  const userId = req.params["userId"]!;
  try {
    const balance = body.mode === "set"
      ? await ubApi.setUserBalance(settings.ubGuildId, userId, {
          cash: body.cash, bank: body.bank, reason: body.reason ?? "Dashboard admin set",
        })
      : await ubApi.patchUserBalance(settings.ubGuildId, userId, {
          cash: body.cash, bank: body.bank, reason: body.reason ?? "Dashboard admin adjust",
        });
    await writeUbAudit(guildId, actorId(res), body.mode === "set" ? "balance_set" : "balance_patch", body, userId);
    res.json({ balance });
  } catch (err) {
    ubErr(res, err);
  }
});

// ── UB store (live) ──────────────────────────────────────────────────────────
router.get("/ub/store", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const local = await listCatalog(guildId);
  let remote: unknown[] = [];
  let remoteError: string | null = null;
  if (isUbConfigured()) {
    try {
      const settings = await getOrCreateUbSettings(guildId);
      const page = await ubApi.listStoreItems(settings.ubGuildId);
      remote = Array.isArray(page) ? page : page.items ?? [];
    } catch (err) {
      remoteError = err instanceof Error ? err.message : "Failed to load UB store";
    }
  }
  res.json({ local, remote, remoteError, configured: isUbConfigured() });
});

router.post("/ub/store/remote", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const body = parse(z.object({
    name: z.string().min(1).max(100),
    price: z.number().int().min(0),
    description: z.string().max(500).optional(),
    emoji_unicode: z.string().max(16).optional(),
    is_inventory: z.boolean().optional(),
    is_usable: z.boolean().optional(),
    is_sellable: z.boolean().optional(),
    unlimited_stock: z.boolean().optional(),
    actions: z.array(z.record(z.string(), z.unknown())).optional(),
    requirements: z.array(z.record(z.string(), z.unknown())).optional(),
  }), req.body, res);
  if (!body) return;
  const settings = await getOrCreateUbSettings(guildId);
  try {
    const item = await ubApi.createStoreItem(settings.ubGuildId, body);
    await writeUbAudit(guildId, actorId(res), "store_create", { item });
    res.json({ item });
  } catch (err) {
    ubErr(res, err);
  }
});

router.patch("/ub/store/remote/:itemId", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const body = parse(z.record(z.string(), z.unknown()), req.body, res);
  if (!body) return;
  const settings = await getOrCreateUbSettings(guildId);
  try {
    const item = await ubApi.editStoreItem(settings.ubGuildId, req.params["itemId"]!, body);
    await writeUbAudit(guildId, actorId(res), "store_edit", { itemId: req.params["itemId"], body });
    res.json({ item });
  } catch (err) {
    ubErr(res, err);
  }
});

router.delete("/ub/store/remote/:itemId", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const settings = await getOrCreateUbSettings(guildId);
  try {
    await ubApi.deleteStoreItem(settings.ubGuildId, req.params["itemId"]!);
    await writeUbAudit(guildId, actorId(res), "store_delete", { itemId: req.params["itemId"] });
    res.json({ ok: true });
  } catch (err) {
    ubErr(res, err);
  }
});

// ── Local catalog ────────────────────────────────────────────────────────────
router.post("/ub/catalog", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    price: z.number().int().min(0).optional(),
    emoji: z.string().max(32).nullable().optional(),
    category: z.string().max(40).optional(),
    grantRoleId: z.string().nullable().optional(),
    forPets: z.boolean().optional(),
    petEffect: z.string().max(40).nullable().optional(),
    petEffectValue: z.number().int().optional(),
    listed: z.boolean().optional(),
  }), req.body, res);
  if (!body) return;
  const item = await createCatalogItem(guildId, body);
  await writeUbAudit(guildId, actorId(res), "catalog_create", { id: item.id });
  res.json({ item });
});

router.patch("/ub/catalog/:id", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = parse(z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    price: z.number().int().min(0).optional(),
    emoji: z.string().max(32).nullable().optional(),
    category: z.string().max(40).optional(),
    ubItemId: z.string().nullable().optional(),
    grantRoleId: z.string().nullable().optional(),
    forPets: z.boolean().optional(),
    petEffect: z.string().max(40).nullable().optional(),
    petEffectValue: z.number().int().optional(),
    listed: z.boolean().optional(),
  }), req.body, res);
  if (!body) return;
  const item = await updateCatalogItem(guildId, id, body);
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ item });
});

router.delete("/ub/catalog/:id", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const id = Number(req.params["id"]);
  const ok = await deleteCatalogItem(guildId, id);
  res.json({ ok });
});

/** Push a local catalog row to UnbelievaBoat as a store item (and link ids). */
router.post("/ub/catalog/:id/sync", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  if (!isUbConfigured()) {
    res.status(503).json({ error: "UNBELIEVABOAT_TOKEN not configured." });
    return;
  }
  const id = Number(req.params["id"]);
  const local = (await listCatalog(guildId)).find(c => c.id === id);
  if (!local) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }
  const settings = await getOrCreateUbSettings(guildId);
  const actions: Record<string, unknown>[] = [];
  if (local.grantRoleId) {
    actions.push({ type: 2, ids: [local.grantRoleId] }); // ADD_ROLES
  }
  try {
    let item;
    const payload = {
      name: local.name,
      price: local.price,
      description: local.description ?? undefined,
      emoji_unicode: local.emoji ?? undefined,
      is_inventory: local.isInventory,
      is_usable: local.isUsable,
      is_sellable: local.isSellable,
      unlimited_stock: local.unlimitedStock,
      actions: actions.length ? actions : undefined,
      is_listed: local.listed,
    };
    if (local.ubItemId) {
      item = await ubApi.editStoreItem(settings.ubGuildId, local.ubItemId, payload);
    } else {
      item = await ubApi.createStoreItem(settings.ubGuildId, payload);
      await updateCatalogItem(guildId, id, { ubItemId: item.id });
    }
    await writeUbAudit(guildId, actorId(res), "catalog_sync", { id, ubItemId: item.id });
    res.json({ item, localId: id });
  } catch (err) {
    ubErr(res, err);
  }
});

// ── Role links ───────────────────────────────────────────────────────────────
router.get("/ub/roles", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const roles = await listRoleLinks(guildId);
  res.json({ roles });
});

router.post("/ub/roles", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const body = parse(z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    discordRoleId: z.string().nullable().optional(),
    ubItemId: z.string().nullable().optional(),
    price: z.number().int().min(0).optional(),
    grantCash: z.number().int().optional(),
    category: z.string().max(40).optional(),
    emoji: z.string().max(32).nullable().optional(),
    enabled: z.boolean().optional(),
    syncToStore: z.boolean().optional(),
  }), req.body, res);
  if (!body) return;

  let ubItemId = body.ubItemId ?? null;
  if (body.syncToStore && isUbConfigured() && body.discordRoleId) {
    try {
      const settings = await getOrCreateUbSettings(guildId);
      const item = await ubApi.createStoreItem(settings.ubGuildId, {
        name: body.name,
        price: body.price ?? 0,
        description: body.description ?? undefined,
        emoji_unicode: body.emoji ?? undefined,
        actions: [
          { type: 2, ids: [body.discordRoleId] },
          ...(body.grantCash ? [{ type: 4, balance: body.grantCash }] : []),
        ],
      });
      ubItemId = item.id;
    } catch (err) {
      ubErr(res, err);
      return;
    }
  }

  const role = await createRoleLink(guildId, { ...body, ubItemId });
  await writeUbAudit(guildId, actorId(res), "role_link_create", { id: role.id, ubItemId });
  res.json({ role });
});

router.patch("/ub/roles/:id", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const id = Number(req.params["id"]);
  const body = parse(z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    discordRoleId: z.string().nullable().optional(),
    ubItemId: z.string().nullable().optional(),
    price: z.number().int().min(0).optional(),
    grantCash: z.number().int().optional(),
    category: z.string().max(40).optional(),
    emoji: z.string().max(32).nullable().optional(),
    enabled: z.boolean().optional(),
  }), req.body, res);
  if (!body) return;
  const role = await updateRoleLink(guildId, id, body);
  if (!role) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ role });
});

router.delete("/ub/roles/:id", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const ok = await deleteRoleLink(guildId, Number(req.params["id"]));
  res.json({ ok });
});

// ── Pets overview (dashboard) ────────────────────────────────────────────────
router.get("/ub/pets", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const [leaderboard, alive, settings] = await Promise.all([
    petLeaderboard(guildId, 25),
    listAlivePets(guildId, 50),
    getOrCreatePetSettings(guildId),
  ]);
  res.json({ leaderboard, alive, settings });
});

router.get("/ub/audit", async (req, res) => {
  const guildId = guildOr503(res);
  if (!guildId) return;
  const rows = await listUbAudit(guildId, 80);
  res.json({ rows });
});

export default router;
