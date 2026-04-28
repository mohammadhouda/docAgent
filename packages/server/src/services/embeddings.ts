import { openaiClient } from './openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

// This service handles the generation of text embeddings using the OpenAI API. It provides methods to generate embeddings for a single text or an array of texts. The embeddings are generated in batches to optimize API usage and performance. The generated embeddings can be used for various purposes such as similarity search, clustering, or as input features for machine learning models.
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

// Convenience function for generating an embedding for a single text input. It calls the batch generation function with an array of one element and returns the resulting embedding.
export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

