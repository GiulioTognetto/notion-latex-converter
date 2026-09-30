let isProcessing = false;
let abortController = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_conversion") {
    if (isProcessing) {
      sendResponse({ success: false, error: "Conversion is already running." });
      return true;
    }

    isProcessing = true;
    abortController = new AbortController();

    const detectedPageTitle = getPageTitle();

    updateState({ 
      isProcessing: true, 
      pageTitle: detectedPageTitle,
      pageUrl: window.location.href,
      current: 0, 
      total: 0, 
      message: "Scanning page blocks...", 
      lastResult: null 
    });

    convertPageInMemory()
      .then((result) => {
        updateState({ isProcessing: false, lastResult: result });
        sendResponse(result);
      })
      .catch((err) => {
        updateState({ isProcessing: false, lastResult: { success: false, error: err.message } });
        sendResponse({ success: false, error: err.message });
      })
      .finally(() => {
        isProcessing = false;
        abortController = null;
      });

    return true;
  }

  if (request.action === "stop_conversion") {
    isProcessing = false;
    if (abortController) {
      abortController.abort();
    }
    updateState({ isProcessing: false, lastResult: { success: false, error: "Operation stopped by user." } });
    sendResponse({ success: true, stopped: true });
    return true;
  }
});

function getPageTitle() {
  const titleSelectors = [
    ".notion-page-block [contenteditable='true']",
    "[data-content-editable-leaf='true']",
    ".notion-header-block [contenteditable='true']",
    "h1.notion-page-block"
  ];

  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = el.innerText || el.textContent;
      if (text && text.trim()) {
        return text.trim();
      }
    }
  }

  if (document.title && document.title.trim()) {
    const cleanedTitle = document.title
      .replace(/\| Notion$/i, "")
      .replace(/– Notion$/i, "")
      .replace(/- Notion$/i, "")
      .trim();

    if (cleanedTitle && cleanedTitle !== "Notion") {
      return cleanedTitle;
    }
  }

  return "Active Notion Page";
}

function updateState(partialState) {
  chrome.storage.local.get("conversionState", (data) => {
    const currentState = data.conversionState || {};
    chrome.storage.local.set({
      conversionState: { ...currentState, ...partialState }
    });
  });
}

async function getStoredApiKey() {
  const data = await chrome.storage.local.get("notion_api_key");
  return data.notion_api_key || null;
}

function getPageIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/([a-f0-9]{32})/i) || 
                path.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);

  return match ? match[1].replace(/-/g, "") : null;
}

function sanitizeRawText(text) {
  if (!text) return "";
  return text
    .replace(/\r?\n|\r/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\t/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseInlineLatexToRichText(rawText) {
  const richText = [];
  const text = sanitizeRawText(rawText);

  const inlineRegex = /\$([^\$]+?)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      if (plainText) {
        richText.push({ type: "text", text: { content: plainText } });
      }
    }

    const formula = match[1].trim();
    if (formula) {
      richText.push({
        type: "equation",
        equation: { expression: formula }
      });
    }

    lastIndex = inlineRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
      richText.push({ type: "text", text: { content: remainingText } });
    }
  }

  return richText;
}

async function fetchAllBlocksRecursive(parentId, apiKey) {
  let allBlocks = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore && isProcessing) {
    let url = `https://api.notion.com/v1/blocks/${parentId}/children?page_size=100`;
    if (startCursor) {
      url += `&start_cursor=${startCursor}`;
    }

    const response = await fetch(url, {
      signal: abortController?.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28"
      }
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || "Failed to retrieve page blocks.");
    }

    const data = await response.json();
    allBlocks.push(...data.results);

    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }

  for (const block of [...allBlocks]) {
    if (!isProcessing) break;

    if (block.has_children) {
      const subBlocks = await fetchAllBlocksRecursive(block.id, apiKey);
      allBlocks.push(...subBlocks);
    }
  }

  return allBlocks;
}

