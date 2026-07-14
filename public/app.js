const out = document.getElementById('out');
const btn = document.getElementById('check');

btn?.addEventListener('click', async () => {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = `Error: ${err?.message || err}`;
  }
});
