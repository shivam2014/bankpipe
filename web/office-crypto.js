// Opening an Excel file the bank password-protected.
//
// Excel encrypts a workbook as an OLE2 container holding two streams:
// `EncryptionInfo` (the parameters) and `EncryptedPackage` (the zip, encrypted).
// This module reads the container, derives the key from the password exactly as
// ECMA-376 Agile Encryption says, and returns the decrypted zip. WebCrypto does
// the hashing; AES is done here because WebCrypto's AES-CBC always strips PKCS#7
// padding, and these blocks are not padded that way.
//
// Everything is local: the password never leaves the page.

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isEncryptedOffice(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

// --- small helpers ---------------------------------------------------------
const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const concat = (...parts) => {
  const len = parts.reduce((t, p) => t + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const b64 = (s) => Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));
const utf16le = (s) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >>> 8;
  }
  return out;
};
async function sha(alg, bytes) {
  return new Uint8Array(await crypto.subtle.digest(alg, bytes));
}

// --- AES-CBC decryption, no padding ---------------------------------------
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(() => {
  // S-box from the multiplicative inverse in GF(2^8).
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6))
      ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

function expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.subarray((i - 1) * 4, i * 4);
    if (i % nk === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, nr };
}

function invShiftRows(s) {
  const t = Uint8Array.from(s);
  for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) {
    s[c * 4 + r] = t[(((c - r + 4) % 4) * 4 + r)];
  }
}

function decryptBlock(block, key) {
  const { w, nr } = key;
  const s = Uint8Array.from(block);
  const addRound = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
  addRound(nr);
  for (let round = nr - 1; round >= 1; round--) {
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRound(round);
    for (let c = 0; c < 4; c++) {
      const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
      s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
  invShiftRows(s);
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
  addRound(0);
  return s;
}

export function aesCbcDecrypt(keyBytes, iv, data) {
  const key = expandKey(keyBytes);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off + 16 <= data.length; off += 16) {
    const block = data.subarray(off, off + 16);
    const plain = decryptBlock(block, key);
    for (let i = 0; i < 16; i++) out[off + i] = plain[i] ^ prev[i];
    prev = block;
  }
  return out;
}

// --- OLE2 container --------------------------------------------------------
export function readCfb(bytes) {
  const dv = view(bytes);
  if (u32(dv, 0) !== 0xe011cfd0) throw new Error("not an OLE2 file");
  const sectorSize = 1 << u16(dv, 30);
  const miniSize = 1 << u16(dv, 32);
  const dirStart = u32(dv, 48);
  const miniCutoff = u32(dv, 56);
  const miniFatStart = u32(dv, 60);
  const numMiniFat = u32(dv, 64);
  const difatStart = u32(dv, 68);
  const numDifat = u32(dv, 72);
  const sector = (n) => bytes.subarray((n + 1) * sectorSize, (n + 1) * sectorSize + sectorSize);

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(dv, 76 + i * 4);
    if (s === 0xffffffff) break;
    fatSectors.push(s);
  }
  let d = difatStart;
  for (let k = 0; k < numDifat && d !== 0xfffffffe && d !== 0xffffffff; k++) {
    const sec = sector(d);
    const sdv = view(sec);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = u32(sdv, i * 4);
      if (s === 0xffffffff) break;
      fatSectors.push(s);
    }
    d = u32(sdv, sectorSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    const sdv = view(sector(s));
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(sdv, i * 4));
  }
  const chainOf = (start) => {
    const out = [];
    let s = start;
    while (s !== 0xfffffffe && s !== 0xffffffff && s < fat.length && out.length < 200000) {
      out.push(s);
      s = fat[s];
    }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chainOf(start).map(sector);
    const all = new Uint8Array(parts.length * sectorSize);
    parts.forEach((p, i) => all.set(p, i * sectorSize));
    return size ? all.subarray(0, size) : all;
  };

  const dir = readChain(dirStart);
  const ddv = view(dir);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = u16(ddv, o + 64);
    let name = "";
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(u16(ddv, o + i));
    entries.push({ name, type: dir[o + 66], start: u32(ddv, o + 116), size: u32(ddv, o + 120) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFat = [];
  if (numMiniFat) {
    const mf = readChain(miniFatStart);
    const mv = view(mf);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(u32(mv, i));
  }
  const readMini = (start, size) => {
    const out = new Uint8Array(size);
    let s = start, off = 0;
    while (s !== 0xfffffffe && s !== 0xffffffff && off < size) {
      const chunk = miniStream.subarray(s * miniSize, s * miniSize + miniSize);
      out.set(chunk.subarray(0, Math.min(chunk.length, size - off)), off);
      off += miniSize;
      s = miniFat[s];
    }
    return out.subarray(0, size);
  };
  const streams = {};
  for (const e of entries) {
    if (e.type !== 2 || !e.name) continue;
    streams[e.name] = e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size);
  }
  return streams;
}

