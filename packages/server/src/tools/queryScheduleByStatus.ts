import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, formatLocation } from './utils.js';

interface ScheduleRow {
  task_id:        string;
  description:    string;
  responsible:    string | null;
  start_date:     string | null;
  end_date:       string | null;
  status:         string | null;
  status_label:   string | null;
  sheet_name:     string | null;
  row_number:     number | null;
  page_number:    number | null;
  context:        string;
  file_name:      string;
}

// Query schedule/programme tasks by status (e.g., "In Progress", "Completed", "Not Started").
// Use this for project schedule documents to find tasks matching a specific status.
// Returns one row per task with task ID, description, responsible party, dates, and status.
export async function queryScheduleByStatus(args: {
  status:     string;
  documentId?: string;
}): Promise<ToolResult> {
  const { status, documentId } = args;

  // Query uses a CTE to first find rows with matching status, then joins to get
  // other columns (task ID, description, responsible, dates) from the same row.
  const result = await pool.query<ScheduleRow>(
    `WITH matching_rows AS (
       -- Find all extracted_values with type='status' matching the query
       SELECT DISTINCT ON (document_id, sheet_name, row_number)
         document_id, sheet_name, row_number, raw_value AS status, label AS status_label
       FROM extracted_values
       WHERE type = 'status'
         AND ($1::uuid IS NULL OR document_id = $1::uuid)
         AND LOWER(raw_value) LIKE LOWER($2)
     )
     SELECT 
       mr.status,
       mr.sheet_name,
       mr.row_number,
       NULL::integer AS page_number,
       d.file_name,
       -- Task ID: extract from label that matches "T-XXX:" pattern (e.g., "Status: T-005: Marble...")
       COALESCE(
         (SELECT SUBSTRING(ev.label FROM '(T-\d+):') FROM extracted_values ev 
          WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
            AND ev.label LIKE '%T-___:%'
          LIMIT 1),
         (SELECT SUBSTRING(mr.status_label FROM '(T-\d+):')),
         (SELECT ev.raw_value FROM extracted_values ev 
          WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
            AND ev.raw_value ~ '^[A-Z]+-\d+$'
          LIMIT 1),
         'T-' || LPAD(mr.row_number::text, 3, '0')
       ) AS task_id,
       -- Description: from label containing task description (after the "T-XXX:" prefix)
       COALESCE(
         (SELECT TRIM(SUBSTRING(ev.label FROM '^[^:]+:\s*T-\d+:\s*(.*)$')) FROM extracted_values ev 
          WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
            AND ev.label LIKE '%T-___:%'
          LIMIT 1),
         (SELECT TRIM(SUBSTRING(mr.status_label FROM 'T-\d+:\s*(.*)$'))),
         (SELECT TRIM(SUBSTRING(ev.label FROM 'T-\d+:\s*(.*)$')) FROM extracted_values ev 
          WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
          LIMIT 1),
         mr.status
       ) AS description,
       -- Responsible party
       (SELECT ev.raw_value FROM extracted_values ev 
        WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
          AND ev.type = 'party'
        LIMIT 1) AS responsible,
       -- Start date
       (SELECT ev.raw_value FROM extracted_values ev 
        WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
          AND ev.type = 'date' AND (ev.label ILIKE '%start%' OR ev.label ILIKE '%from%')
        LIMIT 1) AS start_date,
       -- End date  
       (SELECT ev.raw_value FROM extracted_values ev 
        WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
          AND ev.type = 'date' AND (ev.label ILIKE '%end%' OR ev.label ILIKE '%completion%' OR ev.label ILIKE '%to%')
        LIMIT 1) AS end_date,
       -- Context for sources
       COALESCE(
         (SELECT ev.context FROM extracted_values ev 
          WHERE ev.document_id = mr.document_id AND ev.sheet_name = mr.sheet_name AND ev.row_number = mr.row_number 
          LIMIT 1),
         mr.status
       ) AS context
     FROM matching_rows mr
     JOIN documents d ON mr.document_id = d.id
     ORDER BY mr.sheet_name, mr.row_number`,
    [documentId ?? null, `%${status}%`],
  );

  if (result.rows.length === 0) {
    return { success: false, data: `No tasks found with status "${status}".`, sources: [] };
  }

  const items = result.rows.map((r) => ({
    taskId:      r.task_id,
    description: r.description,
    responsible: r.responsible,
    startDate:   r.start_date,
    endDate:     r.end_date,
    status:      r.status,
    source:      r.file_name,
    location:    formatLocation(r),
  }));

  return {
    success: true,
    data:    { items, totalItems: items.length, status },
    sources: buildSources(result.rows),
  };
}
