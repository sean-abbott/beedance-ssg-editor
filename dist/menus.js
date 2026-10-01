// Sidebar layout chrome: the File/Insert dropdown "app menus" (open/close on
// click, one at a time, closed by an outside click) and the sidebar nav's
// real page-switching (Editor/Pages/Media/Tags/Menu/Drafts/Reviews/Settings
// each swap which #x-page container is visible in app-main, per pws-898q's later
// full-page-not-modal direction) plus the de-emphasized Debug tools link.
// Kept as its own module (rather than in app.js, which is deliberately just
// import-for-side-effects) since this is generic app-chrome behavior, not
// owned by any one feature module.

const APP_MAIN_PAGES = ["editor", "pages", "media", "tags", "menu", "drafts", "reviews", "settings"];

// Each destination module (site-menu.js for Pages, content-editing.js for
// Tags, media-page.js for Media) listens for this rather than each owning
// its own click handler on the sidebar link directly - keeps "which page is
// showing" as this module's one job, and lets a page's own load logic fire
// the same way whether it was reached from the sidebar or from a shortcut
// elsewhere (e.g. the File menu's "Site menu..." item, which also just
// calls showAppMainPage("pages"); or the Tags page's "N posts" count, which
// calls showAppMainPage("pages", { tag: "newsletter" }); or Media's "Used
// on N pages" link, which calls showAppMainPage("pages", { paths: [...],
// image: "garden-day.jpg" })). `extra` is spread into the event detail
// alongside `page` - a plain, ad hoc carrier for the one destination that
// cares about it, not a general routing state store. Always includes
// every key a listener might check (null when not given) so "nothing was
// passed" and "clear whatever filter was set before" are the same,
// unambiguous state - a plain sidebar-nav click (which never passes extra)
// always lands on a clean page rather than silently keeping a stale
// filter from an earlier visit.
export const showAppMainPage = (name, extra = {}) => {
  for (const page of APP_MAIN_PAGES) {
    const el = document.getElementById(`${page}-page`);
    if (el) el.style.display = page === name ? "" : "none";
  }
  document.querySelectorAll(".sidebar-nav a[data-page]").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === name);
  });
  document.dispatchEvent(
    new CustomEvent("beedance:page-changed", { detail: { page: name, tag: null, paths: null, image: null, ...extra } })
  );
};

document.querySelectorAll(".sidebar-nav a[data-page]").forEach((a) => {
  a.addEventListener("click", () => showAppMainPage(a.dataset.page));
});

// A plain CSS position:absolute dropdown (anchored to its trigger via the
// nearest positioned ancestor) gets silently clipped invisible by any
// ancestor using overflow:hidden to round its own corners - .media-card
// does exactly that for its thumbnail, and .panel's own border-radius
// relies on the same trick. Found the hard way: the Media page's per-card
// "..." menu rendered, per Sean, "down and to the right and not z forward
// enough to be visible" - actually invisible, clipped by .media-card's
// overflow:hidden, not a stacking/z-index problem at all. Fixed by
// positioning every .menu-dropdown with position:fixed and real viewport
// coordinates (computed from the trigger's own getBoundingClientRect())
// instead of relying on CSS's default position:absolute-relative-to-
// ancestor behavior - position:fixed is computed against the viewport, so
// it escapes any ancestor's overflow clipping entirely. Clamped to the
// viewport's right/bottom edges so a menu near the grid's own edge doesn't
// overflow off-screen instead of just clipping.
const positionDropdown = (trigger, dropdown) => {
  const rect = trigger.getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left}px`;
  // offsetWidth/Height are only meaningful once the dropdown is actually
  // laid out (display: flex, via the .menu.open .menu-dropdown rule) -
  // this runs AFTER the "open" class is added, below, so it reflects the
  // real rendered size, not the display:none default of 0.
  const maxLeft = window.innerWidth - dropdown.offsetWidth - 8;
  if (rect.left > maxLeft) dropdown.style.left = `${Math.max(8, maxLeft)}px`;
  const maxTop = window.innerHeight - dropdown.offsetHeight - 8;
  if (rect.bottom + 4 > maxTop) dropdown.style.top = `${Math.max(8, rect.top - dropdown.offsetHeight - 4)}px`;
};

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
    if (!wasOpen) {
      menu.classList.add("open");
      const dropdown = menu.querySelector(".menu-dropdown");
      if (dropdown) positionDropdown(toggle, dropdown);
    }
    return;
  }
  // Also closes an open dropdown when one of its own items is clicked (e.g.
  // "New page..."), same as a real app menu - that click's own handler
  // (elsewhere) already ran during the bubble phase before this one, since
  // only the toggle button branch above stops the click from reaching here.
  document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
});
// position:fixed tracks the viewport, not the trigger - if the page
// scrolls out from under an open menu (the Media grid, in particular, can
// scroll with many images), just close it rather than letting it drift
// away from whatever it was anchored to. Capture phase, since a scroll
// inside a specific scrollable element doesn't bubble the way click does.
document.addEventListener(
  "scroll",
  () => {
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  },
  true
);

// The File menu used to also carry "Manage tags..."/"Site menu..." shortcuts
// to the Tags/Pages pages - dropped per Dave's real-user feedback (pws-auax):
// once Tags and Pages became real sidebar destinations, keeping a second,
// duplicate navigation path to the same place inside a menu about file
// actions was redundant, not a convenience. The sidebar nav links (above)
// are the only way there now.

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
