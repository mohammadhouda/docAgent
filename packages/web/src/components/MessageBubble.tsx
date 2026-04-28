'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Wrench } from 'lucide-react';
import { SourceReference, StructuredAnswer } from '@/lib/api';
import SourceReferenceList from './SourceReference';
import StructuredAnswerView from './StructuredAnswer';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: StructuredAnswer;
  sources?: SourceReference[];
  toolsUsed?: string[];
}

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
  const [showSources, setShowSources] = useState(false);
  const isUser = message.role === 'user';
  const isEmptyAssistant = !isUser && !message.content && !message.answer;

  if (isEmptyAssistant) return null;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] ${isUser ? 'order-1' : 'order-2'}`}>
        <div
          className={`px-4 py-3 rounded-2xl shadow-sm ${
            isUser
              ? 'bg-blue-600 text-white rounded-tr-none'
              : 'bg-white text-gray-900 rounded-tl-none border border-gray-100'
          }`}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : message.answer ? (
            <StructuredAnswerView answer={message.answer} />
          ) : (
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{message.content}</p>
          )}
        </div>

        {/* Tool badges */}
        {!isUser && message.toolsUsed && message.toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1 px-1">
            {message.toolsUsed.map((tool) => (
              <span
                key={tool}
                className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full"
              >
                <Wrench className="w-2.5 h-2.5" />
                {tool.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}

        {/* Sources toggle */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="mt-2 px-1">
            <button
              onClick={() => setShowSources((v) => !v)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              {showSources ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showSources ? 'Hide' : 'Show'} {message.sources.length} source
              {message.sources.length > 1 ? 's' : ''}
            </button>
            {showSources && <SourceReferenceList sources={message.sources} />}
          </div>
        )}
      </div>
    </div>
  );
}
