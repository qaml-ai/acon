const CANDIDATE_SITES = [
  "https://example.com",
  "https://developer.mozilla.org/en-US/",
  "https://www.rfc-editor.org/",
  "https://httpbin.org/",
];

function readContext() {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fromSearch = new URLSearchParams(window.location.search);
  return {
    threadId: fromHash.get("threadId") || fromSearch.get("threadId") || "default-thread",
  };
}

function hash(text) {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) >>> 0;
  }
  return value;
}

const { threadId } = readContext();
const site = CANDIDATE_SITES[hash(threadId) % CANDIDATE_SITES.length];
const frame = document.getElementById("site-frame");
if (frame instanceof HTMLIFrameElement) {
  frame.src = site;
}
