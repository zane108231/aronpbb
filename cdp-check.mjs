const targets = await fetch('http://localhost:9222/json/list').then((response) => response.json());
const page = targets.find((target) => target.type === 'page');
if (!page) {
  throw new Error('No page target found');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const events = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(JSON.stringify(message.error)));
    } else {
      resolve(message.result);
    }
    return;
  }

  if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(message.method)) {
    events.push(message.params);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: 'http://localhost:3000/' });
await new Promise((resolve) => setTimeout(resolve, 20000));

const expression = `JSON.stringify({
  videos: [...document.querySelectorAll('video')].map((video) => ({
    id: video.id,
    readyState: video.readyState,
    currentTime: video.currentTime,
    paused: video.paused,
    muted: video.muted,
    error: video.error ? video.error.message : null,
    src: video.currentSrc
  })),
  states: [...document.querySelectorAll('.tile-state')].map((node) => node.textContent),
  message: document.querySelector('#app-message')?.textContent || '',
  activeCount: document.querySelector('#active-feed-count')?.textContent || ''
})`;

const result = await send('Runtime.evaluate', { expression, returnByValue: true });
console.log(result.result.value);
console.log('EVENTS');
for (const event of events.slice(-80)) {
  console.log(JSON.stringify(event));
}
socket.close();
process.exit(0);
