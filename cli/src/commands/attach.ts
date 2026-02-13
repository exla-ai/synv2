import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { WSClient } from '../ws-client.js';
import { ChatUI } from '../chat-ui.js';

export async function attachCommand(name: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  // Verify project exists and is running
  let project;
  try {
    project = await api.getProject(name);
  } catch (err: any) {
    console.error(`Project "${name}" not found: ${err.message}`);
    process.exit(1);
  }

  if (project.status !== 'running') {
    console.error(`Project "${name}" is ${project.status}. It must be running to attach.`);
    process.exit(1);
  }

  const wsUrl = api.getWsUrl(name);

  let ui: ChatUI;
  let ws: WSClient;
  let bannerShown = false;

  ws = new WSClient(wsUrl, {
    onDelta: (delta) => {
      // Show banner after we get the first status message (has supervisor info)
      if (delta.type === 'status' && !bannerShown) {
        ui.handleDelta(delta); // update internal state first
        ui.showBanner();
        bannerShown = true;
        return;
      }
      // Show history before prompting
      if (delta.type === 'history') {
        ui.handleDelta(delta);
        if (bannerShown) ui.prompt();
        return;
      }
      ui.handleDelta(delta);
    },
    onOpen: () => {
      // Identify as human so supervisor knows to pause
      ws.identify('human');
    },
    onClose: (_code, _reason) => {
      ui.showStatus('Disconnected.');
      process.exit(0);
    },
    onError: (err) => {
      ui.showStatus(`Connection error: ${err.message}`);
    },
  });

  ui = new ChatUI({
    onMessage: (text) => {
      ws.sendMessage(text);
    },
    onExit: () => {
      ws.close();
      ui.destroy();
      console.log('Disconnected.');
      process.exit(0);
    },
    projectName: name,
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    ws.close();
    ui.destroy();
    console.log('\nDisconnected.');
    process.exit(0);
  });

  ws.connect();
}
