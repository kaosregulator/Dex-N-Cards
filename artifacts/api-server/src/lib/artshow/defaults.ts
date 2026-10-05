/** Default Art Show economy — used by setup reset. */

export const ARTSHOW_DEFAULTS = {
  votesPerDay: 5,
  bonusVotesOnSubmit: 2,
  voteRefreshHours: 6,
  bumpCostVotes: 3,
  crownThreshold: 25,
  enabled: true,
} as const;

export type ArtshowDefaults = typeof ARTSHOW_DEFAULTS;
