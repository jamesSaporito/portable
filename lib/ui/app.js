// The environment page. Talks to the host agent's /api with the token from the page's URL.
// Everything from the API is put on the page as text, never as HTML.
import { covers, parseRequest, splitHost } from '/hosts.mjs';

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
let hostsDirty = false;
let repoDirty = false;
let portsDirty = false;
let portsShown = '';
let switching = ''; // 'on' or 'off' while the offline switch runs

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
  renderNetwork();
  renderOffline();
  renderHosts();
  renderSettings();
  renderEvents();
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
  const { settings } = status;
  form.querySelector('button[type=submit]').textContent = settingsDirty ? 'Save changes' : 'Save';
  if (settingsDirty) return;
  form.cpus.value = settings.cpus;
  form.memory.value = settings.memory;
  const recreate = $('#recreate');
  recreate.hidden = !status.recreateNeeded.length;
  recreate.textContent = status.recreateNeeded.length
    ? `CPUs and memory are fixed when a sandbox is created (now ${status.createdWith.cpus} CPUs, ${status.createdWith.memory}). To apply, run: portable rm ${status.id}, then portable in ${status.path}. That deletes the sandbox's Docker data and Claude history.`
    : '';
}

// This environment's extra allowed hosts, at the top of Network.
function renderHosts() {
  const form = $('#hosts-form');
  const { overrides, global } = status;
  form.querySelector('button[type=submit]').textContent = hostsDirty ? 'Save changes' : 'Save';
  if (hostsDirty) return;
  form.allowDomains.value = (overrides.allowDomains ?? []).join('\n');
  $('#global-domains').textContent = global.allowDomains.length
    ? `Plus, for every environment: ${global.allowDomains.join(', ')}. The list below has every host the sandbox can reach.`
    : 'The list below has every host the sandbox can reach, these included.';
}

function renderEvents() {
  $('#events').replaceChildren(...status.events.slice().reverse().map((e) => el('li', {}, `${new Date(e.at).toLocaleTimeString()}  ${e.message}`)));
}

$('#claude-repo-form').addEventListener('input', () => {
  repoDirty = true;
});

$('#claude-repo-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  busy(form.querySelector('button[type=submit]'), async () => {
    const repo = form.repo.value.trim();
    const result = await api('PUT', '/api/claude/repo', { repo });
    repoDirty = false;
    report(result.problems, repo ? `Saved. This sandbox now uses ${repo}; new Claude sessions pick it up.` : 'Removed the configuration repo.');
    await loadClaude();
  });
});

$('#settings-form').addEventListener('input', () => {
  settingsDirty = true;
  $('#settings-form button[type=submit]').textContent = 'Save changes';
});

$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const overrides = {
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

$('#hosts-form').addEventListener('input', () => {
  hostsDirty = true;
  $('#hosts-form button[type=submit]').textContent = 'Save changes';
});

$('#hosts-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const lines = form.allowDomains.value.split(/[\s,]+/).filter(Boolean);
  busy(form.querySelector('button[type=submit]'), async () => {
    const result = await api('PUT', '/api/settings', { overrides: { allowDomains: lines.length ? lines : null } });
    hostsDirty = false;
    report(result.problems, 'Saved. The hosts apply right away.');
    await Promise.all([loadStatus(), loadNetwork()]);
  });
});

// --- network -----------------------------------------------------------------------------------------

// Where an allowed host's rule came from, as the grid says it, in the order the grid lists them.
const NETWORK_SOURCES = {
  environment: 'This environment',
  global: 'Every sandbox (sbx policy allow network)',
  kit: 'Kit (portable and the Claude agent)',
  sbx: "sbx's defaults",
};
// Allowed hosts are asked of sbx at load and on Refresh; blocked ones come with every status poll.
let networkGroups = null;
let networkError = '';
let networkShown = '';

async function loadNetwork() {
  try {
    networkGroups = (await api('GET', '/api/network')).groups;
    networkError = '';
  } catch (error) {
    networkError = error.message;
  }
  networkShown = '';
  renderNetwork();
}

