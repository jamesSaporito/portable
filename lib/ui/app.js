// The environment page. Talks to the host agent's /api with the token from the page's URL.
// Everything from the API is put on the page as text, never as HTML.

// The token comes in the URL `portable ui` prints. It's remembered in this browser (per port), and
// taken out of the address bar so it doesn't end up in history; a bookmark of the page then works.
const params = new URLSearchParams(location.search);
const storageKey = `portable-token-${location.port}`;
let remembered = null;
try { remembered = localStorage.getItem(storageKey); } catch { /* storage off */ }
const token = params.get('t') ?? remembered ?? '';
if (params.has('t')) {
  try { localStorage.setItem(storageKey, token); } catch { /* storage off */ }
  history.replaceState(null, '', location.pathname);
}

const $ = (selector) => document.querySelector(selector);
let status = null;
let logSource = null;
// The page refreshes every few seconds; fields with unsaved edits are left alone until they're
// saved, so the refresh never overwrites what's being typed.
let settingsDirty = false;
let portsDirty = false;
let portsShown = '';

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'x-portable-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status}`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function banner(message, ok = false) {
  const node = $('#banner');
  node.hidden = !message;
  node.textContent = message ?? '';
  node.classList.toggle('ok', ok);
}

function report(problems, success) {
  if (problems?.length) banner(problems.join('\n'));
  else banner(success, true);
}

