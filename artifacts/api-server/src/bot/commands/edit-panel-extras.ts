// Extra button rows pinned under the /edit_card panel.
// The bulk Vault create flow uses this so "Next card" survives rarity/toggle
// refreshes. edit-card must not import vault-batch (that file already imports
// renderPanel).

import { ActionRowBuilder, type ButtonBuilder } from "discord.js";

type ExtraRows = ActionRowBuilder<ButtonBuilder>[];
type Factory = () => ExtraRows;

const extras = new Map<string, Factory>();

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function setEditPanelExtras(guildId: string, userId: string, factory: Factory | null): void {
  const id = key(guildId, userId);
  if (!factory) extras.delete(id);
  else extras.set(id, factory);
}

export function editPanelExtraRows(
  guildId: string | null | undefined,
  userId: string | null | undefined,
): ExtraRows {
  if (!guildId || !userId) return [];
  return extras.get(key(guildId, userId))?.() ?? [];
}
