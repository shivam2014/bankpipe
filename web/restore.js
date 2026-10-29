// Detects whether the signed-in Drive already holds a BankPipe vault.
//
// This is deliberately a probe, not a second implementation of the vault
// format. Decryption stays in backup.js/vault.js, which the backup page
// already exercises. The app only needs to know which door to open:
//
//   vault exists  → /backup?restore=1   (unlock the existing one)
//   no vault      → /backup?create=1    (make the first one)

import { getToken } from "./drive.js";
import { driveStorage } from "./storage.js";
import { listSnapshots, readVaultKey } from "./backup.js";

// Pure: pick the next screen. Kept separate so it is testable without Drive.
export function vaultDestination(result) {
  if (!result || result.ok === false) return "/backup";
  return result.hasKey ? "/backup?restore=1" : "/backup?create=1";
}

export async function probeVault({ fetchImpl = fetch } = {}) {
  try {
    const { token } = await getToken(fetchImpl);
    const storage = driveStorage({ token, fetchImpl });
    const key = await readVaultKey({ storage });
    const snapshots = await listSnapshots({ storage });
    return {
      ok: true,
      hasKey: Boolean(key),
      snapshots: snapshots.length,
      latest: snapshots[0] ? snapshots[0].name : null,
    };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || String(err) };
  }
}
