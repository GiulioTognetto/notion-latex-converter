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
  const titleEl = document.querySelector(".notion-page-block [contenteditable='true']") || document.querySelector("title");
  if (titleEl) {
    const text = titleEl.innerText || titleEl.textContent;
    if (text && text.trim()) {
      return text.replace(" | Notion", "").trim();
    }
  }
  return "Notion Page";
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

/**
 * Decodes HTML entities (e.g. &lt; -> <) and normalizes tabs and escaped characters
 */
function normalizeLatexText(text) {
  if (!text) return "";
  return text
    .replace(/\t/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\\{2}/g, "\\"); // Fix double escaping if present
}

/**
 * Parses inline $...$ syntax into rich_text elements
 */
function parseInlineLatex(text) {
  const richText = [];
  const regex = /\$([^\$]+?)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      if (plainText) {
        richText.push({ type: "text", text: { content: plainText } });
      }
    }

    const formula = match[1].trim();
    if (formula) {
      richText.push({ type: "equation", equation: { expression: formula } });
    }

    lastIndex = regex.lastIndex;
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
    if (startCursor) url += `&start_cursor=${startCursor}`;

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

  const childFetchPromises = allBlocks
    .filter(block => block.has_children)
    .map(async (block) => {
      const subBlocks = await fetchAllBlocksRecursive(block.id, apiKey);
      return subBlocks;
    });

  if (childFetchPromises.length > 0) {
    const nestedBlocksArrays = await Promise.all(childFetchPromises);
    for (const nestedArray of nestedBlocksArrays) {
      allBlocks.push(...nestedArray);
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

    const fullText = normalizeLatexText(rawFullText);

    // CASE 1: Contains Block Formula ($$...$$)
    if (/\$\$[\s\S]+?\$\$/.test(fullText)) {
      modifiedCount++;
      const parts = fullText.split(/(\$\$[\s\S]+?\$\$)/g);
      const newBlocksToAppend = [];
      let firstBlockRichText = null;
      let convertOriginalBlockToEquation = false;

      for (const part of parts) {
        if (!part) continue;

        if (part.startsWith("$$") && part.endsWith("$$")) {
          const expr = part.slice(2, -2).trim();
          if (expr) {
            if (firstBlockRichText === null && newBlocksToAppend.length === 0) {
              convertOriginalBlockToEquation = true;
              firstBlockRichText = expr;
            } else {
              newBlocksToAppend.push({
                object: "block",
                type: "equation",
                equation: { expression: expr }
              });
            }
          }
        } else {
          const parsedInline = parseInlineLatex(part);
          if (parsedInline.length > 0) {
            if (firstBlockRichText === null && !convertOriginalBlockToEquation) {
              firstBlockRichText = parsedInline;
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
        type: convertOriginalBlockToEquation ? "convert_block_to_equation" : "block_split",
        blockId: block.id,
        parentId: block.parent?.block_id || block.parent?.page_id,
        firstBlockData: firstBlockRichText,
        blockType: blockType,
        newBlocksToAppend: newBlocksToAppend
      });
    } 
    // CASE 2: Contains Inline Formula ($...$)
    else if (/\$([^\$]+?)\$/.test(fullText)) {
      modifiedCount++;
      const newRichText = parseInlineLatex(fullText);
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
    } else if (op.type === "convert_block_to_equation") {
      await fetch(`https://api.notion.com/v1/blocks/${op.blockId}`, {
        method: "PATCH",
        signal: abortController?.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "equation",
          equation: { expression: op.firstBlockData }
        })
      });

      if (op.newBlocksToAppend.length > 0 && op.parentId) {
        await fetch(`https://api.notion.com/v1/blocks/${op.parentId}/children`, {
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
    } else if (op.type === "block_split") {
      await fetch(`https://api.notion.com/v1/blocks/${op.blockId}`, {
        method: "PATCH",
        signal: abortController?.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          [op.blockType]: { rich_text: op.firstBlockData }
        })
      });

      if (op.newBlocksToAppend.length > 0 && op.parentId) {
        await fetch(`https://api.notion.com/v1/blocks/${op.parentId}/children`, {
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