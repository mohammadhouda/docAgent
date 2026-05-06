import OpenAI from 'openai';
import { config } from '../config.js';
import { openaiClient, SYSTEM_PROMPT } from './openai.js';
import { toolDefinitions, executeTool } from '../tools/index.js';
import { documentStore } from './documentStore.js';
import { updateRequestStatus } from './requestStatus.js';
import { AskResponse, ConversationMessage, DocumentProfileEntry, SourceReference, StructuredAnswer } from '../types/index.js';

const MODEL = 'gpt-5.4-mini';

let queryCounter = 0;

function dbg(queryId: number, msg: string) {
  console.debug(`[agent] Q#${queryId} ${msg}`);
}

// This service implements the core agent loop that processes user questions, interacts with the OpenAI API, executes tools, and synthesizes answers. It maintains the conversation history and tracks sources and tools used throughout the interaction. The agent iteratively calls the language model to determine which tools to use and when to stop and generate a final answer based on the accumulated information.
function parseStructuredAnswer(raw: string): StructuredAnswer {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sections)) {
      return parsed as StructuredAnswer;
    }
  } catch {
    // fall through to fallback
  }
  return { title: 'Answer', sections: [{ type: 'paragraph', content: raw }] };
}

// This function builds the message array for the OpenAI chat completion API. It includes the system prompt, the conversation history, and the current user question. The conversation history is mapped to the appropriate roles (user or assistant) to maintain context in the dialogue.

function buildDocumentContext(entries: DocumentProfileEntry[]): string {
  const valid = entries.filter((e) => e.profile != null);
  if (valid.length === 0) return '';

  const lines: string[] = ['=== LOADED DOCUMENTS ==='];

  valid.forEach((entry, i) => {
    const p = entry.profile!;
    const costPart = p.totalCost
      ? `  |  Total cost: ${p.totalCost.toLocaleString()} ${p.currency}`
      : '';

    lines.push('');
    lines.push(`[${i + 1}] ${entry.fileName}`);
    lines.push(`    Document ID : ${entry.id}`);
    lines.push(`    Type        : ${p.documentType}  |  Currency: ${p.currency}  |  Language: ${p.language}`);
    lines.push(`    Summary     : ${p.summary}`);

    if (p.keyCategories.length > 0) {
      lines.push(`    Categories  : ${p.keyCategories.join(', ')}`);
    }

    lines.push(`    Data present: ${p.availableValueTypes.join(', ') || 'none'}${costPart}`);

    if (p.sheets && p.sheets.length > 0) {
      const sheetParts = p.sheets.map((s) => {
        const cost = s.costTotal
          ? ` · ${s.costTotal.toLocaleString()} ${s.currency ?? p.currency}`
          : '';
        return `"${s.name}" [${s.role}, ${s.itemCount} items${cost}]`;
      });
      lines.push(`    Sheets      : ${sheetParts.join(' | ')}`);
    }

    if (p.queryHints.length > 0) {
      lines.push(`    Query hints :`);
      p.queryHints.forEach((h) => lines.push(`      • ${h}`));
    }

    lines.push(`    Best tools  : ${p.suggestedTools.join(', ')}`);
  });

  lines.push('');
  lines.push('IMPORTANT: The inventory above is complete. Do NOT call get_document_info(mode:"list") — Document IDs are already shown above. Use them directly in tool calls.');
  return lines.join('\n');
}

function buildMessages(
  question: string,
  history: ConversationMessage[],
  documentContext: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemContent = documentContext
    ? `${SYSTEM_PROMPT}\n\n${documentContext}`
    : SYSTEM_PROMPT;
  return [
    { role: 'system', content: systemContent },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: question },
  ];
}

