// public/panel.js
(() => {
  const BASE = '/api';
  const locInput    = document.getElementById('loc-id');
  const btnGenerate = document.getElementById('btn-generate');
  const output      = document.getElementById('evo-output');
  let locationId;

  // Llamada genérica al backend
  async function call(path) {
    if (!locationId) throw new Error('Location ID no definido');
    const url = `${BASE}/${path}?locationId=${encodeURIComponent(locationId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.blob();
  }

  // Al hacer clic en “Revisar conexión”
  btnGenerate.addEventListener('click', async () => {
    locationId = locInput.value.trim();
    if (!locationId) {
      alert('Introduce tu Location ID');
      return;
    }
    output.innerHTML = 'Comprobando estado…';

    try {
      const result = await call('wa-qr');
      output.innerHTML = '';

      if (result instanceof Blob) {
        // Mostrar QR
        const imgURL = URL.createObjectURL(result);
        const img = new Image();
        img.src = imgURL;
        img.alt = 'QR WhatsApp';
        output.appendChild(img);
        setTimeout(() => URL.revokeObjectURL(imgURL), 60000);
      } else {
        // Mostrar mensaje JSON
        const msg = result.message || JSON.stringify(result);
        const p = document.createElement('p');
        p.textContent = msg;
        output.appendChild(p);
      }
    } catch (err) {
      output.innerHTML = '';
      const p = document.createElement('p');
      p.style.color = 'red';
      p.textContent = err.message;
      output.appendChild(p);
    }
  });
})();
