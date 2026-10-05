//! Per-site collaboration policy (pws-4g2n) - currently just "does more
//! than one person edit this site". site_config_dir() like R2SiteConfig
//! (committed, shared), since this is a property of the site/team, not a
//! personal preference - two different people working on the same site
//! should see the same answer.

use std::sync::Mutex;

use crate::site::site_config_dir;

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCollabConfig {
    // Gates the soft "you're saving directly to the live site" warning
    // (git-workflow.js) - a solo editor doesn't need that reminder on
    // every checkpoint/push to the live branch.
    pub multiple_editors: bool,
}

const GIT_COLLAB_CONFIG_FILE: &str = "git-collab.json";

pub struct GitCollabConfigState(pub Mutex<GitCollabConfig>);

pub fn load_git_collab_config() -> GitCollabConfig {
    std::fs::read_to_string(site_config_dir().join(GIT_COLLAB_CONFIG_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_git_collab_config(state: tauri::State<GitCollabConfigState>) -> GitCollabConfig {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_git_collab_config(settings: GitCollabConfig, state: tauri::State<GitCollabConfigState>) -> Result<(), String> {
    *state.0.lock().unwrap() = settings.clone();

    let dir = site_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(GIT_COLLAB_CONFIG_FILE), json).map_err(|e| e.to_string())?;
    Ok(())
}
