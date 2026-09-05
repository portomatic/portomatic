(() => {
  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const labels = {
    implementing: 'implementing',
    focused_green: 'focused green',
    regression_green: 'all gates green',
    merged: 'merged',
  };
  const ranks = { regression_green: 0, focused_green: 1, implementing: 2, merged: 3 };
  const scriptBase = new URL('.', document.currentScript.src);
  const isFilePage = window.location.protocol === 'file:';
  let dashboard = window.__PORTOMATIC_DASHBOARD__ ?? null;
  let sortKey = 'state';
  let sortDirection = 1;
  const openLaneIds = new Set();

  function secondsAgo(timestamp) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    return `${Math.floor(elapsed / 3600)}h ago`;
  }

  function dataIsFresh() {
    return dashboard?.generated_at && Date.now() - Date.parse(dashboard.generated_at) < 15000;
  }

  function laneIsRunning(lane) {
    return dataIsFresh() && lane.worker_state === 'running';
  }

  function metric(value, label) {
    return `<span class="tracker-metric"><strong>${escapeHtml(value)}</strong> ${escapeHtml(label)}</span>`;
  }

  function renderSummary() {
    const summary = dashboard.summary;
    const running = dataIsFresh() ? summary.workers_running : 0;
    byId('tracker-summary').innerHTML = [
      metric(`${summary.repositories_qualified}/${summary.repositories_total}`, 'repositories qualified'),
      metric(`${summary.lanes_merged}/${summary.lanes_total}`, 'lanes merged'),
      metric(running, 'workers running'),
      metric(secondsAgo(dashboard.generated_at), 'updated'),
    ].join('');
    byId('tracker-updated').textContent = `Integration ${dashboard.source.commit.slice(0, 8)}  Coordination ${dashboard.source.coordination_updated_through}`;
  }

  function pullRequestHtml(lane) {
    if (lane.pr?.url) {
      const status = lane.delivery_state === 'conflicting'
        ? '<small>conflict</small>'
        : lane.delivery_state === 'merged'
          ? '<small>merged</small>'
          : '';
      return `<span class="cell-stack"><a href="${escapeHtml(lane.pr.url)}">PR #${escapeHtml(lane.pr.number)}</a>${status}</span>`;
    }
    return '—';
  }

  function activityCellHtml(lane) {
    const running = laneIsRunning(lane);
    const lines = lane.activity ?? [];
    const latest = lines.at(-1);
    const label = running
      ? lane.worker_count > 1 ? `${lane.worker_count} live` : 'live'
      : lane.display_state === 'merged' ? 'finished' : 'no worker';
    const age = running && latest
      ? `<time data-activity-time="${escapeHtml(latest.timestamp)}">${escapeHtml(secondsAgo(latest.timestamp))}</time>`
      : lane.delivery_state === 'conflicting'
        ? 'PR needs rebase'
        : lane.display_state === 'merged'
          ? 'merged'
          : 'not currently active';
    return `<span class="activity-compact"><span>${label}</span><small>${age}</small></span>`;
  }

  function activityPanelHtml(lane) {
    const lines = lane.activity ?? [];
    if (!lines.length) return '<p class="activity-empty">No worker output recorded.</p>';
    return `<ol class="activity-lines">${lines.map((line) => `<li><time data-activity-time="${escapeHtml(line.timestamp)}">${escapeHtml(secondsAgo(line.timestamp))}</time><code>${escapeHtml(line.text)}</code></li>`).join('')}</ol>`;
  }

  function laneRow(lane) {
    const open = openLaneIds.has(lane.id);
    return `<tr class="lane-main-row" data-lane-id="${escapeHtml(lane.id)}" tabindex="0" aria-expanded="${open}">
      <td><span class="lane-name">${escapeHtml(lane.display_name ?? lane.id)}</span><small class="lane-subtitle">${escapeHtml(lane.subsystem.replaceAll('-', ' '))}</small></td>
      <td><span class="state-chip state-${escapeHtml(lane.display_state)}">${escapeHtml(labels[lane.display_state])}</span></td>
      <td>${escapeHtml(lane.affected_repositories.join(', '))}</td>
      <td>${pullRequestHtml(lane)}</td>
      <td>${activityCellHtml(lane)}</td>
    </tr>
    <tr class="lane-activity-row" data-activity-for="${escapeHtml(lane.id)}"${open ? '' : ' hidden'}>
      <td colspan="5">${activityPanelHtml(lane)}</td>
    </tr>`;
  }

  function sortValue(lane, key) {
    if (key === 'state') return ranks[lane.display_state];
    if (key === 'repositories') return lane.affected_repositories.join(', ');
    if (key === 'pr') return lane.pr?.number ?? Number.MAX_SAFE_INTEGER;
    if (key === 'activity') return lane.last_activity_at ?? '';
    return lane.display_name ?? lane.id;
  }

  function sortedLanes() {
    return [...dashboard.lanes].sort((left, right) => {
      const leftValue = sortValue(left, sortKey);
      const rightValue = sortValue(right, sortKey);
      let difference = 0;
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        difference = leftValue - rightValue;
      } else {
        difference = String(leftValue).localeCompare(String(rightValue));
      }
      if (difference) return difference * sortDirection;
      if (sortKey === 'state') {
        const priorityDifference = (left.priority ?? 100) - (right.priority ?? 100);
        if (priorityDifference) return priorityDifference;
      }
      return left.id.localeCompare(right.id);
    });
  }

  function updateSortButtons() {
    document.querySelectorAll('.sort-button').forEach((button) => {
      const active = button.dataset.sort === sortKey;
      button.classList.toggle('is-active', active);
      button.dataset.direction = active && sortDirection < 0 ? 'desc' : 'asc';
      button.closest('th').setAttribute(
        'aria-sort',
        active ? (sortDirection < 0 ? 'descending' : 'ascending') : 'none',
      );
    });
  }

  function renderLanes() {
    byId('lane-table-body').innerHTML = sortedLanes().map(laneRow).join('');
    updateSortButtons();
    installLaneExpansion();
  }

  function toggleLane(row) {
    const laneId = row.dataset.laneId;
    const panel = document.querySelector(`[data-activity-for="${CSS.escape(laneId)}"]`);
    const open = !openLaneIds.has(laneId);
    if (open) openLaneIds.add(laneId);
    else openLaneIds.delete(laneId);
    row.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }

  function installLaneExpansion() {
    document.querySelectorAll('.lane-main-row').forEach((row) => {
      row.addEventListener('click', (event) => {
        if (event.target.closest('a, button')) return;
        toggleLane(row);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleLane(row);
      });
    });
  }

  function repositoryName(repository) {
    const name = repository.display_name ?? repository.id;
    return repository.detail_url
      ? `<a href="${escapeHtml(repository.detail_url)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
  }

  function repositoryRow(repository) {
    const target = repository.upstream_cases === null
      ? `${repository.selected_cases.toLocaleString()} enrolled / total unknown`
      : `${repository.selected_cases.toLocaleString()} enrolled / ${repository.upstream_cases.toLocaleString()} discovered`;
    let native = repository.native_green_cases === null
      ? '—'
      : `${repository.native_green_cases.toLocaleString()}/${repository.selected_cases.toLocaleString()}`;
    const evidence = repository.native_evidence;
    if (evidence) {
      native = `<span class="cell-stack"><span>${escapeHtml(evidence.frozen_gate_admitted)} admitted</span><small>${escapeHtml(evidence.expanded_stable)} stable in expanded suite</small></span>`;
    }
    const buildDetail = evidence
      ? `<small>${escapeHtml(evidence.build_states.built)} compiled; ${escapeHtml(evidence.build_states.architecture_inapplicable)} not ARM64</small>`
      : '';
    let linux = repository.qualification_status.replaceAll('_', ' ');
    if (repository.linux_exact_cases !== null) {
      linux = `${repository.linux_exact_cases}/${repository.selected_cases}`;
    }
    return `<tr>
      <td>${repositoryName(repository)}</td>
      <td><span class="cell-stack"><span>${target}</span>${buildDetail}</span></td>
      <td>${native}</td>
      <td>${escapeHtml(linux)}</td>
      <td>${escapeHtml(repository.blocker || '—')}</td>
    </tr>`;
  }

  function renderRepositories() {
    byId('repository-table-body').innerHTML = dashboard.repositories.map(repositoryRow).join('');
  }

  function render() {
    renderSummary();
    renderLanes();
    renderRepositories();
  }

  function updateTimes() {
    if (!dashboard) return;
    renderSummary();
    document.querySelectorAll('[data-activity-time]').forEach((time) => {
      time.textContent = secondsAgo(time.dataset.activityTime);
    });
  }

  function poll() {
    if (isFilePage) {
      const snapshot = document.createElement('script');
      snapshot.src = new URL(`dashboard.snapshot.js?refresh=${Date.now()}`, scriptBase);
      snapshot.onload = () => {
        dashboard = window.__PORTOMATIC_DASHBOARD__ ?? dashboard;
        snapshot.remove();
        render();
        window.setTimeout(poll, 3000);
      };
      snapshot.onerror = () => {
        snapshot.remove();
        window.setTimeout(poll, 3000);
      };
      document.head.append(snapshot);
      return;
    }
    fetch(new URL('dashboard.json', scriptBase), { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`dashboard returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        dashboard = data;
        render();
      })
      .catch(() => {})
      .finally(() => window.setTimeout(poll, 3000));
  }

  document.querySelectorAll('.sort-button').forEach((button) => {
    button.addEventListener('click', () => {
      if (sortKey === button.dataset.sort) {
        sortDirection *= -1;
      } else {
        sortKey = button.dataset.sort;
        sortDirection = 1;
      }
      renderLanes();
    });
  });
  if (!dashboard) {
    byId('tracker-summary').innerHTML = '<p class="tracker-error">Dashboard snapshot missing.</p>';
    return;
  }
  render();
  window.setInterval(updateTimes, 1000);
  poll();
})();
