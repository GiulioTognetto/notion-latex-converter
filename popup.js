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
  const progressContainer = document.getElementById("progress-container");
  const progressBar = document.getElementById("progress-bar");
  const pageTracker = document.getElementById("page-tracker");
  const pageLink = document.getElementById("page-link");

  let existingToken = null;
  let targetTabId = null;
  let targetPageUrl = null;

  async function init() {
    const storedData = await chrome.storage.local.get(["notion_api_key", "conversionState"]);
    existingToken = storedData.notion_api_key || null;

    if (existingToken) {
      showConnectedView();
      if (storedData.conversionState) {
        updateUIFromState(storedData.conversionState);
      }
    } else {
      showSetupView(false);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.conversionState) {
      updateUIFromState(changes.conversionState.newValue);
    }
  });

  function updateUIFromState(state) {
    if (!state) return;

    if (state.tabId) targetTabId = state.tabId;
    if (state.pageUrl) targetPageUrl = state.pageUrl;

    if (state.isProcessing) {
      convertBtn.style.display = "none";
      stopBtn.style.display = "block";
      
      if (state.pageTitle) {
        pageTracker.style.display = "block";
        pageLink.innerText = state.pageTitle;
      } else {
        pageTracker.style.display = "none";
      }

      if (state.total > 0) {
        progressContainer.style.display = "block";
        const percent = Math.min(100, Math.round((state.current / state.total) * 100));
        progressBar.style.width = `${percent}%`;
        statusMsg.style.color = "#2563eb";
        statusMsg.innerText = `⏳ Processing: ${state.current} / ${state.total} expressions...`;
      } else {
        progressContainer.style.display = "none";
        statusMsg.style.color = "#2563eb";
        statusMsg.innerText = state.message || "⏳ Scanning page blocks...";
      }
    } else {
      resetButtons();
      pageTracker.style.display = "none";
      progressContainer.style.display = "none";
      progressBar.style.width = "0%";

      if (state.lastResult) {
        if (state.lastResult.success) {
          statusMsg.style.color = "#059669";
          statusMsg.innerText = `✓ Page updated! Converted ${state.lastResult.count} expression(s).`;
        } else {
          statusMsg.style.color = "#dc2626";
          statusMsg.innerText = `❌ ${state.lastResult.error || "Operation stopped"}`;
        }
      }
    }
  }

  // Focus target tab on link click
  pageLink.addEventListener("click", async (e) => {
    e.preventDefault();
    if (targetTabId) {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        if (tab) {
          chrome.tabs.update(targetTabId, { active: true });
          chrome.windows.update(tab.windowId, { focused: true });
          return;
        }
      } catch (err) {
        // Tab was closed
      }
    }
    
    if (targetPageUrl) {
      chrome.tabs.create({ url: targetPageUrl });
    }
  });

  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();

    if (key.startsWith("ntn_") || key.startsWith("secret_")) {
      await chrome.storage.local.set({ notion_api_key: key });
      existingToken = key;
      showConnectedView();
      statusMsg.style.color = "#059669";
      statusMsg.innerText = "✓ Token saved successfully!";
    } else {
      statusMsg.style.color = "#dc2626";
      statusMsg.innerText = "⚠️ Token must start with 'ntn_' or 'secret_'";
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

  convertBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || (!tab.url.includes("notion.so") && !tab.url.includes("notion.com"))) {
      statusMsg.style.color = "#dc2626";
      statusMsg.innerText = "⚠️ Please open a Notion page before converting.";
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: "start_conversion" }, (response) => {
      if (chrome.runtime.lastError) {
        statusMsg.style.color = "#dc2626";
        statusMsg.innerText = "❌ Please reload the Notion page and try again.";
      }
    });
  });

  stopBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "stop_conversion" });
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