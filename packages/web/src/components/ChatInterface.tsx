'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Trash2 } from 'lucide-react';
import {
  askQuestion,
  createConversation,
  getConversationMessages,
  deleteConversation,
  StoredMessage,
} from '@/lib/api';
import MessageBubble, { Message } from './MessageBubble';
import LoadingIndicator from './LoadingIndicator';

const SUGGESTED_QUESTIONS = [
  'What documents are loaded?',
  'List all cost items above SAR 1 million',
  'Extract all dates and deliverables',
  'Summarize the scope of work',
];

const CONVERSATION_KEY = 'docagent_conversation_id';

let messageIdCounter = 0;
function nextId() {
  return String(++messageIdCounter);
}

function storedToMessage(s: StoredMessage): Message {
  return {
    id:        nextId(),
    role:      s.role,
    content:   s.content ?? '',
    answer:    s.answer,
    sources:   s.sources,
    toolsUsed: s.toolsUsed,
  };
}

export default function ChatInterface() {
  const [messages, setMessages]             = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [loadingStatus, setLoadingStatus]   = useState('Analysing your question…');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // On mount: load or create a conversation, then fetch its messages
  useEffect(() => {
    async function init() {
      let id = localStorage.getItem(CONVERSATION_KEY);

      if (id) {
        try {
          const { messages: stored } = await getConversationMessages(id);
          setMessages(stored.map(storedToMessage));
          setConversationId(id);
          return;
        } catch {
          // Conversation no longer exists (e.g. DB was reset) — create a new one
          localStorage.removeItem(CONVERSATION_KEY);
        }
      }

      const { id: newId } = await createConversation();
      localStorage.setItem(CONVERSATION_KEY, newId);
      setConversationId(newId);
    }
    init();
  }, []);

  const clearChat = useCallback(async () => {
    if (!conversationId) return;
    await deleteConversation(conversationId);
    const { id: newId } = await createConversation();
    localStorage.setItem(CONVERSATION_KEY, newId);
    setConversationId(newId);
    setMessages([]);
  }, [conversationId]);

  const sendMessage = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || loading || !conversationId) return;

    const userMsg: Message        = { id: nextId(), role: 'user', content: question };
    const assistantId             = nextId();
    const placeholderMsg: Message = { id: assistantId, role: 'assistant', content: '' };

    setMessages((prev) => [...prev, userMsg, placeholderMsg]);
    setInput('');
    setLoading(true);
    setLoadingStatus('Analysing your question…');

    try {
      const result = await askQuestion(question, conversationId, [], (status) => {
        setLoadingStatus(status);
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, answer: result.answer, sources: result.sources, toolsUsed: result.toolsUsed }
            : m,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: `Error: ${msg}` } : m)),
      );
    } finally {
      setLoading(false);
      setLoadingStatus('');
    }
  }, [loading, conversationId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-gray-700 mb-1">Ask your documents</h2>
              <p className="text-sm text-gray-400">
                Load documents in the sidebar, then ask questions below.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full px-4">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  className="text-left text-sm px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:bg-blue-50 transition-colors shadow-sm"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {loading && (
          <div className="flex justify-start">
            <LoadingIndicator status={loadingStatus} />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 bg-white p-4">
        <div className="flex gap-3 items-end max-w-4xl mx-auto">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your documents… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 resize-none px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm max-h-32 overflow-y-auto"
            style={{ minHeight: '48px' }}
          />
          <button
            onClick={clearChat}
            disabled={loading || messages.length === 0}
            title="Clear chat"
            className="p-3 text-gray-400 rounded-xl hover:bg-gray-100 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => sendMessage(input)}
            disabled={loading || !input.trim()}
            className="p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
