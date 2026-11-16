# Product constraints

These are settled product decisions, kept in one place because the code's shape does
not explain them. They decide what the app must never assume, so read this page before
changing how an asset is valued or how an account is identified. Where this page and
another file disagree, the other file is describing code that has not caught up; each
rule names its contradictions so nobody has to guess which version is current.

## A maturity date is not a payment

A bond past its maturity date has not necessarily been paid. Maturity is a term of the
instrument; the money arrives when the issuer credits it, and that credit appears in a
bank statement. So the maturity date alone never removes a bond from net worth. A matured
lot moves into a Matured section, is labelled `awaiting payment`, and stays on the asset
side, because the issuer still owes it.

Receipt is a separate fact, and a matched bank credit is the only thing that can supply
it: the right amount, inside a date window that makes sense for that instrument. Once
that credit is matched, the lot is marked received and leaves the asset side. Nothing
else counts as evidence. A missing CAS row is not evidence of payment, because a CAS
reports holdings and a paid-off bond is simply absent. A broker file is not evidence
either, because it repeats the same maturity date. With no bank statement imported, a
matured lot stays matured and unpaid indefinitely, and the UI says the payment is
unconfirmed instead of guessing either way.

This corrects a rule that is partly merged and partly on the unmerged `t3/afe451f3`
branch (`1114e17`). In the merged app, `web/index.html:12336` puts matured bonds in a
`Matured bonds (N) · not counted` section, and `docs/UI-REVIEW.md:116` (A34) records
that as the fix. On the branch, `maturedFromHoldings` classifies the lots and
`adjustHoldingTotals` subtracts them from every account total in `web/assets.js`, and
`web/assets.test.mjs:135` asserts that the class total and the account value both drop
it. Do not carry either
version forward. The same error is applied to fixed deposits at `web/assets.js:108`,
which returns no value for a matured FD, and `docs/UI-REVIEW.md:117` (A39) records that
as the fix; if deposits are meant to differ from bonds, that needs its own decision
rather than an inference from the code.

## India is the constraint, not the model

India is where the app has to work first. The demat, broker and depository chain is the
hardest case and it must be correct there, down to a CAS, a BO ID and a depository that
prints one. But that chain is an adapter, not the shape of the model. An account is a
container: a bank account, a demat account, a brokerage account and a fund folio all
hold assets, and none of them needs a report to exist or to be correct.

A report is optional enrichment. It may fill a quantity, a cost, a price or an India
identity, but the account is valid without it. Manual entry is a first-class path, not a
fallback: someone outside India, or with a broker the app cannot parse, must be able to
record a bond, a fund, an equity, a fixed deposit, gold or property by hand and have
every screen work. One file may describe one account holding all of those things, the
way a Trading 212 export does. The Indian separation of broker, depository and cost
record belongs in an adapter that reads those files into the same account and holding
tables; it does not get to define the tables.

Identity follows the same rule. A BO ID is an Indian identity for a depository account,
not the general identity of an account. The general identity is the account plus
whatever stable key its source provides: a BO ID, an account number, a folio number or
a broker client code. A source that offers only a client code is still a source; match
on that code and do not refuse it for lacking a BO ID.

A mutual fund folio's slash suffix is the registrar's check digit, not a sub-folio. A
trailing `/0` is the zero check digit and does not change identity, so `99990000001`
and `99990001/0` are one position. Every other suffix stays distinct (`/1`, `/68`,
`/00`): without the registrar's table a non-zero digit cannot be proven
non-identifying, and a wrong merge costs more than a duplicate. The printed spelling
stays on the account; only comparison normalises it (`web/folio.js:normalizeFolio`).
A fund account that carries the folio, holds no unit rows and records a manual current
value is an adoption candidate, not an automatic home. The import offers that exact
account, and only an explicit choice replaces the manual total with the statement's
units; keeping the manual total leaves it as the single position and imports none of
the statement's rows. A second account carrying the same canonical folio is the
duplicate this rule prevents.

Two existing statements pull the other way and should be softened, not deleted.
`web/db.js:110` says a demat account's identity is the BO ID "not the string a person
typed", and `web/bo-id.js:3-4` says a client code is "a label, never a key". Both are
softer in practice than in prose: `bo_id` stays empty for a number that is not a BO ID,
and `matchDemat` returns `unknown` rather than refusing, so the sentences are the part
that needs to change.
`DEMAT_INTEGRATION.md:158` and `:169` put `depository`, `dp_id` and `client_id` on the
account noun; keep them as nullable fields written by the demat adapter, not as
requirements for an account to exist.

When these rules move into code, a test should hold each one: a matured lot with no
matched credit stays in net worth, and an account with no report can hold every
category.
