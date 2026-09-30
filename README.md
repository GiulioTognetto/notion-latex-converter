# Notion LaTeX Converter ⚡

A fast, lightweight, and privacy-first Chrome Extension that converts raw LaTeX syntax (`$inline$` and `$$block$$`) into native Notion equation blocks across your entire Notion page.

---

## ✨ Features

- **Zero Backend Required:** Operates directly from your browser using your own Notion Integration Secret (`ntn_...`). Your token never leaves your local device (`chrome.storage.local`).
- **Recursive Page Scanning:** Detects and converts LaTeX formulas inside all nested structures, including Callouts, Toggle Lists, Bullet/Numbered Lists, Columns, and Tables.
- **High-Speed Parallel Engine:** Processes and updates page blocks concurrently using `Promise.all()` for near-instant execution.
- **In-Memory Parsing:** Reads the page structure first, parses formulas locally, and applies changes cleanly without corrupting existing content.
- **Cancellation Control:** Integrated **Stop** button with `AbortController` to interrupt conversion at any point.
- **Full LaTeX & KaTeX Compatibility:** Preserves complex commands (`\quad`, `\longrightarrow`, `\mathbb{R}`, multiline matrices, and cases) without character stripping.
- **Supports All Notion Domains:** Works seamlessly on `notion.so` and `app.notion.com`.

---

## 🚀 Installation & Setup

### 1. Install the Extension
1. Clone or download this repository.
   ```bash
   git clone [https://github.com/GiulioTognetto/notion-latex-converter.git](https://github.com/GiulioTognetto/notion-latex-converter.git)
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder containing the project files.

---

### 2. Connect Your Notion Integration (One-time Setup)

1. Go to [notion.so/my-integrations](https://www.google.com/search?q=https://www.notion.so/my-integrations) and click **New integration**.
2. Name your integration (e.g., `LaTeX Converter`) and select your workspace.
3. Copy the **Internal Integration Secret** (it starts with `ntn_`).
4. Click the **Notion LaTeX Converter** extension icon in your Chrome toolbar, paste the token, and click **Save & Connect**.
5. Open the Notion page you want to convert, click the **`...` (More)** menu at the top right, navigate to **Connections**, and add your integration.

---

## 🛠️ How to Use

1. Open any page on Notion (`notion.so` or `app.notion.com`).
2. Write your equations using standard LaTeX syntax:
* **Inline formulas:** `$e^{i\pi} + 1 = 0$`
* **Block formulas:** `$$\arcsin: [-1, 1] \longrightarrow \left[-\frac{\pi}{2}, \frac{\pi}{2}\right]$$`


3. Click the extension icon in your browser toolbar.
4. Click **⚡ Convert LaTeX on Active Page**.
5. The extension will scan the page, convert all matches to native Notion equations, and automatically refresh the view upon completion.

---

## 🔒 Privacy & Security

* **No Remote Servers:** The extension communicates exclusively with `https://api.notion.com/v1/*`.
* **Local Credentials:** Your API key is stored securely in your browser's `chrome.storage.local`.
* **Open Source:** Every line of code running in your browser is fully transparent and open for inspection in this repository.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://www.google.com/search?q=https://github.com/GiulioTognetto/notion-latex-converter/issues) if you want to contribute or report a bug.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).