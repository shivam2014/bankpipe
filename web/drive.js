// Google Drive access through the BankPipe auth broker.
//
// The browser never holds a client secret or a refresh token. The broker keeps
// the refresh token in an HttpOnly cookie and hands back a short-lived access
// token on request, so connecting is a one-time action instead of an hourly one.
//
// Scope is still drive.file: the app can only touch files it created.
// The broker lives on the same origin, so no CORS and no third-party cookie.

const FOLDER = "BankPipe";

// Starts the consent flow. The broker redirects back here when it is done.
export function connect() {
  location.assign("/oauth/start");
}

// Asks the broker for a live access token. The refresh token stays in the
// broker's HttpOnly cookie, so this works without the user present.
export async function getToken(fetchImpl = fetch) {
  const res = await fetchImpl("/token", { method: "POST", credentials: "same-origin" });
  if (res.status === 401) {
    const err = new Error("Google Drive needs to be connected again.");
    err.code = "reconnect_required";
    throw err;
  }
  if (!res.ok) throw new Error(`token ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("broker returned no token");
  return { token: body.access_token, expiresIn: body.expires_in ?? 0 };
}

// Revokes the grant at Google and clears the broker's cookie.
export async function disconnect(fetchImpl = fetch) {
  const res = await fetchImpl("/disconnect", { method: "POST", credentials: "same-origin" });
  return res.ok;
}

export function makeDrive(fetchImpl, token) {
  const api = async (path, opts = {}) => {
    const res = await fetchImpl(`https://www.googleapis.com/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`drive ${res.status}: ${await res.text()}`);
    return res;
  };

  return {
    async ensureFolder() {
      const q = encodeURIComponent(
        `name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const found = await (await api(`drive/v3/files?q=${q}&fields=files(id,name)`)).json();
      if (found.files?.length) return found.files[0].id;
      const made = await (await api("drive/v3/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }),
      })).json();
      return made.id;
    },

    async list(parentId) {
      const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
      const out = [];
      let pageToken = "";
      do {
        const page = await (await api(
          `drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,size,modifiedTime)` +
          `&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`)).json();
        out.push(...(page.files || []));
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      return out;
    },

    async upload(parentId, name, bytes) {
      const boundary = "bankpipe" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name, parents: [parentId] });
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--`,
      ]);
      const res = await api("upload/drive/v3/files?uploadType=multipart&fields=id,name", {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return (await res.json()).id;
    },

    async download(fileId) {
      const res = await api(`drive/v3/files/${fileId}?alt=media`);
      return new Uint8Array(await res.arrayBuffer());
    },

    // Replace the bytes of an existing file without changing its id or name.
    async update(fileId, bytes) {
      const res = await api(`upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      return (await res.json()).id;
    },

    async remove(fileId) {
      await api(`drive/v3/files/${fileId}`, { method: "DELETE" });
    },
  };
}
