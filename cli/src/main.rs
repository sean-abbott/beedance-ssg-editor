//! Admin tooling for beedance-ssg-editor. Separate binary/crate from the
//! Tauri GUI app on purpose - this needs none of that dependency tree (no
//! GTK/webkit), just an HTTP client and some prompts, and it's meant to be
//! run by an admin (e.g. from a terminal), not installed alongside the app
//! for every non-technical user.
//!
//! Storage-provider specific: today this only knows how to talk to
//! Cloudflare R2. That's a deliberate choice, not an oversight - see
//! src-tauri/src/zola.rs for the same reasoning applied to SSGs: build one
//! real thing well, keep it named/bounded so a second provider is "add an
//! implementation" rather than "untangle everything", don't build the
//! abstraction before a second real case exists to generalize from.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CF_API_BASE: &str = "https://api.cloudflare.com/client/v4";

#[derive(Parser)]
#[command(name = "beedance-cli", about = "Admin tooling for beedance-ssg-editor: issue scoped per-person storage credentials", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage this tool's own configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Create a new scoped R2 credential for one person, to hand off for
    /// them to paste into beedance's Settings
    CreateUserKey,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Set your own top-level Cloudflare API token (needs "API Tokens: Edit"
    /// permission) - used to issue scoped tokens for others, not itself
    /// handed out to anyone
    SetAdminToken,
    /// Show current configuration (secrets redacted)
    Show,
}

#[derive(Serialize, Deserialize, Default)]
struct Config {
    admin_api_token: Option<String>,
}

fn config_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "could not determine a config directory for this platform".to_string())?
        .join("beedance-cli");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config() -> Config {
    config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path()?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Config { action } => match action {
            ConfigAction::SetAdminToken => set_admin_token(),
            ConfigAction::Show => show_config(),
        },
        Command::CreateUserKey => create_user_key(),
    };

    if let Err(err) = result {
        eprintln!("Error: {err}");
        std::process::exit(1);
    }
}

fn set_admin_token() -> Result<(), String> {
    println!(
        "This is your OWN top-level Cloudflare API token (not a per-person one) - it needs\n\
         \"API Tokens: Edit\" permission, since it's used to issue scoped tokens for other\n\
         people. Create one at https://dash.cloudflare.com/profile/api-tokens if you don't\n\
         have it yet."
    );
    let token: String = dialoguer::Password::new()
        .with_prompt("Cloudflare API token")
        .interact()
        .map_err(|e| e.to_string())?;

    let mut config = load_config();
    config.admin_api_token = Some(token);
    save_config(&config)?;
    println!("Saved.");
    Ok(())
}

fn show_config() -> Result<(), String> {
    let config = load_config();
    match config.admin_api_token {
        Some(token) => {
            let redacted = if token.len() > 6 {
                format!("{}...{}", &token[..3], &token[token.len() - 3..])
            } else {
                "***".to_string()
            };
            println!("admin_api_token: {redacted}");
        }
        None => println!("admin_api_token: (not set - run `beedance-cli config set-admin-token`)"),
    }
    Ok(())
}

/// Looks up a permission group's opaque ID by name, rather than hardcoding a
/// guessed ID string - Cloudflare documents the group NAMES
/// ("Workers R2 Storage Bucket Item Write"/"...Read") but not stable IDs to
/// hardcode, and does document a name-filtered lookup endpoint for this.
fn find_permission_group_id(admin_token: &str, name: &str) -> Result<String, String> {
    let encoded_name = name.replace(' ', "%20");
    let url = format!("{CF_API_BASE}/user/tokens/permission_groups?name={encoded_name}");
    let body: serde_json::Value = ureq::get(&url)
        .header("Authorization", &format!("Bearer {admin_token}"))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;

    body["result"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|item| item["id"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("couldn't find a permission group named \"{name}\" - response: {body}"))
}

/// NOT YET TESTED against a real Cloudflare account - the request/response
/// shape here is verified against Cloudflare's docs, but an HTTP integration
/// like this can only be truly confirmed by actually calling it. Needs a
/// real admin token + bucket to validate end to end.
fn create_user_key() -> Result<(), String> {
    let config = load_config();
    let admin_token = config
        .admin_api_token
        .ok_or_else(|| "no admin token configured - run `beedance-cli config set-admin-token` first".to_string())?;

    let label: String = dialoguer::Input::new()
        .with_prompt("Label for this credential (e.g. the person's name)")
        .interact_text()
        .map_err(|e| e.to_string())?;
    let account_id: String = dialoguer::Input::new()
        .with_prompt("Cloudflare account ID")
        .interact_text()
        .map_err(|e| e.to_string())?;
    let bucket: String = dialoguer::Input::new()
        .with_prompt("R2 bucket name")
        .interact_text()
        .map_err(|e| e.to_string())?;

    println!("Looking up permission groups...");
    let write_id = find_permission_group_id(&admin_token, "Workers R2 Storage Bucket Item Write")?;
    let read_id = find_permission_group_id(&admin_token, "Workers R2 Storage Bucket Item Read")?;

    // "default" jurisdiction covers non-jurisdictional buckets, which is the
    // common case - a bucket created under the EU or FedRAMP jurisdiction
    // would need that instead, not handled here yet.
    let resource_key = format!("com.cloudflare.edge.r2.bucket.{account_id}_default_{bucket}");
    let request_body = serde_json::json!({
        "name": format!("beedance: {label} ({bucket})"),
        "policies": [{
            "effect": "allow",
            "permission_groups": [{"id": write_id}, {"id": read_id}],
            "resources": { resource_key: "*" }
        }]
    });

    println!("Creating scoped token...");
    let response: serde_json::Value = ureq::post(&format!("{CF_API_BASE}/user/tokens"))
        .header("Authorization", &format!("Bearer {admin_token}"))
        .header("Content-Type", "application/json")
        .send_json(&request_body)
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;

    let token_id = response["result"]["id"]
        .as_str()
        .ok_or_else(|| format!("unexpected response (no token id): {response}"))?;
    let token_value = response["result"]["value"]
        .as_str()
        .ok_or_else(|| format!("unexpected response (no token value): {response}"))?;

    let secret_access_key = {
        let mut hasher = Sha256::new();
        hasher.update(token_value.as_bytes());
        hex_encode(&hasher.finalize())
    };

    println!();
    println!("Credential created for \"{label}\" - hand these to them to paste into beedance's Settings:");
    println!("  Account ID:        {account_id}");
    println!("  Bucket:            {bucket}");
    println!("  Endpoint:          https://{account_id}.r2.cloudflarestorage.com");
    println!("  Access Key ID:     {token_id}");
    println!("  Secret Access Key: {secret_access_key}");
    println!();
    println!("This is shown once - Cloudflare doesn't let you retrieve the secret again after this.");

    Ok(())
}
