const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Slider sync
document.getElementById('intervalSlider')?.addEventListener('input', (e) => {
  document.getElementById('intervalValue').textContent = e.target.value;
});

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Failed to fetch state');
    return await res.json();
  } catch (err) {
    console.error('Error fetching state:', err);
    return null;
  }
}

async function createRule() {
  const errorEl = document.getElementById('createError');
  const successEl = document.getElementById('createSuccess');
  errorEl.classList.remove('show');
  successEl.classList.remove('show');

  const name = document.getElementById('ruleName').value.trim();
  const inputMint = document.getElementById('inputMint').value.trim();
  const outputMint = document.getElementById('outputMint').value;
  const swapAmountUsd = parseFloat(document.getElementById('swapAmount').value);
  const intervalMin = parseInt(document.getElementById('intervalSlider').value);
  const thresholdUsd = parseFloat(document.getElementById('thresholdUsd').value) || 0;

  if (!name) {
    errorEl.textContent = 'Please enter a rule name';
    errorEl.classList.add('show');
    return;
  }
  if (!inputMint) {
    errorEl.textContent = 'Please enter input token mint';
    errorEl.classList.add('show');
    return;
  }
  if (!outputMint) {
    errorEl.textContent = 'Please select output token';
    errorEl.classList.add('show');
    return;
  }
  if (swapAmountUsd < 0.25 || swapAmountUsd > 10) {
    errorEl.textContent = 'Swap amount must be between $0.25 and $10';
    errorEl.classList.add('show');
    return;
  }

  try {
    const res = await fetch('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        inputMint,
        outputMint,
        swapAmountUsd,
        intervalMin,
        thresholdUsd,
        enabled: false
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create rule');
    }

    const rule = await res.json();
    successEl.textContent = `Rule "${rule.name}" created! Click "Start" to begin trading.`;
    successEl.classList.add('show');

    document.getElementById('ruleName').value = '';
    document.getElementById('inputMint').value = '';
    document.getElementById('outputMint').value = '';
    document.getElementById('swapAmount').value = '0.5';
    document.getElementById('thresholdUsd').value = '';

    updateUI();
  } catch (err) {
    errorEl.textContent = `Error: ${err.message}`;
    errorEl.classList.add('show');
  }
}

async function startRule(ruleId) {
  try {
    const res = await fetch(`/api/rules/${ruleId}/start`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to start rule');
    updateUI();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function stopRule(ruleId) {
  try {
    const res = await fetch(`/api/rules/${ruleId}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to stop rule');
    updateUI();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function deleteRule(ruleId) {
  if (!confirm('Delete this rule?')) return;
  try {
    const res = await fetch(`/api/rules/${ruleId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete rule');
    updateUI();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function resetThresholdToEntry() {
  alert('Feature coming soon: Entry balance tracking');
}

async function updateUI() {
  const state = await fetchState();
  if (!state) return;

  // Update stats
  const activeCount = state.rules.filter(r => r.enabled).length;
  const totalTrades = (state.totals?.success || 0) + (state.totals?.failure || 0);
  const successRate = totalTrades > 0 ? Math.round((state.totals.success / totalTrades) * 100) : 0;

  document.getElementById('activeRules').textContent = activeCount;
  document.getElementById('totalTrades').textContent = totalTrades;
  document.getElementById('successRate').textContent = `${successRate}%`;
  document.getElementById('totalFees').textContent = `$${(state.totals?.feesSpent || 0).toFixed(2)}`;
  document.getElementById('winCount').textContent = state.totals?.success || 0;
  document.getElementById('lossCount').textContent = state.totals?.failure || 0;

  // Update rules table
  const rulesContainer = document.getElementById('rulesContainer');
  if (state.rules.length === 0) {
    rulesContainer.innerHTML = '<p style="color: #9ca3af;">No active rules yet. Create one above!</p>';
  } else {
    let html = '<table><thead><tr><th>Rule</th><th>Input → Output</th><th>Interval</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
    for (const rule of state.rules) {
      const badge = rule.enabled ? '<span class="badge badge-active">RUNNING</span>' : '<span class="badge badge-inactive">STOPPED</span>';
      html += `<tr>
        <td><strong>${rule.name}</strong></td>
        <td><code style="font-size: 0.8rem;">${rule.inputMint.slice(0, 8)}... → ${rule.outputMint.slice(0, 8)}...</code></td>
        <td>${rule.intervalMin} min</td>
        <td>$${rule.swapAmountUsd.toFixed(2)}</td>
        <td>${badge}</td>
        <td style="white-space: nowrap;">
          ${rule.enabled 
            ? `<button class="danger" style="padding: 0.5rem 0.75rem; margin-top: 0;" onclick="stopRule('${rule.id}')">Stop</button>` 
            : `<button class="success" style="padding: 0.5rem 0.75rem; margin-top: 0;" onclick="startRule('${rule.id}')">Start</button>`}
          <button class="danger" style="padding: 0.5rem 0.75rem; margin-top: 0; margin-left: 0.25rem;" onclick="deleteRule('${rule.id}')">Delete</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    rulesContainer.innerHTML = html;
  }

  // Update history
  const historyContainer = document.getElementById('historyContainer');
  if (!state.history || state.history.length === 0) {
    historyContainer.innerHTML = '<p style="color: #9ca3af;">No trades yet.</p>';
  } else {
    let html = '<table><thead><tr><th>Time</th><th>Rule</th><th>Status</th><th>Details</th></tr></thead><tbody>';
    for (const trade of state.history.slice(0, 20)) {
      const timestamp = new Date(trade.ts).toLocaleString();
      const statusBadge = trade.status === 'success' 
        ? '<span class="badge badge-success">✓ SUCCESS</span>' 
        : '<span class="badge badge-failure">✗ FAILED</span>';
      const details = trade.status === 'success'
        ? `In: ${(trade.amountIn / 1e6).toFixed(4)} | Out: ${(trade.execute?.outputAmountResult / 1e6).toFixed(2)} USDC`
        : trade.error || 'Unknown error';
      html += `<tr>
        <td>${timestamp}</td>
        <td>${trade.ruleName}</td>
        <td>${statusBadge}</td>
        <td style="font-size: 0.85rem;">${details}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    historyContainer.innerHTML = html;
  }
}

// Initial load and auto-refresh
updateUI();
setInterval(updateUI, 5000);
