'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const DEFAULT_COMMAND_TIMEOUT_MS = 60000;
const FIREFOX_ENDPOINT_TIMEOUT_MS = 30000;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function attachChildProcessErrorGuard(child, label) {
  if (!child || typeof child.on !== 'function') {
    throw new Error(`${label} did not return an observable child process`);
  }
  let observedError = null;
  let resolveFailure = null;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const guard = Object.freeze({
    failure,
    get error() {
      return observedError;
    }
  });
  child.on('error', (cause) => {
    if (observedError) return;
    observedError = new Error(
      `${label} process error: ${cause && cause.message ? cause.message : String(cause)}`,
      { cause }
    );
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    resolveFailure(observedError);
  });
  return guard;
}

async function awaitWithChildProcessError(operation, guard) {
  if (guard.error) throw guard.error;
  const result = await Promise.race([
    typeof operation === 'function' ? Promise.resolve().then(operation) : Promise.resolve(operation),
    guard.failure.then((error) => { throw error; })
  ]);
  if (guard.error) throw guard.error;
  return result;
}

function firefoxChildIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

async function waitForFirefoxChildToStop(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (firefoxChildIsRunning(child) && Date.now() < deadline) await wait(25);
  return !firefoxChildIsRunning(child);
}

async function terminateFirefoxChild(child, gracefulWaitMs = 1000, forcedWaitMs = 5000) {
  if (!firefoxChildIsRunning(child)) return;
  if (!child.killed) child.kill('SIGTERM');
  if (await waitForFirefoxChildToStop(child, gracefulWaitMs)) return;
  child.kill('SIGKILL');
  if (await waitForFirefoxChildToStop(child, forcedWaitMs)) return;
  if (Number.isInteger(child.pid)) {
    throw new Error(`Installed Firefox process ${child.pid} did not terminate after SIGKILL`);
  }
}

async function cleanupFirefoxChild(child, profilePath, gracefulWaitMs = 1000) {
  const cleanupErrors = [];
  try {
    await terminateFirefoxChild(child, gracefulWaitMs);
  } catch (error) {
    cleanupErrors.push(error);
  }
  let profileCleanupError = null;
  for (let attempt = 0; attempt < 50 && fs.existsSync(profilePath); attempt += 1) {
    try {
      fs.rmSync(profilePath, { recursive: true, force: true });
      profileCleanupError = null;
    } catch (error) {
      profileCleanupError = error;
      await wait(100);
    }
  }
  if (profileCleanupError && fs.existsSync(profilePath)) {
    cleanupErrors.push(profileCleanupError);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Installed Firefox cleanup failed');
  }
}

function encodeLocalValue(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Infinity) return { type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { type: 'number', value: '-0' };
    return { type: 'number', value };
  }
  if (value instanceof RegExp) {
    return {
      type: 'regexp',
      value: { pattern: value.source, flags: value.flags }
    };
  }
  if (value instanceof Date) {
    return { type: 'date', value: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { type: 'array', value: value.map(encodeLocalValue) };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      value: Object.entries(value).map(([key, entry]) => [key, encodeLocalValue(entry)])
    };
  }
  throw new Error(`Unsupported WebDriver BiDi argument type: ${typeof value}`);
}

function decodeRemoteValue(remote) {
  if (!remote || typeof remote !== 'object') return undefined;
  switch (remote.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return remote.value;
    case 'number':
      if (remote.value === 'NaN') return Number.NaN;
      if (remote.value === 'Infinity') return Infinity;
      if (remote.value === '-Infinity') return -Infinity;
      if (remote.value === '-0') return -0;
      return Number(remote.value);
    case 'bigint':
      return BigInt(remote.value);
    case 'date':
      return new Date(remote.value);
    case 'regexp':
      return new RegExp(remote.value.pattern, remote.value.flags || '');
    case 'array':
    case 'set':
    case 'nodelist':
    case 'htmlcollection':
      return Array.isArray(remote.value) ? remote.value.map(decodeRemoteValue) : [];
    case 'object':
    case 'map': {
      const object = {};
      for (const pair of remote.value || []) {
        const rawKey = pair[0];
        const key = typeof rawKey === 'string' ? rawKey : String(decodeRemoteValue(rawKey));
        object[key] = decodeRemoteValue(pair[1]);
      }
      return object;
    }
    default:
      return remote.value;
  }
}

class BidiConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (data) => this.onMessage(data));
    socket.on('close', () => this.rejectAll(new Error('Firefox WebDriver BiDi socket closed')));
    socket.on('error', (error) => this.rejectAll(error));
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Number.isInteger(message.id) || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error' || message.error) {
      const error = new Error(
        `WebDriver BiDi ${pending.method} failed: ${message.error || 'unknown error'}: ${message.message || ''}`
      );
      error.bidiResponse = message;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result || {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  command(method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebDriver BiDi socket is not open for ${method}`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WebDriver BiDi ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

const LOCATOR_HELPERS = String.raw`
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (element) => String(
    element.getAttribute('aria-label') || element.getAttribute('title') ||
    element.value || element.textContent || ''
  ).trim();
  const roleMatches = (element, role) => {
    const explicit = String(element.getAttribute('role') || '').toLowerCase();
    if (explicit === role) return true;
    const tag = element.tagName.toLowerCase();
    if (role === 'button') return tag === 'button' ||
      (tag === 'input' && ['button', 'submit', 'reset'].includes(String(element.type).toLowerCase()));
    return false;
  };
  const resolve = (spec) => {
    let roots = [document];
    for (const step of spec.steps) {
      const next = [];
      if (step.kind === 'css') {
        const requireVisible = /:visible\b/.test(step.selector) || step.visible === true;
        const selector = step.selector.replace(/:visible\b/g, '');
        for (const root of roots) {
          for (const element of root.querySelectorAll(selector)) {
            if (!requireVisible || visible(element)) next.push(element);
          }
        }
      } else if (step.kind === 'role') {
        const matcher = step.name
          ? new RegExp(step.name.pattern, step.name.flags || '')
          : null;
        for (const root of roots) {
          for (const element of root.querySelectorAll('*')) {
            if (!roleMatches(element, step.role)) continue;
            if (matcher && !matcher.test(accessibleName(element))) continue;
            if (step.visible && !visible(element)) continue;
            next.push(element);
          }
        }
      }
      roots = next;
    }
    if (spec.visible) roots = roots.filter(visible);
    if (Number.isInteger(spec.index)) {
      return roots[spec.index] ? [roots[spec.index]] : [];
    }
    return roots;
  };
`;

function locatorFunction(functionBody) {
  return `function(spec, argument) {\n${LOCATOR_HELPERS}\n${functionBody}\n}`;
}

class BidiLocator {
  constructor(page, spec) {
    this.page = page;
    this.spec = spec;
  }

  locator(selector) {
    return new BidiLocator(this.page, {
      ...this.spec,
      steps: [...this.spec.steps, { kind: 'css', selector: String(selector) }]
    });
  }

  getByRole(role, options = {}) {
    const name = options.name instanceof RegExp
      ? { pattern: options.name.source, flags: options.name.flags }
      : options.name
        ? { pattern: `^${String(options.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, flags: 'i' }
        : null;
    return new BidiLocator(this.page, {
      ...this.spec,
      steps: [...this.spec.steps, {
        kind: 'role',
        role: String(role).toLowerCase(),
        name,
        visible: false
      }]
    });
  }

  filter(options = {}) {
    return new BidiLocator(this.page, {
      ...this.spec,
      visible: options.visible === true || this.spec.visible === true
    });
  }

  first() {
    return new BidiLocator(this.page, { ...this.spec, index: 0 });
  }

  async count() {
    return this.page.callFunction(
      locatorFunction('return resolve(spec).length;'),
      [this.spec, null]
    );
  }

  async evaluate(fn, argument) {
    const body = [
      'const elements = resolve(spec);',
      'if (elements.length !== 1) throw new Error(`Expected one element, found ${elements.length}`);',
      `const callback = (${fn.toString()});`,
      'return callback(elements[0], argument);'
    ].join('\n');
    return this.page.callFunction(locatorFunction(body), [this.spec, argument]);
  }

  async evaluateAll(fn, argument) {
    const body = [
      'const elements = resolve(spec);',
      `const callback = (${fn.toString()});`,
      'return callback(elements, argument);'
    ].join('\n');
    return this.page.callFunction(locatorFunction(body), [this.spec, argument]);
  }

  async scrollIntoViewIfNeeded() {
    return this.page.callFunction(
      locatorFunction([
        'const elements = resolve(spec);',
        'if (elements.length !== 1) throw new Error(`Expected one element, found ${elements.length}`);',
        "elements[0].scrollIntoView({ block: 'center', inline: 'center' });",
        'return true;'
      ].join('\n')),
      [this.spec, null]
    );
  }

  async click(options = {}) {
    await this.scrollIntoViewIfNeeded();
    const point = await this.page.callFunction(
      locatorFunction([
        'const elements = resolve(spec);',
        'if (elements.length !== 1) throw new Error(`Expected one element, found ${elements.length}`);',
        'const rect = elements[0].getBoundingClientRect();',
        'return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) };'
      ].join('\n')),
      [this.spec, null]
    );
    await this.page.connection.command('input.performActions', {
      context: this.page.contextId,
      actions: [{
        type: 'pointer',
        id: 'installed-firefox-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 }
        ]
      }]
    }, options.timeout || DEFAULT_COMMAND_TIMEOUT_MS);
    await this.page.connection.command('input.releaseActions', {
      context: this.page.contextId
    }).catch(() => {});
  }

  async fill(value) {
    return this.evaluate((element, nextValue) => {
      element.focus();
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(element), 'value'
      );
      if (descriptor && descriptor.set) descriptor.set.call(element, String(nextValue));
      else element.value = String(nextValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value;
    }, String(value));
  }

  async inputValue() {
    return this.evaluate((element) => String(element.value));
  }

  async selectOption(value) {
    return this.evaluate((element, nextValue) => {
      element.value = String(nextValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return Array.from(element.selectedOptions || []).map((option) => option.value);
    }, String(value));
  }

  async press(key) {
    const value = key === 'Tab' ? '\uE004' : String(key);
    await this.page.connection.command('input.performActions', {
      context: this.page.contextId,
      actions: [{
        type: 'key',
        id: 'installed-firefox-keyboard',
        actions: [
          { type: 'keyDown', value },
          { type: 'keyUp', value }
        ]
      }]
    });
    await this.page.connection.command('input.releaseActions', {
      context: this.page.contextId
    }).catch(() => {});
  }

  async waitFor(options = {}) {
    const state = options.state || 'visible';
    const timeout = options.timeout || DEFAULT_COMMAND_TIMEOUT_MS;
    const started = Date.now();
    for (;;) {
      const observation = await this.page.callFunction(
        locatorFunction([
          'const elements = resolve(spec);',
          'return { count: elements.length, visibleCount: elements.filter(visible).length };'
        ].join('\n')),
        [this.spec, null]
      );
      const ready = (state === 'visible' && observation.visibleCount > 0) ||
        (state === 'attached' && observation.count > 0) ||
        ((state === 'hidden' || state === 'detached') && observation.count === 0);
      if (ready) return;
      if (Date.now() - started >= timeout) {
        throw new Error(`Locator did not reach state ${state} in ${timeout} ms`);
      }
      await wait(50);
    }
  }
}

class BidiPage {
  constructor(connection, contextId) {
    this.connection = connection;
    this.contextId = contextId;
  }

  async callFunction(fn, args = [], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const result = await this.connection.command('script.callFunction', {
      functionDeclaration: typeof fn === 'function' ? fn.toString() : String(fn),
      awaitPromise: true,
      target: { context: this.contextId },
      arguments: args.map(encodeLocalValue),
      resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 12, maxDomDepth: 0 }
    }, timeoutMs);
    if (result.type === 'exception') {
      throw new Error(`Firefox page script failed: ${result.exceptionDetails?.text || 'unknown exception'}`);
    }
    if (result.type !== 'success') {
      throw new Error(`Unexpected Firefox page script result: ${JSON.stringify(result)}`);
    }
    return decodeRemoteValue(result.result);
  }

  evaluate(fn, argument) {
    const args = arguments.length >= 2 ? [argument] : [];
    return this.callFunction(fn, args);
  }

  async waitForTimeout(milliseconds) {
    await wait(milliseconds);
  }

  async goto(url, options = {}) {
    const waitState = options.waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    return this.connection.command('browsingContext.navigate', {
      context: this.contextId,
      url: String(url),
      wait: waitState
    }, options.timeout || DEFAULT_COMMAND_TIMEOUT_MS);
  }

  locator(selector) {
    return new BidiLocator(this, {
      steps: [{ kind: 'css', selector: String(selector) }],
      index: null,
      visible: false
    });
  }

  async screenshot(options = {}) {
    const dimensions = await this.callFunction(() => ({
      documentElementWidth: document.documentElement
        ? document.documentElement.scrollWidth
        : 0,
      documentElementHeight: document.documentElement
        ? document.documentElement.scrollHeight
        : 0,
      documentWidth: Math.max(
        document.documentElement ? document.documentElement.scrollWidth : 0,
        document.body ? document.body.scrollWidth : 0
      ),
      documentHeight: Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      ),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
    const documentOriginUsable = options.fullPage &&
      dimensions.documentElementWidth > 0 && dimensions.documentElementHeight > 0;
    const origin = documentOriginUsable ? 'document' : 'viewport';
    this.lastScreenshotEvidence = {
      requestedFullPage: options.fullPage === true,
      capturedOrigin: origin,
      fallbackReason: options.fullPage && !documentOriginUsable
        ? 'document-has-no-positive-capture-area'
        : '',
      dimensions
    };
    const result = await this.connection.command('browsingContext.captureScreenshot', {
      context: this.contextId,
      origin,
      format: { type: 'png' }
    });
    if (!options.path) return Buffer.from(result.data, 'base64');
    fs.writeFileSync(options.path, Buffer.from(result.data, 'base64'));
    return undefined;
  }
}

class BidiBrowserContext {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.options = options;
    this.openPages = [];
  }

  async grantPermissions() {
    throw new Error(
      'Installed Firefox permissions must be established by the isolated profile; silent grant fallback is forbidden'
    );
  }

  async newPage() {
    const result = await this.connection.command('browsingContext.create', { type: 'tab' });
    if (this.options.viewport) {
      await this.connection.command('browsingContext.setViewport', {
        context: result.context,
        viewport: {
          width: Number(this.options.viewport.width),
          height: Number(this.options.viewport.height)
        }
      });
    }
    const page = new BidiPage(this.connection, result.context);
    this.openPages.push(page);
    return page;
  }

  pages() {
    return [...this.openPages];
  }

  async close() {
    for (const page of this.openPages.splice(0)) {
      await this.connection.command('browsingContext.close', {
        context: page.contextId,
        promptUnload: false
      }).catch(() => {});
    }
  }
}

class InstalledFirefoxBrowser {
  constructor({
    connection,
    child,
    profilePath,
    executablePath,
    executableSha256,
    capabilities,
    workflowErrorGuard
  }) {
    this.connection = connection;
    this.child = child;
    this.profilePath = profilePath;
    this.executablePath = executablePath;
    this.executableSha256 = executableSha256;
    this.capabilities = capabilities;
    this.workflowErrorGuard = workflowErrorGuard;
    this.contexts = [];
    this.closed = false;
    this.automation = 'webdriver-bidi';
  }

  version() {
    return String(this.capabilities.browserVersion || '');
  }

  async newContext(options = {}) {
    const context = new BidiBrowserContext(this.connection, options);
    this.contexts.push(context);
    return context;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const context of this.contexts.splice(0)) {
      await awaitWithChildProcessError(
        () => context.close(),
        this.workflowErrorGuard
      ).catch(() => {});
    }
    if (!this.workflowErrorGuard.error) {
      await awaitWithChildProcessError(
        () => this.connection.command('browser.close', {}),
        this.workflowErrorGuard
      ).catch(() => {});
    }
    this.connection.close();
    await cleanupFirefoxChild(this.child, this.profilePath);
  }
}

