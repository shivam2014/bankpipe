# BankPipe backup

How the encrypted backup works, what it protects, and what it does not.

## What it does

The browser holds the working copy of the database in IndexedDB. A backup writes an
encrypted snapshot of that database into a folder the user controls, and a restore
brings it back.

Browser storage is not durable. WebKit's policy is explicit: by default an origin's
storage is *best-effort* and can be evicted, and Safari clears script-writable storage
after a period of no interaction with the site. So the backup is not a convenience
feature — it is the only thing standing between a cleared browser and a lost ledger.
The page calls `navigator.storage.persist()` and shows the answer honestly, including
when it is refused.

## What lives in the folder

```
BankPipe/
  vault-key-0001.bpk                  the data key, sealed with the passphrase
  bankpipe-2026-10-21T160453Z-5AAM.bpdb   one snapshot, immutable
  bankpipe-2026-10-22T091200Z-5AAM.bpdb
  bankpipe-auto.manifest              the automatic copy's block list
  block-<id>.bpblk                    one 64 KiB block of the automatic copy
```

**`vault-key-0001.bpk`** is a small JSON payload — a random 32-byte data key, a label,
a creation date — encrypted with a key derived from the passphrase (PBKDF2-HMAC-SHA256,
600,000 iterations, fresh 16-byte salt). This is the only file the passphrase ever
touches.

**`bankpipe-*.bpdb`** are snapshots: the whole SQLite file, encrypted with that data key
using AES-256-GCM. No passphrase is involved, so they open instantly.

**`bankpipe-auto.manifest`** and the **`block-<id>.bpblk`** files are the automatic copy.
The database is split into fixed 64 KiB blocks, each encrypted on its own and named by
HMAC-SHA256(DEK, block). The name is the content, so a block that did not change is
already in the folder and is not uploaded again. The encrypted manifest lists the blocks
in order and carries the size and SHA-256 of the whole database. It is replaced in place
and is the commit point: blocks go up first, the manifest second, and blocks the new
manifest no longer names are deleted last. Manual snapshots never share this path and are
never pruned to make room for it.

The split exists so the passphrase can change without re-encrypting the archive. It also
means a new device needs exactly two things: the key file, and the passphrase.

Every file header is authenticated as AES-GCM additional data. The iteration count
cannot be downgraded, the algorithm cannot be swapped, and a snapshot cannot be
relabelled as belonging to another vault. Each snapshot carries a 4-byte vault
fingerprint, so the app can say *"this belongs to a different vault"* rather than
*"the file is corrupt"* — two very different messages after a failed restore.

## What each party can see

| Party | Sees |
|---|---|
| You, holding the passphrase | Everything |
| Google (or whichever storage provider) | File names, sizes, timestamps, and ciphertext. Not one transaction, balance or account number |
| Whoever wrote BankPipe | Nothing. There is no server, no telemetry, no upload path to the author |
| Someone who steals the Drive account | Ciphertext. Useless without the passphrase |
| Someone who steals a device | The local database, unencrypted. Encrypt the disk |

The scope is `drive.file`, so the app can only see files it created. It cannot read the
rest of anyone's Drive, and the user can revoke access at any time from their Google
account without losing the files.

## Restore

1. Open the app on the new device and connect the same storage.
2. The app finds `vault-key-0001.bpk`, asks for the passphrase, and unwraps the data key
   in memory.
3. Pick a snapshot. The app downloads it, decrypts it, runs `PRAGMA integrity_check`,
   counts the rows, and only then replaces the local database.

If any step fails, nothing local changes. That ordering is deliberate: a restore that
half-succeeds is worse than one that refuses.

There is also a **restore drill** that performs every step except the last one. Run it
monthly. A backup that has never been restored is a rumour.

## The honest limits

- **There is no passphrase reset.** Not by the author, not by Google. If the passphrase
  is lost, every snapshot is permanently unreadable. This is the cost of the provider
  being unable to read the data, and no feature can remove it. Write it down and keep it
  with important documents.
- **Browser storage can still vanish** between backups. The badge says which regime the
  current browser is in.
- **One writer at a time.** Nothing is ever overwritten, so two devices cannot destroy
  each other's data — but they can produce two lineages. The page warns when it sees
  another device's snapshot newer than yours.
- **The working copy is sealed only when a database passphrase is set.** Real mode asks
  for one at setup, and the IndexedDB blob is AES-256-GCM ciphertext. Without a passphrase
  the blob is plain SQLite, so use full-disk encryption (FileVault, BitLocker, device
  passcode) either way.
- **Credentials are not in the snapshot's protection model yet.** Vault entries are
  sealed with a separate device key. Decide deliberately whether they should ride inside
  the encrypted database instead.

## Leaving

Every backup can be downloaded as a file, and the data exports as CSV and JSON with
amounts in integer paise. The encrypted file can be copied to any other storage — a USB
disk, iCloud, Dropbox — and restored by pointing the app at it. The format is documented
above and needs no server to decode.

## Google setup, for a family

1. Google Cloud project → enable the Drive API.
2. OAuth consent screen → scope `https://www.googleapis.com/auth/drive.file`
   (classified non-sensitive, so no security assessment is ever required).
3. Add each family member's Gmail as a **test user**.
4. Credentials → OAuth client ID → **Web application** → authorised JavaScript origins
   must include the exact origin the app is served from (`http://127.0.0.1:8766`,
   `http://localhost:8766`, and any deployed origin).

Google's own documentation exempts **personal-use apps with fewer than 100 users** from
verification. Users click through one "unverified app" warning on first sign-in. Growing
past 100 users means publishing and undergoing brand verification — still no security
assessment, because the scope is non-sensitive.
