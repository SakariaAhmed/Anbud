"use client";

import { ChangeEvent, FormEvent, ReactNode, useMemo, useState } from "react";

import { Bid, BidChatResponse, BidDocument, BidEvent, BidNote } from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

type SectionKey = "overview" | "chat" | "events" | "documents" | "notes";
const SECTION_OPTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "chat", label: "Chat" },
  { key: "events", label: "Events" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Notes" }
];

interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  confidence?: string;
  citations?: string[];
}

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function toEventText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    const parsed = parseJsonLikeString(value);
    if (parsed !== value) {
      return toEventText(parsed);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => `- ${toEventText(item)}`).join("\n");
  }
  if (typeof value === "object") {
    const lines: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      if (Array.isArray(rawValue)) {
        lines.push(`${key}:`);
        for (const item of rawValue) {
          lines.push(`- ${toEventText(item)}`);
        }
      } else if (typeof rawValue === "object" && rawValue !== null) {
        lines.push(`${key}:`);
        lines.push(toEventText(rawValue));
      } else {
        lines.push(`${key}: ${toEventText(rawValue)}`);
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }
  return String(value);
}

function toCustomRows(fields: Record<string, string>): CustomFieldRow[] {
  return Object.entries(fields).map(([key, value]) => ({
    id: `${key}-${Math.random().toString(16).slice(2)}`,
    key,
    value
  }));
}

function parseChatMessages(events: BidEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.type === "chat_question") {
      const question = toEventText(event.payload.question ?? "").trim();
      if (question) {
        messages.push({ role: "user", text: question });
      }
    }

    if (event.type === "chat_answer") {
      const answer = toEventText(event.payload.answer ?? "").trim();
      const confidence = String(event.payload.confidence ?? "").trim();
      const citationsPayload = event.payload.citations;
      const citations = Array.isArray(citationsPayload)
        ? citationsPayload.map((item) => toEventText(item)).filter(Boolean)
        : [];
      if (answer) {
        messages.push({ role: "assistant", text: answer, confidence, citations });
      }
    }
  }
  return messages;
}