function installedFirefoxPath(explicitPath = '') {
  const requireFirefoxFile = (candidate, source) => {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`${source} Firefox executable was not found: ${resolved}`);
    }
    return fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  };
  if (explicitPath) {
    return requireFirefoxFile(explicitPath, 'Explicit');
  }
  if (process.env.GAME_CAPTURE_FIREFOX_PATH) {
    return requireFirefoxFile(
      process.env.GAME_CAPTURE_FIREFOX_PATH,
      'GAME_CAPTURE_FIREFOX_PATH'
    );
  }
  if (process.env.ProgramFiles) {
    return requireFirefoxFile(
      path.join(process.env.ProgramFiles, 'Mozilla Firefox', 'firefox.exe'),
      'Default installed'
    );
  }
  throw new Error(
    'Installed Firefox was not found; pass --firefox-path or GAME_CAPTURE_FIREFOX_PATH'
  );
}

function writeIsolatedFirefoxProfile(profilePath) {
  const preferences = [
    ['browser.shell.checkDefaultBrowser', false],
    ['datareporting.policy.dataSubmissionEnabled', false],
    ['media.autoplay.blocking_policy', 0],
    ['media.autoplay.default', 0],
    ['media.navigator.permission.disabled', true],
    ['media.navigator.streams.fake', true],
    ['media.peerconnection.ice.obfuscate_host_addresses', false],
    ['toolkit.telemetry.enabled', false]
  ];
  const source = preferences
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(profilePath, 'user.js'), source, 'utf8');
}

