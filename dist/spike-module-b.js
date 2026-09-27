// See spike-module-a.js - this is the "consumer" half of the spike, proving
// a module can import from another module file, not just execute alone.
import { spikeMessage } from "./spike-module-a.js";

console.log("[module spike]", spikeMessage);
document.title = document.title + " [modules OK]";
