// Test-only shim: resolves ./bond-source.js to the app's real module.
// The build copies web/bond-source.js into the bundle instead.
export * from "../../web/bond-source.js";
