document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('server-url');
  const usernameInput = document.getElementById('username');
  const saveBtn = document.getElementById('save-btn');
  const status = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['wp_server', 'wp_user'], (data) => {
    serverInput.value = data.wp_server || 'ws://localhost:3000';
    usernameInput.value = data.wp_user || '';
  });

  saveBtn.addEventListener('click', () => {
    const serverUrl = serverInput.value.trim();
    const username = usernameInput.value.trim();

    if (!serverUrl) {
      status.textContent = 'Please enter a server URL';
      status.style.color = '#e94560';
      return;
    }

    chrome.storage.local.set({
      wp_server: serverUrl,
      wp_user: username
    }, () => {
      status.textContent = '✓ Settings saved!';
      status.style.color = '#4ecca3';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});
