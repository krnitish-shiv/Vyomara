import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The desktop UI smoke test requires macOS on Apple Silicon.');
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'vyomara-desktop-ui-smoke-'));
const debugPortProbe = createServer();
await new Promise((resolveListen, rejectListen) => {
  debugPortProbe.once('error', rejectListen);
  debugPortProbe.listen(0, '127.0.0.1', resolveListen);
});
const address = debugPortProbe.address();
if (!address || typeof address === 'string') throw new Error('A local debug port could not be allocated.');
const debugPort = address.port;
await new Promise((resolveClose, rejectClose) => {
  debugPortProbe.close(error => error ? rejectClose(error) : resolveClose());
});

const child = spawn(
  resolve(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(temporaryRoot, 'electron-profile')}`,
    resolve(projectRoot, 'out/main/index.js'),
  ],
  {
    cwd: projectRoot,
    env: {
      // Editors such as VS Code set ELECTRON_RUN_AS_NODE, which makes Electron reject app flags.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      VYOM_PROVIDER: 'placeholder',
      VYOM_DATA_DIR: join(temporaryRoot, 'app-data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let processOutput = '';
child.stdout.on('data', chunk => { processOutput = (processOutput + chunk).slice(-4_000); });
child.stderr.on('data', chunk => { processOutput = (processOutput + chunk).slice(-4_000); });

let socket;
let nextMessageId = 0;
const pending = new Map();
const checks = [];

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks.push(message);
}

async function waitFor(operation, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited while ${description}: ${processOutput}`);
    }
    const result = await operation();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out while ${description}: ${processOutput}`);
}

async function send(method, params = {}) {
  const id = ++nextMessageId;
  return new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const request = method === 'Runtime.evaluate' ? ` (${params.expression})` : '';
      rejectResponse(new Error(`DevTools request timed out: ${method}${request}`));
    }, 10_000);
    pending.set(id, {
      resolve: response => {
        clearTimeout(timer);
        resolveResponse(response);
      },
      reject: error => {
        clearTimeout(timer);
        rejectResponse(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function clickButton(label) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(candidate => candidate.innerText.trim().endsWith(${JSON.stringify(label)}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not click enabled button "${label}".`);
}

async function typeText(text) {
  await send('Input.insertText', { text });
}

async function pressKey(key, code, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}