function answerBlocked(request, action, label) {
  const button = el('button', { type: 'button', class: action === 'allow' ? 'small primary' : 'small' }, label);
  button.addEventListener('click', () => busy(button, async () => {
    const result = await api('POST', '/api/blocked', { id: request.id, action });
    report(result.problems, action === 'allow' ? `${request.host} is allowed for this environment.` : `Dismissed ${request.host}.`);
    // With unsaved edits the form isn't refreshed, so add the host to it too; saving the form
    // would otherwise drop it again.
    if (action === 'allow' && hostsDirty) {
      const field = $('#hosts-form').allowDomains;
      if (!field.value.split(/[\s,]+/).includes(request.host)) field.value = `${field.value.trim()}\n${request.host}`.trim();
    }
    await Promise.all([loadStatus(), action === 'allow' && loadNetwork()]);
  }));
  return button;
}

// One row per rule: blocked hosts first (with Allow and Dismiss), then allowed rules, this
// environment's and the kit's before sbx's ~200 defaults, then the catch-all that refuses the rest.
// A rule's port matters: `**.amazonaws.com:443` allows HTTPS only, so http://amazonaws.com is refused.
// Searching for a whole host, URL or host:port answers whether a request to it would be allowed.
function renderNetwork() {
  if (!status) return;
  const search = $('#network-search').value.trim().toLowerCase();
  const filter = $('#network-filter').value;
  const shown = JSON.stringify([status.blocked, networkGroups, networkError, search, filter]);
  if (shown === networkShown) return;
  networkShown = shown;

  const allowed = new Map();
  for (const group of networkGroups ?? []) {
    const source = group.source === 'sbx' ? `${NETWORK_SOURCES.sbx}: ${group.name}` : NETWORK_SOURCES[group.source] ?? group.name;
    const rank = Object.keys(NETWORK_SOURCES).indexOf(group.source);
    for (const rule of group.hosts) {
      const seen = allowed.get(rule);
      allowed.set(rule, { sources: [...(seen?.sources ?? []), source], rank: Math.min(seen?.rank ?? Infinity, rank) });
    }
  }
  // By domain, so `**.github.com` sits next to `github.com` rather than with the other wildcards.
  const domain = (rule) => splitHost(rule).name.replace(/^\*+\./, '');
  const order = [...allowed.keys()].sort((a, b) => allowed.get(a).rank - allowed.get(b).rank || domain(a).localeCompare(domain(b)));
  $('#network-count').textContent = networkGroups
    ? `(${allowed.size} allowed${status.blocked.length ? `, ${status.blocked.length} blocked` : ''})`
    : '';

  const policy = (state) => el('span', { class: `policy ${state}` }, state === 'allowed' ? 'Allowed' : 'Blocked');
  const portText = (port) => (port === null ? 'Any' : port === 443 ? '443 (HTTPS)' : port === 80 ? '80 (HTTP)' : String(port));
  // A whole host name narrows the grid to the rules that cover it; anything else is a text search.
  const request = parseRequest(search);
  const matches = (rule, state) => (filter === 'all' || filter === state)
    && (!search || (request ? covers(rule, request.name, request.port) : rule.includes(search)));
  const rows = [];

  if (request && networkGroups) {
    const rule = order.find((r) => covers(r, request.name, request.port));
    rows.push(el('tr', { class: rule ? 'verdict' : 'verdict blocked' },
      el('td', {}, el('code', {}, request.name)),
      el('td', {}, portText(request.port)),
      el('td', {}, rule ? `Allowed by ${rule} (${allowed.get(rule).sources.join(', ')})` : 'No rule covers this host on this port, so sbx refuses it'),
      el('td', {}, policy(rule ? 'allowed' : 'blocked')),
      el('td', {})));
  }
  for (const blocked of status.blocked) {
    const { name, port } = splitHost(blocked.host);
    if (!matches(`${name}:${port ?? 443}`, 'blocked')) continue;
    rows.push(el('tr', { class: 'blocked' },
      el('td', {}, el('code', {}, name)),
      el('td', {}, portText(port ?? 443)),
      el('td', { class: 'muted' }, `Tried at ${new Date(blocked.at).toLocaleTimeString()}; no rule covers it`),
      el('td', {}, policy('blocked')),
      el('td', { class: 'row-actions' }, answerBlocked(blocked, 'allow', 'Allow'), ' ', answerBlocked(blocked, 'dismiss', 'Dismiss'))));
  }
  for (const rule of order) {
    if (!matches(rule, 'allowed')) continue;
    const { name, port } = splitHost(rule);
    rows.push(el('tr', {},
      el('td', {}, el('code', {}, name)),
      el('td', {}, portText(port)),
      el('td', {}, allowed.get(rule).sources.join(', ')),
      el('td', {}, policy('allowed')),
      el('td', {})));
  }
  if (networkGroups && filter !== 'allowed' && !search) {
    rows.push(el('tr', {},
      el('td', { class: 'muted' }, 'Everything else'),
      el('td', { class: 'muted' }, 'Any'),
      el('td', { class: 'muted' }, "sbx's default policy refuses any host and port no rule allows"),
      el('td', {}, policy('blocked')),
      el('td', {})));
  }
  const note = networkError || (!networkGroups ? 'Reading the policy…' : !rows.length ? 'No host matches.' : '');
  if (note) rows.unshift(el('tr', {}, el('td', { colspan: 5, class: networkError ? 'warn' : 'muted' }, note)));
  $('#network-body').replaceChildren(...rows);
}

