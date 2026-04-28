import OpenAI from 'openai';
import { config } from '../config.js';
import { openaiClient, SYSTEM_PROMPT } from './openai.js';
import { toolDefinitions, executeTool } from '../tools/index.js';
import { documentStore } from './documentStore.js';
import { updateRequestStatus } from './requestStatus.js';
import { AskResponse, ConversationMessage, SourceReference, StructuredAnswer } from '../types/index.js';

const MODEL = 'gpt-5.4-mini';

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

function buildMessages(
  question: string,
  history: ConversationMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: question },
  ];
}

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

  const messages       = buildMessages(question, history);
  const allSources:    SourceReference[] = [];
  const toolsUsed      = new Set<string>();

  const updateStatus = (status: string) => {
    if (requestId) updateRequestStatus(requestId, status);
  };

  updateStatus('Analysing your question…');

  for (let i = 0; i < config.maxAgentIterations; i++) {
    const response = await openaiClient.chat.completions.create(
      { model: MODEL, messages, tools: toolDefinitions, tool_choice: 'auto', temperature: 0 },
      { signal },
    );

    const msg = response.choices[0].message;
    messages.push(msg);

    if (response.choices[0].finish_reason === 'stop' || !msg.tool_calls) {
      updateStatus('Writing answer…');
      return {
        answer:    parseStructuredAnswer(msg.content ?? FALLBACK_ANSWER),
        sources:   deduplicateSources(allSources),
        toolsUsed: Array.from(toolsUsed),
      };
    }

    const toolNames = msg.tool_calls.map((tc) => tc.function.name);
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

  // Max iterations reached — one final synthesis call without tools
  updateStatus('Preparing final answer…');
  const finalResponse = await openaiClient.chat.completions.create(
    { model: MODEL, messages, temperature: 0 },
    { signal },
  );
  return {
    answer:    parseStructuredAnswer(finalResponse.choices[0].message.content ?? FALLBACK_ANSWER),
    sources:   deduplicateSources(allSources),
    toolsUsed: Array.from(toolsUsed),
  };
}
