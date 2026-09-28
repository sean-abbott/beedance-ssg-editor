// Sidebar layout chrome: the File/Insert/<branch> dropdown "app menus"
// (open/close on click, one at a time, closed by an outside click) and the
// sidebar nav's real page-switching (Editor/Pages/Media/Tags/Settings each
// swap which #x-page container is visible in app-main, per pws-898q's
// later full-page-not-modal direction) plus the de-emphasized Debug tools
// link. Kept as its own module (rather than in app.js, which is
// deliberately just import-for-side-effects) since this is generic
// app-chrome behavior, not owned by any one feature module.

const APP_MAIN_PAGES = ["editor", "pages", "media", "tags", "settings"];

// Each destination module (site-menu.js for Pages, content-editing.js for
// Tags, media-page.js for Media) listens for this rather than each owning
// its own click handler on the sidebar link directly - keeps "which page is
// showing" as this module's one job, and lets a page's own load logic fire
// the same way whether it was reached from the sidebar or from a shortcut
// elsewhere (e.g. the File menu's "Site menu..." item, which also just
// calls showAppMainPage("pages"); or the Tags page's "N posts" count, which
// calls showAppMainPage("pages", { tag: "newsletter" })). `extra` is
// spread into the event detail alongside `page` - a plain, ad hoc carrier
// for the one destination that cares about it, not a general routing
// state store. Always includes every key a listener might check (tag:
// null when not given) so "no tag was passed" and "clear whatever tag
// filter was set before" are the same, unambiguous state - a plain
// sidebar-nav click (which never passes extra) always lands on a clean
// page rather than silently keeping a stale filter from an earlier visit.
export const showAppMainPage = (name, extra = {}) => {
  for (const page of APP_MAIN_PAGES) {
    const el = document.getElementById(`${page}-page`);
    if (el) el.style.display = page === name ? "" : "none";
  }
  document.querySelectorAll(".sidebar-nav a[data-page]").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === name);
  });
  document.dispatchEvent(new CustomEvent("beedance:page-changed", { detail: { page: name, tag: null, ...extra } }));
};

document.querySelectorAll(".sidebar-nav a[data-page]").forEach((a) => {
  a.addEventListener("click", () => showAppMainPage(a.dataset.page));
});

// Delegated (not bound to each ".menu > button" individually) so this also
// covers a .menu built later at runtime - the media page's per-card "..."
// overflow menu (media-page.js) in particular, created fresh every time
// that grid re-renders, long after this module's own top-level code has
// already run once. A per-element binding here would only ever see
// whatever .menu elements existed at that one moment.
document.addEventListener("click", (e) => {
  const toggle = e.target.closest(".menu > button");
  if (toggle) {
    e.stopPropagation();
    const menu = toggle.parentElement;
    const wasOpen = menu.classList.contains("open");
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    if (!wasOpen) menu.classList.add("open");
    return;
  }
  // Also closes an open dropdown when one of its own items is clicked (e.g.
  // "New page..."), same as a real app menu - that click's own handler
  // (elsewhere) already ran during the bubble phase before this one, since
  // only the toggle button branch above stops the click from reaching here.
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
});

// The File menu's "Manage tags..." item used to open its own modal - now it
// just navigates to the Tags page (content-editing.js owns that page's
// content, listening for the page-changed event below).
document.getElementById("manage-tags-button").addEventListener("click", () => {
  showAppMainPage("tags");
});

// The File menu's "Site menu..." item used to open its own modal - now it
// just navigates to the Pages page (which owns that same editor as its
// "Site navigation" section, see site-menu.js) and scrolls to it.
document.getElementById("site-menu-button").addEventListener("click", () => {
  showAppMainPage("pages");
  document.getElementById("pages-site-nav-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Debug tools moved out of an always-visible <details> block on the main
// screen (found the hard way that non-technical users would see it and
// wonder what it was) - now a de-emphasized sidebar link that reveals the
// same <details>, opened, rather than a whole separate panel.
const debugDetails = document.getElementById("debug-tools-details");
document.getElementById("sidebar-nav-debug").addEventListener("click", () => {
  const showing = debugDetails.style.display !== "none";
  debugDetails.style.display = showing ? "none" : "block";
  debugDetails.open = !showing;
});