function processBlocksInMemory(blocks) {
  let modifiedCount = 0;
  const operations = [];

  for (const block of blocks) {
    if (!isProcessing) break;

    const blockType = block.type;
    const blockData = block[blockType];

    if (!blockData || !Array.isArray(blockData.rich_text) || blockData.rich_text.length === 0) {
      continue;
    }

    const rawFullText = blockData.rich_text
      .map(t => {
        if (t.type === "text") return t.plain_text || t.text?.content || "";
        if (t.type === "equation") return `$${t.equation?.expression || ""}$`;
        return "";
      })
      .join("");

    const fullText = sanitizeRawText(rawFullText).trim();

    if (/\$\$[\s\S]+?\$\$/.test(fullText)) {
      modifiedCount++;
      const parts = fullText.split(/(\$\$[\s\S]+?\$\$)/g);
      const newBlocksToAppend = [];
      let leadingTextRichText = null;

      for (const part of parts) {
        if (!part) continue;

        if (part.startsWith("$$") && part.endsWith("$$")) {
          const expr = part.slice(2, -2).trim();
          if (expr) {
            newBlocksToAppend.push({
              object: "block",
              type: "equation",
              equation: { expression: expr }
            });
          }
        } else {
          const parsedInline = parseInlineLatexToRichText(part);
          if (parsedInline.length > 0) {
            if (leadingTextRichText === null && newBlocksToAppend.length === 0) {
              leadingTextRichText = parsedInline;
            } else {
              newBlocksToAppend.push({
                object: "block",
                type: blockType,
                [blockType]: { rich_text: parsedInline }
              });
            }
          }
        }
      }

      operations.push({
        type: "block_equation_replace",
        blockId: block.id,
        parentId: block.parent?.block_id || block.parent?.page_id,
        leadingTextRichText: leadingTextRichText,
        blockType: blockType,
        newBlocksToAppend: newBlocksToAppend
      });
    } else if (/\$([^\$]+?)\$/.test(fullText)) {
      modifiedCount++;
      const newRichText = parseInlineLatexToRichText(fullText);
      operations.push({
        type: "inline_patch",
        blockId: block.id,
        payload: {
          [blockType]: { rich_text: newRichText }
        }
      });
    }
  }

  return { modifiedCount, operations };
}

async function applyChanges(operations, apiKey) {
  if (!isProcessing) throw new Error("Operation cancelled by user.");

  const total = operations.length;
  let current = 0;

  for (const op of operations) {
    if (!isProcessing) throw new Error("Operation cancelled by user.");

    if (op.type === "inline_patch") {
      await fetch(`https://api.notion.com/v1/blocks/${op.blockId}`, {
        method: "PATCH",
        signal: abortController?.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(op.payload)
      });
    } else if (op.type === "block_equation_replace") {
      const parentId = op.parentId;

      if (!parentId) {
        current++;
        updateState({ current, total });
        continue;
      }

      if (op.newBlocksToAppend.length > 0) {
        await fetch(`https://api.notion.com/v1/blocks/${parentId}/children`, {
          method: "PATCH",
          signal: abortController?.signal,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            children: op.newBlocksToAppend,
            after: op.blockId
          })
        });
      }

      if (op.leadingTextRichText && op.leadingTextRichText.length > 0) {
        await fetch(`https://api.notion.com/v1/blocks/${op.blockId}`, {
          method: "PATCH",
          signal: abortController?.signal,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            [op.blockType]: { rich_text: op.leadingTextRichText }
          })
        });
      } else {
        await fetch(`https://api.notion.com/v1/blocks/${op.blockId}`, {
          method: "DELETE",
          signal: abortController?.signal,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28"
          }
        });
      }
    }

    current++;
    updateState({ current, total });
  }
}

async function convertPageInMemory() {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error("Notion token not found.");

  const pageId = getPageIdFromUrl();
  if (!pageId) throw new Error("Could not detect Page ID from URL.");

  const blocks = await fetchAllBlocksRecursive(pageId, apiKey);

  if (!isProcessing) throw new Error("Operation cancelled by user.");

  const { modifiedCount, operations } = processBlocksInMemory(blocks);

  if (modifiedCount === 0) {
    throw new Error("No LaTeX formulas found to convert on this page.");
  }

  updateState({ current: 0, total: operations.length, message: "Applying updates..." });

  await applyChanges(operations, apiKey);

  if (isProcessing) {
    return { success: true, count: modifiedCount };
  } else {
    throw new Error("Operation cancelled.");
  }
}