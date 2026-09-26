//! Cloudflare R2 (or any S3-compatible store, in principle) as an ADDITIONAL
//! image placement alongside "static"/"bundle" (see images.rs), not a
//! replacement - the site-committed default stays available regardless.
//! Real, tested against a live account (not just a compile spike): put_object
//! only correctly returns Err on a bad request when rust-s3's "fail-on-err"
//! feature is enabled - found the hard way when a corrupted credential
//! silently "succeeded" with fail-on-err missing from the feature set.

use std::sync::Mutex;

use crate::site::config_dir;

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct R2Settings {
    enabled: bool,
    account_id: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    // The URL a browser actually fetches the image from (a custom domain or
    // the bucket's r2.dev dev URL) - NOT the same host as the S3-compatible
    // API endpoint (<account>.r2.cloudflarestorage.com), which only accepts
    // authenticated requests.
    public_url_base: String,
}

impl R2Settings {
    pub fn fully_configured(&self) -> bool {
        self.enabled
            && !self.account_id.is_empty()
            && !self.bucket.is_empty()
            && !self.access_key_id.is_empty()
            && !self.secret_access_key.is_empty()
            && !self.public_url_base.is_empty()
    }

    pub fn public_url_base(&self) -> &str {
        &self.public_url_base
    }
}

const R2_SETTINGS_FILE: &str = "r2-settings.json";

pub struct R2SettingsState(pub Mutex<R2Settings>);

pub fn load_r2_settings() -> R2Settings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(R2_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_r2_settings(state: tauri::State<R2SettingsState>) -> R2Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_r2_settings(settings: R2Settings, state: tauri::State<R2SettingsState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(R2_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn upload_to_r2(settings: &R2Settings, key: &str, content: &[u8]) -> Result<(), String> {
    use s3::bucket::Bucket;
    use s3::creds::Credentials;
    use s3::region::Region;

    let region = Region::Custom {
        region: "auto".to_string(),
        endpoint: format!("https://{}.r2.cloudflarestorage.com", settings.account_id),
    };
    let credentials = Credentials::new(
        Some(&settings.access_key_id),
        Some(&settings.secret_access_key),
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    let bucket = Bucket::new(&settings.bucket, region, credentials).map_err(|e| e.to_string())?;

    bucket.put_object(key, content).map_err(|e| e.to_string())?;
    Ok(())
}
