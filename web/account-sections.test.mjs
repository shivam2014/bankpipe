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

test("the disclosure sits left of the section label", () => {
  const helper = html.slice(html.indexOf("function accountSectionsHtml"),
    html.indexOf("function bankRow"));
  assert.ok(helper.indexOf('class="acct-sec-toggle"') < helper.indexOf('class="subrow acct-sec-link"'),
    "the toggle is the left control, the link starts after it");
  assert.match(html, /acct-sec-spacer/);
  assert.match(html, /\.acct-sec-body\{padding:0 0 6px 28px\}/);
});

test("the bank page does not double-indent the account sections", () => {
  assert.match(html, /variant: "bank"/);
  assert.match(html, /variant === "bank" \? " in-bank" : ""/);
  assert.match(html,
    /\.acct-sections\.in-bank\{margin-left:0;border-left:0;padding-left:0;padding-right:0\}/);
});

test("the bank account row aligns with the section labels", () => {
  assert.match(html, /class="subrow acct-bank-row"/);
  assert.match(html, /\.acct-bank-row\{padding-left:28px\}/);
  assert.match(html, /\.acct-bank-row \.nm\{white-space:normal;overflow:visible;text-overflow:clip;line-height:1\.35\}/);
  assert.match(html, /\.acct-sec-body\{padding:0 0 6px 28px\}/);
});

test("the bank account list uses the assets page inset", () => {
  assert.match(html, /class="bank-subs acct-list"/);
  assert.match(html, /\.bank-subs\.acct-list\{margin-left:14px;padding-left:8px;width:calc\(100% - 14px\)\}/);
});

test("lockers are custody, not an asset value", () => {
  assert.match(html, /function lockerContents/);
  assert.match(html, /class="locker-row"/);
  assert.match(html, /locker-stored/);
  assert.match(html, /locker-cost/);
  assert.match(html, /note: "custody"/);
  assert.match(html, /Contents memo/);
  assert.match(html, /Renews \$\{esc\(dateLabel\(l\.renewal_date\)\)\}/);
  assert.doesNotMatch(html, /Locker contents/);
  assert.doesNotMatch(html, /inside, not counted/);
});
