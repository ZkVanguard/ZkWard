use anyhow::Result;

fn main() -> Result<()> {
    // prost-build writes generated code to $OUT_DIR by default; src/pb/mod.rs
    // picks it up via `include!(concat!(env!("OUT_DIR"), "/vault.rs"))`.
    prost_build::Config::new()
        .default_package_filename("vault")
        .compile_protos(&["proto/vault.proto"], &["proto/"])?;

    println!("cargo:rerun-if-changed=proto/vault.proto");
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
