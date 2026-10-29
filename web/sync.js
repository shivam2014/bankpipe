// Local-first sync.
//
// Every change is an op: (device, seq, lamport, entity, id, field, value).
// Ops are append-only, one file per device, so two devices never write the same
// object. Merge is deterministic and idempotent.
//
// Conflict policy, by field class:
//   * append-only entities (transactions, corrections): never conflict, both sides
//     survive because each carries its own identity
//   * register fields (city, nominee, price): last writer wins by lamport clock
//   * money fields (amount, balance, opening, closing): a second, different value
//     from another device is a *conflict*, never a silent overwrite. A human resolves it.
//
// "Live" has a ceiling in a browser: Drive has no push channel. The app polls
// while visible and syncs on focus. Changes appear within one poll interval, not
// instantly.

export const opId = (o) => `${o.device}:${o.seq}`;

export const PROTECTED = new Set(["amount", "balance", "opening", "closing",
  "amount_paise", "balance_paise", "account_number", "number"]);

export function makeOp(device, seq, entity, id, field, value, lamport = Date.now(),
                       extra = {}) {
  return { device, seq, entity, id, field, value, lamport, ...extra };
}

// Hybrid logical clock: monotonic even when wall clocks disagree.
export function nextLamport(last = 0, now = Date.now()) {
  return Math.max(now, last + 1);
}

export function merge(...sets) {
  const seen = new Map();
  for (const set of sets) for (const o of set) {
    const k = opId(o);
    if (!seen.has(k)) seen.set(k, o);
  }
  return [...seen.values()].sort((a, b) =>
    a.lamport - b.lamport
    || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0)
    || a.seq - b.seq);
}

export function reduce(ops) {
  return reduceDetailed(ops).state;
}

export function reduceDetailed(ops) {
  const state = new Map();
  const conflicts = new Map();      // entity/id/field -> {kept, rejected, devices}

  for (const o of merge(ops)) {
    const key = `${o.entity}/${o.id}`;
    const row = state.get(key) || {};
    const fkey = `${key}/${o.field}`;
    const seen = row[`__op:${o.field}`];

    if (seen) {
      const currentValue = row[o.field];
      const differs = JSON.stringify(currentValue) !== JSON.stringify(o.value);
      const otherDevice = seen.device !== o.device;

      if (differs && PROTECTED.has(o.field) && otherDevice) {
        const c = conflicts.get(fkey) || {
          entity: o.entity, id: o.id, field: o.field,
          kept: currentValue, rejected: o.value,
          devices: [seen.device, o.device],
        };
        conflicts.set(fkey, c);
        continue;                       // never overwrite money silently
      }

      const wins = o.lamport > seen.lamport
        || (o.lamport === seen.lamport && o.device >= seen.device);
      if (!wins) continue;
    }

    if (o.value === null || o.deleted) {
      row[`__tomb:${o.field}`] = true;
      delete row[o.field];
    } else {
      row[o.field] = o.value;
      delete row[`__tomb:${o.field}`];
    }
    row[`__op:${o.field}`] = { lamport: o.lamport, device: o.device };
    state.set(key, row);
  }

  const out = {};
  for (const [key, row] of state) clean(row, out, key);
  function clean(row, out, key) {
    const value = {};
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith("__")) continue;
      value[k] = v;
    }
    if (Object.keys(row).some((k) => k.startsWith("__tomb:"))) {
      const all = Object.keys(value).length === 0;
      if (all) return;                  // fully deleted
    }
    out[key] = value;
  }

  return { state: out, conflicts: [...conflicts.values()] };
}

export function pending(local, remoteIds) {
  const have = new Set(remoteIds);
  return local.filter((o) => !have.has(opId(o)));
}

export function segment(device, lastSeq, ops) {
  const mine = ops.filter((o) => o.device === device && o.seq > lastSeq)
    .sort((a, b) => a.seq - b.seq);
  return {
    device,
    from: lastSeq + 1,
    to: mine.length ? mine[mine.length - 1].seq : lastSeq,
    ops: mine,
  };
}

