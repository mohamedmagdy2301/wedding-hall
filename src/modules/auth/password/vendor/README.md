# Vendored Argon2 WebAssembly (D-64)

`argon2.wasm` is copied unchanged from `@phi-ag/argon2@0.6.1` (`dist/argon2.wasm`), MIT licensed — see
`LICENSE` (Copyright (c) 2024 Peter Hirn). It is a build of the Argon2 reference implementation
(github.com/P-H-C/phc-winner-argon2, CC0 1.0 / Apache 2.0).

It lives in `src/` because Turbopack does not resolve `@phi-ag/argon2/argon2.wasm?module` through the
package's `exports` map. The JavaScript wrapper is still imported from the pinned package, so both must
come from the same version: `tests/unit/password-vendor.test.ts` fails when they differ.

To upgrade: bump the exact version in `package.json`, copy the new `dist/argon2.wasm` and `LICENSE` here,
and run the unit tests (including the interruption test).