// --- ECMA-376 Agile Encryption --------------------------------------------
const BLOCK = {
  keyValue: Uint8Array.from([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]),
  verifierInput: Uint8Array.from([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]),
  verifierValue: Uint8Array.from([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]),
};

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export function parseEncryptionInfo(bytes) {
  const dv = view(bytes);
  const major = u16(dv, 0), minor = u16(dv, 2);
  if (major !== 4 || minor !== 4) {
    throw new Error(`only Agile encryption is supported (found ${major}.${minor})`);
  }
  const xml = new TextDecoder("utf-8").decode(bytes.subarray(8));
  const keyData = /<keyData\s([^>]+)>/i.exec(xml);
  if (!keyData) throw new Error("the file has no key data");
  // The spin count, the password salt and the encrypted key live on the
  // <p:encryptedKey> element; the outer <keyData> carries the cipher choice and
  // a *different* salt, which is the one the package segments are chained with.
  const encryptedKey = /<[a-z0-9]*:?encryptedKey\s([^>]+)>/i.exec(xml);
  const integrity = /<dataIntegrity\s([^>]+)>/i.exec(xml);
  return {
    keyData: attrsOf(keyData[1]),
    encryptedKey: encryptedKey ? attrsOf(encryptedKey[1]) : {},
    dataIntegrity: integrity ? attrsOf(integrity[1]) : null,
  };
}

async function deriveHash(password, kd) {
  const hashAlg = /SHA512/i.test(kd.hashAlgorithm) ? "SHA-512"
    : /SHA1/i.test(kd.hashAlgorithm) ? "SHA-1" : "SHA-256";
  const salt = b64(kd.saltValue);
  const spin = Number(kd.spinCount) || 0;
  let h = await sha(hashAlg, concat(salt, utf16le(password)));
  // The iteration hashes the counter *before* the previous hash: H(LE32(i) + H).
  for (let i = 0; i < spin; i++) h = await sha(hashAlg, concat(le32(i), h));
  return { h, salt, hashAlg };
}

async function blockKey(hash, salt, hashAlg, keyBits, block) {
  const hf = await sha(hashAlg, concat(hash, block));
  return hf.subarray(0, keyBits / 8);
}

// A wrong password is caught by the verifier, which every Agile file carries:
// a random block is encrypted with one key and its hash with another. Decrypt
// both; if the hash of the block is not the decrypted hash, the key is wrong.
async function checkPassword(h, salt, hashAlg, keyBits, hashSize, kd) {
  if (!kd.encryptedVerifierHashInput || !kd.encryptedVerifierHashValue) return;
  const iv = salt.subarray(0, Number(kd.blockSize) || 16);
  const input = aesCbcDecrypt(
    await blockKey(h, salt, hashAlg, keyBits, BLOCK.verifierInput), iv,
    b64(kd.encryptedVerifierHashInput));
  const expected = aesCbcDecrypt(
    await blockKey(h, salt, hashAlg, keyBits, BLOCK.verifierValue), iv,
    b64(kd.encryptedVerifierHashValue));
  const actual = await sha(hashAlg, input);
  const n = Math.min(actual.length, hashSize);
  let diff = 0;
  for (let i = 0; i < n; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) throw new Error("wrong password");
}

// A wrong password fails the verifier; without one, the zip that comes out is
// not readable, and the caller treats that the same way.
export async function decryptOffice(bytes, password) {
  const streams = readCfb(bytes);
  const info = streams.EncryptionInfo;
  const pkg = streams.EncryptedPackage;
  if (!info || !pkg) throw new Error("this file is not an encrypted workbook");

  const { keyData, encryptedKey, dataIntegrity } = parseEncryptionInfo(info);
  const kd = { ...keyData, ...encryptedKey };
  const { h, salt, hashAlg } = await deriveHash(String(password), kd);
  const keyBits = Number(kd.keyBits) || 256;
  const blockSize = Number(kd.blockSize) || 16;
  const hashSize = Number(kd.hashSize) || 20;
  // The package chains each segment with the outer keyData salt.
  const packageSalt = b64(keyData.saltValue);

  await checkPassword(h, salt, hashAlg, keyBits, hashSize, kd);

  const keyBytes = await blockKey(h, salt, hashAlg, keyBits, BLOCK.keyValue);
  const secret = aesCbcDecrypt(keyBytes, salt.subarray(0, blockSize), b64(kd.encryptedKeyValue));

  const size = Number(view(pkg).getBigUint64(0, true));
  const body = pkg.subarray(8);
  const out = new Uint8Array(body.length);
  for (let off = 0, i = 0; off < body.length; off += 4096, i++) {
    const iv = (await sha(hashAlg, concat(packageSalt, le32(i)))).subarray(0, blockSize);
    const chunk = body.subarray(off, Math.min(off + 4096, body.length));
    out.set(aesCbcDecrypt(secret, iv, chunk), off);
  }
  const zip = out.subarray(0, size);
  if (!kd.encryptedVerifierHashInput && (zip[0] !== 0x50 || zip[1] !== 0x4b)) {
    throw new Error("wrong password");
  }
  return zip;
}
