import "server-only";
// Imported as a compiled WebAssembly.Module: Workers forbid compiling WASM from bytes at runtime.
import argon2Wasm from "./vendor/argon2.wasm?module";

export const argon2Module: WebAssembly.Module = argon2Wasm;
