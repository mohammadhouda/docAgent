'use client';

import { FileText, MapPin } from 'lucide-react';
import { SourceReference as SourceRef } from '@/lib/api';

interface Props {
  sources: SourceRef[];
}

export default function SourceReferenceList({ sources }: Props) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Sources</p>
      {sources.map((src, i) => (
        <div key={i} className="border border-gray-200 rounded-lg p-3 bg-gray-50 text-sm">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-blue-500 shrink-0" />
            <span className="font-medium text-gray-800 truncate">{src.documentName}</span>
          </div>
          <div className="flex items-center gap-1 text-gray-500 mb-1">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="text-xs">{src.location}</span>
          </div>
          {src.excerpt && (
            <p className="text-xs text-gray-600 italic line-clamp-3">"{src.excerpt}"</p>
          )}
        </div>
      ))}
    </div>
  );
}