// Disables a button while its action runs and shows errors in the banner.
async function busy(button, action) {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    banner(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

// --- status, ports, settings -------------------------------------------------------------------------

async function loadStatus() {
  status = await api('GET', '/api/status');
  document.title = `${status.id} · portable`;
  $('#title').textContent = status.id;
  $('#folder').textContent = status.path;
  const pill = $('#status');
  pill.textContent = status.status;
  pill.className = `pill ${status.status}`;
  renderPorts();
  renderBlocked();
  renderSettings();
  renderEvents();
}

let blockedShown = '';
function renderBlocked() {
  const shown = JSON.stringify(status.blocked);
  if (shown === blockedShown) return;
  blockedShown = shown;
  $('#blocked').hidden = !status.blocked.length;
  $('#blocked-list').replaceChildren(...status.blocked.map((request) => {
    const answer = (action, label) => {
      const button = el('button', { type: 'button', class: action === 'allow' ? 'small primary' : 'small' }, label);
      button.addEventListener('click', () => busy(button, async () => {
        const result = await api('POST', '/api/blocked', { id: request.id, action });
        report(result.problems, action === 'allow' ? `${request.host} is allowed for this environment.` : `Dismissed ${request.host}.`);
        // With unsaved edits the form isn't refreshed, so add the host to it too; saving the form
        // would otherwise drop it again.
        if (action === 'allow' && settingsDirty) {
          const field = $('#settings-form').allowDomains;
          if (!field.value.split(/[\s,]+/).includes(request.host)) field.value = `${field.value.trim()}\n${request.host}`.trim();
        }
        await loadStatus();
      }));
      return button;
    };
    return el('li', { class: 'blocked-row' },
      el('code', {}, request.host),
      el('span', { class: 'muted' }, ` ${new Date(request.at).toLocaleTimeString()} `),
      answer('allow', 'Allow'), ' ', answer('dismiss', 'Dismiss'));
  }));
}

function renderPorts() {
  const body = $('#ports-body');
  const shown = JSON.stringify([status.forwards, status.sticky]);
  if (portsDirty || shown === portsShown) return;
  portsShown = shown;
  const rows = new Map(status.forwards.map((f) => [f.sandbox, { ...f, live: true }]));
  for (const [sandbox, host] of Object.entries(status.sticky ?? {})) {
    if (!rows.has(Number(sandbox))) rows.set(Number(sandbox), { sandbox: Number(sandbox), host, live: false });
  }
  const sorted = [...rows.values()].sort((a, b) => a.sandbox - b.sandbox);
  body.replaceChildren();
  if (!sorted.length) {
    body.append(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Nothing published yet. Start a service below or run docker in the sandbox.')));
    return;
  }
  for (const row of sorted) {
    const input = el('input', { type: 'number', min: 1024, max: 65535, value: status.sticky?.[row.sandbox] ?? row.host, 'aria-label': `Host port for ${row.sandbox}` });
    const save = el('button', { type: 'button', class: 'small' }, 'Set');
    input.addEventListener('input', () => { portsDirty = true; });
    save.addEventListener('click', () => busy(save, async () => {
      try {
        await api('PUT', '/api/ports', { sandboxPort: row.sandbox, hostPort: Number(input.value) });
        banner(`Port ${row.sandbox} now sticks to ${input.value}.`, true);
      } finally {
        portsDirty = false;
        portsShown = '';
        await loadStatus();
      }
    }));
    const forget = el('button', { type: 'button', class: 'small' }, 'Forget');
    forget.title = 'Drop the saved host port; the next forward picks a free one';
    forget.addEventListener('click', () => busy(forget, async () => {
      await api('PUT', '/api/ports', { sandboxPort: row.sandbox, hostPort: null });
      portsDirty = false;
      portsShown = '';
      await loadStatus();
    }));
    const link = row.live
      ? el('a', { href: `http://localhost:${row.host}`, target: '_blank', rel: 'noreferrer' }, `localhost:${row.host}`)
      : el('span', { class: 'muted' }, 'not published now');
    body.append(el('tr', {}, el('td', {}, row.sandbox), el('td', {}, input, ' ', save), el('td', {}, link), el('td', {}, forget)));
  }
}

function renderSettings() {
  const form = $('#settings-form');
  const { overrides, settings, global } = status;
  form.querySelector('button[type=submit]').textContent = settingsDirty ? 'Save changes' : 'Save';
  if (settingsDirty) return;
  form.allowDomains.value = (overrides.allowDomains ?? []).join('\n');
  $('#global-domains').textContent = global.allowDomains.length
    ? `Plus the kit's list and, for every environment: ${global.allowDomains.join(', ')}`
    : "Plus the kit's list (GitHub, npm, Terraform, Docker Hub, AWS, ...).";
  form.cpus.value = settings.cpus;
  form.memory.value = settings.memory;
  const recreate = $('#recreate');
  recreate.hidden = !status.recreateNeeded.length;
  recreate.textContent = status.recreateNeeded.length
    ? `CPUs and memory are fixed when a sandbox is created (now ${status.createdWith.cpus} CPUs, ${status.createdWith.memory}). To apply, run: portable rm ${status.id}, then portable in ${status.path}. That deletes the sandbox's Docker data and Claude history.`
    : '';
}

function renderEvents() {
  $('#events').replaceChildren(...status.events.slice().reverse().map((e) => el('li', {}, `${new Date(e.at).toLocaleTimeString()}  ${e.message}`)));
}

$('#settings-form').addEventListener('input', () => {
  settingsDirty = true;
  $('#settings-form button[type=submit]').textContent = 'Save changes';
});

$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const lines = form.allowDomains.value.split(/[\s,]+/).filter(Boolean);
  const overrides = {
    allowDomains: lines.length ? lines : null,
    cpus: Number(form.cpus.value) === status.global.cpus ? null : Number(form.cpus.value),
    memory: form.memory.value.trim().toLowerCase() === status.global.memory ? null : form.memory.value.trim(),
  };
  busy(form.querySelector('button[type=submit]'), async () => {
    const result = await api('PUT', '/api/settings', { overrides });
    settingsDirty = false;
    report(result.problems, 'Saved.');
    await loadStatus();
  });
});

// --- services ----------------------------------------------------------------------------------------

async function loadServices() {
  const body = $('#services-body');
  let data;
  try {
    data = await api('GET', '/api/services');
  } catch (error) {
    body.replaceChildren(el('p', { class: 'bad' }, error.message));
    return;
  }
  const blocks = data.projects.map((project) => {
    const rel = project.file.startsWith(`${status.path}/`) ? project.file.slice(status.path.length + 1) : project.file;
    const buttons = ['up', 'restart', 'down'].map((action) => {
      const button = el('button', { type: 'button', class: 'small' }, action === 'up' ? 'Start' : action === 'down' ? 'Stop' : 'Restart');
      button.addEventListener('click', () => busy(button, async () => {
        banner(`Running docker compose ${action} for ${rel}…`, true);
        const result = await api('POST', '/api/services', { file: project.file, action });
        if (result.ok) banner(`docker compose ${action} finished for ${rel}.`, true);
        else banner(`docker compose ${action} failed:\n${result.output.split('\n').slice(-15).join('\n')}`);
        await Promise.all([loadServices(), loadStatus()]);
      }));
      return button;
    });
    const logs = el('button', { type: 'button', class: 'small' }, 'Logs');
    logs.addEventListener('click', () => openLogs(project.file, null, rel));
    const containers = project.containers.map((c) => {
      const serviceLogs = el('button', { type: 'button', class: 'small' }, 'Logs');
      serviceLogs.addEventListener('click', () => openLogs(project.file, c.service, `${rel} · ${c.service}`));
      return el('li', {}, el('span', {}, el('strong', {}, c.service ?? c.name), ' ', el('span', { class: `state-${c.state}` }, c.status)), el('span', { class: 'muted mono' }, c.ports || ''), serviceLogs);
    });
    return el('div', { class: 'project' },
      el('div', { class: 'project-head' }, el('code', {}, rel), el('div', { class: 'buttons' }, buttons, logs)),
      containers.length ? el('ul', { class: 'containers' }, containers) : el('p', { class: 'muted' }, 'Not started.'));
  });
  if (data.other.length) {
    blocks.push(el('div', { class: 'project' },
      el('div', { class: 'project-head' }, el('strong', {}, 'Other containers')),
      el('ul', { class: 'containers' }, data.other.map((c) => el('li', {}, el('span', {}, el('strong', {}, c.name), ' ', el('span', { class: `state-${c.state}` }, c.status)), el('span', { class: 'muted mono' }, c.image))))));
  }
  body.replaceChildren(...(blocks.length ? blocks : [el('p', { class: 'muted' }, 'No compose files in this folder or the two levels below it.')]));
}

function openLogs(file, service, title) {
  logSource?.close();
  const pre = $('#logs-body');
  pre.textContent = '';
  $('#logs').hidden = false;
  $('#logs-title').textContent = `Logs: ${title}`;
  const query = new URLSearchParams({ file, t: token });
  if (service) query.set('service', service);
  logSource = new EventSource(`/api/logs?${query}`);
  logSource.onmessage = (event) => {
    const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent += `${event.data}\n`;
    if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
    if (stick) pre.scrollTop = pre.scrollHeight;
  };
  logSource.addEventListener('end', () => logSource.close());
}

// --- AWS -----------------------------------------------------------------------------------------------

async function loadAws() {
  const body = $('#aws-body');
  let aws;
  try {
    aws = await api('GET', '/api/aws');
  } catch (error) {
    body.replaceChildren(el('p', { class: 'bad' }, error.message));
    return;
  }
  const setProfile = async (profile, done) => {
    const result = await api('PUT', '/api/settings', { overrides: { awsProfile: profile } });
    report(result.problems, done);
    await Promise.all([loadAws(), loadStatus()]);
  };
  if (!aws.cliInstalled) {
    body.replaceChildren(el('p', {}, el('span', { class: 'muted' }, 'The aws CLI isn\'t installed on this computer; install it to use AWS here: '), el('code', {}, 'brew install awscli')));
    return;
  }
  if (!aws.enabled) {
    if (!aws.profiles.length) {
      body.replaceChildren(el('p', { class: 'muted' }, 'Off. No AWS profiles are set up on this computer (aws configure sso).'));
      return;
    }
    const select = el('select', { 'aria-label': 'AWS profile' }, aws.profiles.map((p) => el('option', { value: p }, p)));
    const enable = el('button', { type: 'button', class: 'primary' }, 'Turn on');
    enable.addEventListener('click', () => busy(enable, () => setProfile(select.value, `AWS is on with profile ${select.value}.`)));
    body.replaceChildren(
      el('p', {}, 'Profile: ', select, ' ', enable),
      el('p', { class: 'aws-state off' }, 'Off'),
    );
    return;
  }
  const login = el('button', { type: 'button', class: 'primary' }, aws.signedIn ? 'Sign in again' : 'Sign in');
  login.addEventListener('click', () => busy(login, async () => {
    banner(`Signing in to ${aws.profile}; finish it in the browser window that opens...`, true);
    report((await api('POST', '/api/aws/login')).problems, `Signed in to ${aws.profile}; credentials are in the sandbox for new sessions.`);
    await loadAws();
  }));
  const refresh = el('button', { type: 'button' }, 'Refresh credentials');
  refresh.addEventListener('click', () => busy(refresh, async () => {
    report((await api('POST', '/api/aws/refresh')).problems, 'AWS credentials refreshed for new sessions.');
    await loadAws();
  }));
  const off = el('button', { type: 'button' }, 'Turn off');
  off.addEventListener('click', () => busy(off, () => setProfile(null, 'AWS is off; the sandbox\'s credentials were cleared.')));
  const detail = !aws.profileExists
    ? `profile '${aws.profile}' isn't on this computer anymore`
    : aws.signedIn
      ? `signed in${aws.expiresAt ? `, until ${new Date(aws.expiresAt).toLocaleTimeString()}` : ''}`
      : 'signed out';
  body.replaceChildren(
    el('p', {}, `Profile: ${aws.profile}`),
    el('div', { class: 'actions' }, aws.profileExists ? login : null, aws.signedIn ? refresh : null, off),
    el('p', { class: 'aws-state on' }, `On — ${detail}`),
  );
}

// --- Claude configuration and secrets ---------------------------------------------------------------

async function loadClaude() {
  let info;
  try {
    info = await api('GET', '/api/claude');
  } catch (error) {
    $('#claude-repo').textContent = error.message;
    return;
  }
  $('#claude-repo').textContent = info.installed
    ? `${info.repo} at ${info.commit.hash} — ${info.commit.subject} (${info.commit.when})`
    : info.repo ? `${info.repo} isn't installed in the sandbox yet (see Activity, or run portable doctor).` : 'No configuration repo set (claudeConfigRepo in config.json).';
  const disabled = new Set(status.settings.claudeConfigDisable);
  const toggle = (name) => {
    const box = el('input', { type: 'checkbox', checked: !disabled.has(name) });
    box.addEventListener('change', () => busy(box, async () => {
      const next = new Set(status.settings.claudeConfigDisable);
      if (box.checked) next.delete(name); else next.add(name);
      const result = await api('PUT', '/api/settings', { overrides: { claudeConfigDisable: [...next] } });
      report(result.problems, `${name} is ${box.checked ? 'on' : 'off'} for new Claude sessions.`);
      await loadStatus();
    }));
    return el('li', {}, el('label', {}, box, name));
  };
  $('#skills').replaceChildren(...info.skills.map(toggle));
  $('#rules').replaceChildren(...info.rules.map(toggle));
}

async function loadSecrets() {
  let data;
  try {
    data = await api('GET', '/api/secrets');
  } catch (error) {
    $('#secrets-note').textContent = error.message;
    return;
  }
  $('#secrets-note').textContent = `Stored in the ${data.backend}; sbx puts them on requests, so the sandbox only sees placeholders. Values are never shown here.`;
  const items = data.secrets.map((s) => {
    const ok = s.stored && s.registered;
    const hint = ok ? 'ready' : !s.stored ? `not stored (optional) — run: portable configure` : `stored but sbx isn't reading it — run: portable configure`;
    return el('li', {}, el('span', { class: ok ? 'ok' : 'muted' }, ok ? '●' : '○'), ` ${s.label} (${s.name}): ${hint}`);
  });
  items.push(el('li', {}, el('span', { class: data.claudeSignedIn ? 'ok' : 'bad' }, data.claudeSignedIn ? '●' : '○'),
    data.claudeSignedIn ? ' Claude: signed in' : ' Claude: not signed in — run portable claude and type /login'));
  $('#secrets').replaceChildren(...items);
}

// --- buttons -------------------------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const actions = {
    sync: async () => { await api('POST', '/api/ports/sync'); await loadStatus(); },
    services: loadServices,
    'close-logs': async () => { logSource?.close(); $('#logs').hidden = true; },
    'claude-update': async () => {
      report((await api('POST', '/api/claude/update')).problems, 'Claude configuration updated for new sessions.');
      await loadClaude();
    },
  };
  busy(button, actions[button.dataset.action]);
});

async function start() {
  if (!token) {
    banner('This page needs its token. Open the URL that `portable ui` prints.');
    return;
  }
  try {
    await loadStatus();
  } catch (error) {
    banner(error.message);
    return;
  }
  loadServices();
  loadAws();
  loadClaude();
  loadSecrets();
  setInterval(() => loadStatus().catch((error) => banner(`Lost the agent: ${error.message}. It stops with the sandbox; run portable in ${status?.path ?? 'the folder'} to start it again.`)), 5000);
}

start();
