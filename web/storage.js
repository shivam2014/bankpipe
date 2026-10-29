// Storage adapters.
//
// Every backend satisfies the same five methods, and nothing above this layer
// knows which one is in use:
//
//   list()                  -> [{ id, name, size, modifiedTime }]
//   put(name, bytes, opts)  -> { id, name, size }
//   get(id)                 -> Uint8Array
//   remove(id)              -> true
//   describe()              -> { kind, label }
//
// Google Drive is the first adapter, not the architecture. A second backend
// (iCloud Drive, OneDrive, WebDAV, a plain folder) is a new function with these
// five methods, and the backup protocol is unchanged.

import { makeDrive } from "./drive.js";

export const FOLDER_NAME = "BankPipe";
export const SNAPSHOT_MIME = "application/x-bankpipe-snapshot";

// Used by the tests and by demo mode. Same contract as Drive, so a protocol bug
// cannot hide behind the fake.
export function memoryStorage(seed = []) {
  const files = new Map();
  let n = 0;
  for (const f of seed) files.set(f.id, { ...f });
  return {
    describe: () => ({ kind: "memory", label: "in-memory" }),
    async list() {
      return [...files.values()]
        .map(({ id, name, bytes, modifiedTime }) => ({
          id, name, size: String(bytes.length), modifiedTime,
        }))
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    },
    async put(name, bytes) {
      const id = `mem${++n}`;
      files.set(id, {
        id, name, bytes: new Uint8Array(bytes), modifiedTime: new Date().toISOString(),
      });
      return { id, name, size: String(bytes.length) };
    },
    async get(id) {
      const f = files.get(id);
      if (!f) throw new Error(`no such file: ${id}`);
      return new Uint8Array(f.bytes);
    },
    async update(id, bytes) {
      const f = files.get(id);
      if (!f) throw new Error(`no such file: ${id}`);
      files.set(id, { ...f, bytes: new Uint8Array(bytes), modifiedTime: new Date().toISOString() });
      return { id, name: f.name, size: String(bytes.length) };
    },
    async remove(id) {
      if (!files.delete(id)) throw new Error(`no such file: ${id}`);
      return true;
    },
    _files: files,
  };
}

export function driveStorage({ token, fetchImpl = fetch }) {
  if (!token) throw new Error("a Drive token is required");
  const drive = makeDrive(fetchImpl, token);
  let folderId = null;

  return {
    describe: () => ({ kind: "drive", label: `Google Drive · ${FOLDER_NAME}` }),
    async folder() {
      if (!folderId) folderId = await drive.ensureFolder();
      return folderId;
    },
    async list() {
      return drive.list(await this.folder());
    },
    async put(name, bytes) {
      const id = await drive.upload(await this.folder(), name, bytes);
      return { id, name, size: String(bytes.length) };
    },
    async get(id) {
      return drive.download(id);
    },
    async update(id, bytes) {
      await drive.update(id, bytes);
      return { id, size: String(bytes.length) };
    },
    async remove(id) {
      await drive.remove(id);
      return true;
    },
  };
}

// The path that needs no account at all: a file on disk the user controls. This
// is the "leave" route, and it should exist before any cloud adapter does.
export function downloadBytes(bytes, filename, mime = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.click();
  });
}
