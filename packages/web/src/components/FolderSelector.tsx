'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FolderOpen, Upload, AlertCircle, X, FileText, FileSpreadsheet } from 'lucide-react';
import { uploadFiles, getJobStatus } from '@/lib/api';
import UploadProgress, { JobDisplay } from './UploadProgress';

interface Props {
  onIngestSuccess: () => void;
}

const SUPPORTED = new Set(['.pdf', '.xlsx', '.xls', '.csv']);

function isSupportedFile(name: string) {
  return SUPPORTED.has(name.slice(name.lastIndexOf('.')).toLowerCase());
}

function FileIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ['.xlsx', '.xls', '.csv'].includes(ext)
    ? <FileSpreadsheet className="w-3.5 h-3.5 text-green-600 shrink-0" />
    : <FileText className="w-3.5 h-3.5 text-red-500 shrink-0" />;
}

const TERMINAL = new Set(['completed', 'failed']);

export default function FolderSelector({ onIngestSuccess }: Props) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [jobs, setJobs]                   = useState<JobDisplay[]>([]);
  const [uploading, setUploading]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [dragging, setDragging]           = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);

  const isProcessing = jobs.length > 0 && jobs.some((j) => !TERMINAL.has(j.state));
  const isDone       = jobs.length > 0 && jobs.every((j) => TERMINAL.has(j.state));

  // Poll job statuses until all reach a terminal state
  useEffect(() => {
    if (jobs.length === 0 || isDone) return;

    const id = setTimeout(async () => {
      const updates = await Promise.all(jobs.map((j) => getJobStatus(j.id).catch(() => null)));
      setJobs((prev) =>
        prev.map((j, i) => {
          const u = updates[i];
          if (!u) return j;
          return {
            ...j,
            state:  u.state,
            chunks: u.result?.chunks,
            error:  u.error,
          };
        }),
      );
    }, 2000);

    return () => clearTimeout(id);
  }, [jobs, isDone]);

  // When all jobs finish, refresh document list
  useEffect(() => {
    if (isDone) onIngestSuccess();
  }, [isDone, onIngestSuccess]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const supported = Array.from(incoming).filter((f) => isSupportedFile(f.name));
    if (supported.length === 0) return;
    setSelectedFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...supported.filter((f) => !names.has(f.name))];
    });
    setError(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const removeFile = (name: string) =>
    setSelectedFiles((prev) => prev.filter((f) => f.name !== name));

  const handleLoad = async () => {
    if (selectedFiles.length === 0 || uploading || isProcessing) return;
    setUploading(true);
    setError(null);
    setJobs([]);

    try {
      const { jobs: queued } = await uploadFiles(selectedFiles);
      setJobs(queued.map((j) => ({ id: j.id, fileName: j.fileName, state: 'waiting' })));
      setSelectedFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const reset = () => setJobs([]);

  return (
    <div className="space-y-3">
      {/* Drop zone — hidden while processing */}
      {!isProcessing && !isDone && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`relative border-2 border-dashed rounded-xl p-4 text-center transition-colors cursor-pointer select-none ${
              dragging
                ? 'border-blue-400 bg-blue-50'
                : 'border-gray-300 hover:border-blue-300 hover:bg-gray-50'
            }`}
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderOpen className={`w-7 h-7 mx-auto mb-1.5 ${dragging ? 'text-blue-500' : 'text-gray-400'}`} />
            <p className="text-sm font-medium text-gray-600">
              {dragging ? 'Drop files here' : 'Click to choose a folder'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">or drag &amp; drop files here</p>
            <p className="text-xs text-gray-400">PDF, XLSX, XLS, CSV</p>
            <input
              ref={folderInputRef}
              type="file"
              // @ts-expect-error — webkitdirectory is not in TS types but works in all major browsers
              webkitdirectory=""
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full text-xs text-gray-500 hover:text-blue-600 underline underline-offset-2 text-center"
          >
            Or pick individual files instead
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </>
      )}

      {/* Selected files list */}
      {selectedFiles.length > 0 && !isProcessing && !isDone && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500">{selectedFiles.length} file(s) selected</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {selectedFiles.map((f) => (
              <div key={f.name} className="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1">
                <FileIcon name={f.name} />
                <span className="text-xs text-gray-700 flex-1 truncate" title={f.name}>{f.name}</span>
                <button onClick={() => removeFile(f.name)} className="text-gray-400 hover:text-red-500 shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={handleLoad}
            disabled={uploading}
            className="w-full mt-1 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Queuing files…' : `Load ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Processing / done progress */}
      {jobs.length > 0 && (
        <div className="space-y-2">
          <UploadProgress jobs={jobs} />
          {isDone && (
            <button
              onClick={reset}
              className="w-full text-xs text-gray-500 hover:text-blue-600 underline underline-offset-2 text-center"
            >
              Upload more files
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
