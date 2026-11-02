// One identity string for an asset: label, holder and Demat/number.
// The Assets row, the Demat mismatch card and the sync header all read from
// here, so they cannot drift apart. Missing fields drop their clause instead
// of leaving an empty separator or `""`.
//
//   row        DigiFInn · IN99990009183122 · TEST HOLDER
//   name       Bonds · portfolio 2 (TEST HOLDER)
//   full       Bonds · portfolio 1 · IN99990009183122 (TEST HOLDER)
//   numberLine Demat 9999000001140907 (TEST HOLDER)

const clean = (value) => String(value ?? "").replace(/^[,\s]+/, "")
  .replace(/^"+|"+$/g, "").trim();

export function assetIdentity(asset = {}, { numberLabel = "" } = {}) {
  const rawLabel = clean(asset.label);
  const broker = clean(asset.bank);
  const label = rawLabel || broker || clean(asset.id);
  const number = clean(asset.number);
  const holder = clean(asset.holder);
  const withHolder = (text) => {
    if (!text) return holder;
    return holder ? `${text} (${holder})` : text;
  };
  const full = [label, number].filter(Boolean).join(" · ");
  return {
    rawLabel,
    broker,
    label,
    number,
    holder,
    name: withHolder(label),
    numberLine: number
      ? withHolder(numberLabel ? `${numberLabel} ${number}` : number)
      : (holder || ""),
    full: full ? withHolder(full) : withHolder(label),
    row: [broker && broker !== rawLabel ? broker : "", number, holder]
      .filter(Boolean).join(" · "),
  };
}
