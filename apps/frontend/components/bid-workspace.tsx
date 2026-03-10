"use client";

import { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useState } from "react";

import {
  Bid,
  BidChatResponse,
  BidDecision,
  BidDocument,
  BidDocumentCreateResponse,
  BidEvent,
  BidNote,
  BidRequirement,
  BidTask,
  ChatCitation,
  GenerateRequirementsResponse,
  RequirementStatus,
  TaskStatus
} from "@/lib/types";
import { readWorkspaceCache, writeWorkspaceCache } from "@/lib/client/workspace-cache";

const API_BASE = "";

type SectionKey = "overview" | "chat" | "requirements" | "events" | "documents" | "notes" | "decisions" | "tasks";
const SECTION_OPTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "chat", label: "Chat" },
  { key: "requirements", label: "Requirements" },
  { key: "events", label: "Events" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Notes" },
  { key: "decisions", label: "Decisions" },
  { key: "tasks", label: "Tasks" }
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
  citations?: ChatCitation[];
}

function submitOnEnter(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  const form = event.currentTarget.form;
  if (!form) {
    return;
  }

  event.preventDefault();
  form.requestSubmit();
}

function blurOnEnter(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  event.preventDefault();
  event.currentTarget.blur();
}

function normalizeCitation(value: unknown): ChatCitation | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const excerpt = value.trim();
    return excerpt ? { document_name: null, excerpt } : null;
  }
  if (typeof value === "object") {
    const payload = value as Record<string, unknown>;
    const excerpt = toEventText(payload.excerpt ?? payload.text ?? payload.quote ?? "").trim();
    const documentName = toEventText(payload.document_name ?? payload.document ?? payload.file_name ?? "").trim() || null;
    return excerpt ? { document_name: documentName, excerpt } : null;
  }
  return null;
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

function normalizePossiblyBrokenText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "[object Object]") {
    return "";
  }
  return trimmed;
}

function sanitizeRenderedText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[object Object]") {
    return "This answer was stored in an unreadable format. Ask the question again to regenerate a clean response.";
  }
  return value;
}

function extractChatAnswerText(payload: Record<string, unknown>): string {
  const directCandidates: unknown[] = [payload.answer, payload.text, payload.message, payload.summary];
  for (const candidate of directCandidates) {
    const text = normalizePossiblyBrokenText(toEventText(candidate));
    if (text) {
      return text;
    }
  }

  const nestedCandidates: unknown[] = [
    (payload.result as Record<string, unknown> | undefined)?.answer,
    (payload.response as Record<string, unknown> | undefined)?.answer,
    payload.result,
    payload.response
  ];
  for (const candidate of nestedCandidates) {
    const text = normalizePossiblyBrokenText(toEventText(candidate));
    if (text) {
      return text;
    }
  }

  return "";
}

function toCustomRows(fields: Record<string, string>): CustomFieldRow[] {
  return Object.entries(fields).map(([key, value]) => ({
    id: `${key}-${Math.random().toString(16).slice(2)}`,
    key,
    value
  }));
}

function mergeEvents(existing: BidEvent[], incoming: BidEvent[]): BidEvent[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-50);
}

function mergeNewestFirst<T extends { id: string; created_at: string }>(existing: T[], incoming: T[], limit = 50): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}

function requirementProgress(status: RequirementStatus): number {
  if (status === "Covered") {
    return 100;
  }
  if (status === "In Progress") {
    return 55;
  }
  return 10;
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
      const answer = extractChatAnswerText(event.payload ?? {});
      const confidence = String(event.payload.confidence ?? "").trim();
      const citationsPayload = event.payload.citations;
      const citations = Array.isArray(citationsPayload)
        ? citationsPayload.map((item) => normalizeCitation(item)).filter((value): value is ChatCitation => Boolean(value))
        : [];
      if (answer) {
        messages.push({ role: "assistant", text: answer, confidence, citations });
      } else {
        messages.push({
          role: "assistant",
          text: "This answer was stored in an unreadable format. Ask the question again to regenerate a clean response.",
          confidence,
          citations
        });
      }
    }
  }
  return messages;
}

