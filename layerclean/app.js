(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    files: $('file-list'), viewport: $('viewport'), stage: $('image-stage'),
    before: $('before-image'), after: $('after-image'), divider: $('compare-divider'),
    history: $('history-select'), input: $('file-input')
  };
  const state = {
    config: null, connected: false, connecting: false, uploading: false,
    creating: false, historyLoading: false, historyFetching: false,
    inputs: [], job: null, history: [], selected: null, source: 'input',
    epoch: 0, timer: null, watchSequence: 0, pollPaused: false, interacted: false,
    preferredView: 'compare', view: 'before', zoom: 'fit', split: 50,
    preview: null, previewKey: '', dragDepth: 0
  };
  const jobStates = new Set(['queued', 'running', 'done', 'error']);
  const itemStates = { done: '已完成', skipped: '已跳过', error: '处理失败' };
  const jobLabels = { queued: '等待处理', running: '正在清理', done: '处理完成', error: '任务失败' };
  const string = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const validId = (value) => (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const dimension = (value) => number(value) !== null && value > 0 ? value : null;
  const metric = (value) => number(value) === null ? '—' : value.toLocaleString('zh-CN');
  const activeJob = () => Boolean(state.job && ['queued', 'running'].includes(state.job.state));
  const busy = () => state.uploading || state.creating || state.historyLoading || activeJob();
  const canImport = () => Boolean(state.config && state.connected && !state.connecting && !busy());

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function formatBytes(bytes) {
    if (number(bytes) === null) return '大小未提供';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function sizeText(width, height) {
    return dimension(width) && dimension(height) ? `${width.toLocaleString('zh-CN')} × ${height.toLocaleString('zh-CN')}` : '尺寸未提供';
  }

  // 预览与下载只接受同源 HTTP(S) 地址，不执行服务端传入的 HTML。
  function localURL(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.startsWith("/api/") ? "." + value : value, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function notice(message, type = 'info') {
    $('notice-text').textContent = message;
    $('notice').className = `notice ${type}`;
    $('notice').hidden = !message;
  }

  function connection(connected, text) {
    state.connected = connected;
    $('connection-button').className = `connection ${state.connecting ? 'pending' : connected ? '' : 'error'}`;
    $('connection-text').textContent = text || (connected ? '浏览器引擎已连接' : '浏览器引擎未连接');
    $('connection-button').title = connected ? '浏览器引擎已连接，点击检查连接' : '点击重新连接浏览器引擎';
    $('footer-service').textContent = connected ? `浏览器引擎就绪${state.config?.port ? ` · 端口 ${state.config.port}` : ''}` : '请通过浏览器引擎打开此工作台';
  }

  async function request(path, { method = 'GET', body, raw = false, timeout = 180000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      if (!state.config?.session_token) throw new Error('本地会话尚未就绪，请先重新连接。');
      headers['X-Session-Token'] = state.config.session_token;
      headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
    }
    try {
      const response = await fetch("." + path, {
        method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`浏览器引擎未返回有效 JSON（HTTP ${response.status}）。`);
      }
      if (!response.ok || (typeof data?.error === 'string' && !jobStates.has(data.state))) throw new Error(string(data?.error, `请求失败（HTTP ${response.status}）。`));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('浏览器引擎返回的数据格式不正确。');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查浏览器引擎是否仍在运行。');
      if (error instanceof TypeError) throw new Error('无法访问浏览器接口，请通过浏览器引擎打开工作台并检查连接。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function items() {
    return Array.isArray(state.job?.items) ? state.job.items.filter((item) => item && validId(item.input_id)) : [];
  }

  function entries() {
    const results = new Map(items().map((item) => [String(item.input_id), item]));
    const list = state.inputs.map((input) => ({ id: String(input.id), input, result: results.get(String(input.id)) || null }));
    const known = new Set(list.map((entry) => entry.id));
    for (const item of results.values()) {
      if (!known.has(String(item.input_id))) list.push({ id: String(item.input_id), input: null, result: item });
    }
    return list;
  }

  function selectedEntry() {
    return entries().find((entry) => entry.id === state.selected) || null;
  }

  function entryName(entry) {
    return string(entry?.result?.name, string(entry?.input?.name, '未命名图层'));
  }

  function setActivity(title, message, count = '', progress = null, kind = '') {
    $('activity-title').textContent = title;
    $('activity-message').textContent = message;
    $('activity-count').textContent = count;
    $('activity-panel').className = `activity-panel ${kind ? `is-${kind}` : ''}`;
    const supplied = number(progress) !== null;
    $('progress-track').hidden = !supplied;
    if (supplied) {
      const value = Math.min(100, Math.max(0, progress));
      $('progress-track').setAttribute('aria-valuenow', String(value));
      $('progress-fill').style.width = `${value}%`;
    }
  }

  function renderJobActivity() {
    const job = state.job;
    if (!job) return;
    const historical = state.source === 'history' ? '历史任务 · ' : '';
    const title = state.pollPaused ? '状态查询中断' : historical + jobLabels[job.state];
    const message = state.pollPaused ? '任务可能仍在本机运行。重新查询只获取状态，不会重新处理。' : string(job.error, string(job.message, job.state === 'done' ? '请逐项检查对比画面、检测数量与 Alpha 校验，再下载结果。' : '正在等待本地引擎返回处理信息。'));
    const count = `${metric(job.completed)} / ${metric(job.total)} 项`;
    setActivity(title, message, count, job.progress, state.pollPaused || job.state === 'error' ? 'error' : activeJob() ? 'busy' : '');
  }

  function updateControls() {
    const locked = busy() || state.connecting;
    const importable = canImport();
    $('dropzone').disabled = !importable;
    $('empty-import').disabled = !importable;
    ui.input.disabled = !importable;
    $('settings-fieldset').disabled = !state.config || locked;
    $('process-button').disabled = !state.inputs.length || !state.connected || locked || state.source === 'history';
    const clearingBusy = state.uploading || state.creating || state.historyLoading || (activeJob() && !state.pollPaused);
    $('clear-button').disabled = clearingBusy || (!entries().length && !state.job);
    ui.history.disabled = locked || state.historyFetching || !state.history.length || !state.config;
    $('connection-button').disabled = state.connecting || state.uploading || state.creating || state.historyLoading;
    $('resume-button').hidden = !state.pollPaused;
    $('process-label').textContent = state.uploading ? '正在导入素材' : state.creating ? '正在创建任务' : activeJob() ? '正在清理' : '开始清理';
    $('run-hint').textContent = state.source === 'history' ? '历史任务仅查看，不自动重新处理' : activeJob() ? '本机处理进行中，请勿重复提交' : state.uploading ? '所有文件上传结束后即可处理' : state.inputs.length ? `已准备 ${state.inputs.length} 个图层` : '导入素材后即可开始';
    document.body.setAttribute('aria-busy', String(state.uploading || state.creating || state.historyLoading));
  }

  function renderList() {
    const list = entries();
    if (!list.some((entry) => entry.id === state.selected)) state.selected = list[0]?.id || null;
    $('file-count').textContent = String(list.length);
    $('list-empty').hidden = list.length > 0;
    ui.files.hidden = !list.length;
    $('list-context').hidden = !state.job;
    $('list-context').textContent = state.job ? `${state.source === 'history' ? '历史结果' : '当前任务'} · ${jobLabels[state.job.state]}${number(state.job.total) !== null ? ` · 共 ${state.job.total} 项` : ''}` : '';
    const fragment = document.createDocumentFragment();
    for (const entry of list) {
      const item = entry.result;
      const data = item || entry.input || {};
      const button = el('button', `file-row${entry.id === state.selected ? ' selected' : ''}`);
      button.type = 'button';
      button.dataset.id = entry.id;
      button.setAttribute('aria-pressed', String(entry.id === state.selected));
      button.title = entryName(entry);
      const thumb = el('span', 'file-thumb');
      const url = localURL(entry.input?.preview_url) || localURL(item?.before_url) || localURL(item?.after_url);
      if (url) {
        const image = el('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = url;
        image.addEventListener('error', () => thumb.replaceChildren(icon('image')), { once: true });
        thumb.append(image);
      } else thumb.append(icon('image'));
      const body = el('span', 'file-row-body');
      const status = item ? (itemStates[item.state] || '状态未提供') : activeJob() ? '等待结果' : state.job ? '未返回结果' : '待清理';
      body.append(el('span', 'file-name', entryName(entry)), el('span', 'file-meta', sizeText(data.width, data.height)), el('span', `file-status ${itemStates[item?.state] ? item.state : ''}`, status));
      button.append(thumb, body, el('span', `file-row-indicator ${itemStates[item?.state] ? item.state : ''}`));
      const row = el('div');
      row.setAttribute('role', 'listitem');
      row.append(button);
      fragment.append(row);
    }
    const scrollTop = ui.files.scrollTop;
    ui.files.replaceChildren(fragment);
    ui.files.scrollTop = scrollTop;
  }

  function setDownload(id, url, filename) {
    const anchor = $(id);
    const safe = localURL(url);
    anchor.classList.toggle('disabled', !safe);
    anchor.setAttribute('aria-disabled', String(!safe));
    anchor.tabIndex = safe ? 0 : -1;
    if (safe) {
      // The browser download manager may create a new request without the tab
      // that owns this in-memory job. Keep the URL as data and fetch it from
      // this page before asking the browser to save a Blob.
      anchor.href = '#download';
      anchor.dataset.downloadSource = safe;
      anchor.dataset.downloadFilename = filename;
      anchor.removeAttribute('download');
    } else {
      anchor.removeAttribute('href');
      anchor.removeAttribute('download');
      delete anchor.dataset.downloadSource;
      delete anchor.dataset.downloadFilename;
    }
  }

  async function saveDownload(event, id) {
    event.preventDefault();
    const anchor = $(id);
    const source = localURL(anchor.dataset.downloadSource);
    const filename = string(anchor.dataset.downloadFilename, 'LayerClean_download');
    if (!source || anchor.getAttribute('aria-disabled') === 'true' || anchor.dataset.downloading === 'true') return;
    anchor.dataset.downloading = 'true';
    anchor.setAttribute('aria-busy', 'true');
    const original = anchor.innerHTML;
    anchor.textContent = '正在准备下载…';
    try {
      const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(`结果文件暂不可用（HTTP ${response.status}）。请重新打开任务后再试。`);
      const type = response.headers.get('content-type') || '';
      if (!/^(image\/png|application\/zip|application\/octet-stream)/i.test(type)) throw new Error('结果文件格式异常，已取消下载。');
      const blob = await response.blob();
      if (!blob.size) throw new Error('结果文件为空，未保存。');
      const objectURL = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectURL;
      link.download = filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
      notice(`已交给浏览器保存：${filename}`);
    } catch (error) {
      notice(string(error?.message, '下载失败，请重新打开任务后再试。'), 'error');
    } finally {
      anchor.innerHTML = original;
      delete anchor.dataset.downloading;
      anchor.removeAttribute('aria-busy');
    }
  }

  function measuredSize(which) {
    const preview = state.preview;
    const image = which === 'before' ? ui.before : ui.after;
    if (preview?.[`${which}Loaded`] && image.naturalWidth && image.naturalHeight) return [image.naturalWidth, image.naturalHeight];
    return null;
  }

  function renderSummary() {
    const entry = selectedEntry();
    const item = entry?.result;
    const data = item || entry?.input;
    const ready = item && ['done', 'skipped'].includes(item.state);
    $('validation-state').textContent = item ? itemStates[item.state] || '未知状态' : '等待处理';
    $('validation-scope').textContent = entry ? `当前图层 · ${entryName(entry)}` : '当前所选图层 · 以服务端实测为准';
    $('marks-value').replaceChildren(document.createTextNode(metric(item?.marks)), el('small', '', '处'));
    const alpha = $('alpha-value');
    alpha.className = 'alpha-value';
    if (item?.alpha_equal === true) {
      alpha.textContent = '保持一致';
      alpha.classList.add('pass');
    } else if (item?.alpha_equal === false) {
      alpha.textContent = '存在差异';
      alpha.classList.add('fail');
    } else alpha.textContent = item ? '未提供' : '待校验';
    $('stats-value').textContent = `${metric(item?.stats?.logo)} / ${metric(item?.stats?.text)}`;
    $('size-value').textContent = data ? sizeText(data.width, data.height) : '—';
    $('bytes-value').textContent = data ? formatBytes(data.bytes) : '—';
    const original = dimension(entry?.input?.width) && dimension(entry?.input?.height) ? [entry.input.width, entry.input.height] : ready && item.dimensions_equal === true ? [item.width, item.height] : null;
    const output = ready && dimension(item.width) && dimension(item.height) ? [item.width, item.height] : null;
    const check = $('dimensions-check');
    check.className = '';
    if (original && output) {
      const equal = original[0] === output[0] && original[1] === output[1];
      check.textContent = equal ? '尺寸一致' : '尺寸存在差异';
      check.classList.add(equal ? 'pass' : 'fail');
    } else check.textContent = item ? '信息不足' : '待校验';
    const warnings = Array.isArray(item?.warnings) ? item.warnings.filter((warning) => typeof warning === 'string') : [];
    if (typeof item?.error === 'string' && item.error) warnings.unshift(item.error);
    if (item?.state === 'skipped' && !warnings.length) warnings.push('服务端跳过了此图层，未提供具体原因；不等同于清理成功。');
    if (item?.alpha_equal === false) warnings.push('透明通道不一致，请核查后再使用结果。');
    if (original && output && (original[0] !== output[0] || original[1] !== output[1])) warnings.push('原图与结果尺寸不同，前后分割对比已停用，请使用单图检查。');
    if (ready && number(item.marks) === null) warnings.push('服务端未返回检测水印数量。');
    if (ready && typeof item.alpha_equal !== 'boolean') warnings.push('服务端未返回 Alpha 校验结果。');
    for (const key of ['before_url', 'after_url', 'download_url']) {
      if (item?.[key] && !localURL(item[key])) warnings.push('已阻止一个非同源或无效的结果地址。');
    }
    if (state.job?.zip_url && !localURL(state.job.zip_url)) warnings.push('已阻止非同源或无效的整包下载地址。');
    $('item-warnings').replaceChildren(...[...new Set(warnings)].map((warning) => el('li', '', warning)));
    $('item-warnings').hidden = warnings.length === 0;
    const filename = entryName(entry).split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/\.png$/i, '') || 'layer';
    setDownload('download-png', ready ? item.download_url : null, `${filename}_clean.png`);
    const zipName = String(state.job?.id || 'results').replace(/[^a-zA-Z0-9_-]/g, '_');
    setDownload('download-zip', state.job?.zip_url, `LayerClean_${zipName}.zip`);
    $('zip-count').textContent = state.job?.zip_url && number(state.job.completed) !== null ? `(${state.job.completed})` : '';
  }

  function comparePossible() {
    const before = measuredSize('before');
    const after = measuredSize('after');
    return Boolean(before && after && before[0] === after[0] && before[1] === after[1]);
  }

  function setSplit(value) {
    state.split = Math.min(100, Math.max(0, value));
    ui.stage.style.setProperty('--split', `${state.split}%`);
    ui.divider.setAttribute('aria-valuenow', String(Math.round(state.split)));
    ui.divider.setAttribute('aria-valuetext', `原图 ${Math.round(state.split)}%，结果 ${100 - Math.round(state.split)}%`);
  }

  function layoutImage() {
    const preview = state.preview;
    if (!preview) return;
    const entry = selectedEntry();
    const size = measuredSize(state.view === 'after' ? 'after' : 'before') || measuredSize('after');
    const width = dimension(entry?.input?.width) || dimension(entry?.result?.width) || size?.[0];
    const height = dimension(entry?.input?.height) || dimension(entry?.result?.height) || size?.[1];
    if (!width || !height) return;
    const availableWidth = Math.max(1, ui.viewport.clientWidth - 48);
    const availableHeight = Math.max(1, ui.viewport.clientHeight - 48);
    const scale = state.zoom === 'actual' ? 1 : Math.min(1, availableWidth / width, availableHeight / height);
    ui.stage.style.width = `${width * scale}px`;
    ui.stage.style.height = `${height * scale}px`;
    $('zoom-value').textContent = `${Math.round(scale * 1000) / 10}%`;
    $('dimension-badge').textContent = `${width} × ${height}`;
    $('dimension-badge').hidden = false;
    ui.viewport.classList.toggle('can-pan', state.zoom === 'actual');
  }

  function renderView() {
    const preview = state.preview;
    const before = Boolean(preview?.beforeLoaded);
    const after = Boolean(preview?.afterLoaded);
    const compare = comparePossible();
    if (state.preferredView === 'compare' && compare) state.view = 'compare';
    else if (state.preferredView === 'after' && after) state.view = 'after';
    else if (before) state.view = 'before';
    else state.view = after ? 'after' : 'before';
    ui.stage.className = `image-stage mode-${state.view}`;
    document.querySelectorAll('[data-view]').forEach((button) => {
      const view = button.dataset.view;
      button.disabled = view === 'compare' ? !compare : view === 'before' ? !before : !after;
      button.classList.toggle('active', view === state.view);
      button.setAttribute('aria-pressed', String(view === state.view));
      button.title = view === 'compare' && before && after && !compare ? '图像尺寸不同，请使用单图检查' : '';
    });
    $('fit-button').disabled = !before && !after;
    $('actual-button').disabled = !before && !after;
    $('fit-button').classList.toggle('active', state.zoom === 'fit');
    $('actual-button').classList.toggle('active', state.zoom === 'actual');
    $('fit-button').setAttribute('aria-pressed', String(state.zoom === 'fit'));
    $('actual-button').setAttribute('aria-pressed', String(state.zoom === 'actual'));
    let message = '';
    if (preview) {
      if (!preview.beforeURL && !preview.afterURL) message = '服务端未提供可用的同源预览地址';
      else if (!before && !after) message = preview.beforeFailed || preview.afterFailed ? '预览加载失败，请检查本地文件与服务连接' : '正在读取本地图层预览…';
      else if (preview.beforeFailed || preview.afterFailed) message = '部分预览加载失败，当前仅显示可用图像';
    }
    $('preview-message').textContent = message;
    $('preview-message').hidden = !message;
    $('canvas-hint').textContent = state.zoom === 'actual' && (before || after) ? '原尺寸 · 拖动画面或滚动平移' : compare ? '拖动分割线，检查清理前后' : before || after ? '单图预览 · 结果返回后可对比' : '支持透明 PNG 与 ZIP 图层包';
    layoutImage();
  }

  function renderPreview() {
    const entry = selectedEntry();
    $('empty-state').hidden = Boolean(entry);
    $('image-space').hidden = !entry;
    $('preview-title').textContent = entry ? entryName(entry) : '图层预览';
    $('preview-title').title = entry ? entryName(entry) : '图层预览';
    if (!entry) {
      state.preview = null;
      state.previewKey = '';
      for (const image of [ui.before, ui.after]) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
        image.hidden = true;
      }
      $('preview-message').hidden = true;
      $('dimension-badge').hidden = true;
      $('zoom-value').textContent = '—';
      ui.viewport.classList.remove('can-pan');
      renderView();
      return;
    }
    const actual = state.zoom === 'actual';
    const beforeURL = actual ? localURL(entry.result?.before_full_url) || localURL(`/api/inputs/${encodeURIComponent(entry.id)}/original`) : localURL(entry.result?.before_url) || localURL(entry.input?.preview_url);
    const afterURL = ['done', 'skipped'].includes(entry.result?.state) ? localURL(actual ? entry.result?.after_full_url || entry.result?.download_url : entry.result?.after_url) : null;
    const key = JSON.stringify([entry.id, beforeURL, afterURL]);
    if (key !== state.previewKey) {
      state.previewKey = key;
      const preview = { beforeURL, afterURL, beforeLoaded: false, afterLoaded: false, beforeFailed: false, afterFailed: false };
      state.preview = preview;
      for (const [which, image, url] of [['before', ui.before, beforeURL], ['after', ui.after, afterURL]]) {
        image.onload = null;
        image.onerror = null;
        image.hidden = true;
        image.removeAttribute('src');
        if (!url) continue;
        image.alt = `${entryName(entry)} · ${which === 'before' ? '原图' : '清理结果'}`;
        image.onload = () => {
          if (state.preview !== preview || image.currentSrc !== url) return;
          preview[`${which}Loaded`] = true;
          image.hidden = false;
          renderView();
          renderSummary();
        };
        image.onerror = () => {
          if (state.preview !== preview) return;
          preview[`${which}Failed`] = true;
          image.hidden = true;
          renderView();
        };
        image.src = url;
      }
      setSplit(state.split);
      ui.viewport.scrollTop = 0;
      ui.viewport.scrollLeft = 0;
    }
    renderView();
  }

  function renderAll() {
    renderList();
    renderPreview();
    renderSummary();
    updateControls();
  }

  function stopWatching() {
    clearTimeout(state.timer);
    state.timer = null;
  }

  function leaveResults() {
    stopWatching();
    state.epoch += 1;
    state.inputs = [];
    state.job = null;
    state.selected = null;
    state.source = 'input';
    state.pollPaused = false;
    state.previewKey = '';
    ui.history.value = '';
    state.zoom = 'fit';
  }

  function checkJob(data) {
    if (!validId(data.id) || !jobStates.has(data.state)) throw new Error('任务接口未返回有效的任务编号或状态。');
    return data;
  }

  async function watchJob(id, epoch) {
    stopWatching();
    const sequence = ++state.watchSequence;
    try {
      const job = checkJob(await request(`/api/jobs/${encodeURIComponent(id)}`));
      if (epoch !== state.epoch || sequence !== state.watchSequence) return;
      if (String(job.id) !== String(id)) throw new Error('任务接口返回了不匹配的任务编号。');
      state.job = job;
      state.pollPaused = false;
      connection(true);
      renderAll();
      renderJobActivity();
      if (activeJob()) state.timer = setTimeout(() => watchJob(id, epoch), 1000);
      else {
        if (job.state === 'error') notice(string(job.error, string(job.message, '本地任务处理失败，请查看图层错误。')), 'error');
        refreshHistory(false);
      }
    } catch (error) {
      if (epoch !== state.epoch || sequence !== state.watchSequence) return;
      state.pollPaused = true;
      connection(false);
      notice(`${error.message} 查询已暂停，不会重新启动任务。`, 'error');
      renderJobActivity();
      updateControls();
    }
  }

  async function openHistory(id) {
    if (busy() || state.connecting) return;
    state.interacted = true;
    state.historyLoading = true;
    const epoch = ++state.epoch;
    stopWatching();
    updateControls();
    setActivity('正在读取历史任务', '只获取已有结果，不会自动重新处理。', '', null, 'busy');
    try {
      const job = checkJob(await request(`/api/jobs/${encodeURIComponent(id)}`));
      if (epoch !== state.epoch) return;
      if (String(job.id) !== String(id)) throw new Error('历史接口返回了不匹配的任务编号。');
      state.inputs = [];
      state.job = job;
      state.selected = null;
      state.source = 'history';
      state.pollPaused = false;
      state.zoom = 'fit';
      state.historyLoading = false;
      connection(true);
      renderAll();
      renderJobActivity();
      ui.history.value = String(job.id);
      if (activeJob()) state.timer = setTimeout(() => watchJob(job.id, epoch), 1000);
    } catch (error) {
      if (epoch !== state.epoch) return;
      notice(`历史任务读取失败：${error.message}`, 'error');
      if (state.job) renderJobActivity();
      else setActivity('历史任务读取失败', '当前素材列表未改动，可重新选择历史任务。', '', null, 'error');
      ui.history.value = state.job ? String(state.job.id) : '';
    } finally {
      if (epoch === state.epoch) {
        state.historyLoading = false;
        updateControls();
      }
    }
  }

  async function refreshHistory(autoRestore = false) {
    if (state.historyFetching) return;
    state.historyFetching = true;
    const epoch = state.epoch;
    updateControls();
    let recent = null;
    try {
      const data = await request('/api/history');
      if (!Array.isArray(data.jobs)) throw new Error('历史任务格式不正确。');
      state.history = data.jobs.filter((job) => job && validId(job.id));
      state.history.sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
      const placeholder = el('option', '', state.history.length ? '选择上次任务' : '暂无历史任务');
      placeholder.value = '';
      const options = state.history.map((job) => {
        const date = new Date(job.created);
        const dateLabel = Number.isNaN(date.getTime()) ? string(job.created) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const label = string(job.label, `任务 ${job.id}`);
        const option = el('option', '', `${label} · ${jobLabels[job.state] || '未知状态'}${dateLabel ? ` · ${dateLabel}` : ''}`);
        option.value = String(job.id);
        return option;
      });
      ui.history.replaceChildren(placeholder, ...options);
      if (state.job) ui.history.value = String(state.job.id);
      recent = state.history.find((job) => job.state === 'done');
    } catch (error) {
      notice(`历史列表暂不可用：${error.message} 当前上传和处理不受影响。`, 'warning');
    } finally {
      state.historyFetching = false;
      updateControls();
    }
    if (autoRestore && recent && epoch === state.epoch && !state.interacted && !busy() && !state.inputs.length) await openHistory(recent.id);
  }

  async function connect(autoRestore = false) {
    if (state.connecting || state.uploading || state.creating || state.historyLoading) return;
    state.connecting = true;
    connection(false, '正在连接浏览器引擎');
    updateControls();
    try {
      if (!['http:', 'https:'].includes(location.protocol)) throw new Error('请由本机后端提供此页面，直接打开 HTML 文件无法调用 /api 接口。');
      const config = await request('/api/config');
      if (typeof config.session_token !== 'string' || !config.session_token) throw new Error('配置接口未返回有效的 session_token。');
      state.config = config;
      state.connecting = false;
      connection(true);
      $('version-label').textContent = string(config.version, 'LOCAL');
      const limits = config.limits || {};
      const labels = [];
      if (dimension(limits.max_file_mb)) labels.push(`单文件 ≤ ${limits.max_file_mb} MB`);
      if (dimension(limits.max_images)) labels.push(`最多 ${limits.max_images} 张`);
      if (dimension(limits.max_pixels_mp)) labels.push(`单图 ≤ ${limits.max_pixels_mp} MP`);
      $('upload-limits').textContent = labels.length ? labels.join(' · ') : '文件与像素限制由浏览器引擎校验';
      const profiles = Array.isArray(config.profiles) ? config.profiles : [];
      $('profile-list').replaceChildren(...profiles.filter((profile) => profile && typeof profile.name === 'string').map((profile) => el('span', 'profile-chip', profile.name)));
      if (!$('profile-list').childElementCount) $('profile-list').append(el('span', 'muted', '未提供内置匹配规则'));
      notice('');
      updateControls();
      if (state.pollPaused && state.job) watchJob(state.job.id, state.epoch);
      window.layerCleanUIReady=true;
      if(window.layerCleanPending?.length){const pending=window.layerCleanPending.splice(0);await uploadFiles(pending);}
      else await refreshHistory(autoRestore);
    } catch (error) {
      state.connecting = false;
      connection(false);
      $('upload-limits').textContent = '浏览器引擎连接后显示上传限制';
      notice(error.message, 'error');
      updateControls();
    }
  }

  async function uploadFiles(fileList) {
    if (!canImport()) {
      if (!state.connected && window.layerCleanQueue) { window.layerCleanQueue(fileList); return; }
      notice('请等待当前上传或任务结束。', 'warning');
      return;
    }
    state.interacted = true;
    const received = Array.from(fileList);
    if (!received.length) return;
    const warnings = [];
    const limit = dimension(state.config.limits?.max_file_mb);
    const files = received.filter((file) => {
      if (!/\.(png|jpe?g|webp|zip)$/i.test(file.name)) {
        warnings.push(`${file.name}：仅支持 PNG、JPG、WebP 或 ZIP。`);
        return false;
      }
      if (limit && file.size > limit * 1024 * 1024) {
        warnings.push(`${file.name}：超过单文件 ${limit} MB 限制。`);
        return false;
      }
      return true;
    });
    if (!files.length) {
      notice(warnings.join('\n'), 'warning');
      return;
    }
    if (state.job || state.source === 'history') leaveResults();
    else state.epoch += 1;
    const epoch = state.epoch;
    state.uploading = true;
    const startCount = state.inputs.length;
    notice('');
    renderAll();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const imageLimit = dimension(state.config.limits?.max_images);
      if (imageLimit && state.inputs.length >= imageLimit) {
        warnings.push(`已达到 ${imageLimit} 张图层上限，其余 ${files.length - index} 个文件未上传。`);
        break;
      }
      setActivity('正在导入素材', file.name, `文件 ${index + 1} / ${files.length}`, null, 'busy');
      try {
        let uploaded = file;
        if (/\.(jpe?g|webp)$/i.test(file.name)) {
          const bitmap = await createImageBitmap(file);
          try {
            if (bitmap.width * bitmap.height > 80000000 || Math.max(bitmap.width, bitmap.height) > 16384) throw Error('图片过大，请先缩小尺寸');
            const canvas = document.createElement('canvas');canvas.width = bitmap.width;canvas.height = bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);
            const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));canvas.width=canvas.height=1;
            if (!blob) throw Error('图片转换失败');uploaded = new File([blob],file.name.replace(/\.[^.]+$/,'.png'),{type:'image/png'});
          } finally { bitmap.close(); }
        }
        const data = await request(`/api/upload?filename=${encodeURIComponent(uploaded.name)}`, { method: 'POST', body: uploaded, raw: true, timeout: 120000 });
        if (epoch !== state.epoch) return;
        if (!Array.isArray(data.inputs)) throw new Error('上传接口未返回 inputs 列表。');
        const known = new Set(state.inputs.map((input) => String(input.id)));
        for (const input of data.inputs) {
          if (!input || !validId(input.id)) {
            warnings.push(`${file.name}：一个图层未返回有效编号，未加入列表。`);
            continue;
          }
          if (!known.has(String(input.id))) {
            state.inputs.push(input);
            known.add(String(input.id));
          }
        }
        if (data.inputs.length === 0) warnings.push(`${file.name}：未解析出可处理的 PNG 图层。`);
        if (Array.isArray(data.warnings)) warnings.push(...data.warnings.filter((warning) => typeof warning === 'string').map((warning) => `${file.name}：${warning}`));
        renderAll();
      } catch (error) {
        warnings.push(`${file.name}：${error.message}`);
      }
    }
    if (epoch !== state.epoch) return;
    state.uploading = false;
    const count = state.inputs.length - startCount;
    setActivity(count ? '素材已就绪' : '本次未导入新图层', count ? `本次导入 ${count} 个图层，选择清理强度后开始处理。` : '请检查文件格式、大小和浏览器引擎返回的错误。', `共 ${state.inputs.length} 个图层`, null, count ? '' : 'error');
    if (warnings.length) notice(warnings.join('\n'), count ? 'warning' : 'error');
    renderAll();
  }

  async function createJob() {
    if (busy() || state.connecting || !state.connected || !state.inputs.length || state.source === 'history') return;
    const maxImages = dimension(state.config.limits?.max_images);
    const maxPixels = dimension(state.config.limits?.max_pixels_mp);
    if (maxImages && state.inputs.length > maxImages) {
      notice(`当前有 ${state.inputs.length} 张图层，超过 ${maxImages} 张限制。请清空界面后分批导入；清空不会删除磁盘文件。`, 'warning');
      return;
    }
    const oversized = state.inputs.find((input) => maxPixels && dimension(input.width) && dimension(input.height) && input.width * input.height > maxPixels * 1000000);
    if (oversized) {
      notice(`${string(oversized.name, '当前图层')} 超过单图 ${maxPixels} MP 限制，请分批检查素材。`, 'warning');
      return;
    }
    state.interacted = true;
    state.creating = true;
    state.pollPaused = false;
    const epoch = ++state.epoch;
    stopWatching();
    updateControls();
    notice('');
    setActivity('正在创建清理任务', '提交图层编号与清理设置，不重复上传原图。', `${state.inputs.length} 个图层`, null, 'busy');
    const strength = Number(document.querySelector('input[name="strength"]:checked').value);
    try {
      const data = await request('/api/jobs', { method: 'POST', body: { inputs: state.inputs.map((input) => input.id), strength: [0.8, 1, 1.1, 1.6].includes(strength) ? strength : 1, adaptive: $('adaptive-input').checked } });
      if (epoch !== state.epoch) return;
      if (!validId(data.id)) throw new Error('创建接口未返回有效的任务编号。');
      state.job = { id: data.id, state: 'queued', items: [], total: state.inputs.length, message: '任务已提交，等待浏览器引擎返回进度。' };
      state.source = 'input';
      state.creating = false;
      ui.history.value = '';
      renderAll();
      renderJobActivity();
      watchJob(data.id, epoch);
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.creating = false;
      notice(`创建任务请求失败：${error.message} 若服务端已接收请求，任务可能仍在运行。请先检查历史任务，避免重复提交。`, 'error');
      setActivity('任务提交未确认', '请先查看历史任务，再决定是否重新提交。', '', null, 'error');
      updateControls();
      refreshHistory(false);
    }
  }

  function chooseFiles() {
    if (!canImport()) return;
    state.interacted = true;
    ui.input.click();
  }

  document.addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.files||[]);if(files.length){event.preventDefault();uploadFiles(files);}});
  $('dropzone').addEventListener('click', chooseFiles);
  $('empty-import').addEventListener('click', chooseFiles);
  ui.input.addEventListener('change', () => {
    const files = Array.from(ui.input.files || []);
    ui.input.value = '';
    uploadFiles(files);
  });
  $('process-button').addEventListener('click', createJob);
  $('connection-button').addEventListener('click', () => connect(false));
  $('notice-close').addEventListener('click', () => notice(''));
  $('resume-button').addEventListener('click', () => {
    if (!state.job || !state.pollPaused) return;
    state.pollPaused = false;
    updateControls();
    setActivity('正在重新查询', '仅恢复状态查询，不会再次创建任务。', '', null, 'busy');
    watchJob(state.job.id, state.epoch);
  });
  ui.history.addEventListener('change', () => { if (ui.history.value) openHistory(ui.history.value); });
  $('clear-button').addEventListener('click', () => {
    if ($('clear-button').disabled) return;
    if (!window.confirm('仅清空当前界面列表，不删除本机磁盘文件，也不取消后台任务。是否继续？')) return;
    state.interacted = true;
    leaveResults();
    renderAll();
    setActivity('列表已清空', '只清空界面，磁盘文件和历史任务仍保留在本机。', '等待导入');
    notice('列表已清空；没有删除磁盘文件或取消后台任务。');
  });
  ui.files.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    state.selected = button.dataset.id;
    renderAll();
  });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.preferredView = button.dataset.view;
    renderView();
  }));
  document.querySelectorAll('[data-background]').forEach((button) => button.addEventListener('click', () => {
    ui.viewport.classList.remove('bg-checker', 'bg-light', 'bg-dark');
    ui.viewport.classList.add(`bg-${button.dataset.background}`);
    document.querySelectorAll('[data-background]').forEach((other) => {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
  }));
  for (const [id, zoom] of [['fit-button', 'fit'], ['actual-button', 'actual']]) {
    $(id).addEventListener('click', () => {
      state.zoom = zoom;
      renderPreview();
      ui.viewport.scrollTop = 0;
      ui.viewport.scrollLeft = 0;
    });
  }
  document.querySelectorAll('input[name="strength"]').forEach((input) => input.addEventListener('change', () => {
    const value = Number(input.value);
    $('strength-value').textContent = `${value.toFixed(1)}×`;
    $('strength-help').classList.toggle('warning', value >= 1.1);
    $('strength-help').textContent = value === 1.6 ? '超强模式大幅增强已识别水印的清理，可能损失细节或产生色差；请放大对比后导出。' : value === 1.1 ? '强力模式可能引入色差，请放大对比边缘、颜色与透明区域。' : value === 0.8 ? '减少清理强度，优先保守处理；部分水印可能仍有残留。' : '标准模式，在清理效果与图层保真之间取得平衡。';
  }));
  for (const id of ['download-png', 'download-zip']) $(id).addEventListener('click', (event) => saveDownload(event, id));

  const dialog = $('help-dialog');
  $('help-button').addEventListener('click', () => dialog.showModal());
  $('help-close').addEventListener('click', () => dialog.close());
  $('help-confirm').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    if (canImport()) {
      $('drop-overlay').hidden = false;
      $('dropzone').classList.add('dragging');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canImport() ? 'copy' : 'none';
  });
  function clearDrag() {
    state.dragDepth = 0;
    $('drop-overlay').hidden = true;
    $('dropzone').classList.remove('dragging');
  }
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) clearDrag();
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    clearDrag();
    uploadFiles(event.dataTransfer.files);
  });
  document.addEventListener('dragend', clearDrag);
  window.addEventListener('blur', clearDrag);

  let splitPointer = null;
  function splitAt(event) {
    const rect = ui.stage.getBoundingClientRect();
    if (rect.width) setSplit(((event.clientX - rect.left) / rect.width) * 100);
  }
  ui.divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    splitPointer = event.pointerId;
    ui.divider.setPointerCapture(event.pointerId);
    ui.divider.focus({ preventScroll: true });
    splitAt(event);
  });
  ui.divider.addEventListener('pointermove', (event) => { if (event.pointerId === splitPointer) splitAt(event); });
  function endSplit(event) {
    if (event.pointerId !== splitPointer) return;
    splitPointer = null;
    if (ui.divider.hasPointerCapture(event.pointerId)) ui.divider.releasePointerCapture(event.pointerId);
  }
  ui.divider.addEventListener('pointerup', endSplit);
  ui.divider.addEventListener('pointercancel', endSplit);
  ui.divider.addEventListener('lostpointercapture', () => { splitPointer = null; });
  ui.divider.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 10 : 1;
    const values = { ArrowLeft: state.split - step, ArrowRight: state.split + step, ArrowUp: state.split + step, ArrowDown: state.split - step, Home: 0, End: 100, PageUp: state.split + 10, PageDown: state.split - 10 };
    if (Object.hasOwn(values, event.key)) {
      event.preventDefault();
      setSplit(values[event.key]);
    }
  });

  let pan = null;
  ui.viewport.addEventListener('pointerdown', (event) => {
    if (state.zoom !== 'actual' || !state.preview || event.button !== 0 || !event.isPrimary || event.target.closest('#compare-divider')) return;
    if (!event.target.closest('#image-stage')) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: ui.viewport.scrollLeft, top: ui.viewport.scrollTop };
    ui.viewport.setPointerCapture(event.pointerId);
    ui.viewport.classList.add('panning');
    event.preventDefault();
  });
  ui.viewport.addEventListener('pointermove', (event) => {
    if (!pan || pan.id !== event.pointerId) return;
    ui.viewport.scrollLeft = pan.left - (event.clientX - pan.x);
    ui.viewport.scrollTop = pan.top - (event.clientY - pan.y);
  });
  function endPan(event) {
    if (!pan || pan.id !== event.pointerId) return;
    pan = null;
    ui.viewport.classList.remove('panning');
    if (ui.viewport.hasPointerCapture(event.pointerId)) ui.viewport.releasePointerCapture(event.pointerId);
  }
  ui.viewport.addEventListener('pointerup', endPan);
  ui.viewport.addEventListener('pointercancel', endPan);
  ui.viewport.addEventListener('lostpointercapture', () => { pan = null; ui.viewport.classList.remove('panning'); });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layoutImage).observe(ui.viewport);
  else window.addEventListener('resize', layoutImage);
  window.addEventListener('pagehide', stopWatching);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && activeJob() && !state.pollPaused) watchJob(state.job.id, state.epoch);
  });

  renderAll();
  connect(true);
})();
