// In-app confirmation for the DigiFInn bond sync. Native confirm() labels the
// accept button "OK" and focuses it, which makes a mapping move or a lot
// removal the default action. This dialog puts Cancel first, focuses it, maps
// Escape to Cancel, and paints the accept button red. The caller only writes
// after the promise resolves true.

export function createBondSyncDialog(doc) {
  const dialog = doc.getElementById("bond-sync-dialog");
  const title = doc.getElementById("bond-sync-title");
  const dangers = doc.getElementById("bond-sync-dangers");
  const summary = doc.getElementById("bond-sync-summary");
  const cancel = doc.getElementById("bond-sync-cancel");
  const accept = doc.getElementById("bond-sync-accept");
  if (!dialog || !cancel || !accept) return null;

  let settle = null;
  const finish = (ok) => {
    if (!settle) return;
    const resolve = settle;
    settle = null;
    if (dialog.open) dialog.close();
    resolve(ok);
  };
  cancel.addEventListener("click", () => finish(false));
  accept.addEventListener("click", () => finish(true));
  // Escape fires cancel; prevent the default close so every path settles here.
  dialog.addEventListener("cancel", (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    finish(false);
  });
  // Any close that did not come from Accept is not consent.
  dialog.addEventListener("close", () => finish(false));

  return {
    ask({ heading = "Apply bond sync?", dangerLines = [], body = "",
      acceptLabel = "Replace holdings" } = {}) {
      if (settle) finish(false);
      if (title) title.textContent = heading;
      if (summary) summary.textContent = body;
      if (dangers) {
        dangers.replaceChildren(...dangerLines.map((line) => {
          const row = doc.createElement("div");
          row.textContent = line;
          return row;
        }));
        dangers.style.display = dangerLines.length ? "grid" : "none";
      }
      accept.textContent = acceptLabel;
      return new Promise((resolve) => {
        settle = resolve;
        try {
          dialog.showModal();
          cancel.focus();
        } catch (e) {
          finish(false);
        }
      });
    },
  };
}
