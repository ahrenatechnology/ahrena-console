// The configuration the release depends on being right (issue #90): the same version in the three
// files (the `app-v<version>` tag is checked against tauri.conf.json in CI), the updater pointing
// at this repository's releases and the app's identifier.

use std::path::Path;

use serde_json::Value;

const RELEASES: &str = "https://github.com/ahrenatechnology/ahrena-console/releases/";

fn read(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn json(relative: &str) -> Value {
    serde_json::from_str(&read(relative)).unwrap_or_else(|e| panic!("{relative}: {e}"))
}

fn conf() -> Value {
    json("tauri.conf.json")
}

/// The `version` of Cargo.toml's `[package]` section.
fn cargo_version() -> String {
    let cargo = read("Cargo.toml");
    let mut in_package = false;
    for line in cargo.lines().map(str::trim) {
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if let Some(rest) = line.strip_prefix("version").filter(|_| in_package) {
            if let Some(value) = rest.trim_start().strip_prefix('=') {
                return value.trim().trim_matches('"').to_string();
            }
        }
    }
    panic!("Cargo.toml without version in [package]")
}

#[test]
fn the_version_is_the_same_in_the_three_files() {
    let conf = conf()["version"].as_str().expect("tauri.conf.json without version").to_string();
    let npm = json("../package.json")["version"].as_str().expect("package.json without version").to_string();
    assert_eq!(conf, cargo_version(), "tauri.conf.json and Cargo.toml");
    assert_eq!(conf, npm, "tauri.conf.json and package.json");
}

#[test]
fn the_updater_looks_in_this_repositorys_releases() {
    let conf = conf();
    let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().expect("plugins.updater.endpoints");
    assert!(!endpoints.is_empty());
    for e in endpoints {
        let e = e.as_str().expect("an endpoint is text");
        assert!(e.starts_with(RELEASES), "endpoint outside the repository's releases: {e}");
    }
}

#[test]
fn the_public_key_is_text_and_the_updater_artifacts_are_left_to_ci() {
    let conf = conf();
    // Empty until the project has the key; the app only turns the updater on with it (updater.rs).
    assert!(conf["plugins"]["updater"]["pubkey"].is_string(), "plugins.updater.pubkey must be text");
    // On here, every local build would ask for the private key; CI turns it on with `--config`.
    let artifacts = &conf["bundle"]["createUpdaterArtifacts"];
    assert!(matches!(artifacts, Value::Null | Value::Bool(false)), "bundle.createUpdaterArtifacts on in the conf: {artifacts}");
}

#[test]
fn the_app_identifier() {
    assert_eq!(conf()["identifier"], "dev.ahrena.console");
}
