interface RequestStatus {
  status:    string;
  updatedAt: number;
}

// This service manages the status of user requests in memory. It provides functions to update, retrieve, and delete the status of a request based on its unique ID. The status is stored along with a timestamp to allow for periodic cleanup of old entries. This is useful for tracking the progress of long-running operations such as document ingestion or question answering, and for providing feedback to users about the state of their requests.

const statusStore = new Map<string, RequestStatus>();

export function updateRequestStatus(requestId: string, status: string): void {
  statusStore.set(requestId, { status, updatedAt: Date.now() });
}

export function getRequestStatus(requestId: string): string | undefined {
  return statusStore.get(requestId)?.status;
}

export function deleteRequestStatus(requestId: string): void {
  statusStore.delete(requestId);
}

// Periodically clean up request statuses that are older than 5 minutes to prevent memory bloat from long-running or stalled requests.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, data] of statusStore.entries()) {
    if (data.updatedAt < cutoff) statusStore.delete(id);
  }
}, 60_000);