function waitForBidiEndpoint(child, workflowErrorGuard) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error, endpoint = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
      child.off('exit', onExit);
      // Keep both pipes draining for long packaged workflows. Leaving them
      // paused after endpoint discovery can eventually block Firefox on a
      // full inherited pipe buffer.
      child.stdout.resume();
      child.stderr.resume();
      if (error) reject(error);
      else resolve(endpoint);
    };
    const inspect = (chunk) => {
      output += String(chunk);
      const match = output.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/i);
      if (match) finish(null, match[1]);
      if (output.length > 128 * 1024) output = output.slice(-64 * 1024);
    };
    const onExit = (code) => finish(new Error(
      `Installed Firefox exited before WebDriver BiDi became ready (exit ${code})`
    ));
    const timer = setTimeout(() => finish(new Error(
      `Installed Firefox did not expose WebDriver BiDi in ${FIREFOX_ENDPOINT_TIMEOUT_MS} ms`
    )), FIREFOX_ENDPOINT_TIMEOUT_MS);
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('exit', onExit);
    workflowErrorGuard.failure.then((error) => finish(error));
  });
}

async function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, 10000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function launchInstalledFirefox(options = {}) {
  const executablePath = installedFirefoxPath(options.executablePath || '');
  const expectedSha256 = String(options.expectedSha256 || '').trim().toLowerCase();
  if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Expected installed Firefox SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const executableSha256BeforeLaunch = sha256File(executablePath);
  if (expectedSha256 && executableSha256BeforeLaunch !== expectedSha256) {
    throw new Error(
      `Installed Firefox SHA-256 mismatch: expected ${expectedSha256}, ` +
      `observed ${executableSha256BeforeLaunch}`
    );
  }
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'game-capture-firefox-bidi-'));
  writeIsolatedFirefoxProfile(profilePath);
  const firefoxArgs = [
    '-no-remote',
    '-profile', profilePath,
    '--remote-debugging-port', '0',
    'about:blank'
  ];
  if (options.headless !== false) firefoxArgs.unshift('-headless');
  const child = spawn(executablePath, firefoxArgs, {
    cwd: path.dirname(executablePath),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const workflowErrorGuard = attachChildProcessErrorGuard(child, 'Installed Firefox');
  try {
    const endpoint = await waitForBidiEndpoint(child, workflowErrorGuard);
    const socket = await awaitWithChildProcessError(
      () => connectWebSocket(`${endpoint}/session`),
      workflowErrorGuard
    );
    const connection = new BidiConnection(socket);
    const session = await awaitWithChildProcessError(
      () => connection.command('session.new', {
        capabilities: {
          alwaysMatch: {
            browserName: 'firefox',
            acceptInsecureCerts: true
          }
        }
      }),
      workflowErrorGuard
    );
    if (String(session.capabilities?.browserName || '').toLowerCase() !== 'firefox') {
      throw new Error(`Unexpected BiDi browser: ${session.capabilities?.browserName || 'missing'}`);
    }
    const executableSha256AfterConnect = sha256File(executablePath);
    if (executableSha256AfterConnect !== executableSha256BeforeLaunch ||
        (expectedSha256 && executableSha256AfterConnect !== expectedSha256)) {
      throw new Error(
        'Installed Firefox executable identity changed between validation and BiDi connection'
      );
    }
    return new InstalledFirefoxBrowser({
      connection,
      child,
      profilePath,
      executablePath,
      executableSha256: executableSha256AfterConnect,
      capabilities: session.capabilities || {},
      workflowErrorGuard
    });
  } catch (error) {
    try {
      await cleanupFirefoxChild(child, profilePath, 500);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

module.exports = {
  launchInstalledFirefox,
  installedFirefoxPath,
  sha256File
};
