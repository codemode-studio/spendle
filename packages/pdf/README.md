# @spendle/pdf

Reads PDF statements for the server: plain text, text fragments with their
positions, and the pages that need OCR. It binds the Rust core of
[pdf-inspector](https://github.com/firecrawl/pdf-inspector) compiled to
WebAssembly, so it runs wherever JavaScript does, without a native binding per
platform. Upstream's own WASM package does not export positioned text, which
every statement layout reads.

`wasm/` is generated and committed, so installing and running Spendle needs no
Rust. Rebuild it only after changing `src/lib.rs` or `Cargo.toml`:

1. Install [rustup](https://rustup.rs); it picks up the toolchain from
   `rust-toolchain.toml`.
2. Install the `wasm-bindgen` CLI at the version `Cargo.toml` pins.
3. Run `vp run build:wasm` here and commit `wasm/` with `Cargo.lock`.

The build remaps source paths, so the same sources produce the same binary on
any machine.

Bumping `pdf-inspector` can change what layouts read. Run the server's PDF tests
(`src/imports`) after a bump.
