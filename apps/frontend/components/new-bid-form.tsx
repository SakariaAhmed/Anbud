"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { BidIntakeSuggestion } from "@/lib/types";

const API_BASE = "";

interface BidResponse {
  id: string;
}

interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NewBidForm() {
  const router = useRouter();

  const [customerName, setCustomerName] = useState("");
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [owner, setOwner] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [customFields, setCustomFields] = useState<CustomFieldRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState("");

  const customFieldPayload = useMemo(() => {
    return customFields.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }, [customFields]);

  function addCustomField(seed?: { key: string; value: string }) {
    setCustomFields((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: seed?.key ?? "",
        value: seed?.value ?? ""
      }
    ]);
  }

  function removeCustomField(id: string) {
    setCustomFields((prev) => prev.filter((field) => field.id !== id));
  }

  function updateCustomField(id: string, field: "key" | "value", value: string) {
    setCustomFields((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function onDocumentChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setDocumentFile(file);
    if (file) {
      void autofillFromDocument(file);
    }
  }

  async function autofillFromDocument(file: File | null = documentFile) {
    if (!file) {
      setStatus("Select a document first.");
      return;
    }

    setAnalyzing(true);
    setStatus("Analyzing document and pre-filling fields...");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/api/v1/bids/intake/autofill`, {
        method: "POST",
        headers: {
          "x-tenant-id": "default"
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Autofill failed (${response.status})`);
      }

      const suggestion = (await response.json()) as BidIntakeSuggestion;
      if (suggestion.customer_name) {
        setCustomerName(suggestion.customer_name);
      }
      if (suggestion.title) {
        setTitle(suggestion.title);
      }
      if (suggestion.deadline) {
        setDeadline(suggestion.deadline);
      }
      if (suggestion.owner) {
        setOwner(suggestion.owner);
      }
      if (suggestion.estimated_value !== null && suggestion.estimated_value !== undefined) {
        setEstimatedValue(String(suggestion.estimated_value));
      }

      const incoming = Object.entries(suggestion.custom_fields ?? {});
      if (incoming.length) {
        setCustomFields((prev) => {
          const existing = new Map(prev.map((row) => [row.key.trim().toLowerCase(), row]));
          const merged = [...prev];
          for (const [key, value] of incoming) {
            const lookup = key.trim().toLowerCase();
            const row = existing.get(lookup);
            if (row) {
              const index = merged.findIndex((item) => item.id === row.id);
              if (index >= 0) {
                merged[index] = { ...merged[index], value };
              }
            } else {
              merged.push({
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                key,
                value
              });
            }
          }
          return merged;
        });
      }

      setStatus("AI autofill completed. Review and create bid.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Autofill failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerName.trim()) {
      setStatus("Customer name is required.");
      return;
    }

    setLoading(true);
    setStatus("Creating bid...");

    try {
      const payload = {
        customer_name: customerName.trim(),
        title: title.trim() || null,
        estimated_value: toNumberOrNull(estimatedValue),
        deadline: deadline || null,
        owner: owner.trim() || null,
        custom_fields: customFieldPayload
      };

      const createResponse = await fetch(`${API_BASE}/api/v1/bids`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": "default",
          "x-user-name": "dashboard-user"
        },
        body: JSON.stringify(payload)
      });

      if (!createResponse.ok) {
        throw new Error(`Create bid failed (${createResponse.status})`);
      }

      const bid = (await createResponse.json()) as BidResponse;

      if (documentFile) {
        setStatus("Uploading document...");
        const formData = new FormData();
        formData.append("file", documentFile);

        const uploadResponse = await fetch(`${API_BASE}/api/v1/bids/${bid.id}/documents`, {
          method: "POST",
          headers: {
            "x-tenant-id": "default",
            "x-user-name": "dashboard-user"
          },
          body: formData
        });

        if (!uploadResponse.ok) {
          throw new Error(`Document upload failed (${uploadResponse.status})`);
        }
      }

      router.push(`/bids/${bid.id}`);
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Create bid failed");
      setLoading(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Create New Bid</h2>
        <p>Only customer name is required. Upload a document to let AI prefill the rest.</p>
      </div>

      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Customer Name *
          <input onChange={(event) => setCustomerName(event.target.value)} required type="text" value={customerName} />
        </label>

        <label>
          Bid Title
          <input onChange={(event) => setTitle(event.target.value)} type="text" value={title} />
        </label>

        <label>
          Deadline
          <input onChange={(event) => setDeadline(event.target.value)} type="date" value={deadline} />
        </label>

        <label>
          Owner
          <input onChange={(event) => setOwner(event.target.value)} type="text" value={owner} />
        </label>

        <label>
          Estimated Value
          <input min="0" onChange={(event) => setEstimatedValue(event.target.value)} step="0.01" type="number" value={estimatedValue} />
        </label>

        <label>
          Requirement Document (PDF or TXT)
          <input accept=".pdf,.txt,text/plain,application/pdf" onChange={onDocumentChange} type="file" />
        </label>

        <div className="form-actions">
          <button className="ghost-btn" disabled={!documentFile || analyzing} onClick={() => void autofillFromDocument()} type="button">
            {analyzing ? "Analyzing..." : "AI Autofill"}
          </button>
          <button disabled={loading} type="submit">
            {loading ? "Creating..." : "Create Bid"}
          </button>
        </div>
      </form>

      <section className="custom-fields">
        <div className="custom-fields-head">
          <h3>Custom Fields</h3>
          <button className="ghost-btn" onClick={() => addCustomField()} type="button">
            Add Field
          </button>
        </div>

        {customFields.length ? (
          <div className="custom-fields-list">
            {customFields.map((row) => (
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
          <p className="muted-copy">No custom fields added yet.</p>
        )}
      </section>

      {status ? <p className="form-status">{status}</p> : null}
    </section>
  );
}
