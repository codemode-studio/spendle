/**
 * Rebuilds `wasm/` from the crate. Needs rustup, which reads the toolchain from
 * rust-toolchain.toml, and the wasm-bindgen CLI at the exact version pinned in
 * Cargo.toml.
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const crate = import.meta.dirname
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')

// Panic messages embed source paths; remapping them keeps the build the same
// on every machine and keeps home directories out of the committed binary.
const rustflags = [
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${crate}=/spendle-pdf`,
].join(' ')

const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, {
    cwd: crate,
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: rustflags },
  })

run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'])
run('wasm-bindgen', [
  '--target',
  'web',
  // Lets index.ts replace an instance a Rust panic left behind.
  '--experimental-reset-state-function',
  '--out-dir',
  'wasm',
  '--out-name',
  'pdf',
  'target/wasm32-unknown-unknown/release/spendle_pdf.wasm',
])
