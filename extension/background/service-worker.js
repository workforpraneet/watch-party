// WatchParty Background Service Worker (MV3)
// Minimal - handles extension lifecycle and message relay

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    wp_server: 'ws://localhost:3000',
    wp_user: ''
  });
});

// Relay messages between popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['wp_server', 'wp_user'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({
      wp_server: msg.serverUrl,
      wp_user: msg.username
    }, () => sendResponse({ ok: true }));
    return true;
  }

  // Forward popup messages to active tab's content script
  if (msg.type === 'TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, msg.data, sendResponse);
      }
    });
    return true;
  }
});
