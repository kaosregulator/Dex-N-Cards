// Per-site display branding for /vaultvalue Info + Browse webhook posts.

export type VaultBrandId = "valuevaultx" | "vaultedvaluesx" | "mttvalues";

export type VaultSiteBrand = {
  id: VaultBrandId;
  /** Webhook username + embed author */
  name: string;
  shortName: string;
  url: string;
  color: number;
  /** Small image (webhook avatar + embed thumbnail, top-right). */
  logoUrl: string;
  /** Larger hero / site photo for embed image when no screenshot. */
  bannerUrl: string;
  emoji: string;
};

/**
 * Logos/banners pulled from each site’s own assets (favicon / og / brand mark).
 * MTT Values blocks hotlink favicons behind Cloudflare — use a stylized mark
 * so the webhook avatar still reads as MTTV until they expose a public logo.
 */
export const VAULT_SITE_BRANDS: Record<VaultBrandId, VaultSiteBrand> = {
  valuevaultx: {
    id: "valuevaultx",
    name: "Value Vault X",
    shortName: "VVX",
    url: "https://www.valuevaultx.com/military-tycoon",
    color: 0x9b59b6,
    logoUrl:
      "https://static.wixstatic.com/media/2814ef_9b80d5b2871741dcb364b7ccb940539b%7Emv2.png/v1/fill/w_192%2Ch_192%2Clg_1%2Cusm_0.66_1.00_0.01/2814ef_9b80d5b2871741dcb364b7ccb940539b%7Emv2.png",
    bannerUrl:
      "https://static.wixstatic.com/media/2814ef_9b80d5b2871741dcb364b7ccb940539b%7Emv2.png/v1/fill/w_192%2Ch_192%2Clg_1%2Cusm_0.66_1.00_0.01/2814ef_9b80d5b2871741dcb364b7ccb940539b%7Emv2.png",
    emoji: "📦",
  },
  vaultedvaluesx: {
    id: "vaultedvaluesx",
    name: "Vaulted Values X",
    shortName: "Vaulted",
    url: "https://mts.vaultedvaluesx.com/value-list",
    color: 0x3b82f6,
    logoUrl: "https://mts.vaultedvaluesx.com/SVGs/favicon.webp",
    bannerUrl:
      "https://tr.rbxcdn.com/180DAY-777107d8a8b8574ddf6d7f61393392d7/768/432/Image/Webp/noFilter",
    emoji: "🌐",
  },
  mttvalues: {
    id: "mttvalues",
    name: "MTT Values",
    shortName: "MTTV",
    url: "https://mttvalues.com",
    color: 0x22c55e,
    logoUrl:
      "https://ui-avatars.com/api/?name=MTTV&background=7c3aed&color=fff&size=128&bold=true&format=png",
    bannerUrl:
      "https://ui-avatars.com/api/?name=MTT+Values&background=0f172a&color=a78bfa&size=512&bold=true&format=png",
    emoji: "📈",
  },
};

export function getVaultBrand(id: string): VaultSiteBrand {
  return VAULT_SITE_BRANDS[id as VaultBrandId] ?? VAULT_SITE_BRANDS.valuevaultx;
}