function renderOffline() {
  // An agent started before offline mode existed doesn't report it; toggle() without a boolean
  // would flip the class on every refresh.
  const known = typeof status.offline === 'boolean';
  const offline = known && status.offline;
  $('#offline').classList.toggle('on', offline);
  $('#offline-state').textContent = !known ? 'Unknown' : offline ? 'Offline' : 'Online';
  // While a switch runs, the status poll mustn't re-enable the button or flip its label: a second
  // click would start the opposite switch before the first one's rules are all in place.
  $('#offline-toggle').textContent = switching
    ? (switching === 'on' ? 'Going offline…' : 'Going back online…')
    : offline ? 'Go back online' : 'Go offline';
  $('#offline-toggle').classList.toggle('primary', offline);
  $('#offline-toggle').disabled = !known || Boolean(switching);
  $('#offline-text').textContent = !known
    ? 'This page\'s agent is older than offline mode, so it can\'t go offline. Stop the sandbox and run portable again to restart it.'
    : offline
    ? "Only Claude's hosts are reachable. Every other host is denied, including ones you allow meanwhile; those work once you go back online."
    : "Go offline to block every host but Claude's for this sandbox, so agents can only work with what's already in it. It stays offline until you come back here.";
}

$('#network-search').addEventListener('input', renderNetwork);
$('#network-filter').addEventListener('change', renderNetwork);

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
  const form = $('#claude-repo-form');
  if (!repoDirty) form.repo.value = info.repo;
  form.repo.disabled = info.repoFromShell;
  form.querySelector('button[type=submit]').disabled = info.repoFromShell;
  $('#claude-repo').textContent = info.repoFromShell
    ? 'Set by PORTABLE_CLAUDE_CONFIG_REPO in the shell that started portable; unset it there to change it here.'
    : info.installed
      ? `Installed at ${info.commit.hash} — ${info.commit.subject} (${info.commit.when})`
      : info.repo ? "Not installed in the sandbox yet (see Activity, or run portable doctor)." : 'No configuration repo set.';
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
    network: loadNetwork,
    offline: async () => {
      switching = status.offline ? 'off' : 'on';
      renderOffline();
      try {
        const result = await api('PUT', '/api/offline', { offline: switching === 'on' });
        report(result.problems, result.offline ? "Offline: only Claude's hosts are reachable." : 'Back online.');
      } finally {
        switching = '';
      }
      await Promise.all([loadStatus(), loadNetwork()]);
    },
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
    banner("This browser doesn't have the page's token yet. On the Mac, run `portable ui` in the project's folder once; after that, this link works on its own.");
    return;
  }
  try {
    await loadStatus();
  } catch (error) {
    banner(error.message);
    return;
  }
  loadServices();
  loadNetwork();
  loadAws();
  loadClaude();
  loadSecrets();
  setInterval(() => loadStatus().catch((error) => banner(`Lost the agent: ${error.message}. It stops with the sandbox; run portable in ${status?.path ?? 'the folder'} to start it again.`)), 5000);
}

start();
