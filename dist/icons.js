// A DOM-node factory for the inline SVG icon sprite pasted into index.html
// (see its <svg id="icon-sprite">) - for the handful of places that build
// rows/chips from data (editor-core.js's tab bar, content-editing.js's tag
// chips, site-menu.js's rows, git-workflow.js's review rows) rather than
// static markup, which can just write `<svg class="icon"><use
// href="#icon-x"/></svg>` directly. No icon font, no CDN - this app has no
// bundler and needs to work fully offline.

const SVG_NS = "http://www.w3.org/2000/svg";

export function makeIcon(name, extraClass) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", extraClass ? `icon ${extraClass}` : "icon");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}