// This function deduplicates source references by their document name and location. It ensures that the same source is not cited multiple times in the final answer, which helps to keep the list of sources concise and relevant. The deduplication is based on a combination of document name and location to account for different references within the same document.
function deduplicateSources(sources: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.documentName}:${s.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FALLBACK_ANSWER = '{"title":"Answer","sections":[{"type":"paragraph","content":"I processed the documents but could not generate a conclusive answer."}]}';

// This function implements the main agent loop. It takes a user question, conversation history, and an optional request ID for status updates. It interacts with the OpenAI API to determine which tools to call based on the question and accumulated information. The loop continues until the model indicates that it has enough information to generate a final answer or until a maximum number of iterations is reached. The function returns a structured answer along with the sources cited and tools used during the process.
export async function runAgent(
  question: string,
  signal: AbortSignal,
  history: ConversationMessage[] = [],
  requestId?: string,
): Promise<AskResponse> {
  if (await documentStore.count() === 0) {
    return {
      answer: {
        title: 'No Documents',
        sections: [{ type: 'paragraph', content: 'No documents are currently loaded. Please upload project files to begin analysis.' }],
      },
      sources: [],
      toolsUsed: [],
    };
  }

  const qid = ++queryCounter;
  const queryStart = Date.now();

  const profileEntries  = await documentStore.getProfiles();
  const documentContext = buildDocumentContext(profileEntries);
  const messages        = buildMessages(question, history, documentContext);
  const allSources:     SourceReference[] = [];
  const toolsUsed      = new Set<string>();
  let   totalToolCalls  = 0;

  const updateStatus = (status: string) => {
    if (requestId) updateRequestStatus(requestId, status);
  };

  updateStatus('Analysing your question…');

  for (let i = 0; i < config.maxAgentIterations; i++) {
    const loopStart = Date.now();
    const response = await openaiClient.chat.completions.create(
      { model: MODEL, messages, tools: toolDefinitions, tool_choice: 'auto', temperature: 0 },
      { signal },
    );

    const msg            = response.choices[0].message;
    const finishReason   = response.choices[0].finish_reason;
    const loopDur        = Date.now() - loopStart;
    messages.push(msg);

    if (finishReason === 'stop' || !msg.tool_calls) {
      dbg(qid, `loop=${i + 1} tools=[] dur=${loopDur}ms reason=stop`);
      dbg(qid, `DONE loops=${i + 1} toolCalls=${totalToolCalls} totalTime=${Date.now() - queryStart}ms`);
      updateStatus('Writing answer…');
      return {
        answer:    parseStructuredAnswer(msg.content ?? FALLBACK_ANSWER),
        sources:   deduplicateSources(allSources),
        toolsUsed: Array.from(toolsUsed),
      };
    }

    const toolNames = msg.tool_calls.map((tc) => tc.function.name);
    totalToolCalls += toolNames.length;
    dbg(qid, `loop=${i + 1} tools=[${toolNames.join(',')}] dur=${loopDur}ms`);
    updateStatus(`Calling ${toolNames.map((n) => n.replace(/_/g, ' ')).join(', ')}…`);

    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        toolsUsed.add(tc.function.name);
        try {
          const args   = JSON.parse(tc.function.arguments);
          const result = await executeTool(tc.function.name, args);
          if (result.sources) allSources.push(...result.sources);
          return {
            role:         'tool' as const,
            tool_call_id: tc.id,
            content:      JSON.stringify({ success: result.success, data: result.data }),
          };
        } catch {
          return {
            role:         'tool' as const,
            tool_call_id: tc.id,
            content:      JSON.stringify({ success: false, data: `Error executing ${tc.function.name}` }),
          };
        }
      }),
    );
    messages.push(...toolResults);
  }

  updateStatus('Preparing final answer…');
  const finalResponse = await openaiClient.chat.completions.create(
    { model: MODEL, messages, temperature: 0 },
    { signal },
  );
  dbg(qid, `DONE loops=${config.maxAgentIterations}(max) toolCalls=${totalToolCalls} totalTime=${Date.now() - queryStart}ms reason=max_iter`);
  return {
    answer:    parseStructuredAnswer(finalResponse.choices[0].message.content ?? FALLBACK_ANSWER),
    sources:   deduplicateSources(allSources),
    toolsUsed: Array.from(toolsUsed),
  };
}
