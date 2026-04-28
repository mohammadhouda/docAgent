interface RequestStatus {
  status:    string;
  updatedAt: number;
}

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

// Remove entries older than 5 minutes — covers requests that timed out without cleanup
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, data] of statusStore.entries()) {
    if (data.updatedAt < cutoff) statusStore.delete(id);
  }
}, 60_000);
