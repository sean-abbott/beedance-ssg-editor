//! Personal-to-this-installation UI preferences (color theme, phone-preview
//! mode) - same persistence pattern as content::AuthorSettings and git's
//! GitAuthConfig (a JSON file under config_dir()), not browser localStorage,
//! since this needs to survive and apply consistently across this app's
//! several windows (main, preview, log), not just one webview's storage.

use std::sync::Mutex;

use crate::site::config_dir;

fn default_true() -> bool {
    true
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    // "bee" (default) or "blue" - anything else the frontend doesn't
    // recognize just falls back to blue, so this never needs validating.
    theme: String,
    // Whether the preview window should open (or be resized to) phone
    // dimensions - a standing preference, not tied to whether a preview
    // window happens to be open right now (see set_preview_phone_mode).
    #[serde(default)]
    pub phone_preview: bool,
    // Whether the first-use feature tour (pws-1nj3) is allowed to auto-fire
    // once per install - defaults to true (missing from an existing config
    // file, e.g. an install upgrading from before this setting existed,
    // means "hasn't opted out yet", not "already said no").
    #[serde(default = "default_true")]
    pub tour_auto_show: bool,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self { theme: "bee".to_string(), phone_preview: false, tour_auto_show: true }
    }
}

// Separate from UiSettings itself: every caller only ever changes ONE field
// at a time (theme.js sets theme, preview-tools.js sets phone_preview), but
// set_ui_settings persists the whole file - taking Option<_> per field and
// merging onto the existing state means a caller updating one field can't
// accidentally reset the other back to its default.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsPatch {
    theme: Option<String>,
    phone_preview: Option<bool>,
    tour_auto_show: Option<bool>,
}

const UI_SETTINGS_FILE: &str = "ui-settings.json";

pub struct UiSettingsState(pub Mutex<UiSettings>);

pub fn load_ui_settings() -> UiSettings {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(UI_SETTINGS_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes the given snapshot to disk - shared by set_ui_settings and
/// preview::set_preview_phone_mode (which updates the same persisted file
/// outside of a UiSettingsPatch round-trip).
pub fn persist_ui_settings(settings: &UiSettings) -> Result<(), String> {
    if let Some(dir) = config_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(UI_SETTINGS_FILE), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_ui_settings(state: tauri::State<UiSettingsState>) -> UiSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_ui_settings(settings: UiSettingsPatch, state: tauri::State<UiSettingsState>) -> Result<(), String> {
    let snapshot = {
        let mut current = state.0.lock().unwrap();
        if let Some(theme) = settings.theme {
            current.theme = theme;
        }
        if let Some(phone_preview) = settings.phone_preview {
            current.phone_preview = phone_preview;
        }
        if let Some(tour_auto_show) = settings.tour_auto_show {
            current.tour_auto_show = tour_auto_show;
        }
        current.clone()
    };
    persist_ui_settings(&snapshot)
}
