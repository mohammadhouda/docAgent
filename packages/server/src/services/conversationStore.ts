import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client.js';
import { conversations, messages, MessageRow } from '../db/schema.js';
import { StructuredAnswer, SourceReference } from '../types/index.js';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  answer?: StructuredAnswer;
  sources?: SourceReference[];
  toolsUsed?: string[];
  createdAt: Date;
}

// This service manages conversations and messages in the database. It provides methods to create new conversations, check for their existence, add messages to a conversation, retrieve messages for a conversation, and delete conversations. The messages can include user inputs, assistant responses, cited sources, and tools used during the interaction. The service abstracts the database operations related to conversations and messages, allowing other parts of the application to interact with it without needing to know the underlying database details.
function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id:        row.id,
    role:      row.role as 'user' | 'assistant',
    content:   row.content   ?? undefined,
    answer:    (row.answer   as StructuredAnswer  | null) ?? undefined,
    sources:   (row.sources  as SourceReference[] | null) ?? undefined,
    toolsUsed: row.toolsUsed ?? undefined,
    createdAt: row.createdAt,
  };
}

class ConversationStore {
  async create(title: string): Promise<string> {
    const id = uuidv4();
    await db.insert(conversations).values({ id, title: title.slice(0, 120), createdAt: new Date() });
    return id;
  }

  async exists(id: string): Promise<boolean> {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return rows.length > 0;
  }

  async addMessage(
    conversationId: string,
    msg: Omit<StoredMessage, 'id' | 'createdAt'>,
  ): Promise<void> {
    await db.insert(messages).values({
      id:             uuidv4(),
      conversationId,
      role:           msg.role,
      content:        msg.content    ?? null,
      answer:         msg.answer     ?? null,
      sources:        msg.sources    ?? null,
      toolsUsed:      msg.toolsUsed  ?? null,
      createdAt:      new Date(),
    });
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
    return rows.map(toStoredMessage);
  }

  async delete(id: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, id));
  }
}

export const conversationStore = new ConversationStore();
