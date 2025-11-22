// Panel WhatsApp v2 - Main Logic
(() => {
  // State
  let locationId = null;
  let pollingInterval = null;
  let pollCount = 0;
  const MAX_POLL_COUNT = 20; // 20 * 3s = 60s max

  // DOM Elements
  const statusSection = document.getElementById('status-section');
  const statusLoading = document.getElementById('status-loading');
  const statusConnected = document.getElementById('status-connected');
  const statusDisconnected = document.getElementById('status-disconnected');
  const statusError = document.getElementById('status-error');
  const errorMessage = document.getElementById('error-message');

  const connectionMethods = document.getElementById('connection-methods');
  const pollingStatus = document.getElementById('polling-status');

  // Instance info
  const instanceNameEl = document.getElementById('instance-name');
  const phoneNumberEl = document.getElementById('phone-number');

  // Tabs
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabQR = document.getElementById('tab-qr');
  const tabPairing = document.getElementById('tab-pairing');

  // QR Code elements
  const btnGenerateQR = document.getElementById('btn-generate-qr');
  const qrOutput = document.getElementById('qr-output');
  const qrLoading = document.getElementById('qr-loading');
  const qrContainer = document.getElementById('qr-container');
  const qrImage = document.getElementById('qr-image');
  const qrAlreadyConnected = document.getElementById('qr-already-connected');

  // Pairing Code elements
  const phoneInput = document.getElementById('phone-input');
  const btnGeneratePairing = document.getElementById('btn-generate-pairing');
  const pairingOutput = document.getElementById('pairing-output');
  const pairingLoading = document.getElementById('pairing-loading');
  const pairingCodeDisplay = document.getElementById('pairing-code-display');
  const pairingCodeEl = document.getElementById('pairing-code');

  // Initialize
  function init() {
    // Extract location_id from URL
    const urlParams = new URLSearchParams(window.location.search);
    locationId = urlParams.get('location_id');

    if (!locationId) {
      showError('No se encontró location_id en la URL. Asegúrate de acceder desde GHL.');
      return;
    }

    // Setup event listeners
    setupEventListeners();

    // Fetch initial status
    fetchStatus();
  }

  function setupEventListeners() {
    // Tab switching
    tabButtons.forEach(button => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    // QR Code generation
    btnGenerateQR.addEventListener('click', generateQRCode);

    // Pairing Code generation
    btnGeneratePairing.addEventListener('click', generatePairingCode);

    // Phone input validation
    phoneInput.addEventListener('input', (e) => {
      // Only allow digits
      e.target.value = e.target.value.replace(/\D/g, '');
    });
  }

  function switchTab(tabName) {
    // Update tab buttons
    tabButtons.forEach(btn => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update tab content
    if (tabName === 'qr') {
      tabQR.classList.add('active');
      tabPairing.classList.remove('active');
    } else {
      tabQR.classList.remove('active');
      tabPairing.classList.add('active');
    }

    // Reset outputs when switching tabs
    resetOutputs();
  }

  function resetOutputs() {
    qrOutput.style.display = 'none';
    qrLoading.style.display = 'none';
    qrContainer.style.display = 'none';
    qrAlreadyConnected.style.display = 'none';

    pairingOutput.style.display = 'none';
    pairingLoading.style.display = 'none';
    pairingCodeDisplay.style.display = 'none';

    stopPolling();
  }

  async function fetchStatus() {
    try {
      statusSection.style.display = 'block';
      showLoading();

      const response = await fetch(`/panel/status/${locationId}`);

      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      updateStatus(data);
    } catch (error) {
      console.error('Error fetching status:', error);
      showError(error.message);
    }
  }

  function updateStatus(data) {
    const { state, instanceName, phoneNumber } = data;

    // Hide loading
    statusLoading.style.display = 'none';

    if (state === 'open') {
      // Connected
      statusConnected.style.display = 'block';
      statusDisconnected.style.display = 'none';
      connectionMethods.style.display = 'none';

      instanceNameEl.textContent = instanceName || '-';
      phoneNumberEl.textContent = phoneNumber || '-';

      stopPolling();
    } else {
      // Disconnected or connecting
      statusConnected.style.display = 'none';
      statusDisconnected.style.display = 'block';
      connectionMethods.style.display = 'block';
    }
  }

  function showLoading() {
    statusLoading.style.display = 'block';
    statusConnected.style.display = 'none';
    statusDisconnected.style.display = 'none';
    statusError.style.display = 'none';
  }

  function showError(message) {
    statusSection.style.display = 'block';
    statusLoading.style.display = 'none';
    statusConnected.style.display = 'none';
    statusDisconnected.style.display = 'none';
    statusError.style.display = 'block';
    errorMessage.textContent = message;
  }

  async function generateQRCode() {
    try {
      qrOutput.style.display = 'block';
      qrLoading.style.display = 'flex';
      qrContainer.style.display = 'none';
      qrAlreadyConnected.style.display = 'none';
      btnGenerateQR.disabled = true;

      const response = await fetch(`/panel/qr/${locationId}`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      qrLoading.style.display = 'none';

      if (data.qrBase64) {
        // Show QR code
        qrImage.src = data.qrBase64;
        qrContainer.style.display = 'block';

        // Start polling
        startPolling();
      } else if (data.message) {
        // Already connected
        qrAlreadyConnected.style.display = 'block';

        // Refresh status
        setTimeout(() => fetchStatus(), 1000);
      }

      btnGenerateQR.disabled = false;
    } catch (error) {
      console.error('Error generating QR:', error);
      qrLoading.style.display = 'none';
      alert(`Error al generar QR Code: ${error.message}`);
      btnGenerateQR.disabled = false;
    }
  }

  async function generatePairingCode() {
    const phoneNumber = phoneInput.value.trim();

    // Validate
    if (!phoneNumber) {
      alert('Por favor, ingresa tu número de teléfono');
      phoneInput.focus();
      return;
    }

    if (!/^\d{1,15}$/.test(phoneNumber)) {
      alert('Formato inválido. Ingresa solo dígitos (sin el signo +), máximo 15 caracteres.');
      phoneInput.focus();
      return;
    }

    try {
      pairingOutput.style.display = 'block';
      pairingLoading.style.display = 'flex';
      pairingCodeDisplay.style.display = 'none';
      btnGeneratePairing.disabled = true;

      const response = await fetch(`/panel/pairing/${locationId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phoneNumber })
      });

      const data = await response.json();

      pairingLoading.style.display = 'none';

      if (response.ok && data.pairingCode) {
        // Success - Show pairing code
        pairingCodeEl.textContent = data.pairingCode;
        pairingCodeDisplay.style.display = 'block';

        // Start polling
        startPolling();
      } else if (data.fallbackToQR) {
        // Failed - Fallback to QR
        alert('El código de vinculación no está disponible. Te cambiaremos al método de QR Code.');

        // Switch to QR tab
        switchTab('qr');

        // Auto-generate QR
        setTimeout(() => generateQRCode(), 500);
      } else {
        throw new Error(data.error || 'Error desconocido');
      }

      btnGeneratePairing.disabled = false;
    } catch (error) {
      console.error('Error generating pairing code:', error);
      pairingLoading.style.display = 'none';
      alert(`Error al generar código de vinculación: ${error.message}`);
      btnGeneratePairing.disabled = false;
    }
  }

  function startPolling() {
    stopPolling(); // Clear any existing polling
    pollCount = 0;
    pollingStatus.style.display = 'flex';

    pollingInterval = setInterval(async () => {
      pollCount++;

      try {
        const response = await fetch(`/panel/status/${locationId}`);
        const data = await response.json();

        if (data.state === 'open') {
          // Connected!
          stopPolling();
          showSuccessMessage();

          // Refresh full status after a moment
          setTimeout(() => {
            fetchStatus();
            resetOutputs();
          }, 2000);
        } else if (pollCount >= MAX_POLL_COUNT) {
          // Timeout
          stopPolling();
          alert('Tiempo de espera agotado. Por favor, intenta nuevamente.');
        }
      } catch (error) {
        console.error('Polling error:', error);
        // Continue polling despite errors
      }
    }, 3000); // Poll every 3 seconds
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    pollCount = 0;
    pollingStatus.style.display = 'none';
  }

  function showSuccessMessage() {
    pollingStatus.innerHTML = '<div class="success-icon"></div><span>Conectado exitosamente!</span>';
    pollingStatus.style.backgroundColor = '#4CAF50';
    pollingStatus.style.color = 'white';
  }

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
