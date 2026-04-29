# How DocAgent Works

DocAgent is designed with two main workflows:
* **Ingestion:** When documents are uploaded and prepared for search.
* **Querying:** When a user asks questions about those documents.

Both run asynchronously, ensuring the UI remains fast while background workers handle heavy processing tasks.

---

## 1. Document Ingestion
When a PDF or Excel file is uploaded, it enters a queue and is processed through a multi-step pipeline.

### Pipeline Overview
1. **Upload File**
2. **Parse Content**
3. **Split into Chunks**
4. **Create Embeddings**
5. **Extract Structured Data**
6. **Save to Database**

### Step 1: Parse Content
The system reads the file based on its specific format to ensure data integrity.

* **PDF Files**
    * Extracts text page by page.
    * Reconstructs lines using layout coordinates.
    * **Detects:** Headings, tables, and normal text.
    * Preserves page numbers and sections.
* **Excel Files**
    * Reads all worksheets.
    * Detects headers automatically.
    * Groups rows into logical sections.
    * Keeps sheet names and row ranges.

### Step 2: Smart Chunking
Large documents are split into smaller, searchable pieces called "chunks." Each chunk retains useful metadata:
* Page number
* Sheet name
* Section title
* Chunk type

**Why chunking matters:**
Instead of searching an entire document (which could confuse the AI), the system searches only the most relevant sections.
* *Example:* Chunk 1 (Payment Terms), Chunk 2 (Scope of Work), Chunk 3 (Mechanical BOQ).

### Step 3: Embeddings (Semantic Search)
Each chunk is converted into a **vector** (a numerical representation) using OpenAI embeddings. This allows the system to find **meaning**, not just matching keywords.

* **Example:**
    * *User asks:* "What are the payment conditions?"
    * *Document says:* "Terms of invoice settlement."
    * *Result:* The system matches them because they are semantically similar.

### Step 4: Structured Extraction
Beyond text search, DocAgent extracts specific values into a structured database.
* **Examples:** Costs, quantities, percentages, dates, contractors, and milestones.

This enables direct calculations without needing to rely on AI reasoning every single time.
* *Example Question:* "What is the total MEP budget?"
* *System Action:* Instead of reading text, it runs a SQL query: `SUM(cost) WHERE category = 'MEP'`. This is fast and 100% accurate.

### Step 5: Store Everything
All processed data is saved in **PostgreSQL**:
* **Documents Table:** Stores file info and metadata.
* **Chunks Table:** Stores searchable text + embeddings.
* **Extracted Values Table:** Stores structured numeric and business data.

---

## 2. Asking Questions
When the user asks a question, a background worker handles the logic via a "Tool-use" flow.

### Flow
1. **User asks question**
2. **AI chooses the right tool** (Search vs. Calculation)
3. **Tool queries PostgreSQL**
4. **AI formats final answer**
5. **UI displays structured response**

### Example Question
* **User:** "Compare electrical costs between both BOQs."
* **System:**
    1. Detects comparison intent.
    2. Runs a cost comparison query.
    3. Retrieves totals from the database.
    4. Returns a formatted answer.

---

## Available Capabilities
DocAgent can answer queries across several categories:

* **Cost Questions:** Total budget, trade breakdown, cost comparison, variance, and percentages.
* **Schedule Questions:** Milestones, deadlines, and dates.
* **Scope Questions:** Specifications, clauses, and responsibilities.
* **Parties:** Contractors, consultants, and suppliers.

---

## Why This Design Works
* **Fast:** Most numerical answers come from SQL, not full AI reasoning.
* **Accurate:** Structured data avoids "hallucinations" (AI making up numbers).
* **Scalable:** Background queues (Redis + BullMQ) process many files safely.
* **Flexible:** Supports both PDFs and Excel files.
* **User Friendly:** Answers are returned in structured UI sections like tables, timelines, key facts, and summaries.

---

## Tech Stack
* **Backend:** Node.js, Express
* **Database:** PostgreSQL, pgvector (for AI search)
* **Queuing:** Redis + BullMQ
* **AI:** OpenAI API
* **Frontend:** React + Next.js

---

### In One Sentence
**DocAgent turns raw project documents into a searchable intelligence system that can answer business questions instantly.**
