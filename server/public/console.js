/*
 * NEXUS control panel.
 *
 * A thin client over /api/v1/*. It holds no credentials of its own: the owner
 * API token lives in sessionStorage for this tab and is sent back only to this
 * same origin as a bearer token. Everything the panel can do, the API can do —
 * the allowlist, the action budget and the approval gate all live server side,
 * so the panel cannot widen them.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'nexus.owner_token';
  var POLL_BUSY_MS = 2000;
  var POLL_IDLE_MS = 10000;

  var el = {
    server: document.getElementById('server'),
    token: document.getElementById('token'),
    authForm: document.getElementById('auth-form'),
    authState: document.getElementById('auth-state'),
    forget: document.getElementById('forget'),
    devices: document.getElementById('devices'),
    refreshDevices: document.getElementById('refresh-devices'),
    pair: document.getElementById('pair'),
    pairState: document.getElementById('pair-state'),
    deviceSelect: document.getElementById('device'),
    taskForm: document.getElementById('task-form'),
    instruction: document.getElementById('instruction'),
    taskState: document.getElementById('task-state'),
    tasks: document.getElementById('tasks'),
    tasksCount: document.getElementById('tasks-count'),
  };

  var token = sessionStorage.getItem(TOKEN_KEY) || '';
  var pollTimer = null;
  var devices = [];

  /* ---------------------------------------------------------------- */

  function say(node, message, kind) {
    if (!node) return;
    node.textContent = message || '';
    node.className = 'state' + (kind ? ' ' + kind : '');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  async function api(path, options) {
    var init = options || {};
    var response = await fetch(path, Object.assign({}, init, {
      headers: Object.assign(
        { accept: 'application/json' },
        init.body ? { 'content-type': 'application/json' } : {},
        token ? { authorization: 'Bearer ' + token } : {},
        init.headers,
      ),
    }));

    var text = await response.text();
    var payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      var failure = payload && payload.error;
      var code = (failure && failure.code) || 'HTTP_' + response.status;
      var message = (failure && failure.message) || response.statusText || 'Request failed.';
      if (response.status === 401) {
        message = 'The token was refused. Check OWNER_API_TOKENS in .env.';
        setServerPill('error', 'token refused');
      }
      var error = new Error(message);
      error.code = code;
      throw error;
    }
    return payload;
  }

  function describe(error) {
    return error.code ? error.code + ': ' + error.message : error.message;
  }

  /* ---------------------------------------------------------------- */

  function setServerPill(state, text) {
    el.server.dataset.state = state;
    el.server.textContent = text;
  }

  async function loadServerInfo() {
    try {
      var health = await api('/healthz');
      var ready = await api('/readyz').catch(function () {
        return null;
      });
      var ai = ready && ready.checks ? ready.checks.ai : null;
      var label = 'v' + health.version + ' · ' + (health.env || 'env');
      if (ai) {
        label += ' · AI ' + (ai.configured ? ai.provider + ' (' + ai.model + ')' : 'not configured');
      }
      if (ready && ready.status !== 'ok') {
        setServerPill('warn', label);
      } else {
        setServerPill('ok', label);
      }
    } catch (error) {
      setServerPill('error', 'server unreachable');
    }
  }

  async function loadDevices() {
    if (!token) return;
    try {
      var payload = await api('/api/v1/devices');
      devices = payload.devices || [];
      renderDevices();
      renderDeviceOptions();
    } catch (error) {
      el.devices.innerHTML = '<p class="hint">' + escapeHtml(describe(error)) + '</p>';
    }
  }

  function renderDevices() {
    if (!devices.length) {
      el.devices.innerHTML =
        '<p class="hint">No device is paired. Create a pairing code and enter it in the NEXUS app.</p>';
      return;
    }
    el.devices.innerHTML = devices
      .map(function (device) {
        return (
          '<div class="item">' +
          '<div class="item-head"><span class="item-title">' +
          escapeHtml(device.label || device.id) +
          '</span><span class="pill" data-state="' +
          (device.online ? 'online' : 'idle') +
          '">' +
          (device.online ? 'online' : 'offline') +
          '</span></div>' +
          '<div class="item-meta">' +
          escapeHtml(device.id) +
          (device.last_seen_at ? ' · last seen ' + escapeHtml(device.last_seen_at) : '') +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
          '<button type="button" class="tiny ghost" data-revoke="' +
          escapeHtml(device.id) +
          '">Revoke</button>' +
          '</div></div>'
        );
      })
      .join('');
  }

  function renderDeviceOptions() {
    var previous = el.deviceSelect.value;
    el.deviceSelect.innerHTML = devices
      .map(function (device) {
        return (
          '<option value="' +
          escapeHtml(device.id) +
          '">' +
          escapeHtml((device.label || device.id) + (device.online ? ' — online' : ' — offline')) +
          '</option>'
        );
      })
      .join('');
    if (previous && devices.some(function (device) {
      return device.id === previous;
    })) {
      el.deviceSelect.value = previous;
    }
    var online = devices.find(function (device) {
      return device.online;
    });
    if (!previous && online) el.deviceSelect.value = online.id;
  }

  /* ---------------------------------------------------------------- */

  function renderTasks(tasks) {
    if (!tasks.length) {
      el.tasks.innerHTML = '<p class="hint">No tasks yet.</p>';
      el.tasksCount.textContent = '0';
      return;
    }
    el.tasksCount.textContent = String(tasks.length);
    el.tasks.innerHTML = tasks
      .map(function (task) {
        var actionRows = (task.actions || [])
          .map(function (action) {
            var detail = action.error_code ? ' · ' + escapeHtml(action.error_code) : '';
            if (action.result && action.result.summary) detail += ' · ' + escapeHtml(action.result.summary);
            return (
              '<li data-status="' +
              escapeHtml(action.status) +
              '"><strong>#' +
              escapeHtml(action.sequence) +
              ' ' +
              escapeHtml(action.type) +
              '</strong> <span class="item-meta">' +
              escapeHtml(action.status) +
              (action.retry_count ? ' · retried ' + escapeHtml(action.retry_count) : '') +
              detail +
              '</span></li>'
            );
          })
          .join('');

        var buttons = '<button type="button" class="tiny ghost" data-cancel="' + escapeHtml(task.task_id) + '">Cancel</button>';
        if (task.requires_approval && task.approval_state === 'pending') {
          buttons =
            '<button type="button" class="tiny primary" data-approve="' +
            escapeHtml(task.task_id) +
            '">Approve</button> ' +
            '<button type="button" class="tiny" data-deny="' +
            escapeHtml(task.task_id) +
            '">Deny</button> ' +
            buttons;
        }

        var summary = task.result && task.result.summary ? '<div class="item-meta">' + escapeHtml(task.result.summary) + '</div>' : '';
        var failure = task.error_code
          ? '<div class="item-meta">' + escapeHtml(task.error_code) + '</div>'
          : '';
        var progress = task.action_count
          ? ' · ' + task.completed_actions + '/' + task.action_count + ' actions'
          : '';

        return (
          '<div class="item">' +
          '<div class="item-head"><span class="item-title">' +
          escapeHtml(task.instruction) +
          '</span><span class="pill" data-state="' +
          pillState(task.status) +
          '">' +
          escapeHtml(task.status) +
          '</span></div>' +
          '<div class="item-meta">' +
          escapeHtml(task.task_id) +
          ' · ' +
          escapeHtml(task.device_id) +
          progress +
          (task.requires_approval ? ' · approval ' + escapeHtml(task.approval_state) : '') +
          '</div>' +
          summary +
          failure +
          (actionRows ? '<ul class="actions">' + actionRows + '</ul>' : '') +
          '<div class="row" style="margin-top:10px">' +
          buttons +
          '</div></div>'
        );
      })
      .join('');
  }

  function pillState(status) {
    if (status === 'completed') return 'ok';
    if (status === 'failed' || status === 'cancelled' || status === 'denied') return 'error';
    if (status === 'awaiting_approval') return 'warn';
    return 'idle';
  }

  async function loadTasks() {
    if (!token) return;
    try {
      var payload = await api('/api/v1/tasks?limit=20');
      var tasks = payload.tasks || [];
      renderTasks(tasks);
      var busy = tasks.some(function (task) {
        return task.active;
      });
      schedule(busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    } catch (error) {
      say(el.taskState, describe(error), 'error');
      schedule(POLL_IDLE_MS);
    }
  }

  function schedule(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      loadTasks().catch(function () {});
    }, ms);
  }

  async function refresh() {
    await Promise.all([loadDevices(), loadTasks()]);
  }

  /* ---------------------------------------------------------------- */

  el.authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    token = el.token.value.trim();
    if (!token) {
      say(el.authState, 'Paste the owner token first.', 'error');
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, token);
    say(el.authState, 'Connected.', 'ok');
    await loadServerInfo();
    await refresh();
  });

  el.forget.addEventListener('click', function () {
    sessionStorage.removeItem(TOKEN_KEY);
    token = '';
    el.token.value = '';
    say(el.authState, 'Token forgotten.');
    el.devices.innerHTML = '<p class="hint">Not loaded yet.</p>';
    el.tasks.innerHTML = '<p class="hint">No tasks yet.</p>';
  });

  el.refreshDevices.addEventListener('click', function () {
    loadDevices().catch(function () {});
  });

  el.pair.addEventListener('click', async function () {
    try {
      var payload = await api('/api/v1/pair', {
        method: 'POST',
        body: JSON.stringify({ action: 'create' }),
      });
      say(
        el.pairState,
        'Code ' + payload.code + ' — expires ' + payload.expires_at + '. Enter it in the NEXUS app; it works once.',
        'ok',
      );
    } catch (error) {
      say(el.pairState, describe(error), 'error');
    }
  });

  el.taskForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var deviceId = el.deviceSelect.value;
    var instruction = el.instruction.value.trim();
    if (!deviceId) {
      say(el.taskState, 'Pair a device first.', 'error');
      return;
    }
    if (!instruction) {
      say(el.taskState, 'Write what the phone should do.', 'error');
      return;
    }
    try {
      await api('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, instruction: instruction }),
      });
      el.instruction.value = '';
      say(el.taskState, 'Task queued.', 'ok');
      await loadTasks();
    } catch (error) {
      say(el.taskState, describe(error), 'error');
    }
  });

  el.tasks.addEventListener('click', async function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    var id = button.dataset.approve || button.dataset.deny || button.dataset.cancel;
    if (!id) return;
    var action = button.dataset.approve ? 'approve' : button.dataset.deny ? 'deny' : 'cancel';
    button.disabled = true;
    try {
      await api('/api/v1/tasks/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      say(el.taskState, 'Task ' + id + ': ' + action + 'd.', 'ok');
      await loadTasks();
    } catch (error) {
      say(el.taskState, describe(error), 'error');
      button.disabled = false;
    }
  });

  el.devices.addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-revoke]');
    if (!button) return;
    var id = button.dataset.revoke;
    if (!window.confirm('Revoke ' + id + '? The phone must be paired again.')) return;
    try {
      await api('/api/v1/devices/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
      await loadDevices();
    } catch (error) {
      say(el.pairState, describe(error), 'error');
    }
  });

  /* ---------------------------------------------------------------- */

  if (token) {
    el.token.value = token;
    say(el.authState, 'Token restored for this tab.');
  }
  loadServerInfo();
  if (token) refresh();
})();
