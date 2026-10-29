// Verifies the public pages are complete enough to submit to Google as
// "home page" and "privacy policy". Fails loudly rather than quietly.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

for (const f of ["index.html", "privacy.html", "_headers"]) {
  check(existsSync(join(ROOT, f)), `missing ${f}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }

const home = read("index.html");
const privacy = read("privacy.html");

// Pages must link to each other. Google checks that the privacy policy is
// reachable from the home page.
check(/href="\.?\/?privacy\.html"/.test(home), "index.html does not link to privacy.html");
check(/href="\.?\/?index\.html"/.test(privacy), "privacy.html does not link back to index.html");

// Titles are required for the consent-screen review.
check(/<title>[^<]{3,}<\/title>/.test(home), "index.html has no title");
check(/<title>[^<]{3,}<\/title>/.test(privacy), "privacy.html has no title");

// The policy must actually describe the Google integration it is asking for.
for (const [needle, why] of [
  ["Google Drive", "privacy policy must name Google Drive"],
  ["drive.file", "privacy policy must name the drive.file scope"],
  ["AES-GCM", "privacy policy must state the encryption used"],
  ["encrypted", "privacy policy must state that backups are encrypted"],
  ["revoke", "privacy policy must explain how to revoke access"],
  ["delete", "privacy policy must explain how to delete data"],
  ["Google API Services User Data Policy", "privacy policy must reference Google's Limited Use policy"],
]) {
  check(privacy.includes(needle), why);
}

// A contact route is required for users to reach the developer. A public issue
// tracker is a valid route; a mailto link is not mandatory.
const contact = /(mailto:[^"]+@[^"]+|github\.com\/shivam2014\/bankpipe\/issues)/;
check(contact.test(home), "index.html has no contact route");
check(contact.test(privacy), "privacy.html has no contact route");

// No third-party code. The privacy policy claims there is none, so enforce it.
for (const [doc, name] of [[home, "index.html"], [privacy, "privacy.html"]]) {
  check(!/<script[^>]+src=["']https?:/i.test(doc), `${name} loads an external script`);
  check(!/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i.test(doc), `${name} loads an external stylesheet`);
  check(!/<img[^>]+src=["']https?:/i.test(doc), `${name} loads a remote image`);
  check(!/google-analytics|googletagmanager|gtag\(|plausible|posthog|sentry/i.test(doc), `${name} contains analytics`);
}

if (failures.length) {
  console.error("FAIL\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: home + privacy pages complete, linked, and free of third-party code");
