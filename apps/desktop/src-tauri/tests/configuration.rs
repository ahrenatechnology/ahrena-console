// The configuration the release depends on being right (issue #90): the same version in the app's
// three files and in the core it bundles (#261; the `app-v<version>` tag is checked against
// tauri.conf.json in CI), the updater pointing at this repository's releases and the app's identifier.

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

fn npm_version(relative: &str) -> String {
    json(relative)["version"].as_str().unwrap_or_else(|| panic!("{relative} without version")).to_string()
}

#[test]
fn the_version_is_the_same_in_the_three_files() {
    let conf = conf()["version"].as_str().expect("tauri.conf.json without version").to_string();
    assert_eq!(conf, cargo_version(), "tauri.conf.json and Cargo.toml");
    assert_eq!(conf, npm_version("../package.json"), "tauri.conf.json and package.json");
}

/// One version for the product (#261): the core shows its package's version in the /ui footer, the
/// instance registry and the MCP `serverInfo`, so it moves with the app's.
#[test]
fn the_bundled_core_has_the_apps_version() {
    let conf = conf()["version"].as_str().expect("tauri.conf.json without version").to_string();
    assert_eq!(conf, npm_version("../../../packages/nucleo/package.json"), "tauri.conf.json and packages/nucleo/package.json");
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

/// Voice dictation records in the app's WKWebView (decision 0019): without NSMicrophoneUsageDescription
/// macOS never asks, and the microphone stays off. Tauri's bundler merges the `Info.plist` that sits
/// next to tauri.conf.json, so the file must exist and keep the key.
#[test]
fn the_info_plist_explains_the_microphone() {
    let plist = read_without_comments("Info.plist");
    let after_key = plist.split("<key>NSMicrophoneUsageDescription</key>").nth(1).expect("Info.plist without NSMicrophoneUsageDescription outside a comment");
    let after_key = after_key.trim_start();
    assert!(after_key.starts_with("<string>"), "NSMicrophoneUsageDescription is not followed by a <string>");
    let description = after_key["<string>".len()..].split("</string>").next().expect("NSMicrophoneUsageDescription string is not closed");
    assert!(!description.trim().is_empty(), "NSMicrophoneUsageDescription is empty");
    // Merged by name, not listed in the conf: a custom path in bundle.macOS.infoPlist would replace the lookup.
    assert!(conf()["bundle"]["macOS"].get("infoPlist").is_none(), "bundle.macOS.infoPlist set: Info.plist next to the conf may not be the one merged");
}

/// The text of `relative` with the XML comments removed, so a key inside a comment does not count.
fn read_without_comments(relative: &str) -> String {
    let mut text = read(relative);
    while let Some(start) = text.find("<!--") {
        let end = text[start..].find("-->").map_or(text.len(), |e| start + e + 3);
        text.replace_range(start..end, "");
    }
    text
}

/// The bundle is signed with the hardened runtime, which silently denies the microphone unless the
/// signature carries the audio-input entitlement (decision 0019): the file must keep the key and the
/// conf must keep pointing at it.
#[test]
fn the_entitlements_allow_audio_input() {
    let entitlements = read_without_comments("Entitlements.plist");
    let after_key = entitlements.split("<key>com.apple.security.device.audio-input</key>").nth(1).expect("Entitlements.plist without com.apple.security.device.audio-input outside a comment");
    assert!(after_key.trim_start().starts_with("<true/>"), "audio-input entitlement is not true");
    assert_eq!(conf()["bundle"]["macOS"]["entitlements"], "Entitlements.plist", "bundle.macOS.entitlements must point at Entitlements.plist");
}

/// The app ships a prebuilt `whisper-server` (decision 0019 item 10, #405): the bundle takes the
/// folder the build script fills, to `whisper/` (where core.rs looks), and both app workflows run
/// that script before the tauri build. Dropping either leaves the app without dictation, silently.
#[test]
fn the_bundle_ships_the_whisper_server_and_ci_builds_it() {
    let conf = conf();
    assert_eq!(conf["bundle"]["resources"]["resources/whisper/"], "whisper/", "bundle.resources must map resources/whisper/ to whisper/");
    // The folder must exist in a checkout, or the bundler fails where the binary is not built (x64).
    assert!(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/whisper/.gitkeep").is_file(), "resources/whisper/.gitkeep");
    assert!(Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/build-whisper-server.sh").is_file(), "apps/desktop/scripts/build-whisper-server.sh");
    for workflow in ["../../../.github/workflows/app-ci.yml", "../../../.github/workflows/app-release.yml"] {
        let text = read(workflow);
        let build = text.find("apps/desktop/scripts/build-whisper-server.sh").unwrap_or_else(|| panic!("{workflow} does not run build-whisper-server.sh"));
        let tauri = text.find("npx tauri build").or_else(|| text.find("tauri-apps/tauri-action")).unwrap_or_else(|| panic!("{workflow} without a tauri build"));
        assert!(build < tauri, "{workflow}: the whisper-server build must come before the tauri build");
        assert!(text.contains("actions/cache@"), "{workflow}: the whisper-server build is cached by tag");
    }
}

/// The pinned whisper.cpp lives in one file that `voice install` (install.ts) and the build script both read.
#[test]
fn the_whisper_pin_has_one_source() {
    let pin = json("../../../packages/nucleo/src/transcription/whisper-cpp.json");
    let commit = pin["commit"].as_str().expect("whisper-cpp.json without commit");
    assert!(commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()), "commit is not a full sha: {commit}");
    assert!(pin["tag"].as_str().is_some_and(|t| t.starts_with('v')), "whisper-cpp.json without tag");
    assert!(read("../../../packages/nucleo/src/transcription/install.ts").contains("whisper-cpp.json"), "install.ts must read whisper-cpp.json");
    let script = read("../scripts/build-whisper-server.sh");
    assert!(script.contains("whisper-cpp.json"), "the build script must read whisper-cpp.json");
    for flag in ["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DBUILD_SHARED_LIBS=OFF"] {
        assert!(script.contains(flag), "the build script without {flag}");
    }
}
