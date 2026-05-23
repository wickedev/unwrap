// M1: content script is minimal — storageState capture is invoked from
// background via chrome.scripting.executeScript, so we don't keep a long-lived
// listener here yet. This file exists so the manifest content_script entry
// points to a real bundle and we have a hook for later milestones
// (user interaction recording, DOM snapshots, etc).

export {}

if (window.top === window) {
  console.debug('[unwrap] content script loaded:', location.href)
}