function taskProgress(status: TaskStatus): number {
  if (status === "Done") {
    return 100;
  }
  if (status === "In Progress") {
    return 55;
  }
  return 10;
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

async function readApiError(response: Response, fallbackMessage: string): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) {
      return payload.detail;
    }
  } catch {
    return fallbackMessage;
  }

  return fallbackMessage;
}

function renderEventDetails(event: BidEvent): ReactNode {
  const payload = event.payload ?? {};

  if (event.type === "chat_question") {
    return <p className="event-text">{toEventText(payload.question ?? "No question content recorded.")}</p>;
  }

  if (event.type === "chat_answer") {
    const citations = Array.isArray(payload.citations)
      ? payload.citations.map((value) => normalizeCitation(value)).filter((value): value is ChatCitation => Boolean(value))
      : [];
    const answerText =
      extractChatAnswerText(payload) ||
      "This answer was stored in an unreadable format. Ask the question again to regenerate a clean response.";
    return (
      <div className="event-answer">
        <p className="event-text">{answerText}</p>
        {payload.confidence ? <small>Confidence: {String(payload.confidence)}</small> : null}
        {citations.length ? (
          <ul>
            {citations.map((citation) => (
              <li key={`${citation.document_name ?? "unknown"}-${citation.excerpt}`}>
                {citation.document_name ? `${citation.document_name}: ` : ""}
                {citation.excerpt}
              </li>
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
  initialDecisions,
  initialDocuments,
  initialEvents,
  initialNotes,
  initialRequirements,
  initialTasks
}: {
  initialBid: Bid;
  initialDecisions: BidDecision[];
  initialDocuments: BidDocument[];
  initialEvents: BidEvent[];
  initialNotes: BidNote[];
  initialRequirements: BidRequirement[];
  initialTasks: BidTask[];
}) {
  const [section, setSection] = useState<SectionKey>("overview");
  const [bid, setBid] = useState<Bid>(initialBid);
  const [customRows, setCustomRows] = useState<CustomFieldRow[]>(toCustomRows(initialBid.custom_fields ?? {}));
  const [documents, setDocuments] = useState<BidDocument[]>(initialDocuments);
  const [events, setEvents] = useState<BidEvent[]>(initialEvents);
  const [notes, setNotes] = useState<BidNote[]>(initialNotes);
  const [decisions, setDecisions] = useState<BidDecision[]>(initialDecisions);
  const [tasks, setTasks] = useState<BidTask[]>(initialTasks);
  const [requirements, setRequirements] = useState<BidRequirement[]>(initialRequirements);
  const [documentsLoaded, setDocumentsLoaded] = useState(true);
  const [eventsLoaded, setEventsLoaded] = useState(true);
  const [notesLoaded, setNotesLoaded] = useState(true);
  const [decisionsLoaded, setDecisionsLoaded] = useState(true);
  const [tasksLoaded, setTasksLoaded] = useState(true);
  const [requirementsLoaded, setRequirementsLoaded] = useState(true);
  const [sectionLoading, setSectionLoading] = useState<SectionKey | null>(null);

  const [saveStatus, setSaveStatus] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [noteStatus, setNoteStatus] = useState("");
  const [decisionStatus, setDecisionStatus] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [requirementsStatus, setRequirementsStatus] = useState("");

  const [uploading, setUploading] = useState(false);
  const [savingOverview, setSavingOverview] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingDecision, setSavingDecision] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [savingRequirementId, setSavingRequirementId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [generatingRequirements, setGeneratingRequirements] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [decisionTitle, setDecisionTitle] = useState("");
  const [decisionDetails, setDecisionDetails] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDetails, setTaskDetails] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [selectedCitation, setSelectedCitation] = useState<ChatCitation | null>(null);

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
  const coveredRequirements = requirements.filter((item) => item.status === "Covered").length;
  const requirementsCompletion = requirements.length ? Math.round((coveredRequirements / requirements.length) * 100) : 0;

  useEffect(() => {
    const cached = readWorkspaceCache(initialBid.id);
    if (!cached) {
      return;
    }

    setBid(cached.bid);
    setDocuments(cached.documents);
    setDocumentsLoaded(true);
    setEvents(cached.events);
    setEventsLoaded(true);
    setNotes(cached.notes);
    setNotesLoaded(true);
    setRequirements(cached.requirements);
    setRequirementsLoaded(true);
    setDecisions(cached.decisions);
    setDecisionsLoaded(true);
    setTasks(cached.tasks);
    setTasksLoaded(true);
  }, [initialBid.id]);

  useEffect(() => {
    writeWorkspaceCache(bid.id, {
      bid,
      documents,
      events,
      notes,
      requirements,
      decisions,
      tasks
    });
  }, [bid, decisions, documents, events, notes, requirements, tasks]);

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
    setEventsLoaded(true);
    return nextEvents;
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
    setDocumentsLoaded(true);
    return nextDocuments;
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
    setNotesLoaded(true);
    return nextNotes;
  }

  async function refreshDecisions() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/decisions?limit=50`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await readApiError(response, `Failed to load decisions (${response.status})`));
    }

    const nextDecisions = (await response.json()) as BidDecision[];
    setDecisions(nextDecisions);
    setDecisionsLoaded(true);
    return nextDecisions;
  }

  async function refreshTasks() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/tasks?limit=50`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await readApiError(response, `Failed to load tasks (${response.status})`));
    }

    const nextTasks = (await response.json()) as BidTask[];
    setTasks(nextTasks);
    setTasksLoaded(true);
    return nextTasks;
  }

  async function refreshRequirements() {
    const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/requirements?limit=100`, {
      headers: {
        "x-tenant-id": "default"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await readApiError(response, `Failed to load requirements (${response.status})`));
    }

    const nextRequirements = (await response.json()) as BidRequirement[];
    setRequirements(nextRequirements);
    setRequirementsLoaded(true);
    return nextRequirements;
  }

  async function ensureSectionData(nextSection: SectionKey) {
    const needsEvents = (nextSection === "chat" || nextSection === "events") && !eventsLoaded;
    const needsDocuments = (nextSection === "documents" || nextSection === "requirements") && !documentsLoaded;
    const needsNotes = nextSection === "notes" && !notesLoaded;
    const needsDecisions = nextSection === "decisions" && !decisionsLoaded;
    const needsTasks = nextSection === "tasks" && !tasksLoaded;
    const needsRequirements = nextSection === "requirements" && !requirementsLoaded;

    if (!needsEvents && !needsDocuments && !needsNotes && !needsDecisions && !needsTasks && !needsRequirements) {
      return;
    }

    setSectionLoading(nextSection);
    try {
      const [loadedEvents, loadedDocuments, loadedNotes, loadedDecisions, loadedTasks] = await Promise.all([
        needsEvents ? refreshEvents() : Promise.resolve(events),
        needsDocuments ? refreshDocuments() : Promise.resolve(documents),
        needsNotes ? refreshNotes() : Promise.resolve(notes),
        needsDecisions ? refreshDecisions() : Promise.resolve(decisions),
        needsTasks ? refreshTasks() : Promise.resolve(tasks)
      ]);

      if (needsEvents) {
        void loadedEvents;
      }
      if (needsNotes) {
        void loadedNotes;
      }
      if (needsDecisions) {
        void loadedDecisions;
      }
      if (needsTasks) {
        void loadedTasks;
      }

      if (needsRequirements) {
        if (loadedDocuments.length > 0) {
          await generateRequirements({ trigger: "auto" });
        } else {
          await refreshRequirements();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load section data";
      if (needsEvents) {
        setChatStatus(message);
      }
      if (needsDocuments) {
        setUploadStatus(message);
      }
      if (needsNotes) {
        setNoteStatus(message);
      }
      if (needsDecisions) {
        setDecisionStatus(message);
      }
      if (needsTasks) {
        setTaskStatus(message);
      }
      if (needsRequirements) {
        setRequirementsStatus(message);
      }
    } finally {
      setSectionLoading((current) => (current === nextSection ? null : current));
    }
  }

  async function generateRequirements(options?: { trigger?: "manual" | "upload" | "auto" }) {
    const trigger = options?.trigger ?? "manual";
    setGeneratingRequirements(true);
    setRequirementsStatus(
      trigger === "upload" ? "Refreshing requirements from the latest uploaded documents..." : "Generating requirements from uploaded documents..."
    );

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/requirements`, {
        method: "POST",
        headers: {
          "x-tenant-id": "default"
        }
      });

      const payload = (await response.json()) as GenerateRequirementsResponse | { detail?: string };
      if (!response.ok) {
        throw new Error("detail" in payload && payload.detail ? payload.detail : `Requirements generation failed (${response.status})`);
      }

      setRequirements((payload as GenerateRequirementsResponse).requirements);
      setRequirementsLoaded(true);
      setRequirementsStatus(
        trigger === "upload"
          ? "Requirements updated automatically from the latest uploaded documents."
          : "Requirements refreshed from all uploaded documents."
      );
    } catch (error) {
      setRequirementsStatus(error instanceof Error ? error.message : "Requirements generation failed");
    } finally {
      setGeneratingRequirements(false);
    }
  }

  async function updateRequirement(requirementId: string, updates: Partial<Pick<BidRequirement, "status" | "completion_notes">>) {
    setSavingRequirementId(requirementId);
    setRequirementsStatus("Saving requirement update...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/requirements/${requirementId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default"
        },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Requirement update failed (${response.status})`));
      }

      const updated = (await response.json()) as BidRequirement;
      setRequirements((prev) =>
        prev.map((requirement) => (requirement.id === updated.id ? updated : requirement)).sort((a, b) => {
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        })
      );
      setRequirementsStatus("Requirement updated.");
    } catch (error) {
      setRequirementsStatus(error instanceof Error ? error.message : "Requirement update failed");
    } finally {
      setSavingRequirementId(null);
    }
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

      const payload = (await response.json()) as BidDocumentCreateResponse;
      setDocuments((prev) => mergeNewestFirst(prev, [payload.document]));
      setDocumentsLoaded(true);
      setRequirementsLoaded(false);
      setRequirementsStatus("Refreshing requirements from the uploaded document...");
      if (payload.event && eventsLoaded) {
        const nextEvent = payload.event;
        setEvents((prev) => mergeEvents(prev, [nextEvent]));
      }
      setUploadStatus("Document uploaded.");
      await generateRequirements({ trigger: "upload" });
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

      const answer = (await response.json()) as BidChatResponse;
      const nextEvents = [answer.question_event, answer.answer_event].filter((value): value is BidEvent => Boolean(value));
      if (nextEvents.length) {
        setEvents((prev) => mergeEvents(prev, nextEvents));
        setEventsLoaded(true);
      }
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

      const note = (await response.json()) as BidNote;
      setNoteInput("");
      setNotes((prev) => mergeNewestFirst(prev, [note]));
      setNotesLoaded(true);
      setNoteStatus("Note saved.");
    } catch (error) {
      setNoteStatus(error instanceof Error ? error.message : "Note save failed");
    } finally {
      setSavingNote(false);
    }
  }

  async function addDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = decisionTitle.trim();
    const details = decisionDetails.trim();
    if (!title) {
      setDecisionStatus("Please add a decision title before saving.");
      return;
    }
    if (savingDecision) {
      return;
    }

    setSavingDecision(true);
    setDecisionStatus("Saving decision...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/decisions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default"
        },
        body: JSON.stringify({ title, details })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Decision save failed (${response.status})`));
      }

      const decision = (await response.json()) as BidDecision;
      setDecisionTitle("");
      setDecisionDetails("");
      setDecisions((prev) => mergeNewestFirst(prev, [decision]));
      setDecisionsLoaded(true);
      setDecisionStatus("Decision saved.");
    } catch (error) {
      setDecisionStatus(error instanceof Error ? error.message : "Decision save failed");
    } finally {
      setSavingDecision(false);
    }
  }

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskTitle.trim();
    const details = taskDetails.trim();
    if (!title) {
      setTaskStatus("Please add a task title before saving.");
      return;
    }
    if (savingTask) {
      return;
    }

    setSavingTask(true);
    setTaskStatus("Saving task...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default"
        },
        body: JSON.stringify({ title, details, due_date: taskDueDate || null })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Task save failed (${response.status})`));
      }

      const task = (await response.json()) as BidTask;
      setTaskTitle("");
      setTaskDetails("");
      setTaskDueDate("");
      setTasks((prev) => mergeNewestFirst(prev, [task]));
      setTasksLoaded(true);
      setTaskStatus("Task saved.");
    } catch (error) {
      setTaskStatus(error instanceof Error ? error.message : "Task save failed");
    } finally {
      setSavingTask(false);
    }
  }

  async function updateTask(taskId: string, updates: Partial<Pick<BidTask, "title" | "details" | "due_date" | "status">>) {
    setSavingTaskId(taskId);
    setTaskStatus("Saving task update...");

    try {
      const response = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default"
        },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, `Task update failed (${response.status})`));
      }

      const updated = (await response.json()) as BidTask;
      setTasks((prev) =>
        prev.map((task) => (task.id === updated.id ? updated : task)).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      );
      setTaskStatus("Task updated.");
    } catch (error) {
      setTaskStatus(error instanceof Error ? error.message : "Task update failed");
    } finally {
      setSavingTaskId(null);
    }
  }

  function openCitation(citation: ChatCitation) {
    setSelectedCitation(citation);
    setSection("documents");
    void ensureSectionData("documents");
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
                onClick={() => {
                  setSection(option.key);
                  void ensureSectionData(option.key);
                }}
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
                onKeyDown={submitOnEnter}
                required
                type="text"
                value={bid.customer_name}
              />
            </label>

            <label>
              Bid Title
              <input onChange={(event) => setBid((prev) => ({ ...prev, title: event.target.value }))} onKeyDown={submitOnEnter} type="text" value={bid.title} />
            </label>

            <label>
              Deadline
              <input onChange={(event) => setBid((prev) => ({ ...prev, deadline: event.target.value }))} type="date" value={bid.deadline} />
            </label>

            <label>
              Owner
              <input onChange={(event) => setBid((prev) => ({ ...prev, owner: event.target.value }))} onKeyDown={submitOnEnter} type="text" value={bid.owner} />
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
                      <input
                        onChange={(event) => updateCustomField(row.id, "key", event.target.value)}
                        onKeyDown={submitOnEnter}
                        placeholder="Field name"
                        value={row.key}
                      />
                      <input
                        onChange={(event) => updateCustomField(row.id, "value", event.target.value)}
                        onKeyDown={submitOnEnter}
                        placeholder="Field value"
                        value={row.value}
                      />
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
          </form>

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
            {!eventsLoaded ? (
              <p className="muted-copy">{sectionLoading === "chat" ? "Loading conversation..." : "Conversation not loaded yet."}</p>
            ) : chatMessages.length ? (
              chatMessages.map((message, index) => (
                <div className={`chat-row ${message.role}`} key={`${message.role}-${index}`}>
                  <div className={`chat-avatar ${message.role}`}>{message.role === "assistant" ? "AI" : "You"}</div>
                  <div className={`chat-bubble chat-${message.role}`}>
                    <p>{sanitizeRenderedText(message.text)}</p>
                    {message.role === "assistant" && message.confidence ? <small>Confidence: {message.confidence}</small> : null}
                    {message.role === "assistant" && message.citations?.length ? (
                      <ul className="citation-list">
                        {message.citations.map((citation) => (
                          <li key={`${citation.document_name ?? "unknown"}-${citation.excerpt}`}>
                            <button className="citation-chip" onClick={() => openCitation(citation)} type="button">
                              {citation.document_name ? `${citation.document_name}: ` : ""}
                              {citation.excerpt}
                            </button>
                          </li>
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
              onKeyDown={submitOnEnter}
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

      {section === "requirements" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Requirements</h2>
            <p>Generate and track delivery requirements extracted from every uploaded bid document.</p>
          </div>

          <div className="requirements-toolbar">
            <button onClick={() => void generateRequirements()} type="button">
              {generatingRequirements ? "Generating..." : "Generate Requirements"}
            </button>
            <div className="requirements-summary">
              <strong>{requirements.length}</strong>
              <span>Total requirements</span>
            </div>
            <div className="requirements-summary">
              <strong>{coveredRequirements}</strong>
              <span>Covered</span>
            </div>
            <div className="requirements-overall">
              <div>
                <strong>Coverage</strong>
                <span>{requirementsCompletion}% complete</span>
              </div>
              <div className="progress-track">
                <span className="progress-fill" style={{ width: `${requirementsCompletion}%` }} />
              </div>
            </div>
          </div>

          {requirementsStatus ? <p className="form-status">{requirementsStatus}</p> : null}

          {requirementsLoaded ? (
            requirements.length ? (
              <div className="requirements-list">
                {requirements.map((requirement) => (
                  <section className="requirement-card" key={requirement.id}>
                    <div className="requirement-head">
                      <div>
                        <h3>{requirement.title}</h3>
                        <p>
                          {requirement.category} · {requirement.priority} priority
                          {requirement.source_document ? ` · Source: ${requirement.source_document}` : ""}
                        </p>
                      </div>
                      <div className="requirement-status">
                        <span>{requirement.status}</span>
                        <div className="progress-track compact">
                          <span className="progress-fill" style={{ width: `${requirementProgress(requirement.status)}%` }} />
                        </div>
                      </div>
                    </div>

                    <div className="requirement-controls">
                      <label>
                        Status
                        <select
                          onChange={(event) => {
                            const nextStatus = event.target.value as RequirementStatus;
                            setRequirements((prev) =>
                              prev.map((item) => (item.id === requirement.id ? { ...item, status: nextStatus } : item))
                            );
                            void updateRequirement(requirement.id, { status: nextStatus, completion_notes: requirement.completion_notes });
                          }}
                          value={requirement.status}
                        >
                          <option value="Open">Open</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Covered">Covered</option>
                        </select>
                      </label>

                      <label className="requirement-notes">
                        Completion Notes
                        <textarea
                          defaultValue={requirement.completion_notes}
                          onKeyDown={blurOnEnter}
                          onBlur={(event) => {
                            const nextNotes = event.target.value.trim();
                            if (nextNotes === requirement.completion_notes) {
                              return;
                            }
                            setRequirements((prev) =>
                              prev.map((item) => (item.id === requirement.id ? { ...item, completion_notes: nextNotes } : item))
                            );
                            void updateRequirement(requirement.id, { status: requirement.status, completion_notes: nextNotes });
                          }}
                          placeholder="Capture how this requirement is covered, who owns it, or what is still missing."
                          rows={3}
                        />
                      </label>
                    </div>

                    {savingRequirementId === requirement.id ? <p className="requirement-saving">Saving requirement...</p> : null}
                  </section>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No requirements generated yet. Upload documents and generate requirements from the full bid pack.</p>
            )
          ) : (
            <p className="muted-copy">
              {sectionLoading === "requirements" ? "Loading requirements..." : "Requirements have not been loaded yet."}
            </p>
          )}
        </article>
      ) : null}

      {section === "events" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Conversation History</h2>
            <p>Immutable log for uploads and chat conversation.</p>
          </div>

          {eventsLoaded ? (
            events.length ? (
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
            )
          ) : (
            <p className="muted-copy">{sectionLoading === "events" ? "Loading event history..." : "Event history not loaded yet."}</p>
          )}
        </article>
      ) : null}

      {section === "documents" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Bid Documents</h2>
            <p>Upload documents to expand AI context for this bid and inspect cited evidence.</p>
          </div>

          <label className="upload-label">
            Upload Document (PDF or TXT)
            <input accept=".pdf,.txt,text/plain,application/pdf" disabled={uploading} onChange={onUploadDocument} type="file" />
          </label>

          {uploadStatus ? <p className="form-status">{uploadStatus}</p> : null}

          {selectedCitation ? (
            <div className="citation-focus">
              <div>
                <strong>{selectedCitation.document_name ?? "Referenced excerpt"}</strong>
                <p>{selectedCitation.excerpt}</p>
              </div>
              <button
                className="ghost-btn"
                onClick={() => {
                  setSelectedCitation(null);
                }}
                type="button"
              >
                Clear Highlight
              </button>
            </div>
          ) : null}

          {documentsLoaded ? (
            documents.length ? (
            <ul className="document-list">
              {documents.map((document) => (
                <li
                  className={
                    selectedCitation && selectedCitation.document_name && selectedCitation.document_name === document.file_name
                      ? "document-row active"
                      : "document-row"
                  }
                  key={document.id}
                >
                  <strong>{document.file_name}</strong>
                  <span>{document.content_type}</span>
                  <span>{new Date(document.created_at).toLocaleString()}</span>
                  {document.preview_text ? <p>{document.preview_text}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No documents uploaded yet.</p>
            )
          ) : (
            <p className="muted-copy">{sectionLoading === "documents" ? "Loading documents..." : "Documents not loaded yet."}</p>
          )}
        </article>
      ) : null}

      {section === "decisions" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Decisions</h2>
            <p>Keep a dated log of internal bid decisions so you can explain what changed and why.</p>
          </div>

          <form className="note-form" onSubmit={addDecision}>
            <input
              onChange={(event) => {
                setDecisionTitle(event.target.value);
                if (decisionStatus) {
                  setDecisionStatus("");
                }
              }}
              onKeyDown={submitOnEnter}
              placeholder="Decision title"
              type="text"
              value={decisionTitle}
            />
            <textarea
              onChange={(event) => {
                setDecisionDetails(event.target.value);
                if (decisionStatus) {
                  setDecisionStatus("");
                }
              }}
              onKeyDown={submitOnEnter}
              placeholder="Describe what was decided and the reasoning behind it..."
              rows={4}
              value={decisionDetails}
            />
            <button disabled={savingDecision} type="submit">
              {savingDecision ? "Saving..." : "Add Decision"}
            </button>
          </form>

          {decisionStatus ? <p className="form-status">{decisionStatus}</p> : null}

          {decisionsLoaded ? (
            decisions.length ? (
              <ul className="note-list">
                {decisions.map((decision) => (
                  <li key={decision.id}>
                    <strong>{decision.title}</strong>
                    {decision.details ? <p>{decision.details}</p> : null}
                    <small>{new Date(decision.decided_at).toLocaleString()}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">No decisions recorded yet.</p>
            )
          ) : (
            <p className="muted-copy">{sectionLoading === "decisions" ? "Loading decisions..." : "Decisions not loaded yet."}</p>
          )}
        </article>
      ) : null}

      {section === "tasks" ? (
        <article className="panel">
          <div className="panel-head">
            <h2>Tasks</h2>
            <p>Track your own follow-up work for this bid with due dates and progress.</p>
          </div>

          <form className="task-form" onSubmit={addTask}>
            <input
              onChange={(event) => {
                setTaskTitle(event.target.value);
                if (taskStatus) {
                  setTaskStatus("");
                }
              }}
              onKeyDown={submitOnEnter}
              placeholder="Task title"
              type="text"
              value={taskTitle}
            />
            <input
              onChange={(event) => setTaskDueDate(event.target.value)}
              type="date"
              value={taskDueDate}
            />
            <textarea
              onChange={(event) => {
                setTaskDetails(event.target.value);
                if (taskStatus) {
                  setTaskStatus("");
                }
              }}
              onKeyDown={submitOnEnter}
              placeholder="What needs to be done?"
              rows={3}
              value={taskDetails}
            />
            <button disabled={savingTask} type="submit">
              {savingTask ? "Saving..." : "Add Task"}
            </button>
          </form>

          {taskStatus ? <p className="form-status">{taskStatus}</p> : null}

          {tasksLoaded ? (
            tasks.length ? (
              <div className="task-list">
                {tasks.map((task) => (
                  <section className="task-card" key={task.id}>
                    <div className="task-card-head">
                      <div>
                        <h3>{task.title}</h3>
                        <p>{task.due_date ? `Due ${new Date(task.due_date).toLocaleDateString()}` : "No due date"}</p>
                      </div>
                      <div className="requirement-status">
                        <span>{task.status}</span>
                        <div className="progress-track compact">
                          <span className="progress-fill" style={{ width: `${taskProgress(task.status)}%` }} />
                        </div>
                      </div>
                    </div>

                    <div className="requirement-controls">
                      <label>
                        Status
                        <select
                          onChange={(event) => {
                            const nextStatus = event.target.value as TaskStatus;
                            setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, status: nextStatus } : item)));
                            void updateTask(task.id, { status: nextStatus, details: task.details, due_date: task.due_date });
                          }}
                          value={task.status}
                        >
                          <option value="To Do">To Do</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Done">Done</option>
                        </select>
                      </label>

                      <label>
                        Due Date
                        <input
                          defaultValue={task.due_date ?? ""}
                          onKeyDown={blurOnEnter}
                          onBlur={(event) => {
                            const nextDueDate = event.target.value || null;
                            if (nextDueDate === task.due_date) {
                              return;
                            }
                            setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, due_date: nextDueDate } : item)));
                            void updateTask(task.id, { status: task.status, details: task.details, due_date: nextDueDate });
                          }}
                          type="date"
                        />
                      </label>

                      <label className="requirement-notes">
                        Task Notes
                        <textarea
                          defaultValue={task.details}
                          onKeyDown={blurOnEnter}
                          onBlur={(event) => {
                            const nextDetails = event.target.value.trim();
                            if (nextDetails === task.details) {
                              return;
                            }
                            setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, details: nextDetails } : item)));
                            void updateTask(task.id, { status: task.status, details: nextDetails, due_date: task.due_date });
                          }}
                          placeholder="Add context, blockers, or next action."
                          rows={3}
                        />
                      </label>
                    </div>

                    {savingTaskId === task.id ? <p className="requirement-saving">Saving task...</p> : null}
                  </section>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No tasks yet.</p>
            )
          ) : (
            <p className="muted-copy">{sectionLoading === "tasks" ? "Loading tasks..." : "Tasks not loaded yet."}</p>
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
              onKeyDown={submitOnEnter}
              placeholder="Write a note, decision, or reminder..."
              rows={4}
              value={noteInput}
            />
            <button disabled={savingNote} type="submit">
              {savingNote ? "Saving..." : "Add Note"}
            </button>
          </form>

          {noteStatus ? <p className="form-status">{noteStatus}</p> : null}

          {notesLoaded ? (
            notes.length ? (
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
            )
          ) : (
            <p className="muted-copy">{sectionLoading === "notes" ? "Loading notes..." : "Notes not loaded yet."}</p>
          )}
        </article>
      ) : null}
    </section>
  );
}
