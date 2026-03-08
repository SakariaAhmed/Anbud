"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";

import { TenderIntakeSuggestion } from "@/lib/types";

const API_BASE = "";

interface TenderResponse {
  id: string;
}

interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

function normalizeEstimatedValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function CreateProjectForm() {
  const [customerName, setCustomerName] = useState("");
  const [title, setTitle] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [deadline, setDeadline] = useState("");
  const [owner, setOwner] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [customRows, setCustomRows] = useState<CustomFieldRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState<string>("");

  const canSubmit = customerName.trim() && title.trim() && deadline.trim() && owner.trim();

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

  function resetForm() {
    setCustomerName("");
    setTitle("");
    setEstimatedValue("");
    setDeadline("");
    setOwner("");
    setDocumentFile(null);
    setCustomRows([]);
  }

  function addCustomRow(seed?: { key: string; value: string }) {
    setCustomRows((rows) => [
      ...rows,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: seed?.key ?? "",
        value: seed?.value ?? ""
      }
    ]);
  }

  function removeCustomRow(id: string) {
    setCustomRows((rows) => rows.filter((row) => row.id !== id));
  }

  function updateCustomRow(id: string, field: "key" | "value", value: string) {
    setCustomRows((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setDocumentFile(file);
    if (file) {
      void analyzeFromFile(file);
    }
  }

  async function analyzeFromFile(file: File | null) {
    if (!file) {
      setStatus("Choose a document first.");
      return;
    }

    setAnalyzing(true);
    setStatus("Analyzing document and pre-filling fields...");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/api/v1/tenders/intake/autofill`, {
        method: "POST",
        headers: {
          "x-tenant-id": "default"
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Autofill failed (${response.status})`);
      }

      const suggestion = (await response.json()) as TenderIntakeSuggestion;

      setCustomerName(suggestion.customer_name ?? "");
      setTitle(suggestion.title ?? "");
      setEstimatedValue(suggestion.estimated_value === null ? "" : String(suggestion.estimated_value));
      setDeadline(suggestion.deadline ?? "");
      setOwner(suggestion.owner ?? "");

      const suggestedFields = Object.entries(suggestion.custom_fields ?? {}).map(([key, value]) => ({ key, value }));
      setCustomRows((existing) => {
        const existingMap = new Map(existing.map((row) => [row.key.trim(), row]));
        const merged = [...existing];

        for (const field of suggestedFields) {
          const existingRow = existingMap.get(field.key.trim());
          if (existingRow) {
            merged[merged.findIndex((row) => row.id === existingRow.id)] = { ...existingRow, value: field.value };
          } else {
            merged.push({
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              key: field.key,
              value: field.value
            });
          }
        }
        return merged;
      });

      setStatus("AI autofill complete. Review and adjust before creating project.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Document analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function onAnalyzeDocument() {
    await analyzeFromFile(documentFile);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      setStatus("Customer, title, deadline, and owner are required.");
      return;
    }

    setLoading(true);
    setStatus("Creating project...");

    const payload = {
      customer_name: customerName.trim(),
      title: title.trim(),
      estimated_value: normalizeEstimatedValue(estimatedValue),
      deadline,
      owner: owner.trim(),
      custom_fields: customFieldPayload
    };

    try {
      const tenderRes = await fetch(`${API_BASE}/api/v1/tenders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify(payload)
      });

      if (!tenderRes.ok) {
        throw new Error(`Create failed (${tenderRes.status})`);
      }

      const tender = (await tenderRes.json()) as TenderResponse;

      if (documentFile) {
        setStatus("Uploading source document...");
        const docData = new FormData();
        docData.append("file", documentFile);

        const docRes = await fetch(`${API_BASE}/api/v1/tenders/${tender.id}/documents`, {
          method: "POST",
          headers: {
            "x-tenant-id": "default",
            "x-user-name": "dashboard-user"
          },
          body: docData
        });

        if (!docRes.ok) {
          throw new Error(`Document upload failed (${docRes.status})`);
        }
      }

      setStatus("Project created. Reloading...");
      resetForm();
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel form-panel" id="new-project">
      <h2>New Bid Round Project</h2>
      <p className="form-hint">Upload a requirement document first, let AI prefill, then add your own fields.</p>

      <form className="ops-form" onSubmit={onSubmit}>
        <label>
          Customer
          <input onChange={(event) => setCustomerName(event.target.value)} required type="text" value={customerName} />
        </label>
        <label>
          Tender Title
          <input onChange={(event) => setTitle(event.target.value)} required type="text" value={title} />
        </label>
        <label>
          Estimated Value
          <input min="0" onChange={(event) => setEstimatedValue(event.target.value)} step="0.01" type="number" value={estimatedValue} />
        </label>
        <label>
          Deadline
          <input onChange={(event) => setDeadline(event.target.value)} required type="date" value={deadline} />
        </label>
        <label>
          Owner
          <input onChange={(event) => setOwner(event.target.value)} required type="text" value={owner} />
        </label>
        <label>
          Requirement Document (PDF or TXT)
          <input accept=".pdf,.txt,text/plain,application/pdf" name="document" onChange={onFileChange} type="file" />
        </label>

        <div className="form-actions-row">
          <button className="ghost-btn" disabled={analyzing || !documentFile} onClick={onAnalyzeDocument} type="button">
            {analyzing ? "Analyzing..." : "Analyze Document"}
          </button>
          <button disabled={loading || !canSubmit} type="submit">
            {loading ? "Saving..." : "Create Project"}
          </button>
        </div>
      </form>

      <section className="custom-fields">
        <div className="custom-fields-header">
          <h3>Custom Fields</h3>
          <button className="ghost-btn" onClick={() => addCustomRow()} type="button">
            Add Field
          </button>
        </div>

        {customRows.length ? (
          <div className="custom-fields-list">
            {customRows.map((row) => (
              <div className="custom-field-row" key={row.id}>
                <input
                  onChange={(event) => updateCustomRow(row.id, "key", event.target.value)}
                  placeholder="Field name"
                  type="text"
                  value={row.key}
                />
                <input
                  onChange={(event) => updateCustomRow(row.id, "value", event.target.value)}
                  placeholder="Field value"
                  type="text"
                  value={row.value}
                />
                <button className="ghost-btn danger" onClick={() => removeCustomRow(row.id)} type="button">
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="form-hint">No custom fields yet.</p>
        )}
      </section>

      <p className="form-status">{status}</p>
    </section>
  );
}
