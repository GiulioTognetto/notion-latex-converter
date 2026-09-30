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

    convertPageInMemory()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }))
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
    sendResponse({ success: true, stopped: true });
    return true;
  }
});

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
 * Normalizes text and creates 'equation' and 'text' nodes
 */
function parseTextToRichText(rawText) {
  const richText = [];
  const text = rawText.replace(/\t/g, " ");

  const latexRegex = /(\$\$[\s\S]+?\$\$|\$[^\$]+?\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = latexRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index);
      if (plainText) {
        richText.push({ type: "text", text: { content: plainText } });
      }
    }

    const fullMatch = match[0];
    let expression = "";

    if (fullMatch.startsWith("$$") && fullMatch.endsWith("$$")) {
      expression = fullMatch.slice(2, -2).trim();
    } else if (fullMatch.startsWith("$") && fullMatch.endsWith("$")) {
      expression = fullMatch.slice(1, -1).trim();
    }

    if (expression) {
      richText.push({
        type: "equation",
        equation: { expression: expression }
      });
    }

    lastIndex = latexRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
      richText.push({ type: "text", text: { content: remainingText } });
    }
  }

  return richText;
}

/**
 * RECURSIVELY fetches all blocks and child blocks across all hierarchy levels
 */
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

/**
 * Processes all retrieved blocks in memory
 */
function processBlocksInMemory(blocks) {
  let modifiedCount = 0;
  const updatedBlocksPayload = [];

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

    const fullText = rawFullText.replace(/\t/g, " ");

    if (/(\$\$[\s\S]+?\$\$|\$[^\$]+?\$)/.test(fullText)) {
      const newRichText = parseTextToRichText(fullText);
      const hasEquations = newRichText.some(item => item.type === "equation");

      if (hasEquations) {
        modifiedCount++;
        updatedBlocksPayload.push({
          blockId: block.id,
          payload: {
            [blockType]: {
              rich_text: newRichText
            }
          }
        });
      }
    }
  }

  return { modifiedCount, updatedBlocksPayload };
}

/**
 * Sends all update requests to Notion in parallel
 */
async function applyChanges(updatedBlocksPayload, apiKey) {
  if (!isProcessing) throw new Error("Operation cancelled by user.");

  const patchPromises = updatedBlocksPayload.map(item => {
    return fetch(`https://api.notion.com/v1/blocks/${item.blockId}`, {
      method: "PATCH",
      signal: abortController?.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(item.payload)
    }).then(res => res.ok);
  });

  await Promise.all(patchPromises);
}

/**
 * Main Flow
 */
async function convertPageInMemory() {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error("Notion token not found.");

  const pageId = getPageIdFromUrl();
  if (!pageId) throw new Error("Could not detect Page ID from URL.");

  const blocks = await fetchAllBlocksRecursive(pageId, apiKey);

  if (!isProcessing) throw new Error("Operation cancelled by user.");

  const { modifiedCount, updatedBlocksPayload } = processBlocksInMemory(blocks);

  if (modifiedCount === 0) {
    throw new Error("No LaTeX formulas found to convert on this page.");
  }

  await applyChanges(updatedBlocksPayload, apiKey);

  if (isProcessing) {
    setTimeout(() => window.location.reload(), 500);
    return { success: true, count: modifiedCount };
  } else {
    throw new Error("Operation cancelled.");
  }
}