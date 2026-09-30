// Inizializza lo stato dello storage locale
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    conversionState: {
      isProcessing: false,
      current: 0,
      total: 0,
      message: "",
      lastResult: null
    }
  });
});