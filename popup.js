document.addEventListener("DOMContentLoaded", async () => {
  const setupView = document.getElementById("setup-view");
  const connectedView = document.getElementById("connected-view");

  const apiKeyInput = document.getElementById("api-key-input");
  const saveBtn = document.getElementById("save-btn");
  const cancelBtn = document.getElementById("cancel-btn");
  const convertBtn = document.getElementById("convert-btn");
  const stopBtn = document.getElementById("stop-btn");
  const editTokenBtn = document.getElementById("edit-token-btn");
  const statusMsg = document.getElementById("status-message");

  let existingToken = null;

  async function init() {
    const storedData = await chrome.storage.local.get("notion_api_key");
    existingToken = storedData.notion_api_key || null;

    if (existingToken) {
      showConnectedView();
    } else {
      showSetupView(false);
    }
  }

  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();

    if (key.startsWith("ntn_") || key.startsWith("secret_")) {
      await chrome.storage.local.set({ notion_api_key: key });
      existingToken = key;
      showConnectedView();
      statusMsg.style.color = "#059669";
      statusMsg.innerText = "✓ Token salvato!";
    } else {
      statusMsg.style.color = "#dc2626";
      statusMsg.innerText = "⚠️ Il token deve iniziare con 'ntn_' o 'secret_'";
    }
  });

  editTokenBtn.addEventListener("click", () => {
    showSetupView(true);
    apiKeyInput.value = existingToken || "";
    statusMsg.innerText = "";
  });

  cancelBtn.addEventListener("click", () => {
    showConnectedView();
    statusMsg.innerText = "";
  });

  // Avvia la conversione
  convertBtn.addEventListener("click", async () => {
    statusMsg.style.color = "#2563eb";
    statusMsg.innerText = "⏳ Lettura ed elaborazione pagina...";
    
    convertBtn.style.display = "none";
    stopBtn.style.display = "block";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || (!tab.url.includes("notion.so") && !tab.url.includes("notion.com"))) {
      statusMsg.style.color = "#dc2626";
      statusMsg.innerText = "⚠️ Apri una pagina di Notion prima di convertire.";
      resetButtons();
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: "start_conversion" }, (response) => {
      resetButtons();

      if (chrome.runtime.lastError) {
        statusMsg.style.color = "#dc2626";
        statusMsg.innerText = "❌ Ricarica la pagina Notion e riprova.";
        return;
      }

      if (response && response.success) {
        statusMsg.style.color = "#059669";
        statusMsg.innerText = `✓ Pagina aggiornata! Convertiti ${response.count} blocchi.`;
      } else {
        statusMsg.style.color = "#dc2626";
        statusMsg.innerText = `❌ ${response?.error || "Operazione annullata"}`;
      }
    });
  });

  // Pulsante di Stop
  stopBtn.addEventListener("click", async () => {
    statusMsg.style.color = "#dc2626";
    statusMsg.innerText = "⏹️ Interruzione in corso...";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "stop_conversion" }, () => {
        resetButtons();
        statusMsg.innerText = "⏹️ Operazione interrotta dall'utente.";
      });
    } else {
      resetButtons();
    }
  });

  function resetButtons() {
    convertBtn.style.display = "block";
    stopBtn.style.display = "none";
  }

  function showConnectedView() {
    setupView.style.display = "none";
    connectedView.style.display = "block";
    resetButtons();
    statusMsg.innerText = "";
  }

  function showSetupView(isEditing) {
    setupView.style.display = "block";
    connectedView.style.display = "none";
    cancelBtn.style.display = isEditing ? "block" : "none";
    statusMsg.innerText = "";
  }

  init();
});