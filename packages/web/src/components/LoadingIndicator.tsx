'use client';

interface Props {
  status?: string;
}

export default function LoadingIndicator({ status }: Props) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 bg-white rounded-2xl rounded-tl-none shadow-sm max-w-xs">
      <div className="flex gap-1 shrink-0">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
      </div>
      <span className="text-sm text-gray-500 truncate">{status ?? 'Analysing documents…'}</span>
    </div>
  );
}