try {
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return undefined;
      const targets = await response.json();
      return targets.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl && !String(candidate.url).includes('#pip'));
    } catch {
      return undefined;
    }
  }, 'waiting for Electron DevTools');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (!response.id) return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  });

  await waitFor(
    async () => (await evaluate('document.body?.innerText ?? ""')).includes('Deterministic placeholder'),
    'waiting for the desktop shell',
  );
  const voiceCapabilities = await evaluate(`(async () => ({
    speechSynthesis: typeof window.speechSynthesis === 'object',
    localVoices: window.speechSynthesis?.getVoices().filter(voice => voice.localService).length ?? 0,
    speechSetup: await window.vyomara.getSpeechSetupStatus(),
  }))()`);
  console.log(`Electron voice capabilities: ${JSON.stringify(voiceCapabilities)}`);
  assert(
    voiceCapabilities.speechSetup.listeningEnabled === false,
    'startup does not enable microphone capture without a saved user preference',
  );
  assert(
    await evaluate(`Boolean(document.querySelector('nav[aria-label="Main navigation"]') &&
      document.querySelector('aside[aria-label="Task activity"]') &&
      document.querySelector('.welcome-card'))`),
    'assistant opens with navigation, chat-first welcome, and task activity',
  );
  assert(
    await evaluate(`Boolean(!document.querySelector('.window-lights') &&
      document.querySelector('.topbar .brand-mark svg') &&
      !document.querySelector('.side-nav .brand'))`),
    'the top-left Vyomara logo remains without a duplicate brand in the sidebar',
  );
  assert(
    await evaluate(`(() => {
      const logo = document.querySelector('.topbar-wordmark');
      return logo?.tagName === 'IMG' &&
        logo.getAttribute('alt') === 'Vyomara' &&
        logo.complete &&
        logo.naturalWidth > 500 &&
        getComputedStyle(logo.parentElement?.querySelector('small')).display === 'none' &&
        document.querySelector('.welcome-brand-line')?.textContent === 'AI Twins. One Orbit. Your Control.';
    })()`),
    'welcome screen displays the brand tagline prominently once, not under the logo',
  );
  assert(
    await evaluate(`document.querySelector('.welcome-intro .welcome-kicker')?.textContent === 'YOUR PERSONAL AI ASSISTANT' &&
      document.querySelector('.welcome-intro h2')?.textContent === 'Tell Vyom what you need.' &&
      document.querySelector('.welcome-copy')?.textContent.includes('Vyom keeps you in control and shows its work') &&
    document.querySelector('.welcome-card .voice-orbit-status')?.classList.contains('visually-hidden') &&
    !document.querySelector('.welcome-card .voice-orbit-status')?.textContent.includes('Tap the orb') &&
    document.querySelector('.welcome-card .voice-orb-button') &&
    document.querySelectorAll('.welcome-card .voice-waveform').length === 2`),
    'welcome screen pairs its intro copy with the logo orb and paired waveforms',
  );
  assert(
    await evaluate(`(() => {
      const orb = document.querySelector('.welcome-card .voice-orb-button');
      const orbMark = orb?.querySelector('.voice-orb-mark svg');
      const current = orb?.querySelector('.voice-orb-current');
      const twins = [...(orb?.querySelectorAll('.orb-scene .twin') ?? [])];
      const logoWave = document.querySelector('.topbar .brand-mark .mark-wave-bar');
      return Boolean(logoWave && orbMark?.querySelector('.mark-wave-bar') &&
        current &&
        getComputedStyle(orb, '::after').display === 'none' &&
        twins.length === 2 &&
        twins.every(twin => getComputedStyle(twin).animationName.startsWith('twin-path')) &&
        getComputedStyle(twins[0]).animationDelay !== getComputedStyle(twins[1]).animationDelay &&
        orb.querySelectorAll('.twin-active').length === 1 &&
        orb.querySelectorAll('.twin-trail').length === 2 &&
        !orbMark.querySelector('rect[rx="18"]') &&
        !orb?.querySelector('.voice-orb-mic') &&
        getComputedStyle(logoWave).animationName === 'mark-wave' &&
        getComputedStyle(orbMark.querySelector('.mark-wave-bar')).animationName === 'mark-wave' &&
        getComputedStyle(current).animationName === 'inner-current-spin');
    })()`),
    'the center orb carries the twin planets (Vyom, Vyomara) with trails on one orbit, the chosen one ringed',
  );
  const firstCurrentTransform = await evaluate(
    `getComputedStyle(document.querySelector('.welcome-card .voice-orb-current')).transform`,
  );
  await delay(350);
  assert(
    await evaluate(
      `getComputedStyle(document.querySelector('.welcome-card .voice-orb-current')).transform !== ${JSON.stringify(firstCurrentTransform)}`,
    ),
    'a thin luminous current moves in a separate loop inside the larger orb',
  );
  const twinPositions = () => evaluate(
    `JSON.stringify([...document.querySelectorAll('.welcome-card .orb-scene .twin')].map(twin => getComputedStyle(twin).offsetDistance))`,
  );
  const firstTwinPositions = await twinPositions();
  await delay(350);
  assert(
    await twinPositions() !== firstTwinPositions,
    'the twin satellites travel their shared orbit around the orb',
  );
  // The assistant introduces itself aloud on launch (the waveform moves while it
  // speaks); stop it, then the waveform must rest.
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('.voice-waveform i')].some(bar => getComputedStyle(bar).animationName !== 'none')`),
    'the launch greeting to start',
    4_000,
  ).catch(() => undefined);
  await evaluate('window.vyomara.stopSpeaking()');
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('.voice-waveform i')].every(bar => getComputedStyle(bar).animationName === 'none')`),
    'the launch greeting to stop',
    5_000,
  ).catch(() => undefined);
  assert(
    await evaluate(`(() => [...document.querySelectorAll('.voice-waveform i')].every(bar =>
      getComputedStyle(bar).animationName === 'none'))()`),
    'side waveform bars stay still before voice listening starts',
  );
  const firstWaveformTransforms = await evaluate(`(() => {
    const orbit = document.querySelector('.welcome-card .voice-orbit');
    orbit.classList.add('voice-orbit-listening');
    return JSON.stringify([...orbit.querySelectorAll('.voice-waveform i')].map(bar => getComputedStyle(bar).transform));
  })()`);
  assert(
    await evaluate(`(() => [...document.querySelectorAll('.voice-waveform i')].every(bar =>
      getComputedStyle(bar).animationName === 'voice-wave'))()`),
    'both side waveforms animate only in the listening state',
  );
  await delay(350);
  assert(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.welcome-card .voice-waveform i')].map(bar => getComputedStyle(bar).transform)) !== ${JSON.stringify(firstWaveformTransforms)}`,
    ),
    'both side waveforms visibly move while listening',
  );
  await evaluate(`document.querySelector('.welcome-card .voice-orbit').classList.remove('voice-orbit-listening')`);
  const idleTwins = await twinPositions();
  await delay(350);
  assert(
    await twinPositions() !== idleTwins,
    'the twin planets keep travelling their orbit when not listening',
  );
  assert(
    await evaluate(`document.documentElement.scrollHeight <= document.documentElement.clientHeight &&
      document.body.scrollHeight <= document.body.clientHeight &&
      document.querySelector('.message-list').scrollHeight <= document.querySelector('.message-list').clientHeight`),
    'the app fits the viewport and keeps conversation scrolling inside the message list',
  );
  const scrollbarLayout = await evaluate(`(() => {
      const list = document.querySelector('.message-list');
      const content = document.querySelector('.message-list-content');
      const conversation = document.querySelector('.conversation');
      const conversationStyle = getComputedStyle(conversation);
      const dividerEdge = conversation.getBoundingClientRect().right -
        Number.parseFloat(conversationStyle.borderRightWidth);
      const listStyle = getComputedStyle(list);
      const welcome = document.querySelector('.welcome-card').getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      const contentStyle = getComputedStyle(content);
      const contentCenter = contentBounds.left + Number.parseFloat(contentStyle.paddingLeft) +
        (contentBounds.width - Number.parseFloat(contentStyle.paddingLeft) -
          Number.parseFloat(contentStyle.paddingRight)) / 2;
      return {
        overflowY: listStyle.overflowY,
        overflowX: listStyle.overflowX,
        scrollbarWidth: listStyle.scrollbarWidth,
        webkitWidth: getComputedStyle(list, '::-webkit-scrollbar').width,
        listPaddingRight: listStyle.paddingRight,
        contentPaddingRight: getComputedStyle(content).paddingRight,
        contentWidth: content.getBoundingClientRect().width,
        listClientWidth: list.clientWidth,
        welcomeCenter: welcome.left + welcome.width / 2,
        contentCenter,
        listCenter: listBounds.left + listBounds.width / 2,
        listRight: list.getBoundingClientRect().right,
        dividerEdge,
      };
    })()`);
  assert(
    scrollbarLayout.overflowY === 'auto' &&
      scrollbarLayout.overflowX === 'hidden' &&
      scrollbarLayout.scrollbarWidth === 'thin' &&
      scrollbarLayout.webkitWidth === '2px' &&
      Number.parseFloat(scrollbarLayout.listPaddingRight) === 0 &&
      Number.parseFloat(scrollbarLayout.contentPaddingRight) > 20 &&
      Math.abs(scrollbarLayout.listRight - scrollbarLayout.dividerEdge) < 1 &&
      Math.abs(scrollbarLayout.contentWidth - scrollbarLayout.listClientWidth) < 1 &&
      Math.abs(scrollbarLayout.welcomeCenter - scrollbarLayout.contentCenter) < 1,
    `the 2px scrollbar aligns to the divider while the welcome content stays centered: ${JSON.stringify(scrollbarLayout)}`,
  );
  assert(
    await evaluate(`document.getElementById('prompt')?.placeholder === 'Message Vyom…' &&
      document.querySelector('.welcome-card .voice-orbit-status')?.classList.contains('visually-hidden') &&
      !document.querySelector('.composer-footer > span') &&
      document.querySelector('.privacy-note')?.classList.contains('visually-hidden')`),
    'empty chat accepts a typed or spoken message without a greeting barrier',
  );
  assert(
    await evaluate(`(() => {
      const button = document.querySelector('.welcome-card .voice-orb-button');
      return button?.type === 'button' &&
        button.getAttribute('aria-pressed') === 'false' &&
        button.getAttribute('aria-label')?.includes('listening') &&
        button.disabled === !${JSON.stringify(voiceCapabilities.speechSetup.runtimeAvailable)} &&
        getComputedStyle(button).cursor === (button.disabled ? 'not-allowed' : 'pointer') &&
        getComputedStyle(button).touchAction === 'manipulation';
    })()`),
    'welcome orb is a tactile, accessible button for safe offline voice listening',
  );
  const orbBounds = await evaluate(`(() => {
    const { x, y, width, height } = document.querySelector('.welcome-card .voice-orb-button').getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: orbBounds.x,
    y: orbBounds.y,
  });
  assert(
    await evaluate(`(() => {
      const button = document.querySelector('.welcome-card .voice-orb-button');
      return button.matches(':hover') &&
        getComputedStyle(button).transform !== 'none' &&
        getComputedStyle(button, '::before').boxShadow !== 'none';
    })()`),
    'orb gives clear visual feedback when hovered like an interactive button',
  );
  assert(
    await evaluate(`(() => {
      const microphone = document.querySelector('.composer .voice-input-button');
      const send = document.querySelector('.composer .send-button');
      return microphone?.type === 'button' &&
        send?.disabled === true &&
        microphone.getAttribute('aria-pressed') === 'false' &&
        microphone.getAttribute('aria-label') === 'Record a message' &&
        microphone.disabled === !${JSON.stringify(voiceCapabilities.speechSetup.runtimeAvailable)} &&
        microphone.getBoundingClientRect().width === 34 &&
        microphone.getBoundingClientRect().height === 34 &&
        document.querySelector('.composer').getBoundingClientRect().height <= 112 &&
        document.querySelector('#prompt').getBoundingClientRect().height <= 92;
    })()`),
    'composer starts compact with the record button and a disabled send button when the message is empty',
  );
  const microphonePosition = await evaluate(`(() => {
    const { x, y, width, height } = document.querySelector('.composer .voice-input-button').getBoundingClientRect();
    return { x, y, width, height };
  })()`);
  assert(
    await evaluate(`document.querySelector('.tool-execution-card')?.innerText.includes('No task running')`),
    'current task panel reports the truthful idle state',
  );
  await evaluate('document.getElementById("prompt").focus()');
  await typeText('Can you help me?');
  assert(
    await evaluate(`(() => {
      const send = document.querySelector('.composer .send-button');
      const microphoneButton = document.querySelector('.composer .voice-input-button');
      if (!send || !microphoneButton || send.disabled) return false;
      const sendBox = send.getBoundingClientRect();
      const microphone = ${JSON.stringify(microphonePosition)};
      const now = microphoneButton.getBoundingClientRect();
      // Record sits above Send in a vertical rail inside the box; neither moves while typing.
      const box = document.querySelector('.composer').getBoundingClientRect();
      return sendBox.width === microphone.width && sendBox.height === microphone.height &&
        Math.abs(now.x - microphone.x) < 1 && Math.abs(now.y - microphone.y) < 1 &&
        Math.abs(sendBox.x - now.x) < 1 && sendBox.y > now.y + now.height - 1 &&
        sendBox.right <= box.right && sendBox.bottom <= box.bottom;
    })()`),
    'typing enables a same-size Send button below the record button, inside the message box',
  );
  assert(
    await evaluate(`document.querySelectorAll('.message-user').length === 0 &&
      !document.querySelector('.pending-state') &&
      document.getElementById('prompt').value === 'Can you help me?'`),
    'typed drafts remain in the composer until explicitly sent',
  );
  await pressKey('Enter', 'Enter', 13);
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('.message-assistant .message-text')?.innerText.length > 0 &&
      document.querySelector('.pending-state'))`),
    'showing the first streamed assistant text before the response completes',
  );
  const firstStreamedText = await evaluate(`document.querySelector('.message-assistant .message-text').innerText`);
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('.message-assistant .message-text')?.innerText !== ${JSON.stringify(firstStreamedText)} &&
      document.querySelector('.pending-state'))`),
    'appending later generated text while the assistant is still responding',
  );
  assert(
    await evaluate(`document.querySelector('.message-assistant .message-text')?.innerText.length > ${firstStreamedText.length} &&
      Boolean(document.querySelector('.pending-state'))`),
    'assistant response grows incrementally while generation remains active',
  );
  await waitFor(
    () => evaluate(`document.querySelector('.message-user .message-text')?.innerText === 'Can you help me?' &&
      document.querySelector('.message-assistant .message-text') &&
      !document.querySelector('.pending-state')`),
    'sending an arbitrary first message and receiving a reply without a greeting',
  );
  assert(
    await evaluate(`document.querySelectorAll('.message-user').length === 1 &&
      !document.querySelector('.session-badge') &&
      !document.querySelector('.conversation-heading') &&
      !document.querySelector('.welcome-intro') &&
      getComputedStyle(document.querySelector('.topbar-brand-copy small')).display !== 'none' &&
      document.querySelector('.topbar-brand-copy small')?.textContent === 'AI Twins. One Orbit. Your Control.' &&
      document.querySelector('.composer .voice-input-button') &&
      document.querySelector('.composer .send-button')?.disabled === true`),
    'first chat keeps only the brand tagline without extra welcome or save-status copy',
  );
  const orbLayout = await evaluate(`(() => {
      const shell = document.querySelector('.app-shell');
      const topbar = document.querySelector('.topbar');
      const workspace = document.querySelector('.workspace');
      const orb = document.querySelector('.topbar-orbit .voice-orb-button');
      const rails = document.querySelectorAll('.orbital-header-rails path');
      if (!shell || !topbar || !workspace || !orb || document.querySelector('.orbital-header-rails-pending')) return null;
      const topbarBounds = topbar.getBoundingClientRect();
      const workspaceBounds = workspace.getBoundingClientRect();
      const conversationBounds = document.querySelector('.conversation').getBoundingClientRect();
      const orbBounds = orb.getBoundingClientRect();
      const railsBounds = document.querySelector('.orbital-header-rails').getBoundingClientRect();
      const rail = rails[0];
      const railStart = rail.getPointAtLength(0);
      const railEnd = rail.getPointAtLength(rail.getTotalLength());
      const railMatrix = rail.getScreenCTM();
      const railStartX = railMatrix.a * railStart.x + railMatrix.c * railStart.y + railMatrix.e;
      const railEndX = railMatrix.a * railEnd.x + railMatrix.c * railEnd.y + railMatrix.e;
      let railCenter = railStart;
      for (let index = 1; index <= 1000; index++) {
        const point = rail.getPointAtLength(rail.getTotalLength() * index / 1000);
        if (point.y > railCenter.y) railCenter = point;
      }
      const railCenterX = railMatrix.a * railCenter.x + railMatrix.c * railCenter.y + railMatrix.e;
      const conversationCenterX = conversationBounds.left + conversationBounds.width / 2;
      const topbarBorderLeft = Number.parseFloat(getComputedStyle(topbar).borderLeftWidth);
      const topbarBorderRight = Number.parseFloat(getComputedStyle(topbar).borderRightWidth);
      const curveGap = railMatrix.b * railCenter.x + railMatrix.d * railCenter.y + railMatrix.f - orbBounds.bottom;
      return {
        active: shell.classList.contains('app-shell-chat-active'),
        welcomeHidden: !document.querySelector('.welcome-card') && !document.querySelector('.welcome-intro') &&
          !document.querySelector('.conversation-heading'),
        railCount: rails.length,
        dividerHidden: getComputedStyle(topbar).borderBottomColor === 'rgba(0, 0, 0, 0)' ||
          Number.parseFloat(getComputedStyle(topbar).borderBottomColor.split(',').at(-1)) === 0,
        orbCentered: Math.abs(orbBounds.left + orbBounds.width / 2 - conversationCenterX) < 1,
        railCentered: Math.abs(railCenterX - conversationCenterX) < 1,
        railSpansHeader: Math.abs(railsBounds.left - (topbarBounds.left + topbarBorderLeft)) < 1 &&
          Math.abs(railsBounds.right - (topbarBounds.right - topbarBorderRight)) < 1 &&
          Math.abs(railStartX - railsBounds.left) < 1 && Math.abs(railEndX - railsBounds.right) < 1,
        curveBelowDivider: railCenter.y > railStart.y,
        curveGap,
        curveNearOrb: curveGap >= 8 && curveGap < 20,
        orbLift: orbBounds.top + orbBounds.height / 2 - (topbarBounds.bottom - 24),
        overlapsWorkspace: orbBounds.bottom > workspaceBounds.top,
        zOrder: [getComputedStyle(topbar).zIndex, getComputedStyle(workspace).zIndex],
      };
    })()`);
  assert(
    Boolean(orbLayout?.active && orbLayout.welcomeHidden && orbLayout.railCount === 1 &&
      orbLayout.dividerHidden && orbLayout.orbCentered && orbLayout.railCentered && orbLayout.curveBelowDivider &&
      orbLayout.railSpansHeader && orbLayout.curveNearOrb &&
      Math.abs(orbLayout.orbLift) <= 1 && orbLayout.overlapsWorkspace &&
      Number(orbLayout.zOrder[0]) > Number(orbLayout.zOrder[1])),
    `the straight divider becomes one centered curve below the orb when chat begins: ${JSON.stringify(orbLayout)}`,
  );
  const originalViewport = await evaluate('({ width: window.innerWidth, height: window.innerHeight })');
  const responsiveCurveResults = [];
  for (const width of [1440, 1024, 800]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: originalViewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const responsiveLayout = await waitFor(
      async () => {
        const layout = await evaluate(`(() => {
        const topbar = document.querySelector('.topbar');
        const orb = document.querySelector('.topbar-orbit .voice-orb-button');
        const rail = document.querySelector('.orbital-header-rails path');
        const svg = document.querySelector('.orbital-header-rails');
        const conversation = document.querySelector('.conversation');
        if (!topbar || !orb || !rail || !svg || !conversation ||
          svg.classList.contains('orbital-header-rails-pending') || window.innerWidth !== ${width}) return null;
        const orbBounds = orb.getBoundingClientRect();
        const conversationBounds = conversation.getBoundingClientRect();
        const svgBounds = svg.getBoundingClientRect();
        const matrix = rail.getScreenCTM();
        const start = rail.getPointAtLength(0);
        const end = rail.getPointAtLength(rail.getTotalLength());
        let deepest = start;
        for (let index = 1; index <= 500; index++) {
          const point = rail.getPointAtLength(rail.getTotalLength() * index / 500);
          if (point.y > deepest.y) deepest = point;
        }
        const centerX = matrix.a * deepest.x + matrix.c * deepest.y + matrix.e;
        const curveY = matrix.b * deepest.x + matrix.d * deepest.y + matrix.f;
        const startX = matrix.a * start.x + matrix.c * start.y + matrix.e;
        const endX = matrix.a * end.x + matrix.c * end.y + matrix.e;
        return {
          width: window.innerWidth,
          geometryMatches: Math.abs(svg.viewBox.baseVal.width - svg.clientWidth) < 1,
          centered: Math.abs(centerX - conversationBounds.left - conversationBounds.width / 2) < 2,
          endpoints: Math.abs(startX - svgBounds.left) < 1 && Math.abs(endX - svgBounds.right) < 1,
          nearOrb: curveY - orbBounds.bottom >= 8 && curveY - orbBounds.bottom < 20,
        };
      })()`);
        return layout?.geometryMatches ? layout : null;
      },
      `waiting for the orb curve at ${width}px`,
    );
    responsiveCurveResults.push(responsiveLayout);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await waitFor(
    () => evaluate(`window.innerWidth === ${originalViewport.width}`),
    'restoring the original desktop viewport',
  );
  assert(
    responsiveCurveResults.every(layout => layout.centered && layout.endpoints && layout.nearOrb),
    `the responsive curve stays centered and connected at narrow and wide sizes: ${JSON.stringify(responsiveCurveResults)}`,
  );
  await waitFor(
    () => evaluate('document.activeElement?.id === "prompt"'),
    'restoring composer focus after the first response completes',
  );
  assert(
    await evaluate('document.activeElement?.id === "prompt"'),
    'composer focus returns after sending the first message with Enter',
  );
  assert(
    await evaluate(`document.querySelector('.message-user')?.classList.contains('message-user') &&
      document.querySelector('.message-assistant')?.classList.contains('message-assistant')`),
    'chat messages distinguish the user and Vyom in the conversation layout',
  );
  await evaluate('document.getElementById("prompt").focus()');
  await typeText('How are you?');
  await pressKey('Enter', 'Enter', 13);
  await waitFor(
    () => evaluate(`document.querySelectorAll('.message-user').length === 2 &&
      document.querySelectorAll('.message-assistant').length === 2 &&
      !document.querySelector('.pending-state')`),
    'continuing the same chat with a normal follow-up message',
  );
  await waitFor(
    () => evaluate('document.activeElement?.id === "prompt"'),
    'restoring composer focus after the follow-up response completes',
  );
  assert(
    await evaluate('document.activeElement?.id === "prompt"'),
    'composer stays focused after an Enter-submitted follow-up',
  );
  await typeText('Tell me one more thing.');
  await evaluate('document.querySelector(".send-button").click()');
  await waitFor(
    () => evaluate(`document.querySelectorAll('.message-user').length === 3 &&
      document.querySelectorAll('.message-assistant').length === 3 &&
      !document.querySelector('.pending-state')`),
    'sending another chat message with the send button',
  );
  await waitFor(
    () => evaluate('document.activeElement?.id === "prompt"'),
    'restoring composer focus after clicking Send',
  );
  assert(
    await evaluate('document.activeElement?.id === "prompt"'),
    'composer focus returns after clicking Send',
  );
  const composerFocusStyle = await evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    const composer = document.querySelector('.composer');
    return {
      textareaOutline: getComputedStyle(textarea).outlineStyle,
      textareaResize: getComputedStyle(textarea).resize,
      composerBorder: getComputedStyle(composer).borderTopColor,
    };
  })()`);
  assert(
    composerFocusStyle.textareaOutline === 'none' &&
      composerFocusStyle.textareaResize === 'none' &&
      composerFocusStyle.composerBorder !== 'rgb(48, 56, 70)',
    'composer uses one subtle focus treatment without the textarea box or resize handle',
  );
  assert(
    await evaluate(`document.documentElement.scrollHeight <= document.documentElement.clientHeight &&
      document.body.scrollHeight <= document.body.clientHeight`),
    'longer conversations do not create an outer page scrollbar',
  );
  await pressKey('Tab', 'Tab', 9);
  const initialFocus = await evaluate(`({
    outline: getComputedStyle(document.activeElement).outlineStyle,
    width: getComputedStyle(document.activeElement).outlineWidth,
  })`);
  assert(initialFocus.outline === 'solid' && initialFocus.width === '2px', 'keyboard focus has a visible outline');

  const removedSections = await evaluate(`['Memory', 'Project workspace', 'Settings']
    .every(label => ![...document.querySelectorAll('.side-nav button')]
      .some(button => button.innerText.trim() === label))`);
  assert(removedSections, 'removed configuration and project sections are absent from navigation');
  await clickButton('History');
  await waitFor(() => evaluate('document.getElementById("history-panel") !== null'), 'opening History');
  assert(
    await evaluate('document.activeElement?.textContent.trim() === "History"'),
    'History opens with focus on its heading',
  );
  assert(
    await evaluate(`(() => {
      const trigger = [...document.querySelectorAll('button')].find(button => button.innerText.trim().endsWith('History'));
      return trigger?.getAttribute('aria-expanded') === 'true' &&
        trigger.getAttribute('aria-controls') === 'history-panel';
    })()`),
    'History trigger exposes expanded state and panel relationship',
  );
  await pressKey('Escape', 'Escape', 27);
  await waitFor(
    () => evaluate(`document.querySelector('button[aria-expanded="true"]') === null`),
    'closing History with Escape',
  );
  const historyRestoredFocus = await evaluate(`({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.innerText,
    expanded: document.activeElement?.getAttribute('aria-expanded'),
  })`);
  assert(
    historyRestoredFocus.text?.trim().endsWith('History') === true,
    `History Escape restores focus to its toolbar trigger: ${JSON.stringify(historyRestoredFocus)}`,
  );

  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const motion = await evaluate(`(() => {
    const element = document.createElement('div');
    element.style.cssText = 'animation-name:pulse;animation-duration:1s;transition-duration:2s;scroll-behavior:smooth';
    document.body.append(element);
    const style = getComputedStyle(element);
    const result = {
      prefers: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animation: style.animationDuration,
      iterations: style.animationIterationCount,
      transition: style.transitionDuration,
      scroll: style.scrollBehavior,
    };
    element.remove();
    return result;
  })()`);
  assert(
    motion.prefers &&
      motion.animation === '1e-05s' &&
      motion.iterations === '1' &&
      motion.transition === '1e-05s' &&
      motion.scroll === 'auto',
    'reduced-motion preference disables animation and smooth scrolling',
  );

  console.log('Desktop UI accessibility smoke checks: PASS');
  checks.forEach((check, index) => console.log(`${index + 1}. PASS ${check}`));
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      delay(7_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
