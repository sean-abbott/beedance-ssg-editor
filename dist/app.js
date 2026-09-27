// Entry point - imports every feature module for its side effects (each one
// wires its own DOM event listeners and runs its own startup calls at its
// own top level). Real ES modules (see pws-zg1h): editor-core.js is the only
// module the others depend on, so it always finishes initializing first
// regardless of the order these are listed in - the module graph enforces
// that, not this list.
import "./editor-core.js";
import "./settings.js";
import "./preview-tools.js";
import "./content-editing.js";
import "./images.js";
import "./git-workflow.js";
