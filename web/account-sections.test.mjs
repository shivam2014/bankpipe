import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("every account card renders Savings, fixed deposits and lockers", () => {
  assert.match(html, /function accountSectionsHtml/);
  assert.match(html, /kind: "savings", label: "Savings"/);
  assert.match(html, /kind: "fds", label: `Fixed deposits \(\$\{fds\.length\}\)`/);
  assert.match(html, /kind: "lockers", label: `Lockers \(\$\{lockers\.length\}\)`/);
  const calls = html.match(/accountSectionsHtml\(\{/g) || [];
  assert.ok(calls.length >= 4,
    "the definition and the three account lists share one section renderer");
  assert.match(html, /No lockers recorded\. Use Add locker on the account page\./);
});

test("the FD and locker headers link to their card on the account page", () => {
  assert.match(html, /openFds: `bpAccount\(\$\{jsArg\(acc\.id\)\},'fds'\)`/);
  assert.match(html, /openLockers: `bpAccount\(\$\{jsArg\(acc\.id\)\},'lockers'\)`/);
  assert.match(html, /id="account-fds"/);
  assert.match(html, /id="lockers"/);
});

test("expand and collapse are a separate control from the header link", () => {
  assert.match(html, /class="acct-sec-toggle" type="button" aria-expanded="true"/);
  assert.match(html, /window\.bpSectionToggle = \(button\) =>/);
  assert.match(html, /const open = button\.getAttribute\("aria-expanded"\) !== "false"/);
  assert.match(html, /body\.hidden = open/);
  assert.match(html, /`\$\{open \? "Expand" : "Collapse"\} \$\{label\}`/);
});

test("the account helper clears a previous scroll target", () => {
  assert.match(html, /window\.bpAccount = \(id, section = ""\)/);
  assert.match(html, /window\.bpAccountSection = section \|\| ""/);
  assert.match(html, /const target = window\.bpAccountSection === "fds" \? "account-fds" : "lockers"/);
  assert.match(html, /document\.getElementById\(target\)/);
});
