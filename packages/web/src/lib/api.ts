export interface DocumentMetadata {
  type?: string;
  projectName?: string | null;
  currency?: string | null;
  parties?: string[];
  summary?: string;
}

export interface DocumentMeta {
  id: string;
  fileName: string;
  fileType: string;
  totalPages?: number;
  totalSheets?: number;
  chunkCount: number;
  hasEmbeddings: boolean;
  metadata: DocumentMetadata;
  ingestedAt: string;
}

export interface SourceReference {
  documentName: string;
  location: string;
  excerpt: string;
}

export interface ParagraphSection {
  type: 'paragraph';
  content: string;
}

export interface KeyFactsSection {
  type: 'key_facts';
  title: string;
  items: Array<{ label: string; value: string; citation?: string }>;
}

export interface TimelineSection {
  type: 'timeline';
  title: string;
  items: Array<{ date: string; label: string; citation?: string }>;
}

export interface TableSection {
  type: 'table';
  title: string;
  headers: string[];
  rows: string[][];
}

export interface ListSection {
  type: 'list';
  title: string;
  items: Array<{ text: string; citation?: string }>;
}

export interface PartiesSection {
  type: 'parties';
  title: string;
  items: Array<{ role: string; name: string; citation?: string }>;
}

export type AnswerSection =
  | ParagraphSection
  | KeyFactsSection
  | TimelineSection
  | TableSection
  | ListSection
  | PartiesSection;

export interface StructuredAnswer {
  title: string;
  summary?: string;
  sections: AnswerSection[];
}

export interface AskResponse {
  answer: StructuredAnswer;
  sources: SourceReference[];
  toolsUsed: string[];
}

interface AskJobPollResult {
  state:   string;
  status?: string;
  result?: AskResponse;
  error?:  string;
}

export interface IngestResponse {
  documentsLoaded: number;
  documents: Array<{ name: string; type: string; chunks: number }>;
  warnings: string[];
}

export interface UploadJob {
  id: string;
  fileName: string;
}

export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';

export interface JobStatus {
  id: string;
  fileName: string;
  state: JobState;
  result?: { name: string; type: string; chunks: number; warnings: string[] };
  error?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  answer?: StructuredAnswer;
  sources?: SourceReference[];
  toolsUsed?: string[];
  createdAt: string;
}

const BASE = '/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function pollAskJob(jobId: string): Promise<AskJobPollResult> {
  const res = await fetch(`${BASE}/ask/jobs/${jobId}`);
  return handleResponse<AskJobPollResult>(res);
}

export async function ingestFolder(folderPath: string): Promise<IngestResponse> {
  const res = await fetch(`${BASE}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  });
  return handleResponse<IngestResponse>(res);
}

export async function uploadFiles(files: File[]): Promise<{ jobs: UploadJob[] }> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
  return handleResponse<{ jobs: UploadJob[] }>(res);
}

export async function getJobStatus(id: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/upload/jobs/${id}`);
  return handleResponse<JobStatus>(res);
}

export async function askQuestion(
  question:       string,
  conversationId: string,
  history:        ConversationMessage[] = [],
  onStatus?:      (status: string) => void,
): Promise<AskResponse> {
  const enqueue = await fetch(`${BASE}/ask`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ question, history, conversationId }),
  });
  const { jobId } = await handleResponse<{ jobId: string }>(enqueue);

  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await pollAskJob(jobId);
    if (poll.state === 'completed' && poll.result) return poll.result;
    if (poll.state === 'failed') throw new Error(poll.error ?? 'Request failed');
    if (poll.status) onStatus?.(poll.status);
  }
}

export async function getDocuments(): Promise<{ documents: DocumentMeta[] }> {
  const res = await fetch(`${BASE}/documents`);
  return handleResponse<{ documents: DocumentMeta[] }>(res);
}

export async function deleteDocuments(): Promise<void> {
  const res = await fetch(`${BASE}/documents`, { method: 'DELETE' });
  return handleResponse(res);
}

export async function createConversation(): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  return handleResponse<{ id: string }>(res);
}

export async function getConversationMessages(id: string): Promise<{ messages: StoredMessage[] }> {
  const res = await fetch(`${BASE}/conversations/${id}/messages`);
  return handleResponse<{ messages: StoredMessage[] }>(res);
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/conversations/${id}`, { method: 'DELETE' });
  return handleResponse(res);
}
