// Test-only shim: resolves ./broker/index.js to the real worker source.
// The build copies worker/src/*.js into the deployed bundle instead.
export { default } from "../../../worker/src/index.js";
