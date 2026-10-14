export type TierEdit = { key: string; minimumTonnes: string; benefitValue: string };
export type SavedTier = { id: string; minimum_tonnes: string };

export function validTierLevels(tiers: TierEdit[]) {
  return tiers.length > 0 && tiers.every((tier) =>
    tier.minimumTonnes.trim() !== "" && Number.isFinite(Number(tier.minimumTonnes)) && Number(tier.minimumTonnes) >= 0 &&
    tier.benefitValue.trim() !== "" && Number.isFinite(Number(tier.benefitValue)) && Number(tier.benefitValue) > 0,
  ) && new Set(tiers.map((tier) => Number(tier.minimumTonnes))).size === tiers.length;
}

/** Upserts retain matching thresholds. Never remove existing tiers if replacement writes fail. */
export async function saveTierLevels(
  saved: SavedTier[], next: TierEdit[],
  actions: { save: (tier: TierEdit) => Promise<unknown>; remove: (tier: SavedTier) => Promise<unknown> },
) {
  if (!validTierLevels(next)) throw new Error("Enter valid discount levels with unique minimum quantities.");
  await Promise.all(next.map(actions.save));
  const thresholds = new Set(next.map((tier) => Number(tier.minimumTonnes)));
  await Promise.all(saved.filter((tier) => !thresholds.has(Number(tier.minimum_tonnes))).map(actions.remove));
}