// Compaction: a snapshot up to `uptoLamport` replaces the ops before it, but
// tombstones are kept so a deleted row cannot come back from an old device.
export function compact(ops, uptoLamport) {
  return merge(ops).filter((o) => o.lamport > uptoLamport || o.value === null || o.deleted);
}

export function segmentName(device, from, to) {
  return `ops-${device}-${String(from).padStart(4, "0")}-${String(to).padStart(4, "0")}.json`;
}

export function parseSegmentName(name) {
  const m = name.match(/^ops-(.+)-(\d+)-(\d+)\.json$/);
  return m ? { device: m[1], from: Number(m[2]), to: Number(m[3]) } : null;
}

// Poll loop. `storage` is the same adapter backup.js uses.
export async function syncOnce({ storage, device, ops, loadRemote, apply, include = () => true }) {
  const files = (await storage.list()).filter((f) => include(f.name));
  const id = parseSegmentName;
  const mine = files.filter((f) => parseSegmentName(f.name)?.device === device);
  const lastSynced = mine.length
    ? Math.max(...mine.map((f) => parseSegmentName(f.name).to)) : 0;

  const seg = segment(device, lastSynced, ops);
  let uploaded = null;
  if (seg.ops.length) {
    const name = segmentName(device, seg.from, seg.to);
    await storage.put(name, JSON.stringify(seg).length ? new TextEncoder().encode(JSON.stringify(seg)) : new Uint8Array());
    uploaded = name;
  }

  let received = 0;
  for (const f of files) {
    const meta = parseSegmentName(f.name);
    if (!meta || meta.device === device) continue;
    const body = JSON.parse(new TextDecoder().decode(await storage.get(f.id)));
    if (!body?.ops?.length) continue;
    received += apply(body.ops);
  }
  return { uploaded, received, lastSynced: seg.to };
}

// --- single-writer lease -------------------------------------------------
// Drive has no atomic compare-and-swap, so this is an advisory lock: one device
// edits, the others open read-only. It is made safe by a read-after-write check
// plus the op-log merge as the backstop.

export const LOCK_FILE = "lock.json";
export const DEFAULT_LEASE_MS = 3 * 60 * 1000;

export function makeLease(device, now, ttl = DEFAULT_LEASE_MS) {
  return { device, acquired: now, expires: now + ttl };
}

export function leaseValid(lease, now) {
  return Boolean(lease) && now < lease.expires;
}

export function canEdit(device, lease, now) {
  return !leaseValid(lease, now) || lease.device === device;
}

export async function readLease(storage) {
  const files = await storage.list();
  const lock = files.find((f) => f.name === LOCK_FILE);
  if (!lock) return null;
  return JSON.parse(new TextDecoder().decode(await storage.get(lock.id)));
}

export async function acquireLease(storage, device, now, ttl = DEFAULT_LEASE_MS) {
  const current = await readLease(storage);
  if (leaseValid(current, now) && current.device !== device) {
    return { granted: false, holder: current.device, until: current.expires };
  }
  const lease = makeLease(device, now, ttl);
  const files = await storage.list();
  const lock = files.find((f) => f.name === LOCK_FILE);
  if (lock) await storage.remove(lock.id).catch(() => {});
  await storage.put(LOCK_FILE, new TextEncoder().encode(JSON.stringify(lease)));

  const check = await readLease(storage);
  if (!check || check.device !== device) {
    return { granted: false, holder: check?.device || "unknown", until: check?.expires || 0 };
  }
  return { granted: true, lease };
}

export async function renewLease(storage, device, now, ttl = DEFAULT_LEASE_MS) {
  const res = await acquireLease(storage, device, now, ttl);
  return res.granted
    ? { renewed: true, lease: res.lease }
    : { renewed: false, holder: res.holder, until: res.until };
}

export async function releaseLease(storage, device) {
  const current = await readLease(storage);
  if (!current || current.device !== device) return false;
  const files = await storage.list();
  const lock = files.find((f) => f.name === LOCK_FILE);
  if (lock) await storage.remove(lock.id);
  return true;
}
