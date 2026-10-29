# Encrypted workbook fixture

`example_password.xlsx` is the Agile-encryption sample from the
[msoffcrypto-tool](https://github.com/nolze/msoffcrypto-tool) test suite
(MIT licence). It is encrypted with the password `Password1234_` and uses
AES-256 with SHA-512.

The test asserts the decrypted bytes hash to
`4dd9dd0ccbfc7fb8769f1f3307830d3cc4c5042e32d619f4b2835fada89d13c6`, which is the
SHA-256 of that repository's `tests/outputs/example.xlsx`.

It is here only to prove the reader works on a file this project did not create.
No real statement is committed.
