(() => {
  const chatPanel = document.querySelector('#live-chat');
  const messagesList = document.querySelector('#chat-messages');
  const chatForm = document.querySelector('#chat-form');
  const nameInput = document.querySelector('#chat-name');
  const messageInput = document.querySelector('#chat-text');
  const sendButton = document.querySelector('#chat-send');
  const chatStatus = document.querySelector('#chat-status');
  if (!chatPanel || !messagesList || !chatForm || !nameInput || !messageInput || !sendButton || !chatStatus) return;

  const renderedMessageIds = new Set();
  const maxRenderedMessages = 50;
  let requestPending = false;
  let lastConnectionWarning = 0;

  function appendMessage(message, animate = false) {
    if (!message || !Number.isSafeInteger(message.id) || renderedMessageIds.has(message.id)) return;

    const shouldScrollToBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 24;
    messagesList.querySelector('.chat-empty')?.remove();

    const entry = document.createElement('li');
    entry.className = 'chat-entry';
    if (animate) entry.classList.add('chat-entry--new');
    entry.dataset.messageId = String(message.id);

    const name = document.createElement('strong');
    name.className = 'chat-entry-name';
    name.textContent = message.name;

    const text = document.createElement('p');
    text.className = 'chat-entry-text';
    text.textContent = message.text;

    entry.append(name, text);
    messagesList.append(entry);
    renderedMessageIds.add(message.id);

    while (messagesList.children.length > maxRenderedMessages) {
      const oldest = messagesList.firstElementChild;
      renderedMessageIds.delete(Number(oldest.dataset.messageId));
      oldest.remove();
    }

    if (shouldScrollToBottom) {
      messagesList.scrollTop = messagesList.scrollHeight;
    }
  }

  async function refreshMessages() {
    if (requestPending) return;
    requestPending = true;

    try {
      const response = await fetch('/api/chat/messages', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Chat refresh failed with status ${response.status}.`);
      }

      const result = await response.json();
      if (!Array.isArray(result.messages)) {
        throw new Error('Chat refresh returned an invalid message list.');
      }

      result.messages.forEach((message) => appendMessage(message));
      chatPanel.dataset.state = 'online';
      chatStatus.textContent = '';
    } catch (error) {
      chatPanel.dataset.state = 'offline';
      chatStatus.textContent = 'Chat unavailable. Reconnecting…';
      if (Date.now() - lastConnectionWarning >= 10_000) {
        console.warn('Unable to refresh live chat:', error);
        lastConnectionWarning = Date.now();
      }
    } finally {
      requestPending = false;
    }
  }

  function handleHistory(event) {
    try {
      const messages = JSON.parse(event.data);
      if (!Array.isArray(messages)) {
        throw new Error('Chat stream returned an invalid message history.');
      }
      messages.forEach((message) => appendMessage(message));
      chatPanel.dataset.state = 'online';
      chatStatus.textContent = '';
    } catch (error) {
      chatPanel.dataset.state = 'offline';
      chatStatus.textContent = 'Chat unavailable. Reconnecting…';
      console.warn('Unable to read live chat history:', error);
    }
  }

  function handleNewMessage(event) {
    try {
      appendMessage(JSON.parse(event.data), true);
      chatPanel.dataset.state = 'online';
      chatStatus.textContent = '';
    } catch (error) {
      chatStatus.textContent = 'A chat update could not be displayed.';
      console.warn('Unable to read live chat message:', error);
    }
  }

  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const text = messageInput.value.trim();
    if (!name || !text) return;

    sendButton.disabled = true;
    chatStatus.textContent = '';

    try {
      const response = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text })
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || `Chat send failed with status ${response.status}.`);
      }

      const result = await response.json();
      appendMessage(result.message, true);
      messageInput.value = '';
      chatPanel.dataset.state = 'online';
      chatStatus.textContent = 'Message sent.';
    } catch (error) {
      chatPanel.dataset.state = 'offline';
      chatStatus.textContent = 'Could not send. Please try again.';
      console.warn('Unable to send chat message:', error);
    } finally {
      sendButton.disabled = false;
    }
  });

  if ('EventSource' in window) {
    const chatStream = new EventSource('/api/chat/stream');
    chatStream.addEventListener('history', handleHistory);
    chatStream.addEventListener('message', handleNewMessage);
    chatStream.onopen = () => {
      chatPanel.dataset.state = 'online';
      chatStatus.textContent = '';
    };
    chatStream.onerror = () => {
      chatPanel.dataset.state = 'offline';
      chatStatus.textContent = 'Chat connection lost. Reconnecting…';
    };
  } else {
    refreshMessages();
    window.setInterval(refreshMessages, 1_500);
  }
})();
