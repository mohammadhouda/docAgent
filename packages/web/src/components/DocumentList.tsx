'use client';

import { Trash2, FileSpreadsheet, FileText } from 'lucide-react';
import { DocumentMeta } from '@/lib/api';

interface Props {
  documents: DocumentMeta[];
  onDelete?: () => void;
}

export default function DocumentList({ documents, onDelete }: Props) {
  if (documents.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No documents loaded</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {onDelete && (
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 border border-red-200 rounded-lg py-1.5 transition-colors"
        >
          <Trash2 className="w-3 h-3" />
          Remove all documents
        </button>
      )}

      {documents.map((doc) => {
        const isExcel = ['xlsx', 'xls', 'csv'].includes(doc.fileType);
        return (
          <div key={doc.id} className="p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex items-start gap-2">
              {isExcel ? (
                <FileSpreadsheet className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              ) : (
                <FileText className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate" title={doc.fileName}>
                  {doc.fileName}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      isExcel ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {doc.fileType.toUpperCase()}
                  </span>
                  <span className="text-xs text-gray-400">{doc.chunkCount} chunks</span>
                  {doc.totalPages && (
                    <span className="text-xs text-gray-400">{doc.totalPages} pages</span>
                  )}
                  {doc.totalSheets && (
                    <span className="text-xs text-gray-400">{doc.totalSheets} sheets</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
