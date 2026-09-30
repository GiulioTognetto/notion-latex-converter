let isProcessing = false;
let abortController = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_conversion") {
    if (isProcessing) {
      sendResponse({ success: false, error: "Conversione già in corso." });
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
 * Normalizza il testo ed estrae nodi 'equation' e 'text'
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
 * Scansiona ed estrae RICORSIVAMENTE tutti i blocchi e sotto-blocchi della pagina
 */
async function fetchAllBlocksRecursive(parentId, apiKey) {
  let allBlocks = [];
  let hasMore = true;
  let startCursor = undefined;

  // 1. Recupera tutti i figli diretti del blocco/pagina corrente
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
      throw new Error(err.message || "Errore durante la lettura dei blocchi.");
    }

    const data = await response.json();
    allBlocks.push(...data.results);

    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }

  // 2. Se tra i blocchi ce ne sono alcuni con sotto-blocchi (Callout, Toggle, Liste, Colonne, ecc.)
  // esegue la ricerca ricorsiva nei figli
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
 * Analizza la lista completa di tutti i blocchi (inclusi i sotto-livelli)
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

    // Ricostruisce il testo grezzo (gestendo anche blocchi con equazioni parziali)
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
 * Invia le modifiche in parallelo per tutti i blocchi modificati
 */
async function applyChanges(updatedBlocksPayload, apiKey) {
  if (!isProcessing) throw new Error("Operazione interrotta dall'utente.");

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
 * Flusso Principale
 */
async function convertPageInMemory() {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error("Token Notion non trovato.");

  const pageId = getPageIdFromUrl();
  if (!pageId) throw new Error("ID pagina non trovato nell'URL.");

  // Scarica l'albero completo dei blocchi a qualsiasi livello di annidamento
  const blocks = await fetchAllBlocksRecursive(pageId, apiKey);

  if (!isProcessing) throw new Error("Operazione interrotta dall'utente.");

  const { modifiedCount, updatedBlocksPayload } = processBlocksInMemory(blocks);

  if (modifiedCount === 0) {
    throw new Error("Nessuna formula da convertire trovata nella pagina.");
  }

  await applyChanges(updatedBlocksPayload, apiKey);

  if (isProcessing) {
    setTimeout(() => window.location.reload(), 500);
    return { success: true, count: modifiedCount };
  } else {
    throw new Error("Operazione interrotta.");
  }
}