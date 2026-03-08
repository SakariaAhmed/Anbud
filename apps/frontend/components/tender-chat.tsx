"use client";

import { FormEvent, useState } from "react";

import { TenderChatResponse } from "@/lib/types";

const API_BASE = "";

interface ChatMessage {
  role: "assistant" | "user";
  text: string;
  confidence?: string;
  citations?: string[];
}

export function TenderChat({ tenderId }: { tenderId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Ask anything about this tender. I will answer based on uploaded documents and tender analysis context."
    }
  ]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || loading) {
      return;
    }

    setMessages((prev) => [...prev, { role: "user", text: prompt }]);
    setQuestion("");
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/v1/tenders/${tenderId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify({ question: prompt })
      });

      if (!response.ok) {
        throw new Error(`Chat failed (${response.status})`);
      }

      const data = (await response.json()) as TenderChatResponse;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.answer,
          confidence: data.confidence,
          citations: data.citations
        }
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: error instanceof Error ? error.message : "Chat request failed"
        }
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="panel">
      <h2>Document Chat</h2>
      <div className="chat-thread">
        {messages.map((message, index) => (
          <div className={`chat-bubble chat-${message.role}`} key={`${message.role}-${index}`}>
            <p>{message.text}</p>
            {message.role === "assistant" && message.confidence ? <small>Confidence: {message.confidence}</small> : null}
            {message.role === "assistant" && message.citations?.length ? (
              <ul>
                {message.citations.map((citation) => (
                  <li key={citation}>{citation}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>

      <form className="chat-form" onSubmit={onSubmit}>
        <input
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about deadlines, risks, constraints, requirements..."
          type="text"
          value={question}
        />
        <button disabled={loading || !question.trim()} type="submit">
          {loading ? "Asking..." : "Ask"}
        </button>
      </form>
    </article>
  );
}
