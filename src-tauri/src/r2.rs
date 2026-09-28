//! Cloudflare R2 (or any S3-compatible store, in principle) as an ADDITIONAL
//! image placement alongside "static"/"bundle" (see images.rs), not a
//! replacement - the site-committed default stays available regardless.
//! Real, tested against a live account (not just a compile spike): put_object
//! only correctly returns Err on a bad request when rust-s3's "fail-on-err"
//! feature is enabled - found the hard way when a corrupted credential
//! silently "succeeded" with fail-on-err missing from the feature set.
//!
//! Split into SITE config (bucket/public_url_base) and PERSONAL config
//! (the enabled toggle, account_id, and the actual credentials). Site config
//! (site_config_dir()) is committed to the site's own repo and MUST NEVER
//! hold anything that isn't comfortable being public - it has to be treated
//! as though that repo is public even when it happens not to be, since
//! that's what everyone touching it will assume. A bucket name and public
//! URL are fine there; account_id, while it grants no access by itself
//! (that needs the scoped access key/secret too), still reads as an account
//! identifier someone might not want sitting in a repo - kept in PERSONAL
//! config instead (config_dir(), never committed, entered once per
//! installation same as the credentials). `enabled` is personal rather than
//! site-level on purpose too: an individual installation can opt out of the
//! site's R2 default and fall back to local git-committed storage even when
//! the site itself is configured for R2.

use std::sync::Mutex;

use crate::site::{config_dir, site_config_dir};

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct R2SiteConfig {
    bucket: String,
    // The URL a browser actually fetches the image from (a custom domain or
    // the bucket's r2.dev dev URL) - NOT the same host as the S3-compatible
    // API endpoint (<account>.r2.cloudflarestorage.com), which only accepts
    // authenticated requests.
    public_url_base: String,
}

const R2_SITE_CONFIG_FILE: &str = "r2-site.json";

pub struct R2SiteConfigState(pub Mutex<R2SiteConfig>);

pub fn load_r2_site_config() -> R2SiteConfig {
    std::fs::read_to_string(site_config_dir().join(R2_SITE_CONFIG_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_r2_site_config(state: tauri::State<R2SiteConfigState>) -> R2SiteConfig {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_r2_site_config(settings: R2SiteConfig, state: tauri::State<R2SiteConfigState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    let dir = site_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(R2_SITE_CONFIG_FILE), json).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct R2PersonalConfig {
    enabled: bool,
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
}

const R2_PERSONAL_CONFIG_FILE: &str = "r2-personal.json";

pub struct R2PersonalConfigState(pub Mutex<R2PersonalConfig>);

pub fn load_r2_personal_config() -> R2PersonalConfig {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(R2_PERSONAL_CONFIG_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_r2_personal_config(state: tauri::State<R2PersonalConfigState>) -> R2PersonalConfig {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_r2_personal_config(settings: R2PersonalConfig, state: tauri::State<R2PersonalConfigState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(R2_PERSONAL_CONFIG_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn r2_fully_configured(site: &R2SiteConfig, personal: &R2PersonalConfig) -> bool {
    personal.enabled
        && !site.bucket.is_empty()
        && !site.public_url_base.is_empty()
        && !personal.account_id.is_empty()
        && !personal.access_key_id.is_empty()
        && !personal.secret_access_key.is_empty()
}

pub fn r2_public_url_base(site: &R2SiteConfig) -> &str {
    &site.public_url_base
}

/// The R2 object key for `url`, if it's actually one of this site's own R2-
/// hosted images (i.e. starts with the site's own public_url_base) - None
/// for anything else (a static/bundle-local image, or a genuinely external
/// URL someone linked to via "Insert image from URL"), which callers should
/// leave alone rather than trying to delete something this app doesn't own.
pub fn r2_key_from_url(site: &R2SiteConfig, url: &str) -> Option<String> {
    let base = site.public_url_base.trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    url.strip_prefix(base)
        .map(|rest| rest.trim_start_matches('/').to_string())
        .filter(|key| !key.is_empty())
}

/// Builds the S3-compatible Bucket handle every real R2 network operation
/// needs - factored out so media.rs's list_r2_images (a third caller, after
/// upload_to_r2/delete_from_r2) doesn't need direct field access to either
/// config struct, which stay private on purpose (see this module's own doc
/// comment on why account_id/credentials are personal, not site, config).
pub fn r2_bucket(site: &R2SiteConfig, personal: &R2PersonalConfig) -> Result<Box<s3::bucket::Bucket>, String> {
    use s3::bucket::Bucket;
    use s3::creds::Credentials;
    use s3::region::Region;

    let region = Region::Custom {
        region: "auto".to_string(),
        endpoint: format!("https://{}.r2.cloudflarestorage.com", personal.account_id),
    };
    let credentials = Credentials::new(
        Some(&personal.access_key_id),
        Some(&personal.secret_access_key),
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    Bucket::new(&site.bucket, region, credentials).map_err(|e| e.to_string())
}

pub fn upload_to_r2(site: &R2SiteConfig, personal: &R2PersonalConfig, key: &str, content: &[u8]) -> Result<(), String> {
    let bucket = r2_bucket(site, personal)?;
    bucket.put_object(key, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes an R2 object outright - upload_to_r2 was, until now, the ONLY R2
/// network operation anywhere in this codebase, so an object never got
/// cleaned up no matter how a page stopped referencing it (deleted,
/// replaced, edited by hand) - see pws-6ryi.
pub fn delete_from_r2(site: &R2SiteConfig, personal: &R2PersonalConfig, key: &str) -> Result<(), String> {
    let bucket = r2_bucket(site, personal)?;
    bucket.delete_object(key).map_err(|e| e.to_string())?;
    Ok(())
}
