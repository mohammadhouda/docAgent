'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import FolderSelector from '@/components/FolderSelector';
import DocumentList from '@/components/DocumentList';
import ChatInterface from '@/components/ChatInterface';
import { getDocuments, deleteDocuments, DocumentMeta } from '@/lib/api';

export default function HomePage() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const refreshDocuments = useCallback(async () => {
    try {
      const data = await getDocuments();
      setDocuments(data.documents);
    } catch {
      // Server may not be ready
    }
  }, []);

  const handleDeleteDocuments = useCallback(async () => {
    await deleteDocuments();
    setDocuments([]);
  }, []);

  useEffect(() => {
    refreshDocuments();
  }, [refreshDocuments]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? 'w-72' : 'w-0'
        } transition-all duration-200 flex-shrink-0 bg-white border-r border-gray-200 overflow-hidden`}
      >
        <div className="w-72 h-full flex flex-col">
          {/* Header */}
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-6 h-6 text-blue-600" />
              <h1 className="font-bold text-gray-900">DocAgent</h1>
            </div>
            <FolderSelector onIngestSuccess={refreshDocuments} />
          </div>

          {/* Document list */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Documents ({documents.length})
              </h2>
              <button
                onClick={refreshDocuments}
                className="text-gray-400 hover:text-gray-600"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <DocumentList documents={documents} onDelete={handleDeleteDocuments} />
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 bg-gray-50">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shrink-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div>
            <h2 className="font-semibold text-gray-800 text-sm">AI Document Q&amp;A</h2>
            <p className="text-xs text-gray-400">
              {documents.length > 0
                ? `${documents.length} document(s) loaded`
                : 'No documents loaded — use the sidebar to load a folder'}
            </p>
          </div>
        </header>

        {/* Chat */}
        <div className="flex-1 overflow-hidden">
          <ChatInterface />
        </div>
      </main>
    </div>
  );
}