function formatEventType(type: BidEvent["type"]): string {
  if (type === "bid_created") return "Bid created";
  if (type === "document_uploaded") return "Document uploaded";
  if (type === "chat_question") return "Chat question";
  return "Chat answer";
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function humanizeFieldName(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function payloadValueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (Array.isArray(value)) {
    return value.map((item) => toEventText(item)).join(", ");
  }
  if (typeof value === "object") {
    return toEventText(value);
  }
  return String(value);
}

function renderEventDetails(event: BidEvent): ReactNode {
  const payload = event.payload ?? {};

  if (event.type === "chat_question") {
    return <p className="event-text">{toEventText(payload.question ?? "No question content recorded.")}</p>;
  }

  if (event.type === "chat_answer") {
    const citations = Array.isArray(payload.citations) ? payload.citations.map((value) => toEventText(value)).filter(Boolean) : [];
    return (
      <div className="event-answer">
        <p className="event-text">{toEventText(payload.answer ?? "No answer content recorded.")}</p>
        {payload.confidence ? <small>Confidence: {String(payload.confidence)}</small> : null}
        {citations.length ? (
          <ul>
            {citations.map((citation) => (
              <li key={citation}>{citation}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (event.type === "document_uploaded") {
    return (
      <ul className="event-kv-list">
        <li>
          <strong>File</strong>
          <span>{String(payload.file_name ?? "Unknown file")}</span>
        </li>
        <li>
          <strong>Content type</strong>
          <span>{String(payload.content_type ?? "Unknown")}</span>
        </li>
      </ul>
    );
  }

  if (event.type === "bid_created") {
    return <p className="event-text">{String(payload.message ?? "Bid was created.")}</p>;
  }

  return (
    <ul className="event-kv-list">
      {Object.entries(payload).map(([key, value]) => (
        <li key={key}>
          <strong>{humanizeFieldName(key)}</strong>
          <span>{payloadValueToText(value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function BidWorkspace({
  initialBid,
  initialDocuments,
  initialEvents,
  initialNotes
}: {
  initialBid: Bid;
  initialDocuments: BidDocument[];
  initialEvents: BidEvent[];
  initialNotes: BidNote[];
}) {
  const [section, setSection] = useState<SectionKey>("overview");
  const [bid, setBid] = useState<Bid>(initialBid);
  const [customRows, setCustomRows] = useState<CustomFieldRow[]>(toCustomRows(initialBid.custom_fields ?? {}));
  const [documents, setDocuments] = useState<BidDocument[]>(initialDocuments);
  const [events, setEvents] = useState<BidEvent[]>(initialEvents);
  const [notes, setNotes] = useState<BidNote[]>(initialNotes);

  const [saveStatus, setSaveStatus] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [noteStatus, setNoteStatus] = useState("");

  const [uploading, setUploading] = useState(false);
  const [savingOverview, setSavingOverview] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteInput, setNoteInput] = useState("");

  const chatMessages = useMemo(() => parseChatMessages(events), [events]);

  const customFieldPayload = useMemo(() => {
    return customRows.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }, [customRows]);

  async function refreshEvents() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/events`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Failed to load events (${response.status})`);
    }

    const nextEvents = (await response.json()) as BidEvent[];
    setEvents(nextEvents);
  }

  async function refreshDocuments() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/documents`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Failed to load documents (${response.status})`);
    }

    const nextDocuments = (await response.json()) as BidDocument[];
    setDocuments(nextDocuments);
  }

  async function refreshNotes() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/notes`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Failed to load notes (${response.status})`);
    }

    const nextNotes = (await response.json()) as BidNote[];
    setNotes(nextNotes);
  }

  function addCustomField() {
    setCustomRows((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: "",
        value: ""
      }
    ]);
  }

  function removeCustomField(id: string) {
    setCustomRows((prev) => prev.filter((row) => row.id !== id));
  }

  function updateCustomField(id: string, field: "key" | "value", value: string) {
    setCustomRows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  async function saveOverview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingOverview(true);
    setSaveStatus("Saving bid...");

    try {
      const payload = {
        customer_name: bid.customer_name,
        title: bid.title,
        estimated_value: toNumberOrNull(String(bid.estimated_value ?? "")),
        deadline: bid.deadline || null,
        owner: bid.owner,
        custom_fields: customFieldPayload
      };

      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Update failed (${response.status})`);
      }

      const updated = (await response.json()) as Bid;
      setBid(updated);
      setSaveStatus("Bid updated.");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Update failed");
    } finally {
      setSavingOverview(false);
    }
  }

  async function onUploadDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setUploading(true);
    setUploadStatus("Uploading document...");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/documents`, {
        method: "POST",
        headers: {
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed (${response.status})`);
      }

      await Promise.all([refreshDocuments(), refreshEvents()]);
      setUploadStatus("Document uploaded.");
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt) {
      setChatStatus("Please write a question before sending.");
      return;
    }
    if (asking) {
      return;
    }

    setAsking(true);
    setChatStatus("Thinking...");
    setQuestion("");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/chat`, {
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

      const _answer = (await response.json()) as BidChatResponse;
      await refreshEvents();
      setChatStatus("");
    } catch (error) {
      setChatStatus(error instanceof Error ? error.message : "Chat failed");
    } finally {
      setAsking(false);
    }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = noteInput.trim();
    if (!content) {
      setNoteStatus("Please write a note before adding.");
      return;
    }
    if (savingNote) {
      return;
    }

    setSavingNote(true);
    setNoteStatus("Saving note...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify({ content })
      });

      if (!response.ok) {
        throw new Error(`Note save failed (${response.status})`);
      }

      setNoteInput("");
      await refreshNotes();
      setNoteStatus("Note saved.");
    } catch (error) {
      setNoteStatus(error instanceof Error ? error.message : "Note save failed");
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <section className="workspace-shell">
      <header className="page-header">
        <div>
          <p className="kicker">Bid Workspace</p>
          <h1>{bid.customer_name}</h1>
          <p className="subtle">{bid.title}</p>
        </div>

        <div className="section-switcher">
          <label>Sections</label>
          <div className="section-tabs" role="tablist" aria-label="Bid sections">
            {SECTION_OPTIONS.map((option) => (
              <button
                aria-selected={section === option.key}
                className={`section-tab ${section === option.key ? "active" : ""}`}
                key={option.key}
                onClick={() => setSection(option.key)}
                role="tab"
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {section === "overview" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Overview</h2>
            <p>Edit the core bid data and add your own custom fields.</p>
          </div>

          <form className="form-grid" onSubmit={saveOverview}>
            <label>
              Customer Name
              <input
                onChange={(event) => setBid((prev) => ({ ...prev, customer_name: event.target.value }))}
                required
                type="text"
                value={bid.customer_name}
              />
            </label>

            <label>
              Bid Title
              <input onChange={(event) => setBid((prev) => ({ ...prev, title: event.target.value }))} type="text" value={bid.title} />
            </label>

            <label>
              Deadline
              <input onChange={(event) => setBid((prev) => ({ ...prev, deadline: event.target.value }))} type="date" value={bid.deadline} />
            </label>

            <label>
              Owner
              <input onChange={(event) => setBid((prev) => ({ ...prev, owner: event.target.value }))} type="text" value={bid.owner} />
            </label>

            <label>
              Estimated Value
              <input
                min="0"
                onChange={(event) => setBid((prev) => ({ ...prev, estimated_value: event.target.value }))}
                step="0.01"
                type="number"
                value={bid.estimated_value ?? ""}
              />
            </label>

            <div className="form-actions">
              <button disabled={savingOverview} type="submit">
                {savingOverview ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>

          <section className="custom-fields">
            <div className="custom-fields-head">
              <h3>Custom Fields</h3>
              <button className="ghost-btn" onClick={addCustomField} type="button">
                Add Field
              </button>
            </div>

            {customRows.length ? (
              <div className="custom-fields-list">
                {customRows.map((row) => (
                  <div className="custom-field-row" key={row.id}>
                    <input onChange={(event) => updateCustomField(row.id, "key", event.target.value)} placeholder="Field name" value={row.key} />
                    <input onChange={(event) => updateCustomField(row.id, "value", event.target.value)} placeholder="Field value" value={row.value} />
                    <button className="ghost-btn danger" onClick={() => removeCustomField(row.id)} type="button">
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No custom fields yet.</p>
            )}
          </section>

          {saveStatus ? <p className="form-status">{saveStatus}</p> : null}
        </article>
      ) : null}

      {section === "chat" ? (
        <article className="panel chat-panel">
          <div className="panel-head">
            <h2>Ask the Document</h2>
            <p>Answers are grounded in all documents uploaded to this bid.</p>
          </div>

          <div className="chat-thread chat-thread-llm">
            {chatMessages.length ? (
              chatMessages.map((message, index) => (
                <div className={`chat-row ${message.role}`} key={`${message.role}-${index}`}>
                  <div className={`chat-avatar ${message.role}`}>{message.role === "assistant" ? "AI" : "You"}</div>
                  <div className={`chat-bubble chat-${message.role}`}>
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
                </div>
              ))
            ) : (
              <p className="muted-copy">No conversation yet. Ask your first question.</p>
            )}
          </div>

          <form className="chat-form chat-form-llm" onSubmit={askQuestion}>
            <textarea
              onChange={(event) => {
                setQuestion(event.target.value);
                if (chatStatus) {
                  setChatStatus("");
                }
              }}
              placeholder="Ask for requirements, gaps, risks, or next actions..."
              rows={2}
              value={question}
            />
            <button disabled={asking} type="submit">
              {asking ? "Asking..." : "Send"}
            </button>
          </form>

          {chatStatus ? <p className="form-status">{chatStatus}</p> : null}
        </article>
      ) : null}

      {section === "events" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Conversation History</h2>
            <p>Immutable log for uploads and chat conversation.</p>
          </div>

          {events.length ? (
            <ul className="event-list">
              {events
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{formatEventType(event.type)}</strong>
                      <span>{new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    {renderEventDetails(event)}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted-copy">No events yet.</p>
          )}
        </article>
      ) : null}

      {section === "documents" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Bid Documents</h2>
            <p>Upload documents to expand AI context for this bid.</p>
          </div>

          <label className="upload-label">
            Upload Document (PDF or TXT)
            <input accept=".pdf,.txt,text/plain,application/pdf" disabled={uploading} onChange={onUploadDocument} type="file" />
          </label>

          {uploadStatus ? <p className="form-status">{uploadStatus}</p> : null}

          {documents.length ? (
            <ul className="document-list">
              {documents.map((document) => (
                <li key={document.id}>
                  <strong>{document.file_name}</strong>
                  <span>{document.content_type}</span>
                  <span>{new Date(document.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No documents uploaded yet.</p>
          )}
        </article>
      ) : null}

      {section === "notes" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Notes</h2>
            <p>Add your own dated notes for this bid.</p>
          </div>

          <form className="note-form" onSubmit={addNote}>
            <textarea
              onChange={(event) => {
                setNoteInput(event.target.value);
                if (noteStatus) {
                  setNoteStatus("");
                }
              }}
              placeholder="Write a note, decision, or reminder..."
              rows={4}
              value={noteInput}
            />
            <button disabled={savingNote} type="submit">
              {savingNote ? "Saving..." : "Add Note"}
            </button>
          </form>

          {noteStatus ? <p className="form-status">{noteStatus}</p> : null}

          {notes.length ? (
            <ul className="note-list">
              {notes.map((note) => (
                <li key={note.id}>
                  <p>{note.content}</p>
                  <small>
                    {new Date(note.created_at).toLocaleString()} by {note.user}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No notes yet.</p>
          )}
        </article>
      ) : null}
    </section>
  );
}
