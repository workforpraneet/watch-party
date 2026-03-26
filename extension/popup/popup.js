const SERVER_URL = 'wss://watch-party-production-ecaa.up.railway.app';

document.addEventListener('DOMContentLoaded', () => {
  const usernameInput = document.getElementById('username');
  const saveBtn = document.getElementById('save-btn');
  const roomCodeInput = document.getElementById('room-code');
  const joinBtn = document.getElementById('join-btn');
  const status = document.getElementById('status');

  chrome.storage.local.get(['wp_user'], (data) => {
    usernameInput.value = data.wp_user || '';
  });

  saveBtn.addEventListener('click', () => {
    chrome.storage.local.set({
      wp_user: usernameInput.value.trim()
    }, () => {
      status.textContent = '✓ Name saved!';
      status.style.color = '#4ecca3';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });

  joinBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) {
      status.textContent = 'Enter a room code';
      status.style.color = '#e94560';
      return;
    }

    // Save name first
    chrome.storage.local.set({ wp_user: usernameInput.value.trim() });
    
    status.textContent = 'Looking for room...';
    status.style.color = '#ccc';

    const ws = new WebSocket(SERVER_URL);
    
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'get-room-info', roomId: code }));
    };
    
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'room-info') {
          if (data.found && data.pageUrl) {
            status.textContent = 'Found! Redirecting...';
            status.style.color = '#4ecca3';
            
            // Save pending join directly to storage to bypass SPA routers completely
            chrome.storage.local.set({
              wp_pending_join: {
                code: code,
                timestamp: Date.now()
              }
            }, () => {
              chrome.tabs.create({ url: data.pageUrl });
            });
          } else {
            status.textContent = 'Room not found (or no URL)';
            status.style.color = '#e94560';
          }
          ws.close();
        }
      } catch (err) {}
    };

    ws.onerror = () => {
      status.textContent = 'Cannot connect to server';
      status.style.color = '#e94560';
    };
  });
});
