import { openaiClient } from './openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openaiClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    // API returns embeddings in the same order as input
    const sorted = response.data.sort((a, b) => a.index - b.index);
    results.push(...sorted.map((d) => d.embedding));
  }

  return results;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

