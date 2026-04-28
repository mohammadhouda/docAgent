'use client';

import { Loader2, CheckCircle, XCircle, Clock, FileText, FileSpreadsheet } from 'lucide-react';
import { JobState } from '@/lib/api';

export interface JobDisplay {
  id: string;
  fileName: string;
  state: JobState;
  chunks?: number;
  error?: string;
}

interface Props {
  jobs: JobDisplay[];
}

function FileIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ['.xlsx', '.xls', '.csv'].includes(ext)
    ? <FileSpreadsheet className="w-3.5 h-3.5 text-green-600 shrink-0" />
    : <FileText className="w-3.5 h-3.5 text-red-500 shrink-0" />;
}

function StateIcon({ state }: { state: JobState }) {
  switch (state) {
    case 'completed': return <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />;
    case 'failed':    return <XCircle     className="w-3.5 h-3.5 text-red-500 shrink-0" />;
    case 'active':    return <Loader2     className="w-3.5 h-3.5 text-blue-500 shrink-0 animate-spin" />;
    default:          return <Clock       className="w-3.5 h-3.5 text-gray-400 shrink-0" />;
  }
}

function stateLabel(job: JobDisplay): string {
  switch (job.state) {
    case 'completed': return job.chunks !== undefined ? `${job.chunks} chunks` : 'done';
    case 'failed':    return 'failed';
    case 'active':    return 'processing…';
    default:          return 'queued';
  }
}

export default function UploadProgress({ jobs }: Props) {
  const done      = jobs.filter((j) => j.state === 'completed').length;
  const failed    = jobs.filter((j) => j.state === 'failed').length;
  const inProgress = jobs.some((j) => j.state === 'active' || j.state === 'waiting' || j.state === 'delayed');

  return (
    <div className="space-y-2">
      {/* Summary line */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        {inProgress
          ? <><Loader2 className="w-3 h-3 animate-spin text-blue-500" /> Processing files…</>
          : <span>{done} done{failed > 0 ? `, ${failed} failed` : ''}</span>
        }
      </div>

      {/* Per-file rows */}
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {jobs.map((job) => (
          <div
            key={job.id}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs ${
              job.state === 'active'    ? 'bg-blue-50'
              : job.state === 'completed' ? 'bg-green-50'
              : job.state === 'failed'    ? 'bg-red-50'
              : 'bg-gray-50'
            }`}
          >
            <FileIcon name={job.fileName} />
            <span className="flex-1 truncate text-gray-700" title={job.fileName}>
              {job.fileName}
            </span>
            <StateIcon state={job.state} />
            <span className={`shrink-0 ${
              job.state === 'completed' ? 'text-green-600'
              : job.state === 'failed'  ? 'text-red-500'
              : job.state === 'active'  ? 'text-blue-500'
              : 'text-gray-400'
            }`}>
              {stateLabel(job)}
            </span>
          </div>
        ))}
      </div>

      {/* Failed errors */}
      {jobs.filter((j) => j.state === 'failed' && j.error).map((j) => (
        <p key={j.id} className="text-xs text-red-500 truncate" title={j.error}>
          ⚠ {j.fileName}: {j.error}
        </p>
      ))}
    </div>
  );
}
